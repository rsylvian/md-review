/** Test-only helpers for poking at rendered HTML without pulling in a DOM parser. */

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Reverse hast-util-to-html's character escaping. */
export function decodeEntities(html: string): string {
  return html.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    return NAMED[body] ?? match;
  });
}

export type TextSpan = {
  start: number;
  end: number;
  /** Rendered text, with HTML escaping reversed. */
  text: string;
  /** True when offsets are the containing node's full range rather than exact. */
  approx: boolean;
};

const SPAN_RE = /<span data-pos="(\d+):(\d+)"(\s+data-approx="")?>([^<]*)<\/span>/g;

/** Every text span md-review stamped, in document order. */
export function textSpans(html: string): TextSpan[] {
  const out: TextSpan[] = [];
  for (const m of html.matchAll(SPAN_RE)) {
    out.push({
      start: Number(m[1]),
      end: Number(m[2]),
      approx: m[3] !== undefined,
      text: decodeEntities(m[4] ?? ''),
    });
  }
  return out;
}

/** The data-pos range stamped on the first `<tag ...>` in the html, or null. */
export function elementPos(html: string, tag: string): [number, number] | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*?)?\\sdata-pos="(\\d+):(\\d+)"`).exec(html);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
