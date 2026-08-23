import { describe, it, expect } from 'vitest';
import { passageAtPoint, placeCard, unionRect } from '../client/popover.js';

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

describe('unionRect', () => {
  it('covers every line of a wrapped passage', () => {
    const union = unionRect([rect(200, 0, 400, 20), rect(0, 20, 150, 40)]);

    expect(union).toEqual(rect(0, 0, 400, 40));
  });

  it('returns a single rect unchanged', () => {
    expect(unionRect([rect(5, 6, 7, 8)])).toEqual(rect(5, 6, 7, 8));
  });
});

describe('placeCard', () => {
  const GAP = 8;

  it('sits just below the passage, aligned with its left edge', () => {
    const top = placeCard(rect(120, 40, 300, 60), 320, 768, GAP);

    expect(top).toEqual({ top: 68, left: 120 });
  });

  it('pulls the card back inside the column when the passage ends near the right edge', () => {
    const placed = placeCard(rect(600, 0, 760, 20), 320, 768, GAP);

    expect(placed.left).toBe(448);
  });

  it('never pushes the card past the left edge of the column', () => {
    const placed = placeCard(rect(10, 0, 60, 20), 900, 768, GAP);

    expect(placed.left).toBe(0);
  });
});
