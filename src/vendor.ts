import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

/**
 * Locates files inside installed packages that their `exports` map does not expose.
 *
 * The client runs without a bundler, so it needs a real URL for htm/preact's
 * self-contained ESM build. That path is not exported, so resolving the package's main
 * entry and walking up to its root is the only way to reach it.
 */

const require = createRequire(import.meta.url);

/** The root directory of an installed package, found from any file inside it. */
function packageRoot(startFile: string, name: string): string | null {
  let dir = dirname(startFile);
  const { root } = parse(dir);

  while (true) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as { name?: unknown }).name === name
        ) {
          return dir;
        }
      } catch {
        // Unreadable manifest; keep walking.
      }
    }
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

/** Absolute path to a file inside an installed package. Throws if it cannot be found. */
export function resolvePackageFile(name: string, relativePath: string): string {
  const entry = require.resolve(name);
  const root = packageRoot(entry, name);
  if (root === null) throw new Error(`could not locate the root of package "${name}"`);

  const target = join(root, relativePath);
  if (!existsSync(target)) {
    throw new Error(`"${name}" does not contain ${relativePath}`);
  }
  return target;
}

/**
 * The single JavaScript file the review page loads: htm bound to Preact, with hooks,
 * bundled and dependency-free so no import map or build step is needed.
 */
export function resolveClientRuntime(): string {
  return resolvePackageFile('htm', join('preact', 'standalone.module.js'));
}
