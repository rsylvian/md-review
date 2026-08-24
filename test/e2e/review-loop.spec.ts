import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The acceptance test for the premise: a human highlights text in a browser, comments,
 * closes the tab, and the waiting process hands the comments to the agent.
 */

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli.js');

const DRAFT = [
  '# Q3 Platform Plan',
  '',
  'The system serves consectetur users of this thing, and we think it works well.',
  '',
  '## Goals',
  '',
  '- Ship the ingestion rewrite',
  '- Measure latency weekly',
  '',
  'We should probably measure this.',
].join('\n');

/**
 * Fixtures for the within-paragraph selection bug (issue #15): adjacent inline runs
 * with no space-free boundary, and an escaped sentence, both real browser hit-testing
 * surfaces that happy-dom-based unit tests can't reproduce.
 */
const BOUNDARY_DRAFT = [
  '# Boundary Cases',
  '',
  'A run of **bold text** next to *italic prose* sits here.',
  '',
  'Escapes: \\*not sturdy\\* here.',
].join('\n');

type Session = {
  dir: string;
  home: string;
  url: string;
  process: ChildProcessWithoutNullStreams;
  /** Resolves with stdout — the review the agent receives — once the CLI exits. */
  output: Promise<{ stdout: string; stderr: string; code: number | null }>;
};

async function startReview(source = DRAFT): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), 'md-review-e2e-'));
  const home = mkdtempSync(join(tmpdir(), 'md-review-e2e-home-'));
  writeFileSync(join(dir, 'draft.md'), source);

  // Sidecars live under the cache home (os.homedir(), which respects $HOME) rather than
  // inside the reviewed project, so tests point $HOME at a scratch dir to stay isolated
  // from the real machine's ~/.cache.
  const child = spawn(process.execPath, [CLI, 'draft.md', '--no-open', '--port', '0'], {
    cwd: dir,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));

  const output = new Promise<{ stdout: string; stderr: string; code: number | null }>((res) => {
    child.on('close', (code) => res({ stdout, stderr, code }));
  });

  // The CLI announces where it is listening on stderr.
  const url = await new Promise<string>((res, rej) => {
    const timer = setTimeout(
      () => rej(new Error(`no URL announced; stderr was: ${stderr}`)),
      10_000,
    );
    const check = (): void => {
      const match = /at (http:\/\/\S+)/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        res(match[1]!);
      }
    };
    child.stderr.on('data', check);
    check();
  });

  return { dir, home, url, process: child, output };
}

/**
 * Measures one word in the rendered document, scrolling it into view.
 * A Range is used because a text run's span can wrap a whole paragraph, making its own
 * bounding box far too wide to aim at.
 */
async function wordBox(
  page: Page,
  word: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  // The page fetches and renders the document after load; wait for it to exist.
  await page.locator('#doc [data-pos]').first().waitFor();

  const box = await page.evaluate((needle) => {
    const root = document.getElementById('doc');
    if (root === null) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null) {
      const index = (node as Text).data.indexOf(needle);
      if (index !== -1) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + needle.length);
        // Must be on screen before it can be dragged across.
        (node as Text).parentElement?.scrollIntoView({ block: 'center' });
        const { x, y, width, height } = range.getBoundingClientRect();
        return { x, y, width, height };
      }
      node = walker.nextNode();
    }
    return null;
  }, word);

  if (box === null) throw new Error(`could not find ${word} on the page`);
  return box;
}

/** Drags across one word, the way a reviewer starts a comment. */
async function selectWord(page: Page, word: string): Promise<void> {
  const box = await wordBox(page, word);
  const midline = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, midline);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, midline, { steps: 12 });
  await page.mouse.up();
}

/** Clicks a word, the way a reviewer opens the comment on a highlighted passage. */
async function clickWord(page: Page, word: string): Promise<void> {
  const box = await wordBox(page, word);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Double-clicks a word, the way native browser word-selection is triggered. */
async function doubleClickWord(page: Page, word: string): Promise<void> {
  const box = await wordBox(page, word);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Drags from the start of `fromWord` and releases exactly on the last pixel of
 * `toWord` — the way a reviewer's drag lands right on a formatting boundary (real
 * mouse hit-testing there often reports an Element-container Range, not a Text one).
 */
async function dragBoundary(page: Page, fromWord: string, toWord: string): Promise<void> {
  const from = await wordBox(page, fromWord);
  const to = await wordBox(page, toWord);
  await page.mouse.move(from.x + 1, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 1, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

/** Saves a draft comment with the given body, the way `selectWord`/`doubleClickWord` set up. */
async function saveComment(page: Page, body: string): Promise<void> {
  const draft = page.locator('.card.draft');
  await expect(draft).toBeVisible();
  await draft.locator('textarea').first().fill(body);
  await draft.getByRole('button', { name: 'comment' }).click();
  await expect(page.locator('.card:not(.draft)')).toHaveCount(1);
}

/** The text actually highlighted for the saved comment, read back from the live DOM. */
async function highlightedText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const highlight = CSS.highlights.get('md-review-comment');
    if (highlight === undefined) return '';
    return [...highlight].map((range) => range.toString()).join('');
  });
}

test.describe('review loop', () => {
  let session: Session;

  test.afterEach(async () => {
    session?.process.kill('SIGKILL');
    if (session?.dir !== undefined) rmSync(session.dir, { recursive: true, force: true });
    if (session?.home !== undefined) rmSync(session.home, { recursive: true, force: true });
  });

  test('a comment left in the browser reaches the agent when the tab closes', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await expect(page.locator('#doc h1')).toHaveText('Q3 Platform Plan');
    await expect(page.locator('.hint')).toBeHidden();
    await page.locator('.topbar .count').hover();
    await expect(page.locator('.hint')).toBeVisible();

    await selectWord(page, 'consectetur');

    const draft = page.locator('.card.draft');
    await expect(draft).toBeVisible();
    await draft.locator('textarea').first().fill('Too vague — name the actual users.');
    await draft.getByRole('button', { name: 'comment' }).click();

    // The saved card replaces the draft.
    const card = page.locator('.card:not(.draft)');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Too vague');
    await expect(page.locator('.topbar .count')).toContainText('1 comment');

    // The reviewer closes the tab; the CLI should finish on its own.
    await page.close();

    const { stdout, code } = await session.output;
    expect(code).toBe(0);
    expect(stdout).toContain('1 open comment');
    expect(stdout).toContain('Too vague — name the actual users.');
    expect(stdout).toContain('> consectetur');
  });

  test('a suggested rewrite arrives as exact replacement text', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    const draft = page.locator('.card.draft');
    await draft.locator('textarea').first().fill('Name them.');
    await draft.getByRole('button', { name: 'suggest a rewrite' }).click();

    const suggestion = draft.locator('textarea').nth(1);
    // Prefilled with the exact source text, ready to edit.
    await expect(suggestion).toHaveValue('consectetur');
    await suggestion.fill('data engineers');
    await draft.getByRole('button', { name: 'comment' }).click();

    await expect(page.locator('.card .suggestion')).toContainText('data engineers');

    await page.close();
    const { stdout } = await session.output;
    expect(stdout).toContain('suggested rewrite');
    expect(stdout).toMatch(/Replace:\n```\nconsectetur\n```/);
    expect(stdout).toMatch(/With:\n```\ndata engineers\n```/);
  });

  test('an untouched prefill is not reported as a rewrite', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    const draft = page.locator('.card.draft');
    await draft.locator('textarea').first().fill('Name them.');
    // Opened the suggestion field, then left the prefill alone and said it in the body.
    await draft.getByRole('button', { name: 'suggest a rewrite' }).click();
    await expect(draft.locator('textarea').nth(1)).toHaveValue('consectetur');
    await draft.getByRole('button', { name: 'comment' }).click();

    await expect(page.locator('.card:not(.draft)')).toHaveCount(1);
    await expect(page.locator('.card .suggestion')).toHaveCount(0);

    await page.close();
    const { stdout } = await session.output;
    expect(stdout).toContain('Name them.');
    expect(stdout).not.toContain('suggested rewrite');
    expect(stdout).not.toContain('Replace:');
  });

  test('an untouched prefill alone is not enough to save', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    const draft = page.locator('.card.draft');
    await draft.getByRole('button', { name: 'suggest a rewrite' }).click();

    // No body, and a suggestion identical to the source — there is no instruction here.
    await expect(draft.getByRole('button', { name: 'comment' })).toBeDisabled();

    await draft.locator('textarea').nth(1).fill('data engineers');
    await expect(draft.getByRole('button', { name: 'comment' })).toBeEnabled();
  });

  test('saving a comment does not make the Send button claim to be sending', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    // Hold the save in flight, so the state during the request can be observed at all.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/comments', async (route) => {
      await held;
      await route.continue();
    });

    await selectWord(page, 'consectetur');
    await page.locator('.card.draft textarea').first().fill('saving now');
    await page.locator('.card.draft').getByRole('button', { name: 'comment' }).click();

    // The draft's own button reports the save, which is the point of the flag.
    await expect(
      page.locator('.card.draft').getByRole('button', { name: 'comment' }),
    ).toBeDisabled();

    // The review, meanwhile, is not being sent.
    const send = page.locator('.topbar .send');
    await expect(send).toHaveText('Send');
    await expect(send).toBeEnabled();

    release();
    await expect(page.locator('.card:not(.draft)')).toContainText('saving now');
  });

  test('the Send button ends the review without closing the tab', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    const draft = page.locator('.card.draft');
    await draft.locator('textarea').first().fill('Sent via the button.');
    await draft.getByRole('button', { name: 'comment' }).click();

    await page.locator('.topbar .send').click();

    await expect(page.locator('.sent h1')).toHaveText('Review sent');

    const { stdout, code } = await session.output;
    expect(code).toBe(0);
    expect(stdout).toContain('Sent via the button.');
  });

  test('the commented passage is highlighted', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    await page.locator('.card.draft textarea').first().fill('x');
    await page.locator('.card.draft').getByRole('button', { name: 'comment' }).click();
    await expect(page.locator('.card:not(.draft)')).toHaveCount(1);

    const highlighted = await page.evaluate(() => {
      const highlight = CSS.highlights.get('md-review-comment');
      return highlight === undefined ? 0 : highlight.size;
    });
    expect(highlighted).toBeGreaterThan(0);
  });

  test('selecting new text while a draft is open does not discard it', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    const draft = page.locator('.card.draft');
    await expect(draft).toBeVisible();
    await draft.locator('textarea').first().fill('unsaved thoughts');

    // Selecting a different passage without saving or cancelling first must not
    // silently discard the draft already in progress.
    await selectWord(page, 'Goals');

    await expect(draft).toBeVisible();
    await expect(draft.locator('textarea').first()).toHaveValue('unsaved thoughts');
  });

  test('a saved comment stays out of the way until its passage is clicked', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    await page.locator('.card.draft textarea').first().fill('open me');
    await page.locator('.card.draft').getByRole('button', { name: 'comment' }).click();
    await expect(page.locator('.card:not(.draft)')).toContainText('open me');

    // Clicking off the passage puts it away.
    await clickWord(page, 'Goals');
    await expect(page.locator('.popover')).toHaveCount(0);

    await clickWord(page, 'consectetur');
    await expect(page.locator('.card:not(.draft)')).toContainText('open me');

    // And the close button puts it away too.
    await page.locator('.card').getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.popover')).toHaveCount(0);
  });

  test('clicking the empty space past the end of the document closes the card', async ({
    page,
  }) => {
    session = await startReview();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    await page.locator('.card.draft textarea').first().fill('close me');
    await page.locator('.card.draft').getByRole('button', { name: 'comment' }).click();
    await expect(page.locator('.popover')).toHaveCount(1);

    // Well below the last line, where there is no document left to click on.
    const doc = await page.locator('#doc').boundingBox();
    if (doc === null) throw new Error('no document');
    await page.mouse.click(doc.x + 40, doc.y + doc.height + 250);

    await expect(page.locator('.popover')).toHaveCount(0);
  });

  test('opening one comment closes the one already open', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    for (const [word, body] of [
      ['consectetur', 'first comment'],
      ['Goals', 'second comment'],
    ]) {
      await selectWord(page, word!);
      await page.locator('.card.draft textarea').first().fill(body!);
      await page.locator('.card.draft').getByRole('button', { name: 'comment' }).click();
      await expect(page.locator('.card:not(.draft)')).toContainText(body!);
    }

    await clickWord(page, 'consectetur');
    await expect(page.locator('.popover')).toHaveCount(1);
    await expect(page.locator('.card')).toContainText('first comment');

    await clickWord(page, 'Goals');
    await expect(page.locator('.popover')).toHaveCount(1);
    await expect(page.locator('.card')).toContainText('second comment');
  });

  test('the card opens below its passage, inside the column', async ({ page }) => {
    session = await startReview();
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    await page.locator('.card.draft textarea').first().fill('placed');
    await page.locator('.card.draft').getByRole('button', { name: 'comment' }).click();

    const passage = await wordBox(page, 'consectetur');
    const card = await page.locator('.popover').boundingBox();
    const column = await page.locator('#doc').boundingBox();
    if (card === null || column === null) throw new Error('nothing to measure');

    expect(card.y).toBeGreaterThanOrEqual(passage.y + passage.height);
    expect(card.x).toBeGreaterThanOrEqual(column.x - 1);
    expect(card.x + card.width).toBeLessThanOrEqual(column.x + column.width + 1);
  });

  test('the finished review is saved beside the sidecar, as markdown only', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    await page.locator('.card.draft textarea').first().fill('saved to disk');
    await page.locator('.card.draft').getByRole('button', { name: 'comment' }).click();
    await expect(page.locator('.card:not(.draft)')).toHaveCount(1);

    await page.close();
    await session.output;

    // The sidecar carries state to the next round; the report is for the agent to read.
    // It lives under the cache home, not the reviewed project, so nothing needs gitignoring.
    const dir = join(session.home, '.cache', 'md-review');
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    const jsonFile = files.find((f) => f.endsWith('.json'));
    const reportFile = files.find((f) => f.endsWith('.review.md'));
    expect(jsonFile).toBeDefined();
    expect(reportFile).toBeDefined();
    expect(reportFile!.replace(/\.review\.md$/, '')).toBe(jsonFile!.replace(/\.json$/, ''));
    expect(readFileSync(join(dir, reportFile!), 'utf8')).toContain('saved to disk');
  });

  test('a comment can be deleted before sending', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    await page.locator('.card.draft textarea').first().fill('never mind');
    await page.locator('.card.draft').getByRole('button', { name: 'comment' }).click();
    await expect(page.locator('.card:not(.draft)')).toHaveCount(1);

    await page.locator('.card:not(.draft) button', { hasText: 'delete' }).click();
    await expect(page.locator('.card:not(.draft)')).toHaveCount(0);

    await page.close();
    const { stdout } = await session.output;
    expect(stdout).toContain('No open comments');
  });

  test('a reload does not end the review', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    await page.locator('.card.draft textarea').first().fill('survives a reload');
    await page.locator('.card.draft').getByRole('button', { name: 'comment' }).click();
    await expect(page.locator('.card:not(.draft)')).toHaveCount(1);

    await page.reload();

    // Still alive, and the comment came back from the server — reopen it to see.
    await clickWord(page, 'consectetur');
    await expect(page.locator('.card:not(.draft)')).toContainText('survives a reload');
    expect(session.process.exitCode).toBeNull();

    await page.close();
    const { stdout } = await session.output;
    expect(stdout).toContain('survives a reload');
  });

  test('comments the agent addressed come back resolved on the next round', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    // Round 1: comment on a passage.
    await selectWord(page, 'consectetur');
    await page.locator('.card.draft textarea').first().fill('name them');
    await page.locator('.card.draft').getByRole('button', { name: 'comment' }).click();
    await expect(page.locator('.card:not(.draft)')).toHaveCount(1);
    await page.close();
    await session.output;

    // The agent rewrites that passage.
    const file = join(session.dir, 'draft.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('consectetur', 'data engineers'));

    // Round 2, same directory and $HOME so the sidecar carries over.
    const second = spawn(process.execPath, [CLI, 'draft.md', '--no-open', '--port', '0'], {
      cwd: session.dir,
      env: { ...process.env, HOME: session.home, USERPROFILE: session.home },
    });
    let stderr = '';
    second.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const url = await new Promise<string>((res) => {
      const check = (): void => {
        const m = /at (http:\/\/\S+)/.exec(stderr);
        if (m) res(m[1]!);
      };
      second.stderr.on('data', check);
    });

    try {
      await page.context().newPage();
      const next = page.context().pages().at(-1)!;
      await next.goto(url);

      await expect(next.locator('.resolved summary')).toHaveText('Resolved (1)');
      await expect(next.locator('.topbar .count')).toContainText('0 comments');
      await expect(next.locator('.topbar .count')).toContainText('1 resolved');
    } finally {
      second.kill('SIGKILL');
    }
  });

  test('double-clicking a word next to an escape highlights only that word', async ({ page }) => {
    session = await startReview(BOUNDARY_DRAFT);
    await page.goto(session.url);

    await doubleClickWord(page, 'sturdy');
    await saveComment(page, 'x');

    expect(await highlightedText(page)).toBe('sturdy');

    await page.close();
    const { stdout } = await session.output;
    expect(stdout).toContain('> sturdy');
    expect(stdout).not.toContain('> Escapes: *not sturdy* here.');
  });

  test('double-clicking a word inside emphasis, next to plain text, highlights only that word', async ({
    page,
  }) => {
    session = await startReview(BOUNDARY_DRAFT);
    await page.goto(session.url);

    await doubleClickWord(page, 'italic');
    await saveComment(page, 'x');

    expect(await highlightedText(page)).toBe('italic');

    await page.close();
    const { stdout } = await session.output;
    expect(stdout).toContain('> italic');
  });

  test('a drag released exactly on a formatting boundary highlights exactly what was dragged', async ({
    page,
  }) => {
    session = await startReview(BOUNDARY_DRAFT);
    await page.goto(session.url);

    await dragBoundary(page, 'run', 'text');
    await saveComment(page, 'x');

    const highlighted = await highlightedText(page);
    expect(highlighted).toBe('run of bold text');
    expect(highlighted).not.toContain('sits here');

    await page.close();
    const { stdout } = await session.output;
    expect(stdout).toContain('> run of bold text');
    expect(stdout).not.toContain('sits here');
  });

  test('a drag that ends outside the document still opens a draft', async ({ page }) => {
    // A drag released past the top edge of the document lands on the sticky topbar
    // (a sibling of #doc, not a descendant) rather than on the document itself. The
    // browser's own Selection still extends correctly; the app must still notice.
    session = await startReview();
    await page.goto(session.url);
    await page.locator('#doc [data-pos]').first().waitFor();

    await page.evaluate(() => {
      const root = document.getElementById('doc')!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let headingNode: Text | null = null;
      let endNode: Text | null = null;
      let node = walker.nextNode() as Text | null;
      while (node !== null) {
        if (headingNode === null && node.data.includes('Goals')) headingNode = node;
        if (node.data.includes('works well.')) endNode = node;
        node = walker.nextNode() as Text | null;
      }
      const range = document.createRange();
      range.setStart(endNode!, endNode!.data.indexOf('works well.'));
      range.setEnd(headingNode!, headingNode!.data.indexOf('Goals') + 'Goals'.length);

      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);

      document
        .querySelector('.topbar')!
        .dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    });

    const draft = page.locator('.card.draft');
    await expect(draft).toBeVisible();
  });
});
