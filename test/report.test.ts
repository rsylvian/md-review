import { describe, it, expect } from 'vitest';
import { formatReport, buildPayload } from '../src/report.ts';
import { makeComment } from './helpers/comments.ts';

const DOC = [
  '# Overview',
  '',
  'The system serves the actual users of this thing.',
  '',
  'We should probably measure this.',
].join('\n');

const AT = '2026-08-13T12:00:00.000Z';

describe('formatReport', () => {
  it('leads with the file and a count the agent can act on', () => {
    const report = formatReport({
      filePath: 'draft.md',
      open: [makeComment(DOC, 'the actual users', { body: 'name them' })],
      newlyResolved: [],
      generatedAt: AT,
    });

    expect(report).toContain('# Review of draft.md');
    expect(report).toContain('1 open comment');
  });

  it('renders each open comment with its lines, quote and body', () => {
    const report = formatReport({
      filePath: 'draft.md',
      open: [
        makeComment(DOC, 'the actual users', { id: 'a', body: 'name them' }),
        makeComment(DOC, 'We should probably measure this.', { id: 'b', body: 'be specific' }),
      ],
      newlyResolved: [],
      generatedAt: AT,
    });

    expect(report).toContain('## 1 — line 3');
    expect(report).toContain('> the actual users');
    expect(report).toContain('name them');
    expect(report).toContain('## 2 — line 5');
    expect(report).toContain('be specific');
  });

  it('renders a multi-line anchor as a line range', () => {
    const src = 'one\ntwo\nthree\n';
    const report = formatReport({
      filePath: 'draft.md',
      open: [makeComment(src, 'two\nthree', { body: 'x' })],
      newlyResolved: [],
      generatedAt: AT,
    });

    expect(report).toContain('lines 2–3');
  });

  it('renders a suggestion as an exact replace/with pair', () => {
    const report = formatReport({
      filePath: 'draft.md',
      open: [
        makeComment(DOC, 'We should probably measure this.', {
          body: 'be concrete',
          suggestion: 'Track p95 latency weekly.',
        }),
      ],
      newlyResolved: [],
      generatedAt: AT,
    });

    expect(report).toContain('suggested rewrite');
    expect(report).toMatch(/Replace:\n```\nWe should probably measure this\.\n```/);
    expect(report).toMatch(/With:\n```\nTrack p95 latency weekly\.\n```/);
  });

  it('lengthens the fence when the content contains backticks', () => {
    const src = 'Use ```js blocks``` for code.\n';
    const report = formatReport({
      filePath: 'draft.md',
      open: [
        makeComment(src, '```js blocks```', {
          body: 'x',
          suggestion: 'fenced blocks',
        }),
      ],
      newlyResolved: [],
      generatedAt: AT,
    });

    // A 3-backtick fence would be closed early by the content itself.
    expect(report).toContain('````\n```js blocks```\n````');
  });

  it('says plainly when there is nothing to do', () => {
    const report = formatReport({ filePath: 'draft.md', open: [], newlyResolved: [], generatedAt: AT });

    expect(report).toContain('No open comments');
    expect(report).not.toContain('## 1');
  });

  it('summarises what was resolved since last round without repeating the bodies', () => {
    const report = formatReport({
      filePath: 'draft.md',
      open: [makeComment(DOC, 'the actual users', { id: 'a', body: 'name them' })],
      newlyResolved: [
        makeComment(DOC, 'We should probably measure this.', {
          id: 'b',
          body: 'be specific',
          status: 'resolved',
          resolvedBy: 'text-changed',
        }),
      ],
      generatedAt: AT,
    });

    expect(report).toContain('1 open comment');
    expect(report).toContain('1 resolved');
    expect(report).toContain('Resolved since last round');
  });

  it('pluralises counts', () => {
    const two = formatReport({
      filePath: 'draft.md',
      open: [
        makeComment(DOC, 'the actual users', { id: 'a' }),
        makeComment(DOC, 'We should probably measure this.', { id: 'b' }),
      ],
      newlyResolved: [],
      generatedAt: AT,
    });

    expect(two).toContain('2 open comments');
  });

  it('does not pluralise "resolved" itself when several were resolved', () => {
    const report = formatReport({
      filePath: 'draft.md',
      open: [],
      newlyResolved: [
        makeComment(DOC, 'the actual users', {
          id: 'a',
          status: 'resolved',
          resolvedBy: 'text-changed',
        }),
        makeComment(DOC, 'We should probably measure this.', {
          id: 'b',
          status: 'resolved',
          resolvedBy: 'text-changed',
        }),
      ],
      generatedAt: AT,
    });

    expect(report).toContain('2 resolved since last round');
    expect(report).not.toContain('resolveds');
  });
});

describe('buildPayload', () => {
  it('exposes ids, anchors and suggestions for programmatic use', () => {
    const open = makeComment(DOC, 'the actual users', {
      id: 'a',
      body: 'name them',
      suggestion: 'data engineers',
    });
    const payload = buildPayload({
      filePath: 'draft.md',
      open: [open],
      newlyResolved: [],
      generatedAt: AT,
    });

    expect(payload.file).toBe('draft.md');
    expect(payload.generatedAt).toBe(AT);
    expect(payload.openCount).toBe(1);
    expect(payload.resolvedCount).toBe(0);
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]!.id).toBe('a');
    expect(payload.comments[0]!.suggestion).toBe('data engineers');
    expect(payload.comments[0]!.anchor.startLine).toBe(3);
    expect(payload.comments[0]!.status).toBe('open');
  });

  it('includes resolved comments so the agent can see what it already fixed', () => {
    const payload = buildPayload({
      filePath: 'draft.md',
      open: [],
      newlyResolved: [
        makeComment(DOC, 'the actual users', { id: 'r', status: 'resolved', resolvedBy: 'text-changed' }),
      ],
      generatedAt: AT,
    });

    expect(payload.openCount).toBe(0);
    expect(payload.resolvedCount).toBe(1);
    expect(payload.comments[0]!.status).toBe('resolved');
  });
});
