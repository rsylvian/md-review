import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Installs the bundled Claude Code skill and returns where it landed. */
export function installSkill(packageRoot: string, home: string = homedir()): string {
  const targetDir = join(home, '.claude', 'skills', 'md-review');
  mkdirSync(targetDir, { recursive: true });

  const target = join(targetDir, 'SKILL.md');
  copyFileSync(join(packageRoot, 'skill', 'SKILL.md'), target);
  return target;
}
