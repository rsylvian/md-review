// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderMarkdown } from '../src/render.ts';
import { anchorFromRange } from '../client/selection.js';

/**
 * The other half of the anchoring contract: a browser selection over the rendered
 * document must map back to the source offsets render.ts stamped. These tests run the
 * real renderer into a real DOM, so a change to either side breaks them.
 */

const DOC = [
  '# Project Overview',
  '',
  'Lorem ipsum **dolor sit** amet, consectetur elit.',
  '',
  '## Goals',
  '',
  '- Ship the thing',
  '- Measure `latency` weekly',
  '',
  '| Col A | Col B |',
  '| ----- | ----- |',
  '| one   | two   |',
  '',
  'Escapes: \\*not bold\\* here.',
  '',
  'Final paragraph of prose.',
].join('\n');

let root: HTMLElement;

function mount(source: string): HTMLElement {
  document.body.innerHTML = `<div id="doc">${renderMarkdown(source)}</div>`;
  return document.getElementById('doc') as HTMLElement;
}

/** Every text node under `el`, in document order. */
function textNodes(el: Node): Text[] {
  const out: Text[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) out.push(node as Text);
    else node.childNodes.forEach(walk);
  };
  walk(el);
  return out;
}

/** Finds the text node containing `needle` and the index of `needle` within it. */
function findText(el: Node, needle: string): { node: Text; index: number } {
  for (const node of textNodes(el)) {
    const index = node.data.indexOf(needle);
    if (index !== -1) return { node, index };
  }
  throw new Error(`test setup: no text node contains ${JSON.stringify(needle)}`);
}

/** A Range covering `needle` exactly, the way a double-click-drag would. */
function rangeOver(el: Node, needle: string): Range {
  const { node, index } = findText(el, needle);
  const range = document.createRange();
  range.setStart(node, index);
  range.setEnd(node, index + needle.length);
  return range;
}

/** `child`'s index among `parent`'s DOM children, for building Element-container Ranges. */
function childIndex(parent: Node, child: Node): number {
  return Array.prototype.indexOf.call(parent.childNodes, child);
}

/** A Range starting inside one text node and ending inside another. */
function rangeAcross(el: Node, from: string, to: string): Range {
  const start = findText(el, from);
  const end = findText(el, to);
  const range = document.createRange();
  range.setStart(start.node, start.index);
  range.setEnd(end.node, end.index + to.length);
  return range;
}

beforeEach(() => {
  root = mount(DOC);
});

describe('anchorFromRange', () => {
  it('maps a selection inside a paragraph back to the source', () => {
    const anchor = anchorFromRange(rangeOver(root, 'consectetur'), root);

    expect(anchor).not.toBeNull();
    expect(DOC.slice(anchor!.startOffset, anchor!.endOffset)).toBe('consectetur');
    expect(anchor!.quote).toBe('consectetur');
    expect(anchor!.approx).toBe(false);
  });

  it('maps a selection inside bold text, excluding the delimiters', () => {
    const anchor = anchorFromRange(rangeOver(root, 'dolor sit'), root);

    expect(DOC.slice(anchor!.startOffset, anchor!.endOffset)).toBe('dolor sit');
    expect(DOC[anchor!.startOffset - 1]).toBe('*');
  });

  it('maps part of a word', () => {
    const anchor = anchorFromRange(rangeOver(root, 'ipsum'), root);

    expect(DOC.slice(anchor!.startOffset, anchor!.endOffset)).toBe('ipsum');
  });

  it('maps a selection inside a heading', () => {
    const anchor = anchorFromRange(rangeOver(root, 'Project Overview'), root);

    expect(DOC.slice(anchor!.startOffset, anchor!.endOffset)).toBe('Project Overview');
  });

  it('maps a selection inside inline code without the backticks', () => {
    const anchor = anchorFromRange(rangeOver(root, 'latency'), root);

    expect(DOC.slice(anchor!.startOffset, anchor!.endOffset)).toBe('latency');
    expect(DOC[anchor!.startOffset - 1]).toBe('`');
  });

  it('maps a selection inside a list item', () => {
    const anchor = anchorFromRange(rangeOver(root, 'Ship the thing'), root);

    expect(DOC.slice(anchor!.startOffset, anchor!.endOffset)).toBe('Ship the thing');
  });

  it('maps a selection inside a table cell', () => {
    const anchor = anchorFromRange(rangeOver(root, 'Col B'), root);

    expect(DOC.slice(anchor!.startOffset, anchor!.endOffset)).toBe('Col B');
  });

  it('does not flag a same-row selection across table cells as approx', () => {
    // Before Fix D, `td` counted as a snap block, so a selection starting at offset 0
    // of one cell and ending in a sibling cell in the same row — nothing to do with
    // the vertical-drag snap this heuristic exists for — was mislabeled approx.
    const anchor = anchorFromRange(rangeAcross(root, 'one', 'two'), root);

    expect(anchor!.approx).toBe(false);
    expect(DOC.slice(anchor!.startOffset, anchor!.endOffset)).toBe('one   | two');
  });

  it('flags a cross-bullet selection as approx, unlike same-row table cells', () => {
    // Unlike td/th, list items are stacked with a real vertical gap between them
    // (`#doc li { margin-bottom }`), so the same Chrome mis-snap the heuristic guards
    // paragraph-to-paragraph drags against can happen bullet-to-bullet too.
    const anchor = anchorFromRange(rangeAcross(root, 'Ship', 'Measure'), root);

    expect(anchor!.approx).toBe(true);
  });

  it('flags a cross-block selection as approx when the start is an Element-container at offset 0', () => {
    // A drag that snaps to a block's very start can surface as either a Text-container
    // start at offset 0, or (real mouse hit-testing) an Element-container start at
    // offset 0 meaning "before this block's first child" — the same position, just
    // expressed the other way.
    const h2 = root.querySelector('h2')!;
    const range = document.createRange();
    range.setStart(h2, 0);
    const end = findText(root, 'Ship the thing');
    range.setEnd(end.node, end.index + 'Ship the thing'.length);

    const anchor = anchorFromRange(range, root);

    expect(anchor!.approx).toBe(true);
  });

  it('spans the source when a selection crosses inline elements', () => {
    // From plain text, through the bold run, into the text after it.
    const anchor = anchorFromRange(rangeAcross(root, 'Lorem', 'amet'), root);
    const slice = DOC.slice(anchor!.startOffset, anchor!.endOffset);

    expect(slice.startsWith('Lorem')).toBe(true);
    expect(slice.endsWith('amet')).toBe(true);
    // The source range necessarily includes the markup between them.
    expect(slice).toContain('**dolor sit**');
  });

  it('spans the source when a selection crosses block elements', () => {
    const anchor = anchorFromRange(rangeAcross(root, 'Goals', 'Ship the thing'), root);
    const slice = DOC.slice(anchor!.startOffset, anchor!.endOffset);

    expect(slice.startsWith('Goals')).toBe(true);
    expect(slice.endsWith('Ship the thing')).toBe(true);
  });

  it('resolves a selection next to an escape exactly, not to the whole sentence', () => {
    const anchor = anchorFromRange(rangeOver(root, 'not bold'), root);

    expect(anchor!.approx).toBe(false);
    expect(DOC.slice(anchor!.startOffset, anchor!.endOffset)).toBe('not bold');
  });

  it('flags a selection that lands on the escape token itself', () => {
    const { node, index } = findText(root, '*');
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 1);

    const anchor = anchorFromRange(range, root);

    expect(anchor!.approx).toBe(true);
    expect(DOC.slice(anchor!.startOffset, anchor!.endOffset)).toBe('\\*');
  });

  it('resolves an Element-container start endpoint by descending into the next child', () => {
    // Real mouse hit-testing at the text/<strong> boundary often reports the start
    // container as the <p> itself with offset = the <strong>'s child index, rather
    // than a Text node. Before Fix B this fell back to the whole paragraph.
    const p = root.querySelector('p')!;
    const strong = p.querySelector('strong')!;
    const range = document.createRange();
    range.setStart(p, childIndex(p, strong));
    const end = findText(root, 'amet');
    range.setEnd(end.node, end.index + 'amet'.length);

    const anchor = anchorFromRange(range, root);
    const slice = DOC.slice(anchor!.startOffset, anchor!.endOffset);

    expect(anchor!.approx).toBe(false);
    expect(slice.startsWith('dolor sit')).toBe(true);
    expect(slice.endsWith('amet')).toBe(true);
  });

  it('resolves an Element-container end endpoint by ascending into the previous child', () => {
    const p = root.querySelector('p')!;
    const start = findText(root, 'consectetur');
    const range = document.createRange();
    range.setStart(start.node, start.index);
    // Boundary at the very end of the paragraph: no next child to descend into,
    // so this must fall back to the last text descendant of the previous child.
    range.setEnd(p, p.childNodes.length);

    const anchor = anchorFromRange(range, root);
    const slice = DOC.slice(anchor!.startOffset, anchor!.endOffset);

    expect(anchor!.approx).toBe(false);
    expect(slice.startsWith('consectetur')).toBe(true);
    expect(slice.endsWith('elit.')).toBe(true);
  });

  it('resolves a selection through the genuine whitespace gap between adjacent inline runs exactly', () => {
    // The space between **bold** and *italic* is real content with its own data-pos.
    // Before Fix C it had none, so an endpoint landing there fell back to the whole
    // paragraph, same failure mode as the Element-container boundary bug.
    const src = '**bold** *italic* run.\n';
    const local = mount(src);

    const anchor = anchorFromRange(rangeAcross(local, 'bold', 'italic'), local);

    expect(anchor!.approx).toBe(false);
    expect(src.slice(anchor!.startOffset, anchor!.endOffset)).toBe('bold** *italic');
  });

  it('falls back to the whole element when there is no text anywhere to normalize to', () => {
    // An Element-container endpoint with no text descendant at all (e.g. an
    // image-only paragraph) has nothing for normalizeEndpoint to descend to. Before
    // this fix, resolveEndpoint returned null for such an endpoint and the whole
    // selection was silently dropped instead of falling back to a whole-element
    // approx anchor, the way every Element-container endpoint used to.
    const src = 'Intro text.\n\n![alt](pic.png)\n';
    const local = mount(src);
    const p = local.querySelectorAll('p')[1]!;
    const img = p.querySelector('img')!;

    const start = findText(local, 'Intro text.');
    const range = document.createRange();
    range.setStart(start.node, start.index);
    // Boundary right after the <img>, its only child — nothing to descend into.
    range.setEnd(p, childIndex(p, img) + 1);

    const anchor = anchorFromRange(range, local);

    expect(anchor).not.toBeNull();
    expect(anchor!.approx).toBe(true);
  });

  it('returns null for a collapsed selection', () => {
    const { node, index } = findText(root, 'consectetur');
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index);

    expect(anchorFromRange(range, root)).toBeNull();
  });

  it('returns null for a selection outside the document', () => {
    const outside = document.createElement('p');
    outside.textContent = 'not part of the review';
    document.body.append(outside);
    const range = document.createRange();
    range.setStart(outside.firstChild!, 0);
    range.setEnd(outside.firstChild!, 3);

    expect(anchorFromRange(range, root)).toBeNull();
  });

  it('returns null when the selection is only whitespace between blocks', () => {
    const between = textNodes(root).find((n) => n.data.trim() === '');
    if (between === undefined) return; // renderer emitted none; nothing to assert
    const range = document.createRange();
    range.setStart(between, 0);
    range.setEnd(between, between.data.length);

    expect(anchorFromRange(range, root)).toBeNull();
  });

  it('produces offsets a server-side anchor can be rebuilt from', () => {
    // The property that matters end to end: for every word in the doc, the offsets the
    // client computes slice the source back to what the reviewer highlighted.
    for (const word of ['Lorem', 'dolor sit', 'Goals', 'Measure', 'one', 'two', 'Final']) {
      const anchor = anchorFromRange(rangeOver(root, word), root);
      expect(anchor, word).not.toBeNull();
      if (!anchor!.approx) {
        expect(DOC.slice(anchor!.startOffset, anchor!.endOffset), word).toBe(word);
      }
    }
  });
});
