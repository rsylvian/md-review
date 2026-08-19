import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReview, saveReview, sidecarPathFor } from '../src/store.ts';
import { makeComment } from './helpers/comments.ts';

const DOC = 'A line of prose worth commenting on.\n';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'md-review-store-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('sidecarPathFor', () => {
  it('puts a top-level file at .md-review/<name>.json', () => {
    expect(sidecarPathFor('draft.md', root)).toBe(join(root, '.md-review', 'draft.json'));
  });

  it('flattens nested paths so directories cannot collide', () => {
    expect(sidecarPathFor('docs/specs/plan.md', root)).toBe(
      join(root, '.md-review', 'docs-specs-plan.json'),
    );
  });

  it('slugifies characters that are awkward in filenames', () => {
    expect(sidecarPathFor('My Draft (v2).md', root)).toBe(
      join(root, '.md-review', 'my-draft-v2.json'),
    );
  });

  it('keeps files outside the root addressable', () => {
    const path = sidecarPathFor('../sibling/notes.md', root);
    expect(path.startsWith(join(root, '.md-review'))).toBe(true);
    expect(path.endsWith('.json')).toBe(true);
  });
});

describe('saveReview / loadReview', () => {
  it('round-trips comments', () => {
    const path = sidecarPathFor('draft.md', root);
    const comment = makeComment(DOC, 'line of prose', { suggestion: 'sentence of prose' });

    saveReview(path, { file: 'draft.md', comments: [comment], updatedAt: 'now' });
    const loaded = loadReview(path);

    expect(loaded).not.toBeNull();
    expect(loaded!.comments).toHaveLength(1);
    expect(loaded!.comments[0]).toEqual(comment);
    expect(loaded!.file).toBe('draft.md');
  });

  it('creates the sidecar directory on demand', () => {
    const path = sidecarPathFor('draft.md', root);
    expect(existsSync(join(root, '.md-review'))).toBe(false);

    saveReview(path, { file: 'draft.md', comments: [], updatedAt: 'now' });

    expect(existsSync(path)).toBe(true);
  });

  it('returns null when no prior review exists', () => {
    expect(loadReview(sidecarPathFor('never-reviewed.md', root))).toBeNull();
  });

  it('returns null rather than throwing on corrupt JSON', () => {
    const path = sidecarPathFor('draft.md', root);
    mkdirSync(join(root, '.md-review'), { recursive: true });
    writeFileSync(path, '{ this is not json');

    expect(loadReview(path)).toBeNull();
  });

  it('returns null when the JSON has the wrong shape', () => {
    const path = sidecarPathFor('draft.md', root);
    mkdirSync(join(root, '.md-review'), { recursive: true });
    writeFileSync(path, JSON.stringify({ comments: 'not an array' }));

    expect(loadReview(path)).toBeNull();
  });

  it('drops individual comments that are malformed', () => {
    const path = sidecarPathFor('draft.md', root);
    const good = makeComment(DOC, 'line of prose', { id: 'good' });
    mkdirSync(join(root, '.md-review'), { recursive: true });
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
    const path = sidecarPathFor('draft.md', root);
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
