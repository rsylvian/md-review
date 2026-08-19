/** Thin wrappers over the review server's HTTP API. */

async function json(response) {
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error ?? `request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

/** The document under review, plus any comments carried over from earlier rounds. */
export function fetchDoc() {
  return fetch('/api/doc').then(json);
}

/**
 * @param {{startOffset: number, endOffset: number, quote: string, approx: boolean}} anchor
 * @param {string} body
 * @param {string | undefined} suggestion
 */
export function createComment(anchor, body, suggestion) {
  return fetch('/api/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...anchor,
      body,
      ...(suggestion === undefined ? {} : { suggestion }),
    }),
  }).then(json);
}

export function deleteComment(id) {
  return fetch(`/api/comments/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(json);
}

/** Ends the review now, rather than waiting for the tab to close. */
export function finalize() {
  return fetch('/api/finalize', { method: 'POST' }).then(json);
}

/**
 * Holds the connection the server uses to notice the tab closing. Nothing is read from
 * it — its existence is the signal.
 */
export function openLiveness() {
  return new EventSource('/api/live');
}
