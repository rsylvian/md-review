import { describe, it, expect } from 'vitest';
import { passageAtPoint } from '../client/popover.js';

const rect = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

describe('passageAtPoint', () => {
  it('finds the passage the point lands in', () => {
    const passages = [
      { id: 'a', rects: [rect(0, 0, 100, 20)] },
      { id: 'b', rects: [rect(0, 40, 100, 60)] },
    ];

    expect(passageAtPoint(passages, { x: 50, y: 50 })).toBe('b');
  });

  it('returns null when the point misses every passage', () => {
    const passages = [{ id: 'a', rects: [rect(0, 0, 100, 20)] }];

    expect(passageAtPoint(passages, { x: 50, y: 200 })).toBe(null);
  });

  it('picks the smaller passage where two overlap', () => {
    const passages = [
      { id: 'sentence', rects: [rect(0, 0, 400, 20)] },
      { id: 'word', rects: [rect(30, 0, 70, 20)] },
    ];

    expect(passageAtPoint(passages, { x: 50, y: 10 })).toBe('word');
  });

  it('breaks a tie between pixel-identical rects by the whole passage footprint', () => {
    // A whole-sentence comment split around an escape/entity token can contribute a
    // rect that exactly matches a separate, narrower comment's own rect. Comparing
    // only the clicked rect would tie and fall back to array order; comparing each
    // passage's full footprint picks the genuinely more specific one.
    const passages = [
      {
        id: 'sentence',
        rects: [
          rect(0, 0, 50, 20),
          rect(50, 0, 60, 20),
          rect(60, 0, 100, 20),
          rect(100, 0, 110, 20),
          rect(110, 0, 160, 20),
        ],
      },
      { id: 'word', rects: [rect(60, 0, 100, 20)] },
    ];

    expect(passageAtPoint(passages, { x: 80, y: 10 })).toBe('word');
  });

  it('hits a passage on any of the lines it wraps across', () => {
    const passages = [{ id: 'a', rects: [rect(200, 0, 400, 20), rect(0, 20, 150, 40)] }];

    expect(passageAtPoint(passages, { x: 100, y: 30 })).toBe('a');
  });

  it('treats the rect edges as inside', () => {
    const passages = [{ id: 'a', rects: [rect(10, 10, 20, 20)] }];

    expect(passageAtPoint(passages, { x: 10, y: 20 })).toBe('a');
  });

  it('handles an empty set', () => {
    expect(passageAtPoint([], { x: 0, y: 0 })).toBe(null);
  });
});
