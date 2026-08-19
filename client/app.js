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
import { passageAtPoint, placeCard, unionRect } from './popover.js';
import { createComment, deleteComment, fetchDoc, finalize, openLiveness } from './api.js';
import { currentTheme, setTheme, watchSystemTheme } from './theme.js';

/** Space between a passage and the card hanging below it. */
const GAP = 10;

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

/**
 * Shows the theme you would switch *to*, which is the usual convention: a moon while
 * light, a sun while dark.
 */
function ThemeToggle() {
  const [theme, setLocal] = useState(currentTheme);

  // Follow the OS for as long as no choice has been stored.
  useEffect(() => watchSystemTheme(setLocal), []);

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

function Header({ file, openCount, resolvedCount, onSend, sending }) {
  const label = openCount === 1 ? '1 comment' : `${openCount} comments`;
  return html`
    <header class="topbar">
      <span class="file">${file}</span>
      <span class="count" tabindex="0">
        ${label}${resolvedCount > 0 ? html` · <span class="muted">${resolvedCount} resolved</span>` : null}
        <span class="hint" role="tooltip">Highlight any text to comment on it. Close the tab when
          you're done and the agent picks the comments up.</span>
      </span>
      <${ThemeToggle} />
      <button class="send" onClick=${onSend} disabled=${sending}>
        ${sending ? 'Sending…' : 'Send'}
      </button>
    </header>
  `;
}

function Quote({ text }) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const clipped = oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine;
  return html`<q class="quote">${clipped}</q>`;
}

const CloseIcon = () => html`
  <svg
    viewBox="0 0 16 16"
    width="13"
    height="13"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
  >
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
`;

function CommentCard({ comment, onClose, onDelete }) {
  return html`
    <article class="card">
      <button class="icon-button card-close" onClick=${onClose} title="Close" aria-label="Close">
        <${CloseIcon} />
      </button>
      <${Quote} text=${comment.anchor.quote} />
      ${comment.body.trim() === '' ? null : html`<p class="body">${comment.body}</p>`}
      ${comment.suggestion === undefined
        ? null
        : html`
            <div class="suggestion">
              <span class="tag">suggested rewrite</span>
              <pre>${comment.suggestion}</pre>
            </div>
          `}
      <footer>
        <span class="lines">
          ${comment.anchor.startLine === comment.anchor.endLine
            ? `line ${comment.anchor.startLine}`
            : `lines ${comment.anchor.startLine}–${comment.anchor.endLine}`}
        </span>
        <button class="link danger" onClick=${onDelete} title="Delete this comment">delete</button>
      </footer>
    </article>
  `;
}

/**
 * The document text a draft points at. The suggestion field is prefilled with this, so an
 * untouched prefill compares equal — and a suggestion equal to the source is not a rewrite.
 * @returns {string}
 */
function sourceSlice(source, anchor) {
  return source.slice(anchor.startOffset, anchor.endOffset);
}

/**
 * The suggestion worth sending, or undefined when there is none. An unedited prefill would
 * otherwise reach the report as `Replace: x / With: x` and mislabel the whole comment as a
 * rewrite, burying the real instruction in the body.
 * @returns {string | undefined}
 */
function effectiveSuggestion(draft, source) {
  if (draft.suggestion === null) return undefined;
  if (draft.suggestion === sourceSlice(source, draft.anchor)) return undefined;
  return draft.suggestion;
}

function DraftCard({ draft, source, onChange, onSave, onCancel, saving }) {
  const textarea = useRef(null);
  useEffect(() => {
    textarea.current?.focus();
  }, []);

  const suggesting = draft.suggestion !== null;
  const rewrite = effectiveSuggestion(draft, source);
  const canSave = draft.body.trim() !== '' || (rewrite !== undefined && rewrite.trim() !== '');

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

  return html`
    <article class="card draft">
      <button class="icon-button card-close" onClick=${onCancel} title="Cancel" aria-label="Cancel">
        <${CloseIcon} />
      </button>
      <${Quote} text=${draft.anchor.quote} />
      <textarea
        ref=${textarea}
        rows="3"
        placeholder="What should change?"
        value=${draft.body}
        onInput=${(e) => onChange({ ...draft, body: e.target.value })}
        onKeyDown=${onKeyDown}
      ></textarea>

      ${suggesting
        ? html`
            <label class="suggest-field">
              <span class="tag">replace with</span>
              <textarea
                rows="3"
                value=${draft.suggestion}
                onInput=${(e) => onChange({ ...draft, suggestion: e.target.value })}
                onKeyDown=${onKeyDown}
              ></textarea>
            </label>
          `
        : null}

      <footer>
        <button
          class="link"
          onClick=${() =>
            onChange({
              ...draft,
              suggestion: suggesting ? null : sourceSlice(source, draft.anchor),
            })}
        >
          ${suggesting ? 'drop suggestion' : 'suggest a rewrite'}
        </button>
        <span class="spacer"></span>
        <button class="link" onClick=${onCancel}>cancel</button>
        <button class="primary" onClick=${onSave} disabled=${!canSave || saving}>comment</button>
      </footer>
    </article>
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

function Sent({ count }) {
  return html`
    <div class="sent">
      <h1>Review sent</h1>
      <p>
        ${count === 0
          ? 'No comments — the agent will hear that the draft reads fine.'
          : `${count === 1 ? '1 comment' : `${count} comments`} handed back to the agent.`}
      </p>
      <p class="muted">You can close this tab.</p>
    </div>
  `;
}

function App() {
  const [doc, setDoc] = useState(null);
  const [draft, setDraft] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [pos, setPos] = useState(null);
  const [sent, setSent] = useState(null);
  /**
   * Which request is in flight: 'comment' while one is being saved, 'review' while the
   * whole review is being handed back, null otherwise. One flag for both would have the
   * Send button announce "Sending…" every time a comment was saved.
   */
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);

  const docRef = useRef(null);
  const popoverRef = useRef(null);

  useEffect(() => {
    fetchDoc().then(setDoc).catch((e) => setError(e.message));
    // Existence of this stream is how the server knows the tab is still open.
    const stream = openLiveness();
    return () => stream.close();
  }, []);

  const open = doc === null ? [] : [...doc.open].sort(byPosition);

  /** The one card on screen: a draft being composed, or the comment whose popover is open. */
  const shown = draft !== null ? draft : (open.find((c) => c.id === openId) ?? null);

  /** Hang the card below its passage. Re-run whenever the passage may have moved. */
  const reposition = useCallback(() => {
    const root = docRef.current;
    const card = popoverRef.current;
    if (root === null || card === null || shown === null) {
      setPos(null);
      return;
    }
    const rects = anchorRects(root, shown.anchor);
    if (rects.length === 0) {
      setPos(null);
      return;
    }
    setPos(placeCard(unionRect(rects), card.offsetWidth, root.clientWidth, GAP));
  }, [doc, draft, openId]);

  // A layout effect, so the card is placed before the browser paints it.
  useLayoutEffect(reposition, [doc, draft, openId]);

  useEffect(() => {
    if (doc === null) return;
    const onResize = () => reposition();
    window.addEventListener('resize', onResize);
    document.fonts?.ready.then(reposition);
    return () => window.removeEventListener('resize', onResize);
  }, [doc, draft, openId]);

  useEffect(() => {
    const root = docRef.current;
    if (root === null || doc === null) return;
    paintHighlights(root, open, shown?.anchor ?? null);
  }, [doc, draft, openId]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      if (draft !== null) setDraft(null);
      else setOpenId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft]);

  const startDraft = useCallback(() => {
    if (sent !== null) return;
    const anchor = anchorFromSelection(window.getSelection(), docRef.current);
    if (anchor === null) return;
    setDraft({ anchor, body: '', suggestion: null });
    setOpenId(null);
  }, [sent]);

  /**
   * Opens the comment on the clicked passage, and closes the open one when a click lands
   * anywhere else. Listening on the document rather than on the column is what makes the
   * empty space past the end of the text dismiss the card.
   *
   * The highlights are painted ranges rather than elements, so there is nothing to click
   * on directly — the passage has to be found by hit-testing.
   */
  useEffect(() => {
    const onClick = (event) => {
      if (sent !== null) return;
      const root = docRef.current;
      if (root === null) return;
      // Clicks inside the card are the card's own business.
      if (popoverRef.current?.contains(event.target) === true) return;
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
      setOpenId(
        passageAtPoint(passages, {
          x: event.clientX - origin.left,
          y: event.clientY - origin.top,
        }),
      );
    };

    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [doc, draft, sent]);

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
        effectiveSuggestion(draft, doc.source),
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
      setDoc((prev) => ({ ...prev, open: prev.open.filter((c) => c.id !== id) }));
    } catch (e) {
      setError(e.message);
    }
  };

  const send = async () => {
    setPending('review');
    try {
      await finalize();
      setSent(open.length);
    } catch (e) {
      setError(e.message);
      setPending(null);
    }
  };

  if (error !== null && doc === null) {
    return html`<div class="sent"><h1>Could not load the review</h1><p>${error}</p></div>`;
  }
  if (doc === null) return html`<div class="loading">Loading…</div>`;
  if (sent !== null) return html`<${Sent} count=${sent} />`;

  return html`
    <${Header}
      file=${doc.file}
      openCount=${open.length}
      resolvedCount=${doc.resolved.length}
      onSend=${send}
      sending=${pending === 'review'}
    />

    ${error === null ? null : html`<div class="error" onClick=${() => setError(null)}>${error}</div>`}

    <main>
      <div class="column">
        <article
          id="doc"
          ref=${docRef}
          onMouseUp=${startDraft}
          onKeyUp=${startDraft}
          dangerouslySetInnerHTML=${{ __html: doc.html }}
        ></article>

        ${shown === null
          ? null
          : html`
              <div
                class="popover"
                ref=${popoverRef}
                style=${pos === null
                  ? 'visibility:hidden'
                  : `top:${pos.top}px;left:${pos.left}px`}
              >
                ${draft !== null
                  ? html`
                      <${DraftCard}
                        draft=${draft}
                        source=${doc.source}
                        saving=${pending === 'comment'}
                        onChange=${setDraft}
                        onSave=${save}
                        onCancel=${() => setDraft(null)}
                      />
                    `
                  : html`
                      <${CommentCard}
                        comment=${shown}
                        onClose=${() => setOpenId(null)}
                        onDelete=${() => remove(shown.id)}
                      />
                    `}
              </div>
            `}
      </div>
    </main>

    <${ResolvedStrip} resolved=${doc.resolved} />
  `;
}

render(html`<${App} />`, document.getElementById('root'));
