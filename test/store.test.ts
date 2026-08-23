import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadReview, saveReview, sidecarPathFor } from '../src/store.ts';
import { makeComment } from './helpers/comments.ts';

const DOC = 'A line of prose worth commenting on.\n';

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'md-review-store-'));
  home = mkdtempSync(join(tmpdir(), 'md-review-home-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('sidecarPathFor', () => {
  it('puts a top-level file at ~/.cache/md-review/<slug>-<hash>.json', () => {
    const path = sidecarPathFor('draft.md', root, home);
    expect(path.startsWith(join(home, '.cache', 'md-review'))).toBe(true);
    expect(path).toContain('draft-');
    expect(path).toMatch(/-[0-9a-f]{8}\.json$/);
  });

  it('folds the whole path into the slug, so nested files stay distinguishable', () => {
    const path = sidecarPathFor('docs/specs/plan.md', root, home);
    expect(path).toContain('docs-specs-plan-');
    expect(path.endsWith('.json')).toBe(true);
  });

  it('slugifies characters that are awkward in filenames', () => {
    const path = sidecarPathFor('My Draft (v2).md', root, home);
    expect(path).toContain('my-draft-v2-');
    expect(path.endsWith('.json')).toBe(true);
  });

  it('keeps files outside the root addressable', () => {
    const path = sidecarPathFor('../sibling/notes.md', root, home);
    expect(path.startsWith(join(home, '.cache', 'md-review'))).toBe(true);
    expect(path.endsWith('.json')).toBe(true);
  });

  it('lives outside the reviewed project entirely', () => {
    const path = sidecarPathFor('draft.md', root, home);
    expect(path.startsWith(root)).toBe(false);
  });

  it('is stable for the same relative path', () => {
    expect(sidecarPathFor('draft.md', root, home)).toBe(sidecarPathFor('draft.md', root, home));
  });

  it('never collides two different relative paths that slugify the same', () => {
    const a = sidecarPathFor('docs/specs/plan.md', root, home);
    const b = sidecarPathFor('docs-specs-plan.md', root, home);
    expect(a).not.toBe(b);
  });

  it('never collides files that differ only by separator character', () => {
    const a = sidecarPathFor('my_draft.md', root, home);
    const b = sidecarPathFor('my-draft.md', root, home);
    expect(a).not.toBe(b);
  });

  it('never collides the same relative path reviewed from two different projects', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'md-review-store-'));
    try {
      const a = sidecarPathFor('draft.md', root, home);
      const b = sidecarPathFor('draft.md', otherRoot, home);
      expect(a).not.toBe(b);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

describe('saveReview / loadReview', () => {
  it('round-trips comments', () => {
    const path = sidecarPathFor('draft.md', root, home);
    const comment = makeComment(DOC, 'line of prose', { suggestion: 'sentence of prose' });

    saveReview(path, { file: 'draft.md', comments: [comment], updatedAt: 'now' });
    const loaded = loadReview(path);

    expect(loaded).not.toBeNull();
    expect(loaded!.comments).toHaveLength(1);
    expect(loaded!.comments[0]).toEqual(comment);
    expect(loaded!.file).toBe('draft.md');
  });

  it('creates the sidecar directory on demand', () => {
    const path = sidecarPathFor('draft.md', root, home);
    expect(existsSync(dirname(path))).toBe(false);

    saveReview(path, { file: 'draft.md', comments: [], updatedAt: 'now' });

    expect(existsSync(path)).toBe(true);
  });

  it('returns null when no prior review exists', () => {
    expect(loadReview(sidecarPathFor('never-reviewed.md', root, home))).toBeNull();
  });

  it('returns null rather than throwing on corrupt JSON', () => {
    const path = sidecarPathFor('draft.md', root, home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ this is not json');

    expect(loadReview(path)).toBeNull();
  });

  it('returns null when the JSON has the wrong shape', () => {
    const path = sidecarPathFor('draft.md', root, home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ comments: 'not an array' }));

    expect(loadReview(path)).toBeNull();
  });

  it('drops individual comments that are malformed', () => {
    const path = sidecarPathFor('draft.md', root, home);
    const good = makeComment(DOC, 'line of prose', { id: 'good' });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        file: 'draft.md',
        updatedAt: 'now',
        comments: [good, { id: 'bad', body: 'no anchor at all' }],
      }),
    );

    const loaded = loadReview(path);

    expect(loaded!.comments.map((c) => c.id)).toEqual(['good']);
  });

  it('overwrites a previous save rather than appending', () => {
    const path = sidecarPathFor('draft.md', root, home);
    saveReview(path, {
      file: 'draft.md',
      comments: [makeComment(DOC, 'line of prose', { id: 'first' })],
      updatedAt: 'a',
    });
    saveReview(path, {
      file: 'draft.md',
      comments: [makeComment(DOC, 'prose worth', { id: 'second' })],
      updatedAt: 'b',
    });

    expect(loadReview(path)!.comments.map((c) => c.id)).toEqual(['second']);
  });
});
