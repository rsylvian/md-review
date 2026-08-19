/**
 * Popover geometry: which commented passage a click landed in, and where its card goes.
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
 * wins, since it is the more specific thing to have aimed at.
 *
 * @param {readonly {id: string, rects: readonly Rect[]}[]} passages
 * @param {{x: number, y: number}} point
 * @returns {string | null}
 */
export function passageAtPoint(passages, point) {
  let best = null;
  let bestArea = Infinity;

  for (const passage of passages) {
    for (const rect of passage.rects) {
      if (!contains(rect, point)) continue;
      const size = area(rect);
      if (size < bestArea) {
        best = passage.id;
        bestArea = size;
      }
    }
  }

  return best;
}

/**
 * One box covering every line a passage wraps across, so the card can hang below the
 * whole thing rather than below whichever line happened to be clicked.
 *
 * @param {readonly Rect[]} rects
 * @returns {Rect}
 */
export function unionRect(rects) {
  return {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
}

/**
 * Where to put the card: below the passage, aligned with its left edge, pulled back when
 * that would hang it off the right of the column.
 *
 * Only the horizontal axis is clamped. Vertically the card extends the page, which the
 * bottom padding on `main` leaves room for — flipping it above the passage instead would
 * have to react to scrolling to stay right.
 *
 * @param {Rect} anchor the passage, as one box
 * @param {number} cardWidth
 * @param {number} columnWidth
 * @param {number} gap space between passage and card
 * @returns {{top: number, left: number}}
 */
export function placeCard(anchor, cardWidth, columnWidth, gap) {
  const overflow = Math.max(0, anchor.left + cardWidth - columnWidth);
  return {
    top: anchor.bottom + gap,
    left: Math.max(0, anchor.left - overflow),
  };
}
