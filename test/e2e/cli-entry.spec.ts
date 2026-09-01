import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Regression test for the entry guard at the bottom of cli.ts. A global `npm i -g`
 * install makes the bin a symlink into lib/node_modules; Node canonicalizes symlinks
 * when it resolves import.meta.url for an ES module, but plain path resolution of
 * argv[1] does not, so the two sides of the guard's comparison silently stopped
 * matching through such a symlink — `md-review --help` printed nothing and exited 0.
 * Every other e2e spec spawns dist/cli.js by its real path, which never has a symlink
 * in it, so none of them would have caught this; this test adds one deliberately.
 */

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli.js');

function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (code) => resolvePromise({ stdout, stderr, code }));
  });
}

test.describe('cli entry guard', () => {
  test('parses argv and prints help when run through a symlink, as a global npm install does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'md-review-symlink-'));
    const link = join(dir, 'md-review');
    symlinkSync(CLI, link);

    try {
      const { stdout, code } = await run([link, '--help']);
      expect(code).toBe(0);
      expect(stdout).toContain('Review a markdown file in the browser');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
