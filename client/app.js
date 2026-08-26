import {
  html,
  render,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from './vendor/htm-preact.js';
import { anchorFromSelection } from './selection.js';
import { anchorRects, paintHighlights } from './highlight.js';
import { passageAtPoint } from './popover.js';
import { createComment, deleteComment, fetchDoc, finalize, openLiveness } from './api.js';
import { currentTheme, setTheme, watchSystemTheme } from './theme.js';
import { formatRelativeTime } from './relative-time.js';

const byPosition = (a, b) => a.anchor.startOffset - b.anchor.startOffset;

const SunIcon = () => html`
  <svg
    viewBox="0 0 16 16"
    width="15"
    height="15"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
  >
    <circle cx="8" cy="8" r="3.1" />
    <path
      d="M8 1.1v1.5M8 13.4v1.5M1.1 8h1.5M13.4 8h1.5M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1"
    />
  </svg>
`;

const MoonIcon = () => html`
  <svg
    viewBox="0 0 16 16"
    width="15"
    height="15"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M13.4 9.9A5.7 5.7 0 0 1 6.1 2.6 5.9 5.9 0 1 0 13.4 9.9Z" />
  </svg>
`;

const TrashIcon = () => html`
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M3 4.5h10" />
    <path d="M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
    <path d="M4.5 4.5l.6 8.4a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.4" />
    <path d="M6.7 7v4M9.3 7v4" />
  </svg>
`;

/**
 * Shows the theme you would switch *to*, which is the usual convention: a moon while
 * light, a sun while dark.
 */
function ThemeToggle() {
  const [theme, setLocal] = useState(currentTheme);

  // Follow the OS for as long as no choice has been stored. A layout effect so the
  // listener is attached before the browser can dispatch a change event racing it —
  // a plain useEffect defers attachment to the next animation frame, which can lose
  // a change event that fires in between (see #27).
  useLayoutEffect(() => watchSystemTheme(setLocal), []);

  const next = theme === 'dark' ? 'light' : 'dark';
  const flip = () => {
    setTheme(next);
    setLocal(next);
  };

  return html`
    <button
      class="icon-button"
      onClick=${flip}
      title=${`Switch to ${next} theme`}
      aria-label=${`Switch to ${next} theme`}
    >
      ${theme === 'dark' ? html`<${SunIcon} />` : html`<${MoonIcon} />`}
    </button>
  `;
}

function Header({ file, openCount, updatedAt, panelOpen, onTogglePanel }) {
  return html`
    <header class="topbar">
      <span class="file">${file}</span>
      <span class="count">Updated ${formatRelativeTime(updatedAt)}</span>
      <span class="topbar-spacer"></span>
      <button
        class="panel-toggle"
        onClick=${onTogglePanel}
        aria-pressed=${panelOpen}
        aria-label="Toggle the comments panel"
      >
        Comments (${openCount})
      </button>
      <span class="topbar-panel-align">
        <${ThemeToggle} />
      </span>
    </header>
  `;
}

function Quote({ text, max = 90 }) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const clipped = oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  return html`<q class="quote">${clipped}</q>`;
}

/**
 * The document text a draft points at, quoted in the Rewrite placeholder so the reviewer
 * knows what their replacement text is standing in for.
 * @returns {string}
 */
function sourceSlice(source, anchor) {
  return source.slice(anchor.startOffset, anchor.endOffset);
}

/**
 * The suggestion worth sending: an explicit empty string for a deletion (replace with
 * nothing), the typed replacement for a rewrite, or undefined when there is none — an
 * empty or whitespace-only rewrite field means the reviewer never actually wrote one.
 * @returns {string | undefined}
 */
function effectiveSuggestion(draft) {
  if (draft.deleting) return '';
  if (draft.suggestion === null || draft.suggestion.trim() === '') return undefined;
  return draft.suggestion;
}

/**
 * Mirrors src/anchors.ts's offsetToLine: a saved comment's anchor already carries
 * startLine/endLine from the server, but a draft (built client-side from a raw
 * Selection) only has offsets, so the composer needs to derive them itself.
 */
function offsetToLine(source, offset) {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  for (let i = 0; i < clamped; i++) {
    if (source[i] === '\n') line++;
  }
  if (clamped === source.length && source.endsWith('\n')) line--;
  return Math.max(1, line);
}

function lineLabel(source, anchor) {
  const startLine = anchor.startLine ?? offsetToLine(source, anchor.startOffset);
  const endLine =
    anchor.endLine ?? offsetToLine(source, Math.max(anchor.startOffset, anchor.endOffset - 1));
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
}

/** A one-line, length-clipped quote for the Rewrite placeholder. */
function clipOneLine(text, max = 60) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function Composer({ draft, source, onChange, onSave, onCancel, saving }) {
  const textarea = useRef(null);
  useEffect(() => {
    textarea.current?.focus();
  }, []);

  const suggesting = !draft.deleting && draft.suggestion !== null;
  const original = sourceSlice(source, draft.anchor);
  const rewrite = effectiveSuggestion(draft);
  const canSave =
    draft.deleting || draft.body.trim() !== '' || (rewrite !== undefined && rewrite.trim() !== '');

  const onKeyDown = (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canSave) onSave();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  const value = suggesting ? (draft.suggestion ?? '') : draft.body;
  const onInput = (e) =>
    onChange(
      suggesting ? { ...draft, suggestion: e.target.value } : { ...draft, body: e.target.value },
    );

  return html`
    <article class="composer" onKeyDown=${onKeyDown}>
      <div class="segmented">
        <button
          type="button"
          class=${!draft.deleting && !suggesting ? 'active' : ''}
          onClick=${() => onChange({ ...draft, deleting: false, suggestion: null })}
        >
          Note
        </button>
        <button
          type="button"
          class=${suggesting ? 'active' : ''}
          onClick=${() =>
            onChange({
              ...draft,
              deleting: false,
              suggestion: draft.suggestion ?? '',
            })}
        >
          Rewrite
        </button>
        <button
          type="button"
          class=${draft.deleting ? 'active' : ''}
          onClick=${() => onChange({ ...draft, deleting: true })}
        >
          Delete
        </button>
      </div>

      ${
        draft.deleting
          ? html`<p class="composer-delete-note">
            The highlighted passage will be marked for deletion.
          </p>`
          : html`
            <textarea
              ref=${textarea}
              rows="3"
              aria-label=${suggesting ? 'Replacement text' : 'Comment'}
              placeholder=${
                suggesting ? `Replace "${clipOneLine(original)}" with…` : 'What should change?'
              }
              value=${value}
              onInput=${onInput}
            ></textarea>
          `
      }

      <footer class="composer-footer">
        <span class="spacer"></span>
        <button class="link" onClick=${onCancel}>cancel</button>
        <button
          class="primary"
          onClick=${onSave}
          disabled=${!canSave || saving}
        >
          ${draft.deleting ? 'delete' : 'comment'}
          <span class="shortcut" aria-hidden="true">⌘↵</span>
        </button>
      </footer>
    </article>
  `;
}

function CommentRow({ comment, active, onActivate, onDelete }) {
  return html`
    <article
      data-id=${comment.id}
      class=${`comment-row${active ? ' active' : ''}`}
      onClick=${onActivate}
    >
      <div class="head">
        <span class="lines muted">${lineLabel('', comment.anchor)}</span>
        ${
          comment.suggestion === undefined
            ? null
            : comment.suggestion === ''
              ? html`<span class="pill pill-delete">deletion</span>`
              : html`<span class="pill">rewrite</span>`
        }
        <span class="spacer"></span>
        <button
          class="icon-button danger"
          title="Delete this comment"
          aria-label="Delete this comment"
          onClick=${(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <${TrashIcon} />
        </button>
      </div>
      ${comment.body.trim() === '' ? null : html`<p class="body">${comment.body}</p>`}
      ${
        comment.suggestion === undefined || comment.suggestion === ''
          ? null
          : html`<pre class="row-suggestion">${comment.suggestion}</pre>`
      }
    </article>
  `;
}

function PanelHeader({ count, onSend, sending }) {
  return html`
    <div class="panel-header">
      <span class="title">Comments</span>
      <span class="muted">${count}</span>
      <button class="send" onClick=${onSend} disabled=${sending || count === 0}>
        ${sending ? 'Sending…' : 'Send'}
      </button>
    </div>
  `;
}

function Panel({
  open,
  draft,
  source,
  activeId,
  isOpen,
  panelRef,
  panelListRef,
  onChange,
  onSave,
  onCancel,
  saving,
  onSend,
  sending,
  onActivate,
  onDelete,
}) {
  return html`
    <aside class="panel" ref=${panelRef} data-open=${isOpen ? 'true' : 'false'}>
      <${PanelHeader}
        count=${open.length}
        onSend=${onSend}
        sending=${sending}
      />
      <div class="panel-list" ref=${panelListRef}>
        ${
          draft !== null
            ? html`
              <${Composer}
                draft=${draft}
                source=${source}
                saving=${saving}
                onChange=${onChange}
                onSave=${onSave}
                onCancel=${onCancel}
              />
            `
            : null
        }
        ${open.map(
          (comment) => html`
            <${CommentRow}
              key=${comment.id}
              comment=${comment}
              active=${comment.id === activeId}
              onActivate=${() => onActivate(comment.id)}
              onDelete=${() => onDelete(comment.id)}
            />
          `,
        )}
        ${
          draft === null && open.length === 0
            ? html`
              <p class="panel-empty">
                Highlight a sentence in the document to get started.
              </p>
            `
            : null
        }
      </div>
    </aside>
  `;
}

function ResolvedStrip({ resolved }) {
  if (resolved.length === 0) return null;
  return html`
    <details class="resolved">
      <summary>Resolved (${resolved.length})</summary>
      <ul>
        ${resolved.map(
          (comment) => html`
            <li key=${comment.id}>
              <${Quote} text=${comment.anchor.quote} />
              ${comment.body.trim() === '' ? null : html`<span class="body">${comment.body}</span>`}
            </li>
          `,
        )}
      </ul>
    </details>
  `;
}

function Sent({ count, report }) {
  return html`
    <div class="sent">
      <h1>Review sent</h1>
      <p>
        ${
          count === 0
            ? 'No comments — the agent will hear that the draft reads fine.'
            : `${count === 1 ? '1 comment' : `${count} comments`} handed back to the agent.`
        }
      </p>
      <p class="muted">You can close this tab.</p>
      <pre class="report-preview">${report}</pre>
    </div>
  `;
}

/** Scrolls `scroller` so the passage sits 140px from the top of the visible area. */
function scrollPassageIntoView(scroller, docRoot, anchor) {
  const rects = anchorRects(docRoot, anchor);
  if (rects.length === 0) return;
  const passageTop = Math.min(...rects.map((r) => r.top));
  const docRootOffset =
    docRoot.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTo({
    top: Math.max(0, docRootOffset + passageTop - 140),
    behavior: 'smooth',
  });
}

function App() {
  const [doc, setDoc] = useState(null);
  const [draft, setDraft] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [sent, setSent] = useState(null);
  /**
   * Which request is in flight: 'comment' while one is being saved, 'review' while the
   * whole review is being handed back, null otherwise. One flag for both would have the
   * Send button announce "Sending…" every time a comment was saved.
   */
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  // Nothing reads this value directly — it just forces "Updated ... ago" to re-render
  // as time passes, since formatRelativeTime's output isn't otherwise reactive.
  const [, retick] = useState(0);

  const docRef = useRef(null);
  const docScrollerRef = useRef(null);
  const panelRef = useRef(null);
  const panelListRef = useRef(null);

  useEffect(() => {
    fetchDoc()
      .then(setDoc)
      .catch((e) => setError(e.message));
    // Existence of this stream is how the server knows the tab is still open.
    const stream = openLiveness();
    return () => stream.close();
  }, []);

  useEffect(() => {
    const id = setInterval(() => retick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const open = doc === null ? [] : [...doc.open].sort(byPosition);

  /** The one passage highlighted as active: a draft being composed, or the open row. */
  const shown = draft !== null ? draft : (open.find((c) => c.id === openId) ?? null);

  // A layout effect so CSS.highlights is repainted synchronously with the render that
  // triggered it, rather than deferred to the next animation frame — a plain useEffect
  // leaves a window where the DOM (e.g. a new .comment-row) has updated but the
  // highlight paint hasn't caught up yet (see #27).
  useLayoutEffect(() => {
    const root = docRef.current;
    if (root === null || doc === null) return;
    const repaint = () => paintHighlights(root, open, shown?.anchor ?? null);
    repaint();
    document.fonts?.ready.then(repaint);
  }, [doc, draft, openId]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      if (draft !== null) setDraft(null);
      else if (panelOpen) setPanelOpen(false);
      else setOpenId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, panelOpen]);

  const startDraft = useCallback(() => {
    if (sent !== null) return;
    // A draft holds text that isn't saved yet, so it stays until saved or cancelled —
    // the same rule the click-dismiss handler below enforces for clicking elsewhere.
    if (draft !== null) return;
    const anchor = anchorFromSelection(window.getSelection(), docRef.current);
    if (anchor === null) return;
    setDraft({ anchor, body: '', suggestion: null, deleting: false });
    setOpenId(null);
    // Below the docked breakpoint the panel is a peer that must be revealed explicitly;
    // the CSS media query ignores this attribute once the panel is docked.
    setPanelOpen(true);
  }, [sent, draft]);

  /**
   * A drag that ends outside the document — most commonly releasing over the sticky
   * topbar while dragging upward past the visible top of the text — still extends the
   * browser's own Selection correctly, but a mouseup bound only to #doc would never see
   * it. Listening on document, like the click-dismiss handler below, catches it
   * regardless of where the release lands; anchorFromSelection already rejects anything
   * outside #doc, so this can't create a bogus draft from an unrelated selection.
   */
  useEffect(() => {
    document.addEventListener('mouseup', startDraft);
    return () => document.removeEventListener('mouseup', startDraft);
  }, [startDraft]);

  /**
   * Opens the comment on the clicked passage, and closes the open one when a click lands
   * anywhere else. Listening on the document rather than on the column is what makes the
   * empty space past the end of the text dismiss the row.
   *
   * The highlights are painted ranges rather than elements, so there is nothing to click
   * on directly — the passage has to be found by hit-testing. Clicks inside the panel
   * manage openId through their own handlers (row activation, delete) — without this
   * guard, every such click would also bubble here, hit-test against coordinates
   * nowhere near any passage, and immediately clear openId again.
   *
   * A layout effect, not a plain useEffect: this listener closes over `open`, so it
   * must be torn down and re-added synchronously whenever `open` changes — otherwise a
   * click landing before the next animation frame still hits the stale listener and
   * hit-tests against last round's passages (see #27).
   */
  useLayoutEffect(() => {
    const onClick = (event) => {
      if (sent !== null) return;
      const root = docRef.current;
      if (root === null) return;
      if (panelRef.current?.contains(event.target) === true) return;
      // A drag that just selected text has already opened a draft for it.
      const selection = window.getSelection();
      if (selection !== null && !selection.isCollapsed) return;
      // A draft holds text that isn't saved yet, so it stays until saved or cancelled.
      if (draft !== null) return;

      const origin = root.getBoundingClientRect();
      const passages = open.map((comment) => ({
        id: comment.id,
        rects: anchorRects(root, comment.anchor),
      }));
      const hit = passageAtPoint(passages, {
        x: event.clientX - origin.left,
        y: event.clientY - origin.top,
      });
      setOpenId(hit);
      if (hit !== null) setPanelOpen(true);
    };

    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [doc, draft, sent, open]);

  // When a passage click activates a row, bring that row into view within the panel.
  useEffect(() => {
    if (openId === null) return;
    panelListRef.current
      ?.querySelector(`[data-id="${openId}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [openId]);

  const activate = (id) => {
    setOpenId(id);
    const comment = open.find((c) => c.id === id);
    if (comment !== undefined && docScrollerRef.current !== null && docRef.current !== null) {
      scrollPassageIntoView(docScrollerRef.current, docRef.current, comment.anchor);
    }
  };

  const save = async () => {
    setPending('comment');
    try {
      const created = await createComment(
        {
          startOffset: draft.anchor.startOffset,
          endOffset: draft.anchor.endOffset,
          quote: draft.anchor.quote,
          approx: draft.anchor.approx,
        },
        draft.body,
        effectiveSuggestion(draft),
      );
      setDoc((prev) => ({ ...prev, open: [...prev.open, created] }));
      setDraft(null);
      setOpenId(created.id);
      window.getSelection()?.removeAllRanges();
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(null);
    }
  };

  const remove = async (id) => {
    try {
      await deleteComment(id);
      setOpenId(null);
      setDoc((prev) => ({
        ...prev,
        open: prev.open.filter((c) => c.id !== id),
      }));
    } catch (e) {
      setError(e.message);
    }
  };

  const send = async () => {
    setPending('review');
    try {
      const result = await finalize();
      setSent({ count: open.length, report: result.report });
    } catch (e) {
      setError(e.message);
      setPending(null);
    }
  };

  if (error !== null && doc === null) {
    return html`<div class="sent">
      <h1>Could not load the review</h1>
      <p>${error}</p>
    </div>`;
  }
  if (doc === null) return html`<div class="loading">Loading…</div>`;
  if (sent !== null) return html`<${Sent} count=${sent.count} report=${sent.report} />`;

  return html`
    <${Header}
      file=${doc.file}
      openCount=${open.length}
      updatedAt=${doc.sourceModifiedAt}
      panelOpen=${panelOpen}
      onTogglePanel=${() => setPanelOpen((v) => !v)}
    />

    ${
      error === null
        ? null
        : html`<div class="error" onClick=${() => setError(null)}>${error}</div>`
    }

    <main>
      <div class="doc-scroller" ref=${docScrollerRef}>
        <div class="column">
          <article
            id="doc"
            ref=${docRef}
            onKeyUp=${startDraft}
            dangerouslySetInnerHTML=${{ __html: doc.html }}
          ></article>
        </div>
      </div>

      <${Panel}
        open=${open}
        draft=${draft}
        source=${doc.source}
        activeId=${openId}
        isOpen=${panelOpen}
        panelRef=${panelRef}
        panelListRef=${panelListRef}
        saving=${pending === 'comment'}
        onChange=${setDraft}
        onSave=${save}
        onCancel=${() => setDraft(null)}
        onSend=${send}
        sending=${pending === 'review'}
        onActivate=${activate}
        onDelete=${remove}
      />
    </main>

    <${ResolvedStrip} resolved=${doc.resolved} />
  `;
}

render(html`<${App} />`, document.getElementById('root'));
