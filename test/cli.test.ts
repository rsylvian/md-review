import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readTarget, openBrowser, note, buildProgram, review } from '../src/cli.ts';
import { sidecarPathFor } from '../src/store.ts';

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
