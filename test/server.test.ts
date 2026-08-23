import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startReviewServer, type ReviewServer } from '../src/server.ts';
import { loadReview, sidecarPathFor } from '../src/store.ts';
import { buildAnchor } from '../src/anchors.ts';

const DOC = [
  '# Overview',
  '',
  'The system serves the actual users of this thing.',
  '',
  'We should probably measure this.',
].join('\n');

const CLIENT_DIR = join(import.meta.dirname, '..', 'client');
const VENDOR_FILE = join(
  import.meta.dirname,
  '..',
  'node_modules',
  'htm',
  'preact',
  'standalone.module.js',
);

let root: string;
let home: string;
let server: ReviewServer;

async function start(overrides: Partial<Parameters<typeof startReviewServer>[0]> = {}) {
  server = await startReviewServer({
    filePath: 'draft.md',
    source: DOC,
    sidecarPath: sidecarPathFor('draft.md', root, home),
    clientDir: CLIENT_DIR,
    vendorFile: VENDOR_FILE,
    port: 0,
    graceMs: 60,
    ...overrides,
  });
  return server;
}

/** Opens the liveness stream the way the browser does, and returns a way to drop it. */
async function openLiveness(base: string): Promise<() => void> {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/live`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  // Start consuming so the connection is genuinely established.
  const reader = res.body!.getReader();
  void reader.read().catch(() => {});
  return () => controller.abort();
}

async function postComment(base: string, needle: string, body: string, suggestion?: string) {
  const start = DOC.indexOf(needle);
  const res = await fetch(`${base}/api/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      startOffset: start,
      endOffset: start + needle.length,
      quote: needle,
      body,
      ...(suggestion === undefined ? {} : { suggestion }),
    }),
  });
  return res;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'md-review-server-'));
  home = mkdtempSync(join(tmpdir(), 'md-review-home-'));
});

afterEach(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('review server', () => {
  it('serves the document with position-annotated html', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/api/doc`);
    const doc = await res.json();

    expect(res.status).toBe(200);
    expect(doc.file).toBe('draft.md');
    expect(doc.source).toBe(DOC);
    expect(doc.html).toContain('data-pos=');
    expect(doc.open).toEqual([]);
    expect(doc.resolved).toEqual([]);
  });

  it('serves the review page and the vendored client runtime', async () => {
    const { url } = await start();

    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');

    const vendor = await fetch(`${url}/vendor/htm-preact.js`);
    expect(vendor.status).toBe(200);
    expect(vendor.headers.get('content-type')).toContain('javascript');
    expect(await vendor.text()).toContain('export{');
  });

  it('refuses to serve files outside the client directory', async () => {
    const { url } = await start();

    for (const path of ['/../package.json', '/%2e%2e/package.json', '/../../etc/passwd']) {
      const res = await fetch(`${url}${path}`, { redirect: 'manual' });
      expect(res.status, path).not.toBe(200);
    }
  });

  it('creates a comment, anchoring it against the server’s own copy of the source', async () => {
    const { url } = await start();

    const res = await postComment(url, 'the actual users', 'name them');
    expect(res.status).toBe(201);
    const created = await res.json();

    expect(created.id).toBeTruthy();
    expect(created.body).toBe('name them');
    expect(created.status).toBe('open');
    expect(created.anchor.sourceText).toBe('the actual users');
    expect(created.anchor.startLine).toBe(3);

    const doc = await (await fetch(`${url}/api/doc`)).json();
    expect(doc.open).toHaveLength(1);
  });

  it('writes through to the sidecar on every mutation', async () => {
    const { url } = await start();
    const sidecar = sidecarPathFor('draft.md', root, home);

    await postComment(url, 'the actual users', 'name them');

    const stored = loadReview(sidecar);
    expect(stored!.comments).toHaveLength(1);
    expect(stored!.comments[0]!.body).toBe('name them');
  });

  it('stores a suggested rewrite alongside the comment', async () => {
    const { url } = await start();

    const res = await postComment(
      url,
      'We should probably measure this.',
      'be concrete',
      'Track p95 latency weekly.',
    );
    const created = await res.json();

    expect(created.suggestion).toBe('Track p95 latency weekly.');
  });

  it('rejects malformed comments', async () => {
    const { url } = await start();

    const cases = [
      { startOffset: -1, endOffset: 5, body: 'x' },
      { startOffset: 5, endOffset: 1, body: 'x' },
      { startOffset: 0, endOffset: DOC.length + 50, body: 'x' },
      { startOffset: 0, endOffset: 5 }, // no body and no suggestion
      { startOffset: 0, endOffset: 5, body: '   ' },
    ];

    for (const payload of cases) {
      const res = await fetch(`${url}/api/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(res.status, JSON.stringify(payload)).toBe(400);
    }

    const bad = await fetch(`${url}/api/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(bad.status).toBe(400);
  });

  it('deletes a comment', async () => {
    const { url } = await start();
    const created = await (await postComment(url, 'the actual users', 'name them')).json();

    const del = await fetch(`${url}/api/comments/${created.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    const doc = await (await fetch(`${url}/api/doc`)).json();
    expect(doc.open).toHaveLength(0);
    expect(loadReview(sidecarPathFor('draft.md', root, home))!.comments).toHaveLength(0);
  });

  it('404s when deleting something that is not there', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/api/comments/nope`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('finalises when the Send button is pressed', async () => {
    const { url, finished } = await start();
    await postComment(url, 'the actual users', 'name them');

    const res = await fetch(`${url}/api/finalize`, { method: 'POST' });
    expect(res.status).toBe(200);

    const result = await finished;
    expect(result.reason).toBe('sent');
    expect(result.report).toContain('1 open comment');
    expect(result.report).toContain('name them');
    expect(result.payload.openCount).toBe(1);
  });

  it('finalises when the tab closes', async () => {
    const { url, finished } = await start();
    await postComment(url, 'the actual users', 'name them');
    const drop = await openLiveness(url);

    drop();

    const result = await finished;
    expect(result.reason).toBe('tab-closed');
    expect(result.report).toContain('name them');
  });

  it('survives a reload inside the grace window', async () => {
    const { url, finished } = await start({ graceMs: 250 });
    const drop = await openLiveness(url);

    let finalized = false;
    void finished.then(() => {
      finalized = true;
    });

    drop();
    await wait(60);
    // The reloaded page reconnects before the grace window expires.
    await openLiveness(url);
    await wait(400);

    expect(finalized).toBe(false);

    const doc = await (await fetch(`${url}/api/doc`)).json();
    expect(doc.file).toBe('draft.md');
  });

  it('does not finalise before the browser has ever connected', async () => {
    const { finished } = await start({ graceMs: 40 });

    let finalized = false;
    void finished.then(() => {
      finalized = true;
    });
    await wait(150);

    expect(finalized).toBe(false);
  });

  it('reports no open comments when the reviewer leaves none', async () => {
    const { url, finished } = await start();
    const drop = await openLiveness(url);

    drop();

    const result = await finished;
    expect(result.report).toContain('No open comments');
    expect(result.payload.openCount).toBe(0);
  });

  it('auto-resolves last round’s comments whose text the agent rewrote', async () => {
    // Seed a sidecar as if a previous round had left two comments.
    const sidecar = sidecarPathFor('draft.md', root, home);
    mkdirSync(dirname(sidecar), { recursive: true });
    const anchorOn = (needle: string) => {
      const start = DOC.indexOf(needle);
      return buildAnchor(DOC, start, start + needle.length, needle);
    };
    writeFileSync(
      sidecar,
      JSON.stringify({
        file: 'draft.md',
        updatedAt: 'earlier',
        comments: [
          {
            id: 'still-open',
            body: 'name them',
            createdAt: 'earlier',
            status: 'open',
            anchor: anchorOn('the actual users'),
          },
          {
            id: 'addressed',
            body: 'be concrete',
            createdAt: 'earlier',
            status: 'open',
            anchor: anchorOn('We should probably measure this.'),
          },
        ],
      }),
    );

    // The agent rewrote the second passage but not the first.
    const revised = DOC.replace('We should probably measure this.', 'Track p95 latency weekly.');
    const { url } = await start({ source: revised });

    const doc = await (await fetch(`${url}/api/doc`)).json();

    expect(doc.open.map((c: { id: string }) => c.id)).toEqual(['still-open']);
    expect(doc.resolved.map((c: { id: string }) => c.id)).toEqual(['addressed']);
    expect(doc.resolved[0].resolvedBy).toBe('text-changed');
  });

  it('reports only the comments resolved this round, not every one ever resolved', async () => {
    const sidecar = sidecarPathFor('draft.md', root, home);
    mkdirSync(dirname(sidecar), { recursive: true });
    const anchorOn = (needle: string) => {
      const start = DOC.indexOf(needle);
      return buildAnchor(DOC, start, start + needle.length, needle);
    };
    writeFileSync(
      sidecar,
      JSON.stringify({
        file: 'draft.md',
        updatedAt: 'earlier',
        comments: [
          {
            id: 'resolved-long-ago',
            body: 'an old note the agent already dealt with',
            createdAt: 'earlier',
            status: 'resolved',
            resolvedBy: 'text-changed',
            resolvedAt: '2026-08-01T00:00:00.000Z',
            anchor: anchorOn('# Overview'),
          },
          {
            id: 'addressed-now',
            body: 'be concrete',
            createdAt: 'earlier',
            status: 'open',
            anchor: anchorOn('We should probably measure this.'),
          },
        ],
      }),
    );

    // This round the agent rewrote the passage behind 'addressed-now'.
    const revised = DOC.replace('We should probably measure this.', 'Track p95 latency weekly.');
    const { url, finished, finalize } = await start({ source: revised });
    await openLiveness(url);
    finalize('sent');
    const { report, payload } = await finished;

    // The resolved section lists quotes, so those are what to assert on.
    expect(report).toContain('1 resolved since last round');
    expect(report).toContain('We should probably measure this.');
    expect(report).not.toContain('# Overview');
    expect(payload.resolvedCount).toBe(1);
  });

  it('persists auto-resolutions immediately, before any new interaction', async () => {
    const sidecar = sidecarPathFor('draft.md', root, home);
    mkdirSync(dirname(sidecar), { recursive: true });
    const start_ = DOC.indexOf('the actual users');
    writeFileSync(
      sidecar,
      JSON.stringify({
        file: 'draft.md',
        updatedAt: 'earlier',
        comments: [
          {
            id: 'addressed',
            body: 'x',
            createdAt: 'earlier',
            status: 'open',
            anchor: buildAnchor(
              DOC,
              start_,
              start_ + 'the actual users'.length,
              'the actual users',
            ),
          },
        ],
      }),
    );

    await start({ source: DOC.replace('the actual users', 'data engineers') });

    const stored = loadReview(sidecar);
    expect(stored!.comments[0]!.status).toBe('resolved');
  });

  it('finalises only once even if asked twice', async () => {
    const { url, finished } = await start();

    await fetch(`${url}/api/finalize`, { method: 'POST' });
    const second = await fetch(`${url}/api/finalize`, { method: 'POST' });

    expect(second.status).toBe(409);
    const result = await finished;
    expect(result.reason).toBe('sent');
  });

  it('refuses to mutate after finalising', async () => {
    const { url, finished } = await start();
    await fetch(`${url}/api/finalize`, { method: 'POST' });
    await finished;

    const res = await postComment(url, 'the actual users', 'too late');
    expect(res.status).toBe(409);
  });
});
