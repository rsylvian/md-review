import { buildAnchor, type Comment } from '../../src/anchors.ts';

/** Builds a comment anchored on `needle`'s first occurrence in `source`. */
export function makeComment(
  source: string,
  needle: string,
  overrides: Partial<Comment> = {},
): Comment {
  const start = source.indexOf(needle);
  if (start === -1) throw new Error(`test setup: ${JSON.stringify(needle)} not in source`);
  return {
    id: 'c1',
    body: 'needs work',
    createdAt: '2026-08-13T00:00:00.000Z',
    status: 'open',
    anchor: buildAnchor(source, start, start + needle.length, needle),
    ...overrides,
  };
}
