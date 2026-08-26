/**
 * Popover geometry: which commented passage a click landed in.
 *
 * Highlights are painted with the CSS Custom Highlight API, so there is no element per
 * passage to hang a click handler on — the passage under the pointer has to be found by
 * hit-testing measured rects. Kept free of the DOM so the arithmetic can be tested; the
 * measuring lives in highlight.js.
 *
 * Every coordinate here is relative to the document column, the box the card is
 * positioned inside.
 */

/**
 * @typedef {object} Rect
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/** @param {Rect} rect */
function area(rect) {
  return (rect.right - rect.left) * (rect.bottom - rect.top);
}

/** @param {Rect} rect @param {{x: number, y: number}} point */
function contains(rect, point) {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

/**
 * The passage a point lands in, or null.
 *
 * Where passages overlap — a commented word inside a commented sentence — the smaller one
 * wins, since it is the more specific thing to have aimed at. Compared by each passage's
 * whole footprint (every rect it has, not just the one under the pointer): two different
 * passages can otherwise contribute a pixel-identical individual rect — e.g. a
 * whole-sentence comment split into several spans around an escape, one of which exactly
 * covers a separate, narrower comment's own single rect — and comparing only that one
 * rect would leave the tie to whichever passage happened to be checked first.
 *
 * @param {readonly {id: string, rects: readonly Rect[]}[]} passages
 * @param {{x: number, y: number}} point
 * @returns {string | null}
 */
export function passageAtPoint(passages, point) {
  let best = null;
  let bestArea = Infinity;

  for (const passage of passages) {
    if (!passage.rects.some((rect) => contains(rect, point))) continue;
    const size = passage.rects.reduce((sum, rect) => sum + area(rect), 0);
    if (size < bestArea) {
      best = passage.id;
      bestArea = size;
    }
  }

  return best;
}
