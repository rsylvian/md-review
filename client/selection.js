/**
 * Turns a browser selection over the rendered document into markdown source offsets.
 *
 * render.ts wraps every visible run of text in `<span data-pos="start:end">` whose text
 * content is character-for-character the source it came from. So an offset inside such a
 * span is just `start + offsetWithinTheSpan`.
 *
 * A Range endpoint whose container is an Element rather than a Text node (common right
 * at the boundary of an inline element, from real mouse hit-testing) is first
 * normalized down to the nearest actual text position — see `normalizeEndpoint`.
 *
 * What's left breaks linearity and falls back to covering the whole run, saying so via
 * `approx`:
 *   - `data-approx` spans: a single escape or entity token, or (rarely) a run that
 *     couldn't be segmented at all, where rendered text isn't a straight slice of source
 *     (`\*` renders as `*`);
 *   - endpoints that land on a block element with no text descendant to normalize to,
 *     e.g. a selection dragged across paragraphs.
 */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** @returns {[number, number] | null} */
function parsePos(element) {
  const raw = element.getAttribute('data-pos');
  if (raw === null) return null;
  const [start, end] = raw.split(':');
  const a = Number(start);
  const b = Number(end);
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
}

/**
 * Excludes `td`/`th` on purpose: the cross-block snap heuristic below exists for
 * vertical drags between blocks with real spacing between them, and a same-row
 * table-cell selection would otherwise be mislabeled `approx` without its offsets
 * actually being wrong. `li` stays in: unlike table cells, list items are stacked
 * vertically with a real gap between them (`#doc li { margin-bottom }`), so a drag
 * from one bullet to the next is exactly the kind of boundary the heuristic exists for.
 */
const SNAP_BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre';

/**
 * Nearest block-level ancestor of `node` within `root`, or `root` itself.
 * Used only to detect whether two endpoints are in the same block, for the snap
 * heuristic below — not a general block-boundary utility.
 */
function nearestSnapBlock(node, root) {
  let current = node.nodeType === TEXT_NODE ? node.parentElement : node;
  while (current !== null && current !== root) {
    if (current.matches(SNAP_BLOCK_SELECTOR)) return current;
    current = current.parentElement;
  }
  return root;
}

/**
 * First (or last, in document order) Text descendant of `node`, or null if it has none.
 * @param {'first' | 'last'} which
 */
function edgeTextDescendant(node, which) {
  if (node.nodeType === TEXT_NODE) return node;
  if (node.nodeType !== ELEMENT_NODE) return null;
  const children = which === 'first' ? node.childNodes : [...node.childNodes].reverse();
  for (const child of children) {
    const found = edgeTextDescendant(child, which);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Real mouse hit-testing often reports a Range endpoint whose container is an
 * Element (offset = a child index) rather than a Text node, typically right at the
 * boundary between plain text and an adjacent inline element. Descends to the nearest
 * actual text position so callers never have to fall back to the whole element.
 * @returns {{ node: Text, offset: number } | null}
 */
function normalizeEndpoint(node, offsetInNode) {
  if (node.nodeType === TEXT_NODE) return { node, offset: offsetInNode };

  const forward = node.childNodes[offsetInNode];
  const forwardText = forward !== undefined ? edgeTextDescendant(forward, 'first') : null;
  if (forwardText !== null) return { node: forwardText, offset: 0 };

  const back = offsetInNode > 0 ? node.childNodes[offsetInNode - 1] : null;
  const backText = back !== null ? edgeTextDescendant(back, 'last') : null;
  if (backText !== null) return { node: backText, offset: backText.data.length };

  return null;
}

/** Nearest ancestor-or-self carrying data-pos, or null if we walk out of `root`. */
function nearestPositioned(node, root) {
  let current = node.nodeType === ELEMENT_NODE ? node : node.parentNode;
  while (current !== null && current !== root.parentNode) {
    if (current.nodeType === ELEMENT_NODE && current.hasAttribute('data-pos')) return current;
    if (current === root) return null;
    current = current.parentNode;
  }
  return null;
}

/** True when this element is one of render.ts's text wrappers: a single text child. */
function isTextRun(element) {
  return (
    element.tagName === 'SPAN' &&
    element.childNodes.length === 1 &&
    element.firstChild.nodeType === TEXT_NODE
  );
}

/** Characters of `element`'s text preceding (node, offsetInNode). */
function textOffsetWithin(element, node, offsetInNode) {
  if (node === element) return 0;
  let total = 0;
  let found = false;
  const walk = (current) => {
    if (found) return;
    if (current === node) {
      found = true;
      return;
    }
    if (current.nodeType === TEXT_NODE) {
      total += current.data.length;
      return;
    }
    current.childNodes.forEach(walk);
  };
  walk(element);
  return total + offsetInNode;
}

/**
 * Resolves one endpoint of a selection to a source offset.
 * @param {'start' | 'end'} side which end of the range this is
 * @returns {{ offset: number, approx: boolean } | null}
 */
function resolveEndpoint(node, offsetInNode, root, side) {
  if (!root.contains(node)) return null;

  const normalized = normalizeEndpoint(node, offsetInNode);
  // normalizeEndpoint finds nothing when the container has no text anywhere to
  // normalize to at all (e.g. an image-only paragraph) — nearestPositioned then walks
  // up from the original node itself, the same whole-element fallback every
  // Element-container endpoint used before normalization was added.
  const element = nearestPositioned(normalized?.node ?? node, root);
  if (element === null) return null;

  const range = parsePos(element);
  if (range === null) return null;
  const [start, end] = range;

  // Not a linear text run: cover the whole thing rather than guess inside it.
  if (normalized === null || element.hasAttribute('data-approx') || !isTextRun(element)) {
    return { offset: side === 'start' ? start : end, approx: true };
  }

  const within = textOffsetWithin(element, normalized.node, normalized.offset);
  return { offset: Math.min(start + within, end), approx: false };
}

/**
 * @typedef {object} SelectionAnchor
 * @property {number} startOffset
 * @property {number} endOffset
 * @property {string} quote  the text the reviewer actually saw
 * @property {boolean} approx
 */

/**
 * @param {Range} range
 * @param {Element} root the element the rendered document was mounted into
 * @returns {SelectionAnchor | null} null when nothing usable is selected
 */
export function anchorFromRange(range, root) {
  if (range.collapsed) return null;

  const quote = range.toString();
  if (quote.trim() === '') return null;

  const start = resolveEndpoint(range.startContainer, range.startOffset, root, 'start');
  const end = resolveEndpoint(range.endContainer, range.endOffset, root, 'end');
  if (start === null || end === null) return null;

  const startOffset = Math.min(start.offset, end.offset);
  const endOffset = Math.max(start.offset, end.offset);
  if (endOffset <= startOffset) return null;

  // Detect cross-block snap: when Chrome places the start of a cross-block
  // selection at offset 0 of a text node, it likely snapped the endpoint to
  // the beginning of the block rather than the character under the cursor. Checked
  // against the *normalized* start (see normalizeEndpoint), not the raw Range
  // container — an Element-container start at "before its first child" is the same
  // snap-to-block-start position as a Text-container start at offset 0, just
  // expressed the other way, and real mouse hit-testing produces both.
  const normalizedStart = normalizeEndpoint(range.startContainer, range.startOffset);
  const snapped =
    !start.approx &&
    !end.approx &&
    normalizedStart !== null &&
    normalizedStart.offset === 0 &&
    nearestSnapBlock(range.startContainer, root) !== nearestSnapBlock(range.endContainer, root);

  return { startOffset, endOffset, quote, approx: start.approx || end.approx || snapped };
}

/**
 * @param {Selection | null} selection
 * @param {Element} root
 * @returns {SelectionAnchor | null}
 */
export function anchorFromSelection(selection, root) {
  if (selection === null || selection.rangeCount === 0) return null;
  return anchorFromRange(selection.getRangeAt(0), root);
}

/**
 * Finds the DOM ranges covering a source span, so it can be highlighted.
 * @param {Element} root
 * @param {number} startOffset
 * @param {number} endOffset
 * @returns {Range[]}
 */
export function rangesForSource(root, startOffset, endOffset) {
  const ranges = [];
  for (const element of root.querySelectorAll('[data-pos]')) {
    if (!isTextRun(element)) continue;
    const pos = parsePos(element);
    if (pos === null) continue;
    const [start, end] = pos;
    if (end <= startOffset || start >= endOffset) continue;

    const text = element.firstChild;
    const approx = element.hasAttribute('data-approx');
    // An approximate run can only be highlighted whole.
    const from = approx ? 0 : Math.max(0, startOffset - start);
    const to = approx ? text.data.length : Math.min(text.data.length, endOffset - start);
    if (to <= from) continue;

    const range = document.createRange();
    range.setStart(text, from);
    range.setEnd(text, to);
    ranges.push(range);
  }
  return ranges;
}
