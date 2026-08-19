import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVersion } from '../src/version.ts';

const PACKAGE_ROOT = join(import.meta.dirname, '..');

describe('readVersion', () => {
  it('reports the version the package declares', () => {
    const manifest: { version: string } = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    );

    expect(readVersion(PACKAGE_ROOT)).toBe(manifest.version);
  });

  it('reads a version from an arbitrary package root', () => {
    const root = mkdtempSync(join(tmpdir(), 'md-review-manifest-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8');

      expect(readVersion(root)).toBe('9.9.9');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A global install trims the tree to `files`, so a wrong PACKAGE_ROOT would surface here
  // rather than as a crash on someone else's machine.
  it('fails loudly when the manifest declares no version', () => {
    const root = mkdtempSync(join(tmpdir(), 'md-review-manifest-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'md-review' }), 'utf8');

      expect(() => readVersion(root)).toThrow(/version/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
