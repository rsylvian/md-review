import type { Anchor, Comment } from './anchors.ts';

/**
 * Turns a finished review into the two things the agent consumes: a markdown report
 * printed to stdout (and saved next to the sidecar), and a JSON payload for anything
 * that wants to read the review programmatically.
 *
 * The report is written for an agent, not a changelog: it leads with how much work there
 * is, quotes what the reviewer pointed at, and renders suggestions as exact
 * replace/with pairs so they can be applied rather than interpreted.
 */

export type ReportInput = {
  /** Path to show in the report, as given on the command line. */
  filePath: string;
  open: readonly Comment[];
  /**
   * What the agent resolved since it last asked — not every comment ever resolved on this
   * document. The report presents this as "Resolved since last round", so passing the
   * accumulated set would make the report claim credit for old rounds' work.
   */
  newlyResolved: readonly Comment[];
  generatedAt: string;
};

/** A fence long enough that `content` cannot terminate it early. */
function fenceFor(content: string): string {
  const longestRun = [...content.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0);
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function block(content: string): string {
  const fence = fenceFor(content);
  return `${fence}\n${content}\n${fence}`;
}

function lineLabel(anchor: Anchor): string {
  return anchor.startLine === anchor.endLine
    ? `line ${anchor.startLine}`
    : `lines ${anchor.startLine}–${anchor.endLine}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Quotes the reviewer's selection as a markdown blockquote. */
function quoteBlock(anchor: Anchor): string {
  return anchor.quote
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function renderComment(comment: Comment, index: number): string {
  const { anchor } = comment;
  // An explicit empty-string suggestion is a deletion (replace the passage with
  // nothing), distinct from no suggestion at all.
  const deleting = comment.suggestion === '';
  const rewriting = comment.suggestion !== undefined && !deleting;
  const heading = deleting
    ? `## ${index + 1} — ${lineLabel(anchor)} · suggested deletion`
    : rewriting
      ? `## ${index + 1} — ${lineLabel(anchor)} · suggested rewrite`
      : `## ${index + 1} — ${lineLabel(anchor)}`;

  const parts = [heading, '', quoteBlock(anchor), ''];

  if (comment.body.trim() !== '') parts.push(comment.body.trim(), '');

  if (deleting) {
    parts.push('Delete:', block(anchor.sourceText), '');
  } else if (comment.suggestion !== undefined) {
    parts.push('Replace:', block(anchor.sourceText), '', 'With:', block(comment.suggestion), '');
  }

  if (anchor.approx) {
    parts.push(
      '_(This passage contains escapes or entities, so the quoted text differs from the source; treat the range as a whole.)_',
      '',
    );
  }

  return parts.join('\n');
}

export function formatReport(input: ReportInput): string {
  const { filePath, open, newlyResolved: resolved } = input;
  const lines: string[] = [`# Review of ${filePath}`, ''];

  const summary =
    open.length === 0 ? 'No open comments.' : `${plural(open.length, 'open comment')}.`;
  // "resolved" is an adjective here, not a countable noun — it takes no plural `s`.
  const resolvedNote = resolved.length > 0 ? ` ${resolved.length} resolved since last round.` : '';
  lines.push(`${summary}${resolvedNote}`, '');

  if (open.length === 0) {
    lines.push('The reviewer closed the tab without leaving feedback on the current text.', '');
  } else {
    for (const [index, comment] of open.entries()) {
      lines.push(renderComment(comment, index));
    }
  }

  if (resolved.length > 0) {
    lines.push('---', '', '## Resolved since last round', '');
    for (const comment of resolved) {
      lines.push(`- ${lineLabel(comment.anchor)}: “${comment.anchor.quote.split('\n')[0]}”`);
    }
    lines.push('');
  }

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

export type ReviewPayload = {
  file: string;
  generatedAt: string;
  openCount: number;
  /** How many this round resolved, matching the report. */
  resolvedCount: number;
  comments: Comment[];
};

export function buildPayload(input: ReportInput): ReviewPayload {
  return {
    file: input.filePath,
    generatedAt: input.generatedAt,
    openCount: input.open.length,
    resolvedCount: input.newlyResolved.length,
    comments: [...input.open, ...input.newlyResolved],
  };
}
