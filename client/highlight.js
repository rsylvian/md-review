import { rangesForSource } from './selection.js';

/**
 * Paints the commented passages.
 *
 * Uses the CSS Custom Highlight API, which colours arbitrary ranges without touching the
 * DOM — important here, because a comment can span element boundaries and wrapping it in
 * `<mark>` would mean surgery on the tree the offsets are measured against.
 *
 * Where the API is missing, the containing blocks get a class instead, so the reviewer
 * can still see which passages carry comments.
 */

const supported = typeof CSS !== 'undefined' && 'highlights' in CSS;

const NAMES = {
  comment: 'md-review-comment',
  active: 'md-review-active',
  activeApprox: 'md-review-active-approx',
};

/** @param {Element} root @param {number} start @param {number} end */
function blocksFor(root, start, end) {
  const blocks = new Set();
  for (const range of rangesForSource(root, start, end)) {
    const element = range.startContainer.parentElement;
    if (element !== null) blocks.add(element);
  }
  return blocks;
}

/**
 * @param {Element} root
 * @param {readonly {anchor: {startOffset: number, endOffset: number}}[]} comments
 * @param {{startOffset: number, endOffset: number} | null} active
 */
export function paintHighlights(root, comments, active) {
  if (!supported) {
    for (const element of root.querySelectorAll('.md-fallback-highlight')) {
      element.classList.remove('md-fallback-highlight');
    }
    for (const comment of comments) {
      for (const block of blocksFor(root, comment.anchor.startOffset, comment.anchor.endOffset)) {
        block.classList.add('md-fallback-highlight');
      }
    }
    return;
  }

  const commented = [];
  for (const comment of comments) {
    commented.push(...rangesForSource(root, comment.anchor.startOffset, comment.anchor.endOffset));
  }
  CSS.highlights.set(NAMES.comment, new Highlight(...commented));

  const activeRanges =
    active === null ? [] : rangesForSource(root, active.startOffset, active.endOffset);
  const isApprox = active !== null && active.approx;
  CSS.highlights.set(isApprox ? NAMES.activeApprox : NAMES.active, new Highlight(...activeRanges));
  CSS.highlights.set(isApprox ? NAMES.active : NAMES.activeApprox, new Highlight());
}

/**
 * Where a passage sits in the column: one rect per line it wraps across, relative to
 * `root`. Feeds both hit-testing a click and placing the card — see popover.js.
 *
 * @param {Element} root
 * @param {{startOffset: number, endOffset: number}} anchor
 * @returns {{left: number, top: number, right: number, bottom: number}[]}
 */
export function anchorRects(root, anchor) {
  const origin = root.getBoundingClientRect();
  const rects = [];

  for (const range of rangesForSource(root, anchor.startOffset, anchor.endOffset)) {
    for (const rect of range.getClientRects()) {
      // Collapsed rects turn up at line breaks and would hit-test as a point.
      if (rect.width === 0 || rect.height === 0) continue;
      rects.push({
        left: rect.left - origin.left,
        top: rect.top - origin.top,
        right: rect.right - origin.left,
        bottom: rect.bottom - origin.top,
      });
    }
  }

  return rects;
}
