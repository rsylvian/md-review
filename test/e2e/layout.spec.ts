import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The header spans the window while the document is a centred column, so the two are
 * only aligned if they share a gutter. These assertions pin that down: a stray padding
 * change would otherwise put them quietly out of line again.
 */

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli.js');

type Session = { dir: string; home: string; url: string; process: ChildProcessWithoutNullStreams };

async function startReview(): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), 'md-review-layout-'));
  const home = mkdtempSync(join(tmpdir(), 'md-review-layout-home-'));
  writeFileSync(
    join(dir, 'draft.md'),
    '# Q3 Platform Plan\n\nThe system serves the actual users of this thing.\n\n## Goals\n\n- Ship it\n',
  );

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

async function edges(page: Page, selector: string): Promise<{ left: number; right: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`no box for ${selector}`);
  return { left: box.x, right: box.x + box.width };
}

let session: Session;

test.afterEach(() => {
  session?.process.kill('SIGKILL');
  if (session?.dir !== undefined) rmSync(session.dir, { recursive: true, force: true });
  if (session?.home !== undefined) rmSync(session.home, { recursive: true, force: true });
});

test.describe('layout', () => {
  test('the header contents line up with the document column', async ({ page }) => {
    session = await startReview();
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(session.url);
    await page.locator('#doc [data-pos]').first().waitFor();

    const filename = await edges(page, '.topbar .file');
    const doc = await edges(page, '#doc');

    // Left edges share the gutter.
    expect(Math.abs(filename.left - doc.left)).toBeLessThan(1.5);
  });

  test('the header controls line up with the right edge of the document', async ({ page }) => {
    session = await startReview();
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(session.url);
    await page.locator('#doc [data-pos]').first().waitFor();

    const send = await edges(page, '.topbar .send');
    const doc = await edges(page, '#doc');

    expect(Math.abs(send.right - doc.right)).toBeLessThan(1.5);
  });

  test('the bar itself still spans the window', async ({ page }) => {
    session = await startReview();
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(session.url);
    await page.locator('#doc [data-pos]').first().waitFor();

    const bar = await edges(page, '.topbar');
    const width = await page.evaluate(() => document.documentElement.clientWidth);

    expect(bar.left).toBeLessThan(1);
    expect(Math.abs(bar.right - width)).toBeLessThan(1);
  });

  test('content is centred, with equal gutters either side', async ({ page }) => {
    session = await startReview();
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(session.url);
    await page.locator('#doc [data-pos]').first().waitFor();

    const doc = await edges(page, '#doc');
    const width = await page.evaluate(() => document.documentElement.clientWidth);

    expect(Math.abs(doc.left - (width - doc.right))).toBeLessThan(1.5);
  });

  test('stays aligned at an awkward width, and keeps a minimum gutter when cramped', async ({
    page,
  }) => {
    session = await startReview();
    await page.goto(session.url);
    await page.locator('#doc [data-pos]').first().waitFor();

    for (const width of [1920, 1280, 1140]) {
      await page.setViewportSize({ width, height: 900 });
      const filename = await edges(page, '.topbar .file');
      const doc = await edges(page, '#doc');

      expect(Math.abs(filename.left - doc.left), `at ${width}px`).toBeLessThan(1.5);
      // Never flush against the window edge.
      expect(doc.left, `at ${width}px`).toBeGreaterThanOrEqual(23);
    }
  });

  test('the document keeps a gutter on both sides of a narrow window', async ({ page }) => {
    session = await startReview();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto(session.url);
    await page.locator('#doc [data-pos]').first().waitFor();

    const doc = await edges(page, '#doc');
    const width = await page.evaluate(() => document.documentElement.clientWidth);

    expect(doc.left).toBeGreaterThanOrEqual(23);
    expect(width - doc.right).toBeGreaterThanOrEqual(23);
  });
});
