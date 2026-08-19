/**
 * Generates docs/how-it-works.html from the real implementation.
 *
 * Everything shown on that page — the stamped HTML, the anchors, the reports, the
 * resolve decisions, the line counts — is produced by importing the shipping modules and
 * running them, and the interactive demo inlines client/selection.js verbatim. So the
 * page cannot drift from the code: regenerate it with `yarn docs`.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderMarkdown } from '../src/render.ts';
import { buildAnchor, reanchor } from '../src/anchors.ts';
import { formatReport } from '../src/report.ts';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'how-it-works.html');

/* ------------------------------------------------------------------ artifacts */

const DRAFT = `# Q3 Platform Plan

The system serves the actual users of this thing.

## Goals

- Ship the ingestion rewrite
- Measure \`latency\` weekly

We should probably measure this.
`;

const html = renderMarkdown(DRAFT);

const at = (needle, source = DRAFT) => {
  const start = source.indexOf(needle);
  return buildAnchor(source, start, start + needle.length, needle);
};

const comment = (needle, body, suggestion, id) => ({
  id,
  body,
  ...(suggestion === undefined ? {} : { suggestion }),
  anchor: at(needle),
  createdAt: '2026-08-13T18:00:00.000Z',
  status: 'open',
});

const round1 = [
  comment('the actual users', 'Too vague — name them.', undefined, 'c1'),
  comment(
    'We should probably measure this.',
    'Commit to a metric.',
    'Track p95 latency weekly.',
    'c2',
  ),
];

const report1 = formatReport({
  filePath: 'draft.md',
  open: round1,
  resolved: [],
  generatedAt: '2026-08-13T18:00:00.000Z',
});

// The agent applies the suggestion and adds a paragraph, shifting every offset below it.
const REVISED = DRAFT.replace(
  'We should probably measure this.',
  'Track p95 latency weekly.',
).replace('# Q3 Platform Plan\n', '# Q3 Platform Plan\n\nAdded during round one.\n');

const { open: stillOpen, resolved } = reanchor(round1, REVISED, () => '2026-08-13T18:30:00.000Z');

const report2 = formatReport({
  filePath: 'draft.md',
  open: stillOpen,
  resolved,
  generatedAt: '2026-08-13T18:30:00.000Z',
});

const selectionSource = readFileSync(join(ROOT, 'client', 'selection.js'), 'utf8');

const MODULES = [
  ['src/render.ts', 'markdown → HTML, stamping source offsets onto every element and text run'],
  ['client/selection.js', 'a browser selection → those source offsets'],
  ['src/anchors.ts', 're-finds a passage on later rounds; decides open vs resolved'],
  ['src/server.ts', 'HTTP + SSE liveness; notices the tab closing'],
  ['src/report.ts', 'comments → the markdown the agent reads'],
  ['src/store.ts', 'the sidecar that carries comments between rounds'],
  ['client/app.js', 'the review page: comment popovers and drafts'],
  ['client/popover.js', 'which passage was clicked, and where its card goes'],
  ['client/highlight.js', 'paints commented passages via the Custom Highlight API'],
  ['src/cli.ts', 'argument parsing, lifecycle, writing the review out'],
  ['src/vendor.ts', 'locates htm/preact’s self-contained build'],
  ['src/skill.ts', 'installs the Claude Code skill'],
].map(([path, purpose]) => ({
  path,
  purpose,
  lines: readFileSync(join(ROOT, path), 'utf8').split('\n').length,
}));

/* ------------------------------------------------------------------ helpers */

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const js = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

/** Renders the stamped HTML as escaped source, with the data-pos attributes picked out. */
const showStamped = (markup) =>
  esc(markup).replace(/data-pos=&quot;(\d+):(\d+)&quot;/g, (m, a, b) =>
    `<b class="attr">data-pos="${a}:${b}"</b>`,
  );

const anchorRow = (label, anchor, source) => `
  <tr>
    <td>${esc(label)}</td>
    <td><code>${anchor.startOffset}:${anchor.endOffset}</code></td>
    <td>${anchor.startLine === anchor.endLine ? `line ${anchor.startLine}` : `lines ${anchor.startLine}–${anchor.endLine}`}</td>
    <td><code>${esc(JSON.stringify(source.slice(anchor.startOffset, anchor.endOffset)))}</code></td>
  </tr>`;

/* ------------------------------------------------------------------ page */

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>md-review — how it works</title>
<style>
/* Same Atlassian-derived palette as the app; this page follows the OS only. */
:root {
  color-scheme: light;
  --bg: #f7f8f9; --surface: #fff; --text: #172b4d; --muted: #626f86;
  --line: #dcdfe4; --accent: #0c66e4; --accent-soft: #cce0ff; --ok: #216e4e;
  --danger: #c9372c; --code-bg: #f1f2f4;
  --shadow: 0 1px 1px rgb(9 30 66 / 12%), 0 2px 8px rgb(9 30 66 / 8%);
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #1d2125; --surface: #22272b; --text: #c7d1db; --muted: #8c9bab;
    --line: #38414a; --accent: #579dff; --accent-soft: #09326c; --ok: #7ee2b8;
    --danger: #f87168; --code-bg: #2c333a;
    --shadow: 0 1px 1px rgb(3 4 4 / 50%), 0 2px 8px rgb(3 4 4 / 35%);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.6 ui-sans-serif, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 60rem; margin: 0 auto; padding: 3rem 1.5rem 6rem; }
h1 { font-size: 2rem; margin: 0 0 .3rem; letter-spacing: -.01em; }
h2 {
  font-size: 1.15rem; margin: 3.5rem 0 .3rem; padding-top: 1.2rem;
  border-top: 1px solid var(--line);
}
h3 { font-size: .95rem; margin: 1.8rem 0 .4rem; }
.lede { color: var(--muted); margin: 0 0 .4rem; }
p { margin: .5rem 0 .9rem; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
code { font-size: .86em; background: var(--code-bg); padding: .1em .35em; border-radius: 4px; }
pre {
  background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px;
  padding: .8rem 1rem; overflow-x: auto; font-size: .8rem; line-height: 1.55; margin: .6rem 0;
}
pre code { background: none; padding: 0; }
b.attr { background: var(--accent-soft); color: var(--accent); border-radius: 3px; font-weight: 600; }
.muted { color: var(--muted); }
.small { font-size: .85rem; }
table { border-collapse: collapse; width: 100%; font-size: .85rem; margin: .8rem 0; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
.card {
  background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
  padding: 1rem 1.15rem; box-shadow: var(--shadow); margin: 1rem 0;
}

/* the round loop */
.loop { display: grid; gap: .7rem; grid-template-columns: repeat(4, 1fr); margin: 1.2rem 0; }
.step {
  background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
  padding: .8rem .9rem; position: relative; box-shadow: var(--shadow);
}
.step .n {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.5rem; height: 1.5rem; border-radius: 50%; background: var(--accent);
  color: #fff; font-size: .75rem; font-weight: 700; margin-bottom: .45rem;
}
.step h4 { margin: 0 0 .2rem; font-size: .87rem; }
.step p { margin: 0; font-size: .8rem; color: var(--muted); line-height: 1.45; }
.step::after {
  content: '→'; position: absolute; right: -.62rem; top: 50%; transform: translateY(-50%);
  color: var(--muted); font-size: .9rem;
}
.step:last-child::after { content: '↩'; right: -.55rem; }
@media (max-width: 52rem) {
  .loop { grid-template-columns: 1fr; }
  .step::after { content: '↓'; right: 50%; top: auto; bottom: -.75rem; transform: none; }
  .step:last-child::after { content: '↩'; }
}

/* pipeline */
.pipe { display: flex; align-items: stretch; gap: .5rem; flex-wrap: wrap; margin: 1rem 0; }
.pipe .box {
  flex: 1 1 8rem; background: var(--surface); border: 1px solid var(--line);
  border-radius: 8px; padding: .6rem .7rem; font-size: .78rem;
}
.pipe .box b { display: block; font-size: .74rem; color: var(--accent); margin-bottom: .15rem; }
.pipe .arrow { align-self: center; color: var(--muted); }

/* live demo */
#demo-doc {
  font: 16px/1.65 ui-serif, Georgia, serif;
  background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
  padding: 1rem 1.3rem; user-select: text;
}
#demo-doc h1 { font-size: 1.4rem; margin: .2rem 0 .5rem; }
#demo-doc h2 { font-size: 1.1rem; margin: 1.2rem 0 .4rem; border: 0; padding: 0; }
#demo-doc p, #demo-doc ul { margin: 0 0 .7rem; }
#demo-doc code { font-size: .85em; }
::highlight(demo-hl) { background: var(--accent-soft); text-decoration: underline; text-decoration-color: var(--accent); }
#readout { margin-top: .8rem; }
#readout table { margin: 0; }
.verdict { font-weight: 600; }
.verdict.ok { color: var(--ok); }
.verdict.approx { color: var(--danger); }
kbd {
  background: var(--code-bg); border: 1px solid var(--line); border-bottom-width: 2px;
  border-radius: 4px; padding: .05em .35em; font-size: .8em; font-family: inherit;
}

/* timeline */
.timeline { margin: 1rem 0; }
.track { position: relative; height: 2.6rem; margin: .35rem 0 1.1rem; }
.track .rail {
  position: absolute; top: 1.15rem; left: 0; right: 0; height: 2px; background: var(--line);
}
.track .ev { position: absolute; top: 0; transform: translateX(-50%); text-align: center; width: 8rem; }
.track .ev i {
  display: block; width: .6rem; height: .6rem; border-radius: 50%; background: var(--accent);
  margin: .9rem auto .15rem;
}
.track .ev span { font-size: .68rem; color: var(--muted); line-height: 1.25; display: block; }
.track .grace {
  position: absolute; top: .55rem; height: 1.2rem; background: var(--accent-soft);
  border-radius: 3px; opacity: .8;
}
.outcome { font-size: .82rem; font-weight: 600; }
.outcome.alive { color: var(--ok); }
.outcome.done { color: var(--danger); }

.two { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
@media (max-width: 52rem) { .two { grid-template-columns: 1fr; } }
.tag {
  display: inline-block; font-size: .68rem; font-weight: 700; letter-spacing: .04em;
  text-transform: uppercase; color: var(--accent); margin-bottom: .3rem;
}
.diff-del { background: color-mix(in srgb, var(--danger) 16%, transparent); text-decoration: line-through; }
.diff-add { background: color-mix(in srgb, var(--ok) 18%, transparent); }
footer { margin-top: 4rem; padding-top: 1.2rem; border-top: 1px solid var(--line); font-size: .8rem; color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">

<h1>md-review</h1>
<p class="lede">How a comment in your browser becomes an edit by the agent.</p>
<p class="small muted">
  Generated from the source by <code>yarn docs</code>. Every offset, report and rendered
  fragment below was produced by running the real modules — the demo in
  <a href="#try">§3</a> inlines <code>client/selection.js</code> verbatim.
</p>

<h2>1 · The round</h2>
<p>
  The document is read once at startup, so the text holds still while you read it. Closing
  the tab is the handoff.
</p>

<div class="loop">
  <div class="step">
    <span class="n">1</span>
    <h4>Agent opens it</h4>
    <p>Runs <code>md-review draft.md</code> backgrounded and waits. A local server renders the file.</p>
  </div>
  <div class="step">
    <span class="n">2</span>
    <h4>You comment</h4>
    <p>Highlight a passage, type. Each comment saves to <code>.md-review/</code> as you make it.</p>
  </div>
  <div class="step">
    <span class="n">3</span>
    <h4>You close the tab</h4>
    <p>The server notices, prints the review to stdout and exits. That exit notifies the agent.</p>
  </div>
  <div class="step">
    <span class="n">4</span>
    <h4>Agent edits</h4>
    <p>Applies the feedback and reopens for round two. Addressed comments resolve themselves.</p>
  </div>
</div>

<h2>2 · Why anchors, not line numbers</h2>
<p>
  A comment on line 9 is worthless once the agent inserts a paragraph at line 2. So a
  comment remembers <em>the text it pointed at</em>. Everything else follows from that.
</p>

<div class="pipe">
  <div class="box"><b>markdown</b>the file on disk</div>
  <span class="arrow">→</span>
  <div class="box"><b>remark → rehype</b>mdast keeps <code>position.offset</code> on every node</div>
  <span class="arrow">→</span>
  <div class="box"><b>data-pos</b>stamped on each element and text run</div>
  <span class="arrow">→</span>
  <div class="box"><b>selection</b>endpoint → nearest <code>[data-pos]</code> → source offset</div>
  <span class="arrow">→</span>
  <div class="box"><b>anchor</b>offsets + exact source text + context</div>
</div>

<h3>The document</h3>
<pre><code>${esc(DRAFT)}</code></pre>

<h3>…rendered, with positions stamped on</h3>
<pre><code>${showStamped(html)}</code></pre>
<p class="small muted">
  Every visible run of text is wrapped in a <code>&lt;span&gt;</code> whose contents are
  character-for-character the source it came from — which is what makes an offset inside it
  just <code>start + offsetWithinTheSpan</code>. Note
  <code>${esc('`latency`')}</code>: the span points at <code>latency</code> without the
  backticks, because the mdast range covering the delimiters gets narrowed to the exact
  text.
</p>

<h2 id="try">3 · Try it</h2>
<p>
  Select any text below. This is the real renderer's output and the real
  <code>anchorFromRange</code> — the offsets you see are what the server would store.
</p>

<div id="demo-doc">${html}</div>
<div id="readout" class="card"><p class="muted small" style="margin:0">Nothing selected yet — drag across a few words above.</p></div>

<p class="small muted">
  Try the escaped text if you add one (<code>\\*not bold\\*</code>): rendered text is shorter
  than its source there, so offsets inside it aren't linear and the anchor covers the whole
  run instead, flagged <code>approx</code>.
</p>

<h2>4 · Auto-resolve</h2>
<p>
  On a later round each comment's remembered text is searched for in the new file. That
  single test decides everything, and needs no cooperation from the agent — editing by hand
  counts too.
</p>

<div class="two">
  <div class="card">
    <span class="tag">still open</span>
    <p class="small" style="margin:0 0 .4rem">The text is still there, so the comment stands — re-pointed at its new offsets.</p>
    <table>
      <tr><th>round</th><th>offsets</th><th>line</th></tr>
      <tr><td>1</td><td><code>${round1[0].anchor.startOffset}:${round1[0].anchor.endOffset}</code></td><td>${round1[0].anchor.startLine}</td></tr>
      <tr><td>2</td><td><code>${stillOpen[0].anchor.startOffset}:${stillOpen[0].anchor.endOffset}</code></td><td>${stillOpen[0].anchor.startLine}</td></tr>
    </table>
    <p class="small muted" style="margin:.3rem 0 0">
      A paragraph was inserted above it, so it moved — and was found anyway.
    </p>
  </div>
  <div class="card">
    <span class="tag">resolved</span>
    <p class="small" style="margin:0 0 .4rem">The text is gone, so the agent rewrote it. Collapsed into the Resolved strip.</p>
    <p class="small" style="margin:0">
      <span class="diff-del">${esc(resolved[0].anchor.quote)}</span><br />
      <span class="diff-add">Track p95 latency weekly.</span>
    </p>
    <p class="small muted" style="margin:.5rem 0 0">
      <code>resolvedBy: ${esc(JSON.stringify(resolved[0].resolvedBy))}</code>
    </p>
  </div>
</div>

<h3>Picking between duplicates</h3>
<p class="small">
  When the remembered text appears more than once, the ${'≈'}40 characters either side
  decide; if those changed too, the occurrence index the comment was originally on breaks
  the tie. Proximity of raw offsets is deliberately <em>not</em> the signal — inserting a
  paragraph shifts every offset below it, which would make the wrong occurrence look
  closer.
</p>

<h2>5 · Knowing the tab closed</h2>
<p>
  The page holds one Server-Sent Events stream open. Nothing is read from it — its
  existence is the signal, and <code>close</code> fires even if the browser crashes, which
  <code>beforeunload</code> does not. A grace window tells a reload apart from a goodbye.
</p>

<div class="timeline">
  <div class="small"><b>Reload</b> — the stream drops and comes straight back</div>
  <div class="track">
    <div class="rail"></div>
    <div class="grace" style="left:30%; width:22%"></div>
    <div class="ev" style="left:12%"><i></i><span>stream open</span></div>
    <div class="ev" style="left:30%"><i></i><span>drops<br />grace starts</span></div>
    <div class="ev" style="left:52%"><i></i><span>reconnects<br />grace cancelled</span></div>
    <div class="ev" style="left:82%"><i></i><span class="outcome alive">review continues</span></div>
  </div>

  <div class="small"><b>Tab closed</b> — nothing comes back</div>
  <div class="track">
    <div class="rail"></div>
    <div class="grace" style="left:30%; width:34%"></div>
    <div class="ev" style="left:12%"><i></i><span>stream open</span></div>
    <div class="ev" style="left:30%"><i></i><span>drops<br />grace starts</span></div>
    <div class="ev" style="left:64%"><i></i><span>1500 ms elapsed</span></div>
    <div class="ev" style="left:86%"><i></i><span class="outcome done">finalise &amp; exit</span></div>
  </div>
</div>
<p class="small muted">
  <kbd>Ctrl</kbd>+<kbd>C</kbd> finalises too, so an interrupted session still hands over
  whatever comments exist. Every comment is written to the sidecar the moment it is posted,
  so nothing depends on a clean shutdown.
</p>

<h2>6 · What the agent receives</h2>
<div class="two">
  <div>
    <span class="tag">round one · stdout</span>
    <pre><code>${esc(report1)}</code></pre>
  </div>
  <div>
    <span class="tag">round two · after the edit</span>
    <pre><code>${esc(report2)}</code></pre>
  </div>
</div>
<p class="small muted">
  <code>Replace:</code>/<code>With:</code> blocks are exact source text, so a suggestion is
  applied rather than interpreted. “No open comments” is an explicit success — it means the
  draft reads fine, not that something broke.
</p>

<h2>7 · The pieces</h2>
<table>
  <tr><th>file</th><th>does</th><th class="small">lines</th></tr>
  ${MODULES.map(
    (m) =>
      `<tr><td><code>${esc(m.path)}</code></td><td class="small">${esc(m.purpose)}</td><td class="small muted">${m.lines}</td></tr>`,
  ).join('\n  ')}
</table>
<p class="small muted">
  The first three are the whole trick; the rest is plumbing. The client ships unbundled —
  Preact and htm arrive as one self-contained ES module, so <code>client/</code> is both the
  source and what runs.
</p>

<footer>
  Generated ${esc('by docs/build-docs.mjs')} · regenerate with <code>yarn docs</code>
</footer>
</div>

<script type="module">
${selectionSource}

/* ---- demo wiring: the code above is the shipping module, unmodified ---- */

const SOURCE = ${js(DRAFT)};
const root = document.getElementById('demo-doc');
const readout = document.getElementById('readout');
const canHighlight = typeof CSS !== 'undefined' && 'highlights' in CSS;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function show() {
  const anchor = anchorFromSelection(window.getSelection(), root);
  if (anchor === null) return;

  const slice = SOURCE.slice(anchor.startOffset, anchor.endOffset);
  const exact = slice === anchor.quote;

  if (canHighlight) {
    CSS.highlights.set('demo-hl', new Highlight(
      ...rangesForSource(root, anchor.startOffset, anchor.endOffset),
    ));
  }

  readout.innerHTML = \`
    <table>
      <tr><th>offsets</th><td><code>\${anchor.startOffset}:\${anchor.endOffset}</code></td></tr>
      <tr><th>you saw</th><td><code>\${esc(JSON.stringify(anchor.quote))}</code></td></tr>
      <tr><th>source slice</th><td><code>\${esc(JSON.stringify(slice))}</code></td></tr>
      <tr><th>approx</th><td><code>\${anchor.approx}</code></td></tr>
      <tr><th>verdict</th><td class="verdict \${anchor.approx ? 'approx' : 'ok'}">\${
        anchor.approx
          ? 'offsets not linear here — the anchor covers the whole run'
          : exact
            ? 'source slice matches what you selected'
            : 'range spans markup between the two endpoints'
      }</td></tr>
    </table>\`;
}

root.addEventListener('mouseup', show);
root.addEventListener('keyup', show);
</script>
</body>
</html>
`;

mkdirSync(join(ROOT, 'docs'), { recursive: true });
writeFileSync(OUT, page, 'utf8');
console.log(`wrote ${OUT} (${(page.length / 1024).toFixed(1)} kB)`);
