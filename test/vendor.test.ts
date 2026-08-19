import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveClientRuntime, resolvePackageFile } from '../src/vendor.ts';

describe('resolveClientRuntime', () => {
  it('finds htm/preact’s self-contained build despite the exports map hiding it', () => {
    const path = resolveClientRuntime();

    expect(path.endsWith('standalone.module.js')).toBe(true);
    const contents = readFileSync(path, 'utf8');
    expect(contents).toContain('export{');
    // Self-contained: nothing for the browser to resolve.
    expect(contents).not.toMatch(/from\s*"preact"/);
  });
});

describe('resolvePackageFile', () => {
  it('throws a useful error for a file that is not there', () => {
    expect(() => resolvePackageFile('htm', 'nope/missing.js')).toThrow(/does not contain/);
  });

  it('throws for a package that is not installed', () => {
    expect(() => resolvePackageFile('definitely-not-installed-xyz', 'index.js')).toThrow();
  });
});
