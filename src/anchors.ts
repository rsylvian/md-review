/**
 * Anchors tie a comment to a passage of markdown source, and survive the agent
 * rewriting the document around them.
 *
 * The rule that drives the whole review loop: on a later round, if a comment's anchored
 * source text is still present, the comment is still open; if it is gone, the agent
 * rewrote that passage, so the comment is auto-resolved. No cooperation from the agent
 * is required, and editing the file by hand counts too.
 */

/** How much surrounding text an anchor remembers, for disambiguating duplicates. */
const CONTEXT_CHARS = 40;

export type Anchor = {
  /** Source character offsets, [start, end). */
  startOffset: number;
  endOffset: number;
  /** 1-based, inclusive — for the human-readable report. */
  startLine: number;
  endLine: number;
  /** Exact source slice. The key used to re-find this passage on later rounds. */
  sourceText: string;
  /** What the reviewer actually saw on screen; may differ from sourceText. */
  quote: string;
  /** Up to CONTEXT_CHARS of source either side. */
  prefix: string;
  suffix: string;
  /** Which occurrence of sourceText this was, 0-based, when the anchor was made. */
  occurrence: number;
  /** True when offsets within this range are not linear (escapes, entities). */
  approx: boolean;
};

export type Comment = {
  id: string;
  body: string;
  /** Proposed replacement for anchor.sourceText, when the reviewer suggested one. */
  suggestion?: string;
  anchor: Anchor;
  createdAt: string;
  status: 'open' | 'resolved';
  resolvedBy?: 'text-changed';
  resolvedAt?: string;
};

/** 1-based line number containing `offset`, clamped to the document. */
export function offsetToLine(source: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  for (let i = 0; i < clamped; i++) {
    if (source[i] === '\n') line++;
  }
  // An offset past the final newline belongs to the last line that has content.
  if (clamped === source.length && source.endsWith('\n')) line--;
  return Math.max(1, line);
}

/** Index of every occurrence of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
  if (needle === '') return [];
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    out.push(i);
  }
  return out;
}

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

export function buildAnchor(
  source: string,
  startOffset: number,
  endOffset: number,
  quote?: string,
  approx = false,
): Anchor {
  const sourceText = source.slice(startOffset, endOffset);
  const before = source.slice(Math.max(0, startOffset - CONTEXT_CHARS), startOffset);
  const after = source.slice(endOffset, endOffset + CONTEXT_CHARS);
  const occurrence = Math.max(0, occurrences(source, sourceText).indexOf(startOffset));

  return {
    startOffset,
    endOffset,
    startLine: offsetToLine(source, startOffset),
    endLine: offsetToLine(source, Math.max(startOffset, endOffset - 1)),
    sourceText,
    quote: quote ?? sourceText,
    prefix: before,
    suffix: after,
    occurrence,
    approx,
  };
}

/**
 * Finds where an anchor's text now lives, or null if it is gone.
 *
 * With duplicates, surrounding context decides; when context has changed too, the
 * anchor's original occurrence index decides. Proximity of raw offsets is deliberately
 * not the primary signal — inserting a paragraph shifts every offset below it, which
 * would make the wrong occurrence look closer.
 */
function locate(source: string, anchor: Anchor): number | null {
  const found = occurrences(source, anchor.sourceText);
  if (found.length === 0) return null;
  if (found.length === 1) return found[0]!;

  let best = found[0]!;
  let bestScore = -1;
  let bestOrdinalGap = Number.POSITIVE_INFINITY;

  for (const [ordinal, start] of found.entries()) {
    const score =
      commonSuffixLength(anchor.prefix, source.slice(0, start)) +
      commonPrefixLength(anchor.suffix, source.slice(start + anchor.sourceText.length));
    const ordinalGap = Math.abs(ordinal - anchor.occurrence);

    if (score > bestScore || (score === bestScore && ordinalGap < bestOrdinalGap)) {
      best = start;
      bestScore = score;
      bestOrdinalGap = ordinalGap;
    }
  }
  return best;
}

export type ReanchorResult = {
  open: Comment[];
  /** Everything resolved, this round or in an earlier one. What the sidecar stores. */
  resolved: Comment[];
  /**
   * Only what this pass resolved — the passages the agent rewrote since it last asked.
   * Kept apart from `resolved` because the report tells the agent what it just addressed,
   * and a list of everything ever resolved would grow with every round.
   */
  newlyResolved: Comment[];
};

/**
 * Re-points last round's comments at the current document, splitting them into those
 * still awaiting attention and those the agent has addressed.
 */
export function reanchor(
  comments: readonly Comment[],
  newSource: string,
  now: () => string = () => new Date().toISOString(),
): ReanchorResult {
  const open: Comment[] = [];
  const resolved: Comment[] = [];
  const newlyResolved: Comment[] = [];

  for (const comment of comments) {
    if (comment.status === 'resolved') {
      resolved.push(comment);
      continue;
    }

    const start = locate(newSource, comment.anchor);
    if (start === null) {
      const justResolved: Comment = {
        ...comment,
        status: 'resolved',
        resolvedBy: 'text-changed',
        resolvedAt: now(),
      };
      resolved.push(justResolved);
      newlyResolved.push(justResolved);
      continue;
    }

    open.push({
      ...comment,
      anchor: buildAnchor(
        newSource,
        start,
        start + comment.anchor.sourceText.length,
        comment.anchor.quote,
        comment.anchor.approx,
      ),
    });
  }

  return { open, resolved, newlyResolved };
}
