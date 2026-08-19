import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkill } from '../src/skill.ts';

const PACKAGE_ROOT = join(import.meta.dirname, '..');

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'md-review-home-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('installSkill', () => {
  it('writes the skill where Claude Code looks for it', () => {
    const target = installSkill(PACKAGE_ROOT, home);

    expect(target).toBe(join(home, '.claude', 'skills', 'md-review', 'SKILL.md'));
    expect(existsSync(target)).toBe(true);
  });

  it('installs a skill with the frontmatter Claude Code needs', () => {
    const contents = readFileSync(installSkill(PACKAGE_ROOT, home), 'utf8');

    expect(contents.startsWith('---\n')).toBe(true);
    expect(contents).toMatch(/^name: md-review$/m);
    expect(contents).toMatch(/^description: .+/m);
    // The instruction the whole handoff depends on.
    expect(contents).toContain('run_in_background: true');
  });

  it('is idempotent', () => {
    const first = installSkill(PACKAGE_ROOT, home);
    const second = installSkill(PACKAGE_ROOT, home);

    expect(second).toBe(first);
    expect(readFileSync(second, 'utf8').length).toBeGreaterThan(0);
  });
});
