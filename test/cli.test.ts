import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readTarget, openBrowser, note, buildProgram, review, printStat } from '../src/cli.ts';
import { sidecarPathFor, saveReview } from '../src/store.ts';
import { makeComment } from './helpers/comments.ts';

// Module-level mock for node:child_process — vi.mock is always hoisted.
const spawnMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'md-review-cli-'));
  spawnMock.mockReset();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// readTarget
// ---------------------------------------------------------------------------

describe('readTarget', () => {
  it('reads a markdown file and returns its source, absolute path, and mtime', () => {
    const file = join(root, 'doc.md');
    writeFileSync(file, '# Hello\n', 'utf8');

    const result = readTarget(file);

    expect(result.absolute).toBe(resolve(file));
    expect(result.source).toBe('# Hello\n');
    expect(result.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('throws for a file that does not exist', () => {
    expect(() => readTarget(join(root, 'nope.md'))).toThrow(/no such file/);
  });

  it('throws when the path is a directory, not a file', () => {
    const dir = join(root, 'subdir');
    mkdirSync(dir);

    expect(() => readTarget(dir)).toThrow(/not a file/);
  });

  it('resolves a relative path against cwd', () => {
    const file = join(root, 'relative.md');
    writeFileSync(file, 'content', 'utf8');

    // Temporarily override cwd so the relative lookup lands inside our temp dir.
    const originalCwd = process.cwd;
    process.cwd = () => root;
    try {
      const result = readTarget('relative.md');
      expect(result.absolute).toBe(resolve(root, 'relative.md'));
      expect(result.source).toBe('content');
    } finally {
      process.cwd = originalCwd;
    }
  });
});

// ---------------------------------------------------------------------------
// note
// ---------------------------------------------------------------------------

describe('note', () => {
  it('writes to stderr with a trailing newline', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    note('hello');

    expect(spy).toHaveBeenCalledWith('hello\n');
  });
});

// ---------------------------------------------------------------------------
// openBrowser
// ---------------------------------------------------------------------------

describe('openBrowser', () => {
  it('spawns "open" on macOS (darwin)', () => {
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() });

    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      openBrowser('http://localhost:5710');

      expect(spawnMock).toHaveBeenCalledWith(
        'open',
        ['http://localhost:5710'],
        expect.objectContaining({ stdio: 'ignore', detached: true, shell: false }),
      );
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('spawns "start" with shell on Windows', () => {
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() });

    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      openBrowser('http://localhost:5710');

      expect(spawnMock).toHaveBeenCalledWith(
        'start',
        ['http://localhost:5710'],
        expect.objectContaining({ shell: true }),
      );
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('spawns "xdg-open" on Linux', () => {
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() });

    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      openBrowser('http://localhost:5710');

      expect(spawnMock).toHaveBeenCalledWith(
        'xdg-open',
        ['http://localhost:5710'],
        expect.objectContaining({ stdio: 'ignore', detached: true }),
      );
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('falls back to a stderr message when spawn throws', () => {
    spawnMock.mockImplementation(() => {
      throw new Error('no browser');
    });

    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    // Should not throw — the error is caught internally.
    openBrowser('http://localhost:5710');

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Could not open a browser'));
  });

  it('calls unref() on the spawned child so the CLI can exit', () => {
    const unrefMock = vi.fn();
    spawnMock.mockReturnValue({ on: vi.fn(), unref: unrefMock });

    openBrowser('http://localhost:5710');

    expect(unrefMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// review & signal handling
// ---------------------------------------------------------------------------

describe('review', () => {
  it('runs review server, handles tab-closed reason, writes report and sidecar', async () => {
    const file = join(root, 'review-doc.md');
    writeFileSync(file, '# Title\nSome content', 'utf8');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const reviewPromise = review(file, {
      port: '0',
      open: false,
      grace: '50',
    });

    // Extract the port / connect to finalize
    // Since review started a server, fetch and finalize it
    // Wait briefly for server to be up
    await new Promise((r) => setTimeout(r, 50));
    const urlMatch = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('http://'));
    expect(urlMatch).toBeDefined();
    const url = urlMatch!.match(/http:\/\/[^\s]+/)?.[0];
    expect(url).toBeDefined();

    const res = await fetch(`${url}/api/finalize`, { method: 'POST' });
    expect(res.status).toBe(200);

    await reviewPromise;

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('# Review of'));
    const sidecar = sidecarPathFor(file);
    const reportSidecar = `${sidecar.replace(/\.json$/, '')}.review.md`;
    expect(existsSync(reportSidecar)).toBe(true);
    expect(readFileSync(reportSidecar, 'utf8')).toContain('# Review of');
  });

  it('handles signals (SIGINT/SIGTERM) to finalize', async () => {
    const file = join(root, 'sig-doc.md');
    writeFileSync(file, '# Signal Test', 'utf8');

    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const reviewPromise = review(file, {
      port: '0',
      open: false,
      grace: '1000',
    });

    await new Promise((r) => setTimeout(r, 50));
    process.emit('SIGINT');

    await reviewPromise;
  });
});

// ---------------------------------------------------------------------------
// printStat
// ---------------------------------------------------------------------------

describe('printStat', () => {
  // printStat resolves the sidecar path the same way production code does (real cache
  // home), so clean up whatever it writes there — read-only, so nothing should exist,
  // but this keeps the test honest if that ever changes.
  const cleanupSidecar = (file: string): void => {
    const sidecarPath = sidecarPathFor(file);
    rmSync(sidecarPath, { force: true });
    rmSync(`${sidecarPath.replace(/\.json$/, '')}.review.md`, { force: true });
  };

  it('prints 0 open, 0 resolved when there is no prior review', () => {
    const file = join(root, 'fresh.md');
    writeFileSync(file, '# Fresh\nNothing reviewed yet.\n', 'utf8');

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      printStat(file);
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('0 open, 0 resolved'));
    } finally {
      cleanupSidecar(file);
    }
  });

  it('counts open comments and re-anchors resolved ones against current content', () => {
    const file = join(root, 'stat-doc.md');
    const original = '# Title\n\nFirst passage.\n\nSecond passage.\n';
    writeFileSync(file, original, 'utf8');

    const sidecarPath = sidecarPathFor(file);
    const stillPresent = makeComment(original, 'First passage.', { id: 'c1' });
    const rewrittenAway = makeComment(original, 'Second passage.', { id: 'c2' });
    saveReview(sidecarPath, {
      file,
      comments: [stillPresent, rewrittenAway],
      updatedAt: '2026-08-13T00:00:00.000Z',
    });

    // The agent rewrote the second passage since the sidecar was last saved.
    writeFileSync(file, '# Title\n\nFirst passage.\n\nRewritten entirely.\n', 'utf8');

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      printStat(file);
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('1 open, 1 resolved'));
    } finally {
      cleanupSidecar(file);
    }
  });

  it('does not write back to the sidecar', () => {
    const file = join(root, 'readonly.md');
    const original = 'Only passage here.\n';
    writeFileSync(file, original, 'utf8');

    const sidecarPath = sidecarPathFor(file);
    const comment = makeComment(original, 'Only passage here.', { id: 'c1' });
    saveReview(sidecarPath, { file, comments: [comment], updatedAt: '2026-08-13T00:00:00.000Z' });

    writeFileSync(file, 'Totally different content now.\n', 'utf8');
    const before = readFileSync(sidecarPath, 'utf8');

    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      printStat(file);
      expect(readFileSync(sidecarPath, 'utf8')).toBe(before);
    } finally {
      cleanupSidecar(file);
    }
  });

  it('throws for a file that does not exist', () => {
    expect(() => printStat(join(root, 'nope.md'))).toThrow(/no such file/);
  });

  it('prints JSON when json is true', () => {
    const file = join(root, 'json-doc.md');
    const original = '# Title\n\nFirst passage.\n\nSecond passage.\n';
    writeFileSync(file, original, 'utf8');

    const sidecarPath = sidecarPathFor(file);
    const stillPresent = makeComment(original, 'First passage.', { id: 'c1' });
    saveReview(sidecarPath, {
      file,
      comments: [stillPresent],
      updatedAt: '2026-08-13T00:00:00.000Z',
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      printStat(file, true);
      expect(stdoutSpy).toHaveBeenCalledWith(
        `${JSON.stringify({ file, openCount: 1, resolvedCount: 0 })}\n`,
      );
    } finally {
      cleanupSidecar(file);
    }
  });
});

// ---------------------------------------------------------------------------
// buildProgram (option parsing and action handling)
// ---------------------------------------------------------------------------

describe('buildProgram', () => {
  it('parses --port, --no-open, and --grace', async () => {
    const program = buildProgram();
    let parsedFile: string | undefined;
    let parsedOpts: Record<string, unknown> | undefined;

    // Replace the action to capture parsed options without side effects.
    program.action((file: string | undefined, opts: Record<string, unknown>) => {
      parsedFile = file;
      parsedOpts = opts;
    });

    await program.parseAsync([
      'node',
      'md-review',
      '--port',
      '8080',
      '--no-open',
      '--grace',
      '3000',
      'test.md',
    ]);

    expect(parsedFile).toBe('test.md');
    expect(parsedOpts).toBeDefined();
    expect(parsedOpts!.port).toBe('8080');
    expect(parsedOpts!.open).toBe(false);
    expect(parsedOpts!.grace).toBe('3000');
  });

  it('uses default values when no flags are given', async () => {
    const program = buildProgram();
    let parsedOpts: Record<string, unknown> | undefined;

    program.action((_file: string | undefined, opts: Record<string, unknown>) => {
      parsedOpts = opts;
    });

    await program.parseAsync(['node', 'md-review', 'doc.md']);

    expect(parsedOpts).toBeDefined();
    expect(parsedOpts!.port).toBe('5710');
    expect(parsedOpts!.open).toBe(true);
    expect(parsedOpts!.grace).toBe('1500');
  });

  it('parses --stat', async () => {
    const program = buildProgram();
    let parsedOpts: Record<string, unknown> | undefined;

    program.action((_file: string | undefined, opts: Record<string, unknown>) => {
      parsedOpts = opts;
    });

    await program.parseAsync(['node', 'md-review', '--stat', 'doc.md']);

    expect(parsedOpts).toBeDefined();
    expect(parsedOpts!.stat).toBe(true);
  });

  it('runs printStat instead of review for --stat', async () => {
    const file = join(root, 'stat-action.md');
    writeFileSync(file, '# Doc\nSome content.\n', 'utf8');
    const sidecarPath = sidecarPathFor(file);

    const program = buildProgram();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      await program.parseAsync(['node', 'md-review', '--stat', file]);

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('0 open, 0 resolved'));
      // No server was started, so nothing was written to the sidecar.
      expect(existsSync(sidecarPath)).toBe(false);
    } finally {
      rmSync(sidecarPath, { force: true });
    }
  });

  it('passes --json through to printStat', async () => {
    const file = join(root, 'stat-json-action.md');
    writeFileSync(file, '# Doc\nSome content.\n', 'utf8');
    const sidecarPath = sidecarPathFor(file);

    const program = buildProgram();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      await program.parseAsync(['node', 'md-review', '--stat', '--json', file]);

      expect(stdoutSpy).toHaveBeenCalledWith(
        `${JSON.stringify({ file, openCount: 0, resolvedCount: 0 })}\n`,
      );
    } finally {
      rmSync(sidecarPath, { force: true });
    }
  });

  it('executes the real action for --install-skill', async () => {
    const program = buildProgram();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'md-review', '--install-skill']);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Installed the md-review skill to'),
    );
  });

  it('shows help when no file is provided', async () => {
    const program = buildProgram();
    program.exitOverride();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      await program.parseAsync(['node', 'md-review']);
    } catch (e) {
      expect((e as { code?: string }).code).toBe('commander.helpDisplayed');
    }
  });

  it('catches and formats errors during review', async () => {
    const program = buildProgram();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const initialExitCode = process.exitCode;

    await program.parseAsync(['node', 'md-review', join(root, 'nonexistent.md')]);

    expect(process.exitCode).toBe(1);
    process.exitCode = initialExitCode; // reset
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('md-review: no such file:'));
  });
});
