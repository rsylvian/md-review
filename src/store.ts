import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Anchor, Comment } from './anchors.ts';

/**
 * The sidecar store: one JSON file per reviewed document, holding every comment ever
 * left on it. It is the source of truth — the server writes through on every mutation,
 * so closing the laptop lid mid-review loses nothing, and the next round can tell which
 * comments the agent has since addressed.
 */

export type StoredReview = {
  /** The reviewed file, as given on the command line. */
  file: string;
  comments: Comment[];
  updatedAt: string;
};

/** Directory name, relative to the review root, holding all sidecars. */
export const SIDECAR_DIR = '.md-review';

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/\.md$|\.markdown$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'review'
  );
}

/**
 * Where a target file's comments live. Nested paths are flattened into one slug, so
 * `docs/specs/plan.md` becomes `.md-review/docs-specs-plan.json` and cannot collide
 * with a `plan.md` elsewhere in the tree.
 */
export function sidecarPathFor(targetFile: string, root: string = process.cwd()): string {
  const absolute = isAbsolute(targetFile) ? targetFile : resolve(root, targetFile);
  const rel = relative(root, absolute);
  // A file outside the root ("../notes.md") still gets a stable name of its own.
  return join(root, SIDECAR_DIR, `${slugify(rel)}.json`);
}

function isAnchor(value: unknown): value is Anchor {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.startOffset === 'number' &&
    typeof a.endOffset === 'number' &&
    typeof a.sourceText === 'string'
  );
}

function isComment(value: unknown): value is Comment {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.body === 'string' &&
    (c.status === 'open' || c.status === 'resolved') &&
    isAnchor(c.anchor)
  );
}

/**
 * Reads a prior review. Returns null when there is none, when the file is unreadable,
 * or when its shape is unrecognisable — a damaged sidecar must never block a review.
 * Individual malformed comments are dropped rather than failing the whole load.
 */
export function loadReview(sidecarPath: string): StoredReview | null {
  let raw: string;
  try {
    raw = readFileSync(sidecarPath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.comments)) return null;

  return {
    file: typeof record.file === 'string' ? record.file : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    comments: record.comments.filter(isComment),
  };
}

/** Writes the review, creating the sidecar directory if needed. */
export function saveReview(sidecarPath: string, review: StoredReview): void {
  mkdirSync(dirname(sidecarPath), { recursive: true });
  writeFileSync(sidecarPath, `${JSON.stringify(review, null, 2)}\n`, 'utf8');
}
