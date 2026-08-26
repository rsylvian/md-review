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
  const composer = page.locator('.composer');
  await expect(composer).toBeVisible();
  await composer.locator('textarea').first().fill(body);
  await composer.getByRole('button', { name: 'comment', exact: true }).click();
  await expect(page.locator('.comment-row')).toHaveCount(1);
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

    await selectWord(page, 'consectetur');

    const composer = page.locator('.composer');
    await expect(composer).toBeVisible();
    await composer.locator('textarea').first().fill('Too vague — name the actual users.');
    await composer.getByRole('button', { name: 'comment', exact: true }).click();

    // The saved row appears in the panel.
    const row = page.locator('.comment-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Too vague');
    await expect(page.locator('.panel-toggle')).toContainText('Comments (1)');

    // The reviewer closes the tab; the CLI should finish on its own.
    await page.close();

    const { stdout, code } = await session.output;
    expect(code).toBe(0);
    expect(stdout).toContain('1 open comment');
    expect(stdout).toContain('Too vague — name the actual users.');
    expect(stdout).toContain('> consectetur');
  });

  test('the Send button is disabled until there is at least one comment', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    const send = page.locator('.panel-header .send');
    await expect(send).toBeDisabled();

    await selectWord(page, 'consectetur');
    const composer = page.locator('.composer');
    await composer.locator('textarea').first().fill('Name them.');
    await composer.getByRole('button', { name: 'comment', exact: true }).click();

    await expect(page.locator('.comment-row')).toHaveCount(1);
    await expect(send).toBeEnabled();
  });

  test('a suggested rewrite arrives as exact replacement text', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    const composer = page.locator('.composer');
    await composer.getByRole('button', { name: 'Rewrite' }).click();

    const field = composer.locator('textarea');
    await expect(field).toHaveAttribute('placeholder', 'Replace "consectetur" with…');
    await field.fill('data engineers');
    await composer.getByRole('button', { name: 'comment', exact: true }).click();

    await expect(page.locator('.comment-row .row-suggestion')).toContainText('data engineers');

    await page.close();
    const { stdout } = await session.output;
    expect(stdout).toContain('suggested rewrite');
    expect(stdout).toMatch(/Replace:\n```\nconsectetur\n```/);
    expect(stdout).toMatch(/With:\n```\ndata engineers\n```/);
  });

  test('switching to Rewrite and back without writing a replacement leaves a plain comment', async ({
    page,
  }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    const composer = page.locator('.composer');
    // Peek at Rewrite mode, then change their mind and leave a note instead.
    await composer.getByRole('button', { name: 'Rewrite' }).click();
    await composer.getByRole('button', { name: 'Note' }).click();
    await composer.locator('textarea').fill('Name them.');
    await composer.getByRole('button', { name: 'comment', exact: true }).click();

    await expect(page.locator('.comment-row')).toHaveCount(1);
    await expect(page.locator('.comment-row .row-suggestion')).toHaveCount(0);

    await page.close();
    const { stdout } = await session.output;
    expect(stdout).toContain('Name them.');
    expect(stdout).not.toContain('suggested rewrite');
    expect(stdout).not.toContain('Replace:');
  });

  test('an empty rewrite alone is not enough to save', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    const composer = page.locator('.composer');
    await composer.getByRole('button', { name: 'Rewrite' }).click();

    // No replacement text yet — there is no instruction here.
    await expect(composer.getByRole('button', { name: 'comment', exact: true })).toBeDisabled();

    await composer.locator('textarea').fill('data engineers');
    await expect(composer.getByRole('button', { name: 'comment', exact: true })).toBeEnabled();
  });

  test('Delete needs no text and marks the passage for removal', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    const composer = page.locator('.composer');
    await composer.getByRole('button', { name: 'Delete', exact: true }).click();

    // No textarea in Delete mode — there is nothing to type.
    await expect(composer.locator('textarea')).toHaveCount(0);
    const saveButton = composer.getByRole('button', { name: 'delete', exact: true });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    const row = page.locator('.comment-row');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.pill-delete')).toHaveText('deletion');

    await page.close();
    const { stdout } = await session.output;
    expect(stdout).toContain('suggested deletion');
    expect(stdout).toMatch(/Delete:\n```\nconsectetur\n```/);
    expect(stdout).not.toContain('Replace:');
    expect(stdout).not.toContain('With:');
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
    await page.locator('.composer textarea').first().fill('saving now');
    await page.locator('.composer').getByRole('button', { name: 'comment', exact: true }).click();

    // The composer's own button reports the save, which is the point of the flag.
    await expect(
      page.locator('.composer').getByRole('button', { name: 'comment', exact: true }),
    ).toBeDisabled();

    // The review, meanwhile, is not being sent — it just has no comments yet.
    const send = page.locator('.panel-header .send');
    await expect(send).toHaveText('Send');

    release();
    await expect(page.locator('.comment-row')).toContainText('saving now');
    await expect(send).toBeEnabled();
  });

  test('the Send button ends the review without closing the tab', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    const composer = page.locator('.composer');
    await composer.locator('textarea').first().fill('Sent via the button.');
    await composer.getByRole('button', { name: 'comment', exact: true }).click();

    await page.locator('.panel-header .send').click();

    await expect(page.locator('.sent h1')).toHaveText('Review sent');
    await expect(page.locator('.report-preview')).toContainText('Sent via the button.');

    const { stdout, code } = await session.output;
    expect(code).toBe(0);
    expect(stdout).toContain('Sent via the button.');
  });

  test('the commented passage is highlighted', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    await page.locator('.composer textarea').first().fill('x');
    await page.locator('.composer').getByRole('button', { name: 'comment', exact: true }).click();
    await expect(page.locator('.comment-row')).toHaveCount(1);

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
    const composer = page.locator('.composer');
    await expect(composer).toBeVisible();
    await composer.locator('textarea').first().fill('unsaved thoughts');

    // Selecting a different passage without saving or cancelling first must not
    // silently discard the draft already in progress.
    await selectWord(page, 'Goals');

    await expect(composer).toBeVisible();
    await expect(composer.locator('textarea').first()).toHaveValue('unsaved thoughts');
  });

  test('clicking a passage activates its row; clicking elsewhere deactivates it without hiding the panel', async ({
    page,
  }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    await page.locator('.composer textarea').first().fill('open me');
    await page.locator('.composer').getByRole('button', { name: 'comment', exact: true }).click();
    const row = page.locator('.comment-row');
    await expect(row).toContainText('open me');
    await expect(row).toHaveClass(/active/);

    // Clicking off the passage deactivates the row, but it stays in the panel.
    await clickWord(page, 'Goals');
    await expect(row).not.toHaveClass(/active/);
    await expect(row).toBeVisible();

    await clickWord(page, 'consectetur');
    await expect(row).toHaveClass(/active/);
  });

  test('clicking empty space below the document clears the active row', async ({ page }) => {
    session = await startReview();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    await page.locator('.composer textarea').first().fill('close me');
    await page.locator('.composer').getByRole('button', { name: 'comment', exact: true }).click();
    const row = page.locator('.comment-row');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveClass(/active/);

    // Well below the last line, where there is no document left to click on.
    const doc = await page.locator('#doc').boundingBox();
    if (doc === null) throw new Error('no document');
    await page.mouse.click(doc.x + 40, doc.y + doc.height + 250);

    await expect(row).not.toHaveClass(/active/);
    await expect(row).toBeVisible();
  });

  test('clicking a different passage activates its row instead of the previous one', async ({
    page,
  }) => {
    session = await startReview();
    await page.goto(session.url);

    for (const [word, body] of [
      ['consectetur', 'first comment'],
      ['Goals', 'second comment'],
    ]) {
      await selectWord(page, word!);
      await page.locator('.composer textarea').first().fill(body!);
      await page.locator('.composer').getByRole('button', { name: 'comment', exact: true }).click();
      await expect(page.locator('.comment-row', { hasText: body! })).toHaveCount(1);
    }

    await clickWord(page, 'consectetur');
    await expect(page.locator('.comment-row.active')).toHaveCount(1);
    await expect(page.locator('.comment-row.active')).toContainText('first comment');

    await clickWord(page, 'Goals');
    await expect(page.locator('.comment-row.active')).toHaveCount(1);
    await expect(page.locator('.comment-row.active')).toContainText('second comment');

    await expect(page.locator('.comment-row')).toHaveCount(2);
  });

  test('the composer renders inside the panel and never overlaps the document', async ({
    page,
  }) => {
    session = await startReview();
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(session.url);

    await selectWord(page, 'consectetur');

    const composer = page.locator('.panel .composer');
    await expect(composer).toHaveCount(1);

    const composerBox = await composer.boundingBox();
    const scrollerBox = await page.locator('.doc-scroller').boundingBox();
    if (composerBox === null || scrollerBox === null) throw new Error('nothing to measure');

    expect(composerBox.x).toBeGreaterThanOrEqual(scrollerBox.x + scrollerBox.width - 1);
  });

  test('the finished review is saved beside the sidecar, as markdown only', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    await page.locator('.composer textarea').first().fill('saved to disk');
    await page.locator('.composer').getByRole('button', { name: 'comment', exact: true }).click();
    await expect(page.locator('.comment-row')).toHaveCount(1);

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
    await page.locator('.composer textarea').first().fill('never mind');
    await page.locator('.composer').getByRole('button', { name: 'comment', exact: true }).click();
    await expect(page.locator('.comment-row')).toHaveCount(1);

    await page.locator('.comment-row').getByRole('button', { name: 'delete' }).click();
    await expect(page.locator('.comment-row')).toHaveCount(0);

    await page.close();
    const { stdout } = await session.output;
    expect(stdout).toContain('No open comments');
  });

  test('a reload does not end the review', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    await page.locator('.composer textarea').first().fill('survives a reload');
    await page.locator('.composer').getByRole('button', { name: 'comment', exact: true }).click();
    await expect(page.locator('.comment-row')).toHaveCount(1);

    await page.reload();

    // Still alive, and the comment came back from the server — reopen it to see.
    await clickWord(page, 'consectetur');
    await expect(page.locator('.comment-row')).toContainText('survives a reload');
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
    await page.locator('.composer textarea').first().fill('name them');
    await page.locator('.composer').getByRole('button', { name: 'comment', exact: true }).click();
    await expect(page.locator('.comment-row')).toHaveCount(1);
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
      await expect(next.locator('.panel-toggle')).toContainText('Comments (0)');
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

    const composer = page.locator('.composer');
    await expect(composer).toBeVisible();
  });

  test('the sent screen shows the exact generated report', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    await page.locator('.composer textarea').first().fill('Spot check the report body.');
    await page.locator('.composer').getByRole('button', { name: 'comment', exact: true }).click();

    await page.locator('.panel-header .send').click();
    await expect(page.locator('.sent h1')).toHaveText('Review sent');

    const preview = page.locator('.report-preview');
    await expect(preview).toContainText('# Review of draft.md');
    await expect(preview).toContainText('1 open comment');
    await expect(preview).toContainText('Spot check the report body.');
    await expect(preview).toContainText('> consectetur');
  });

  test('the Rewrite placeholder quotes a multi-word selection', async ({ page }) => {
    session = await startReview();
    await page.goto(session.url);

    await dragBoundary(page, 'serves', 'users');
    const composer = page.locator('.composer');
    await composer.getByRole('button', { name: 'Rewrite' }).click();

    await expect(composer.locator('textarea')).toHaveAttribute(
      'placeholder',
      'Replace "serves consectetur users" with…',
    );
  });

  test('the composer textarea has an accessible label in both Note and Rewrite mode', async ({
    page,
  }) => {
    session = await startReview();
    await page.goto(session.url);

    await selectWord(page, 'consectetur');
    const composer = page.locator('.composer');
    await expect(composer.getByLabel('Comment')).toBeVisible();

    await composer.getByRole('button', { name: 'Rewrite' }).click();
    await expect(composer.getByLabel('Replacement text')).toBeVisible();
  });

  test('the panel toggle opens and closes the panel below the breakpoint', async ({ page }) => {
    session = await startReview();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto(session.url);
    await page.locator('#doc [data-pos]').first().waitFor();

    const panel = page.locator('.panel');
    await expect(panel).toHaveAttribute('data-open', 'false');

    await page.locator('.panel-toggle').click();
    await expect(panel).toHaveAttribute('data-open', 'true');

    await page.locator('.panel-toggle').click();
    await expect(panel).toHaveAttribute('data-open', 'false');

    // Selecting text also reveals the panel, so the composer is reachable.
    await selectWord(page, 'consectetur');
    await expect(panel).toHaveAttribute('data-open', 'true');
  });
});
