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

  it('flags a selection in a run whose offsets are not linear', () => {
    const anchor = anchorFromRange(rangeOver(root, 'not bold'), root);

    expect(anchor!.approx).toBe(true);
    // Falls back to the whole run rather than guessing an offset inside it.
    expect(DOC.slice(anchor!.startOffset, anchor!.endOffset)).toBe('Escapes: \\*not bold\\* here.');
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
