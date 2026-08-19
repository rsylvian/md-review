import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The version this build declares, read from the manifest rather than baked in at compile
 * time so a global install and a linked clone always report what they actually are.
 */
export function readVersion(packageRoot: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const version =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { version?: unknown }).version
      : undefined;

  if (typeof version !== 'string') {
    throw new Error(`no version in ${join(packageRoot, 'package.json')}`);
  }
  return version;
}
