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
    env: { ...process.env, HOME: home, USERPROFILE: home },
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

  /**
   * The theme toggle is the only thing left in the topbar's right-hand cluster (Send
   * lives in the panel header now). It sits in a box exactly `--panel-width` wide,
   * pulled flush to the viewport edge with a negative margin that cancels `--gutter` —
   * so that box's horizontal span should match the docked panel's exactly.
   */
  test('the theme toggle lines up with the panel docked beneath it', async ({ page }) => {
    session = await startReview();
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(session.url);
    await page.locator('#doc [data-pos]').first().waitFor();

    const align = await edges(page, '.topbar-panel-align');
    const panel = await edges(page, '.panel');

    expect(Math.abs(align.left - panel.left)).toBeLessThan(1.5);
    expect(Math.abs(align.right - panel.right)).toBeLessThan(1.5);
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

  /**
   * The panel is flush with the viewport's right edge, so the document no longer has a
   * symmetric gutter within the *viewport* — it has one within the space left of the
   * panel (the doc-scroller), which is what --content-width's algebra actually
   * guarantees. The doc-scroller ends exactly where the panel begins (flex siblings,
   * no gap), so that space is `panel.left`.
   */
  test('the document is centred in the space left of the panel, with equal gutters either side', async ({
    page,
  }) => {
    session = await startReview();
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(session.url);
    await page.locator('#doc [data-pos]').first().waitFor();

    const doc = await edges(page, '#doc');
    const panel = await edges(page, '.panel');

    expect(Math.abs(doc.left - (panel.left - doc.right))).toBeLessThan(1.5);
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

  test('the panel is exactly 352px wide and flush with the right edge of the viewport', async ({
    page,
  }) => {
    session = await startReview();
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(session.url);
    await page.locator('#doc [data-pos]').first().waitFor();

    const panel = await page.locator('.panel').boundingBox();
    if (panel === null) throw new Error('no panel');
    const width = await page.evaluate(() => document.documentElement.clientWidth);

    expect(panel.width).toBeCloseTo(352, 0);
    expect(width - (panel.x + panel.width)).toBeLessThan(1);
  });

  test('the panel is hidden by default below the breakpoint, with a toggle shown instead', async ({
    page,
  }) => {
    session = await startReview();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto(session.url);
    await page.locator('#doc [data-pos]').first().waitFor();

    await expect(page.locator('.panel-toggle')).toBeVisible();

    const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
    const panelBox = await page.locator('.panel').boundingBox();
    // Translated fully off-screen to the right, not merely display:none, so it can
    // slide in — its left edge sits at or past the viewport's right edge.
    expect(panelBox === null || panelBox.x >= viewportWidth).toBe(true);
  });
});
