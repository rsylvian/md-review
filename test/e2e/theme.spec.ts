import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Theming in a real browser: the OS default, a manual override, and that it sticks. */

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli.js');

type Session = { dir: string; home: string; url: string; process: ChildProcessWithoutNullStreams };

async function startReview(): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), 'md-review-theme-'));
  const home = mkdtempSync(join(tmpdir(), 'md-review-theme-home-'));
  writeFileSync(join(dir, 'draft.md'), '# Title\n\nSome prose to review.\n');

  // Sidecars live under $HOME now, not the reviewed project — point it at a scratch dir
  // so this doesn't touch the real machine's ~/.cache.
  const child = spawn(process.execPath, [CLI, 'draft.md', '--no-open', '--port', '0'], {
    cwd: dir,
    env: { ...process.env, HOME: home },
  });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));

  const url = await new Promise<string>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`no URL; stderr: ${stderr}`)), 10_000);
    const check = (): void => {
      const m = /at (http:\/\/\S+)/.exec(stderr);
      if (m) {
        clearTimeout(timer);
        res(m[1]!);
      }
    };
    child.stderr.on('data', check);
    check();
  });

  return { dir, home, url, process: child };
}

const theme = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.theme ?? null);

const bodyBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

let session: Session;

test.afterEach(() => {
  session?.process.kill('SIGKILL');
  if (session?.dir !== undefined) rmSync(session.dir, { recursive: true, force: true });
  if (session?.home !== undefined) rmSync(session.home, { recursive: true, force: true });
});

test.describe('theme', () => {
  test('follows the OS when nothing has been chosen', async ({ browser }) => {
    session = await startReview();

    const dark = await browser.newContext({ colorScheme: 'dark' });
    const darkPage = await dark.newPage();
    await darkPage.goto(session.url);
    await expect(darkPage.locator('#doc')).toBeVisible();
    expect(await theme(darkPage)).toBe('dark');
    await dark.close();

    const light = await browser.newContext({ colorScheme: 'light' });
    const lightPage = await light.newPage();
    await lightPage.goto(session.url);
    await expect(lightPage.locator('#doc')).toBeVisible();
    expect(await theme(lightPage)).toBe('light');
    await light.close();
  });

  test('the toggle flips the theme and repaints', async ({ page }) => {
    session = await startReview();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(session.url);
    await expect(page.locator('#doc')).toBeVisible();

    const lightBackground = await bodyBackground(page);
    const toggle = page.getByRole('button', { name: 'Switch to dark theme' });
    await expect(toggle).toBeVisible();

    await toggle.click();

    expect(await theme(page)).toBe('dark');
    expect(await bodyBackground(page)).not.toBe(lightBackground);
    // The button now offers the way back.
    await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
  });

  test('a chosen theme survives a reload and outlasts the OS setting', async ({ page }) => {
    session = await startReview();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(session.url);
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    expect(await theme(page)).toBe('dark');

    await page.reload();
    await expect(page.locator('#doc')).toBeVisible();

    expect(await theme(page)).toBe('dark');
    expect(
      await page.evaluate(() => localStorage.getItem('md-review:theme')),
    ).toBe('dark');
  });

  test('the chosen theme is applied before first paint', async ({ page }) => {
    session = await startReview();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(session.url);
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();

    // Catch the attribute at the earliest moment a script can observe the document.
    let earliest: string | null = null;
    await page.exposeFunction('recordTheme', (value: string | null) => {
      earliest ??= value;
    });
    await page.addInitScript(() => {
      document.addEventListener(
        'readystatechange',
        () => {
          // @ts-expect-error injected above
          window.recordTheme(document.documentElement.dataset.theme ?? null);
        },
        { once: true },
      );
    });

    await page.reload();
    await expect(page.locator('#doc')).toBeVisible();

    expect(earliest).toBe('dark');
  });

  test('an untouched tab follows the OS switching underneath it', async ({ page }) => {
    session = await startReview();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(session.url);
    await expect(page.locator('#doc')).toBeVisible();
    expect(await theme(page)).toBe('light');

    await page.emulateMedia({ colorScheme: 'dark' });

    await expect.poll(() => theme(page)).toBe('dark');
  });

  test('commenting still works after switching theme', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);
    await page.locator('#doc [data-pos]').first().waitFor();
    await page.getByRole('button', { name: /Switch to (dark|light) theme/ }).click();

    const box = await page.evaluate(() => {
      const root = document.getElementById('doc');
      if (root === null) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node !== null) {
        const index = (node as Text).data.indexOf('prose');
        if (index !== -1) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 5);
          const { x, y, width, height } = range.getBoundingClientRect();
          return { x, y, width, height };
        }
        node = walker.nextNode();
      }
      return null;
    });
    if (box === null) throw new Error('demo text not found');

    const mid = box.y + box.height / 2;
    await page.mouse.move(box.x + 1, mid);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, mid, { steps: 8 });
    await page.mouse.up();

    const draft = page.locator('.card.draft');
    await expect(draft).toBeVisible();
    await draft.locator('textarea').first().fill('still works');
    await draft.getByRole('button', { name: 'comment' }).click();

    await expect(page.locator('.card:not(.draft)')).toContainText('still works');
  });
});
