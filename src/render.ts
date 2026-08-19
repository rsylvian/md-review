import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { toHtml } from 'hast-util-to-html';
import { visit, SKIP } from 'unist-util-visit';
import type { Element, Root, Text } from 'hast';
import type { Node } from 'unist';

/**
 * Renders markdown to HTML in which every element and every run of visible text
 * carries the source offsets it came from:
 *
 *   <p data-pos="9:21">A <strong data-pos="11:15"><span data-pos="13:13">hi</span></strong></p>
 *
 * The client turns a browser selection into source offsets by reading these, which is
 * what lets a comment survive the agent rewriting the document around it.
 *
 * A span marked `data-approx` means offsets inside it are not linear — escapes
 * (`\*` renders as `*`) and entities (`&amp;` renders as `&`) make rendered text
 * shorter than its source. Those spans cover the whole run and callers must treat the
 * range as a whole rather than indexing into it.
 */

/** Source range, as [startOffset, endOffset). */
type Range = [number, number];

/**
 * Elements whose only legal children are other elements — a wrapper span between a
 * `<tr>` and its `<td>`s is invalid HTML and browsers hoist it out of the table.
 */
const NO_TEXT_CHILDREN = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'ul',
  'ol',
  'dl',
  'select',
  'optgroup',
]);

function rangeOf(node: Node): Range | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === 'number' && typeof end === 'number' ? [start, end] : null;
}

function parseRange(value: unknown): Range | null {
  if (typeof value !== 'string') return null;
  const [start, end] = value.split(':');
  const a = Number(start);
  const b = Number(end);
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
}

/**
 * Narrows a candidate source range down to the exact slice matching `value`.
 *
 * mdast ranges include delimiters the rendered text drops — `` `code` `` spans the
 * backticks, a fenced block spans its fences. Locating the value inside the raw slice
 * recovers exact offsets. Returns null when no exact mapping exists.
 */
function exactRange(source: string, candidate: Range, value: string): Range | null {
  const raw = source.slice(candidate[0], candidate[1]);
  if (raw === value) return candidate;

  const idx = raw.indexOf(value);
  if (idx === -1) return null;
  // Ambiguous when the value appears more than once; the first match is still a
  // correct slice of the same text, so it stays usable.
  const start = candidate[0] + idx;
  return [start, start + value.length];
}

function wrapText(node: Text, range: Range, approx: boolean): Element {
  const properties: Element['properties'] = { dataPos: `${range[0]}:${range[1]}` };
  if (approx) properties.dataApprox = '';
  return { type: 'element', tagName: 'span', properties, children: [node] };
}

/** Stamps data-pos across the tree. Runs after remark-rehype, before serialization. */
function stampPositions(source: string) {
  return (tree: Root): undefined => {
    visit(tree, 'element', (node) => {
      const range = rangeOf(node);
      if (range) node.properties.dataPos = `${range[0]}:${range[1]}`;
    });

    visit(tree, 'text', (node, index, parent) => {
      if (parent === undefined || index === undefined) return;
      // Whitespace between blocks is remark-rehype's own formatting, not content.
      if (node.value.trim() === '') return;
      if (parent.type === 'element' && NO_TEXT_CHILDREN.has(parent.tagName)) return;

      // Fenced code and a few other constructs produce text without its own position;
      // the containing element's range still bounds it.
      const candidate =
        rangeOf(node) ?? (parent.type === 'element' ? parseRange(parent.properties.dataPos) : null);
      if (!candidate) return;

      const exact = exactRange(source, candidate, node.value);
      parent.children[index] = wrapText(node, exact ?? candidate, exact === null);
      return [SKIP, index + 1];
    });
  };
}

/** Markdown source to position-annotated HTML. Raw HTML in the input is dropped. */
export function renderMarkdown(source: string): string {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);
  const hast = processor.runSync(processor.parse(source)) as Root;
  stampPositions(source)(hast);
  return toHtml(hast);
}
