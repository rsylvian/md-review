import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/render.ts';
import { textSpans, elementPos } from './helpers/html.ts';

/**
 * The contract render.ts must uphold, since every anchor in the app depends on it:
 *
 *  1. Elements that had a source position carry data-pos="start:end".
 *  2. Non-whitespace text is wrapped in <span data-pos="start:end">, and unless the
 *     span is marked data-approx, source.slice(start, end) equals the rendered text.
 *  3. Whitespace-only text between blocks is left alone.
 */
describe('renderMarkdown', () => {
  it('stamps data-pos on block elements', () => {
    const src = '# Title\n\nA paragraph.\n';
    const html = renderMarkdown(src);

    expect(elementPos(html, 'h1')).toEqual([0, 7]);
    const p = elementPos(html, 'p');
    expect(p).not.toBeNull();
    expect(src.slice(p![0], p![1])).toBe('A paragraph.');
  });

  it('gives every text span offsets that slice back to the same text', () => {
    const src = [
      '# Project Overview',
      '',
      'Lorem ipsum **dolor sit** amet, consectetur elit.',
      '',
      '## Goals',
      '',
      '- Ship the thing',
      '- Measure it',
      '  - nested item',
      '',
      '| Col A | Col B |',
      '| ----- | ----- |',
      '| one   | two   |',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      'Closing prose with a [link](https://example.com).',
      '',
      '> A blockquote.',
      '',
      '1. first',
      '2. second',
    ].join('\n');

    const spans = textSpans(renderMarkdown(src));
    expect(spans.length).toBeGreaterThan(10);

    for (const span of spans) {
      expect(span.approx, `span ${JSON.stringify(span.text)} should be exact`).toBe(false);
      expect(src.slice(span.start, span.end)).toBe(span.text);
    }
  });

  it('splits inline emphasis into separately anchored spans', () => {
    const src = 'Lorem **dolor sit** amet.\n';
    const spans = textSpans(renderMarkdown(src));

    expect(spans.map((s) => s.text)).toEqual(['Lorem ', 'dolor sit', ' amet.']);
    // The bold run points at the source text without its ** delimiters.
    const bold = spans[1]!;
    expect(src.slice(bold.start, bold.end)).toBe('dolor sit');
    expect(src[bold.start - 1]).toBe('*');
  });

  it('recovers exact offsets for inline code despite backtick delimiters', () => {
    const src = 'Text with `inline code` and ``double `tick` code`` here.\n';
    const spans = textSpans(renderMarkdown(src));

    const inline = spans.find((s) => s.text === 'inline code');
    expect(inline).toBeDefined();
    expect(inline!.approx).toBe(false);
    expect(src.slice(inline!.start, inline!.end)).toBe('inline code');

    const double = spans.find((s) => s.text === 'double `tick` code');
    expect(double).toBeDefined();
    expect(src.slice(double!.start, double!.end)).toBe('double `tick` code');
  });

  it('anchors code fence contents', () => {
    const src = '```js\nconst x = 1;\n```\n';
    const spans = textSpans(renderMarkdown(src));

    const code = spans.find((s) => s.text.includes('const x = 1;'));
    expect(code).toBeDefined();
    expect(src.slice(code!.start, code!.end)).toBe(code!.text);
  });

  it('marks spans approximate when escapes make offsets non-linear', () => {
    const src = 'Escapes: \\*not bold\\* here.\n';
    const spans = textSpans(renderMarkdown(src));

    const span = spans.find((s) => s.text.includes('not bold'));
    expect(span).toBeDefined();
    expect(span!.text).toBe('Escapes: *not bold* here.');
    // Can't map char-by-char, so the span covers the whole node and says so.
    expect(span!.approx).toBe(true);
    expect(src.slice(span!.start, span!.end)).toBe('Escapes: \\*not bold\\* here.');
  });

  it('marks spans approximate when entities make offsets non-linear', () => {
    const src = 'Entities: &amp; and &copy; inline.\n';
    const spans = textSpans(renderMarkdown(src));

    const span = spans.find((s) => s.text.includes('inline'));
    expect(span).toBeDefined();
    expect(span!.text).toBe('Entities: & and © inline.');
    expect(span!.approx).toBe(true);
  });

  it('does not wrap whitespace-only text between blocks', () => {
    const html = renderMarkdown('# A\n\n- one\n- two\n\n| x |\n| - |\n| y |\n');

    expect(html).not.toMatch(/<span data-pos="\d+:\d+">\s*<\/span>/);
    // A stray span between table rows would be invalid HTML.
    expect(html).not.toMatch(/<(?:table|thead|tbody|tr|ul|ol)[^>]*>\s*<span/);
  });

  it('drops raw HTML rather than trusting it', () => {
    const html = renderMarkdown('Hello\n\n<script>alert(1)</script>\n\n<b>bold</b>\n');

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>bold</b>');
  });

  it('renders GFM tables, strikethrough and task lists', () => {
    const html = renderMarkdown(
      '| a | b |\n| - | - |\n| 1 | 2 |\n\n~~gone~~\n\n- [x] done\n- [ ] todo\n',
    );

    expect(html).toContain('<table');
    expect(html).toContain('<del');
    expect(html).toContain('type="checkbox"');
  });

  it('leaves smart quotes alone so offsets stay linear', () => {
    const src = 'He said "hello" -- really.\n';
    const spans = textSpans(renderMarkdown(src));

    expect(spans[0]!.text).toBe('He said "hello" -- really.');
    expect(spans[0]!.approx).toBe(false);
  });
});
