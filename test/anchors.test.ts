import { describe, it, expect } from 'vitest';
import { buildAnchor, offsetToLine, reanchor, type Comment } from '../src/anchors.ts';

const DOC = [
  '# Overview', // line 1
  '', // 2
  'The system serves the actual users of this thing.', // 3
  '', // 4
  '## Goals', // 5
  '', // 6
  'We should probably measure this.', // 7
].join('\n');

/** A comment on `needle`'s first occurrence in `source`. */
function commentOn(source: string, needle: string, overrides: Partial<Comment> = {}): Comment {
  const start = source.indexOf(needle);
  if (start === -1) throw new Error(`test setup: ${needle} not in source`);
  return {
    id: overrides.id ?? 'c1',
    body: overrides.body ?? 'needs work',
    createdAt: '2026-08-13T00:00:00.000Z',
    status: 'open',
    anchor: buildAnchor(source, start, start + needle.length, needle),
    ...overrides,
  };
}

describe('offsetToLine', () => {
  it('is 1-based and counts newlines', () => {
    expect(offsetToLine(DOC, 0)).toBe(1);
    expect(offsetToLine(DOC, DOC.indexOf('The system'))).toBe(3);
    expect(offsetToLine(DOC, DOC.indexOf('We should'))).toBe(7);
  });

  it('clamps out-of-range offsets', () => {
    expect(offsetToLine(DOC, -5)).toBe(1);
    expect(offsetToLine(DOC, DOC.length + 100)).toBe(7);
  });
});

describe('buildAnchor', () => {
  it('captures source text, lines and surrounding context', () => {
    const needle = 'the actual users';
    const start = DOC.indexOf(needle);
    const anchor = buildAnchor(DOC, start, start + needle.length, needle);

    expect(anchor.sourceText).toBe(needle);
    expect(anchor.quote).toBe(needle);
    expect(anchor.startLine).toBe(3);
    expect(anchor.endLine).toBe(3);
    expect(anchor.approx).toBe(false);
    expect(DOC.slice(anchor.startOffset, anchor.endOffset)).toBe(needle);
    expect(anchor.prefix.endsWith('The system serves ')).toBe(true);
    expect(anchor.suffix.startsWith(' of this thing.')).toBe(true);
  });

  it('records a distinct rendered quote when it differs from source', () => {
    const src = 'Text with `inline code` here.\n';
    const start = src.indexOf('inline code');
    const anchor = buildAnchor(src, start, start + 'inline code'.length, 'inline code', true);

    expect(anchor.sourceText).toBe('inline code');
    expect(anchor.approx).toBe(true);
  });

  it('spans multiple lines when the selection does', () => {
    const src = 'one two\nthree four\nfive\n';
    const anchor = buildAnchor(src, src.indexOf('two'), src.indexOf('four') + 4, 'two\nthree four');

    expect(anchor.startLine).toBe(1);
    expect(anchor.endLine).toBe(2);
  });
});

describe('reanchor', () => {
  it('keeps a comment open and unmoved when the document is unchanged', () => {
    const comment = commentOn(DOC, 'the actual users');
    const { open, resolved } = reanchor([comment], DOC);

    expect(resolved).toHaveLength(0);
    expect(open).toHaveLength(1);
    expect(open[0]!.anchor.startOffset).toBe(comment.anchor.startOffset);
    expect(open[0]!.status).toBe('open');
  });

  it('shifts offsets and lines when text above it grows', () => {
    const comment = commentOn(DOC, 'the actual users');
    const grown = DOC.replace('# Overview\n', '# Overview\n\nA new opening paragraph.\n');

    const { open } = reanchor([comment], grown);

    expect(open).toHaveLength(1);
    const anchor = open[0]!.anchor;
    expect(grown.slice(anchor.startOffset, anchor.endOffset)).toBe('the actual users');
    expect(anchor.startOffset).toBeGreaterThan(comment.anchor.startOffset);
    expect(anchor.startLine).toBe(5);
  });

  it('resolves a comment once the agent rewrites the anchored text', () => {
    const comment = commentOn(DOC, 'the actual users');
    const rewritten = DOC.replace('the actual users', 'data engineers at Acme');

    const { open, resolved } = reanchor([comment], rewritten);

    expect(open).toHaveLength(0);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.status).toBe('resolved');
    expect(resolved[0]!.resolvedBy).toBe('text-changed');
    expect(resolved[0]!.resolvedAt).toBeTruthy();
  });

  it('resolves a comment when its whole section is deleted', () => {
    const comment = commentOn(DOC, 'We should probably measure this.');
    const trimmed = DOC.slice(0, DOC.indexOf('## Goals'));

    const { open, resolved } = reanchor([comment], trimmed);

    expect(open).toHaveLength(0);
    expect(resolved[0]!.resolvedBy).toBe('text-changed');
  });

  it('uses surrounding context to pick between duplicate occurrences', () => {
    const src = [
      '## Section A',
      '',
      'the target text',
      '',
      '## Section B',
      '',
      'the target text',
    ].join('\n');
    // Comment on the SECOND occurrence.
    const second = src.lastIndexOf('the target text');
    const comment: Comment = {
      id: 'c1',
      body: 'this one',
      createdAt: '2026-08-13T00:00:00.000Z',
      status: 'open',
      anchor: buildAnchor(src, second, second + 'the target text'.length, 'the target text'),
    };

    // Grow the document above both occurrences; both still exist.
    const grown = `# Title\n\nIntro paragraph added later.\n\n${src}`;
    const { open } = reanchor([comment], grown);

    expect(open).toHaveLength(1);
    expect(open[0]!.anchor.startOffset).toBe(grown.lastIndexOf('the target text'));
  });

  it('falls back to the original occurrence index when context gives no signal', () => {
    const src = 'alpha\n\ntarget\n\nbeta\n\ntarget\n';
    const first = src.indexOf('target');
    const comment: Comment = {
      id: 'c1',
      body: 'x',
      createdAt: '2026-08-13T00:00:00.000Z',
      status: 'open',
      anchor: buildAnchor(src, first, first + 6, 'target'),
    };
    // Surroundings share nothing with the original, so both candidates score zero and
    // only "it was the first occurrence" can decide.
    const changed = 'QQQtargetZZZQQQtargetZZZ';

    const { open } = reanchor([comment], changed);

    expect(open).toHaveLength(1);
    expect(open[0]!.anchor.startOffset).toBe(changed.indexOf('target'));
    expect(open[0]!.anchor.occurrence).toBe(0);
  });

  it('lets surrounding context override the original occurrence index', () => {
    const src = 'alpha\n\ntarget\n\nbeta\n\ntarget\n';
    const first = src.indexOf('target');
    const comment: Comment = {
      id: 'c1',
      body: 'x',
      createdAt: '2026-08-13T00:00:00.000Z',
      status: 'open',
      anchor: buildAnchor(src, first, first + 6, 'target'),
    };
    // The comment was on occurrence 0, but here occurrence 1 is the better contextual
    // match (its trailing newline lines up), and context is the stronger signal.
    const changed = 'target\n\ntarget\n';

    const { open } = reanchor([comment], changed);

    expect(open[0]!.anchor.startOffset).toBe(changed.lastIndexOf('target'));
  });

  it('leaves already-resolved comments resolved without re-searching', () => {
    const comment = commentOn(DOC, 'the actual users', {
      status: 'resolved',
      resolvedBy: 'text-changed',
      resolvedAt: '2026-08-12T00:00:00.000Z',
    });

    const { open, resolved } = reanchor([comment], DOC);

    expect(open).toHaveLength(0);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.resolvedAt).toBe('2026-08-12T00:00:00.000Z');
  });

  it('reports only this round’s auto-resolutions as newly resolved', () => {
    const earlier = commentOn(DOC, 'the actual users', {
      id: 'earlier',
      status: 'resolved',
      resolvedBy: 'text-changed',
      resolvedAt: '2026-08-01T00:00:00.000Z',
    });
    const justAddressed = commentOn(DOC, 'We should probably measure this.', { id: 'just' });
    const next = DOC.replace('We should probably measure this.', 'Track p95 latency weekly.');

    const { resolved, newlyResolved } = reanchor([earlier, justAddressed], next);

    // Both stay resolved, so neither comes back as open next round…
    expect(resolved.map((c) => c.id)).toEqual(['earlier', 'just']);
    // …but only one of them was addressed since the agent last asked.
    expect(newlyResolved.map((c) => c.id)).toEqual(['just']);
  });

  it('partitions a mixed batch', () => {
    const kept = commentOn(DOC, 'the actual users', { id: 'kept' });
    const addressed = commentOn(DOC, 'We should probably measure this.', { id: 'addressed' });
    const next = DOC.replace('We should probably measure this.', 'Track p95 latency weekly.');

    const { open, resolved } = reanchor([kept, addressed], next);

    expect(open.map((c) => c.id)).toEqual(['kept']);
    expect(resolved.map((c) => c.id)).toEqual(['addressed']);
  });

  it('resolves an anchor whose source text is empty rather than matching everything', () => {
    const comment: Comment = {
      id: 'c1',
      body: 'x',
      createdAt: '2026-08-13T00:00:00.000Z',
      status: 'open',
      anchor: { ...buildAnchor(DOC, 0, 0, ''), sourceText: '' },
    };

    const { open, resolved } = reanchor([comment], DOC);

    expect(open).toHaveLength(0);
    expect(resolved).toHaveLength(1);
  });

  it('preserves the comment body and suggestion across rounds', () => {
    const comment = commentOn(DOC, 'the actual users', {
      body: 'name them',
      suggestion: 'data engineers at Acme',
    });

    const { open } = reanchor([comment], `# Added\n\n${DOC}`);

    expect(open[0]!.body).toBe('name them');
    expect(open[0]!.suggestion).toBe('data engineers at Acme');
  });
});
