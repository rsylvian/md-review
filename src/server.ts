import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';
import { buildAnchor, reanchor, type Comment } from './anchors.ts';
import { renderMarkdown } from './render.ts';
import { buildPayload, formatReport, type ReviewPayload } from './report.ts';
import { loadReview, saveReview } from './store.ts';

/**
 * The review server. It holds one document, serves the review page, accepts comments,
 * and — the point of the whole tool — notices when the reviewer closes the tab and
 * finalises the review so the waiting agent can pick it up.
 *
 * Tab-close detection is a Server-Sent Events stream rather than `beforeunload`: the
 * browser holds one connection open, and `close` on the response fires when the tab
 * goes away, including on a crash. A short grace period distinguishes "closed the tab"
 * from "hit reload", which drops and immediately re-establishes the same stream.
 */

export type FinalizeReason = 'tab-closed' | 'sent' | 'signal';

export type FinalizeResult = {
  reason: FinalizeReason;
  report: string;
  payload: ReviewPayload;
};

export type ReviewServerOptions = {
  /** Path shown in the UI and the report, as the user typed it. */
  filePath: string;
  /** The document under review. Read once, so anchors stay consistent. */
  source: string;
  /** When the reviewed file was last modified, shown in the UI as "Updated ... ago". */
  sourceModifiedAt?: string;
  sidecarPath: string;
  clientDir: string;
  /** Absolute path to htm/preact's self-contained ESM build. */
  vendorFile: string;
  port?: number;
  /** How long to wait after the last stream drops before finalising. */
  graceMs?: number;
  now?: () => string;
  newId?: () => string;
};

export type ReviewServer = {
  url: string;
  port: number;
  /** Resolves once the review has been finalised, by any route. */
  finished: Promise<FinalizeResult>;
  /** Finalise explicitly (used for SIGINT). Returns false if already finalised. */
  finalize: (reason: FinalizeReason) => FinalizeResult | false;
  close: () => Promise<void>;
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 1_000_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

type NewCommentRequest = {
  startOffset: number;
  endOffset: number;
  quote?: string;
  approx?: boolean;
  body?: string;
  suggestion?: string;
};

/** Validates a comment request against the server's own copy of the source. */
function validate(payload: unknown, sourceLength: number): NewCommentRequest | string {
  if (typeof payload !== 'object' || payload === null) return 'expected an object';
  const p = payload as Record<string, unknown>;

  const { startOffset, endOffset } = p;
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) {
    return 'startOffset and endOffset must be integers';
  }
  const start = startOffset as number;
  const end = endOffset as number;
  if (start < 0 || end <= start || end > sourceLength) {
    return 'selection is outside the document';
  }

  const body = typeof p.body === 'string' ? p.body : '';
  const suggestion = typeof p.suggestion === 'string' ? p.suggestion : undefined;
  // An explicit empty-string suggestion is a deletion — replace the passage with
  // nothing — so it counts as an instruction on its own, unlike an absent suggestion.
  if (body.trim() === '' && suggestion === undefined) {
    return 'a comment needs a body or a suggestion';
  }

  return {
    startOffset: start,
    endOffset: end,
    quote: typeof p.quote === 'string' ? p.quote : undefined,
    approx: p.approx === true,
    body,
    suggestion,
  };
}

export async function startReviewServer(options: ReviewServerOptions): Promise<ReviewServer> {
  const {
    filePath,
    source,
    sidecarPath,
    clientDir,
    vendorFile,
    port = 0,
    graceMs = 1500,
    now = () => new Date().toISOString(),
    newId = () => randomUUID(),
    sourceModifiedAt = now(),
  } = options;

  const clientRoot = resolve(clientDir);
  const html = renderMarkdown(source);

  // Last round's comments, re-pointed at the current text. Anything whose anchored
  // passage has since been rewritten comes back resolved.
  const prior = loadReview(sidecarPath);
  const state = reanchor(prior?.comments ?? [], source, now);

  const persist = (): void => {
    saveReview(sidecarPath, {
      file: filePath,
      comments: [...state.open, ...state.resolved],
      updatedAt: now(),
    });
  };
  // Record the auto-resolutions straight away, so they survive even if nothing else
  // happens this round.
  persist();

  let finalized = false;
  let resolveFinished: (result: FinalizeResult) => void;
  const finished = new Promise<FinalizeResult>((r) => {
    resolveFinished = r;
  });

  let graceTimer: NodeJS.Timeout | undefined;
  const cancelGrace = (): void => {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
  };

  const finalize = (reason: FinalizeReason): FinalizeResult | false => {
    if (finalized) return false;
    finalized = true;
    cancelGrace();
    const input = {
      filePath,
      open: state.open,
      newlyResolved: state.newlyResolved,
      generatedAt: now(),
    };
    const result: FinalizeResult = {
      reason,
      report: formatReport(input),
      payload: buildPayload(input),
    };
    resolveFinished(result);
    return result;
  };

  const liveStreams = new Set<ServerResponse>();

  const serveFile = async (res: ServerResponse, absolute: string): Promise<void> => {
    try {
      const content = await readFile(absolute);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(absolute)] ?? 'application/octet-stream',
        'content-length': content.length,
        'cache-control': 'no-store',
      });
      res.end(content);
    } catch {
      sendText(res, 404, 'Not found');
    }
  };

  const handleStatic = async (res: ServerResponse, pathname: string): Promise<void> => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }

    const absolute = resolve(clientRoot, `.${decoded === '/' ? '/index.html' : decoded}`);
    // Containment check: a crafted path must not escape the client directory.
    if (absolute !== clientRoot && !absolute.startsWith(clientRoot + sep)) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    await serveFile(res, absolute);
  };

  const handleLiveness = (res: ServerResponse): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Defeats buffering by any proxy sitting in front of localhost.
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    liveStreams.add(res);
    // The page is back (first load, or a reload landing inside the grace window).
    cancelGrace();

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    heartbeat.unref();

    res.on('close', () => {
      clearInterval(heartbeat);
      liveStreams.delete(res);
      if (liveStreams.size === 0 && !finalized) {
        graceTimer = setTimeout(() => finalize('tab-closed'), graceMs);
      }
    });
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (pathname === '/api/live' && method === 'GET') {
      handleLiveness(res);
      return;
    }

    if (pathname === '/vendor/htm-preact.js' && method === 'GET') {
      await serveFile(res, vendorFile);
      return;
    }

    if (pathname === '/api/doc' && method === 'GET') {
      sendJson(res, 200, {
        file: filePath,
        source,
        sourceModifiedAt,
        html,
        open: state.open,
        resolved: state.resolved,
      });
      return;
    }

    if (pathname === '/api/comments' && method === 'POST') {
      if (finalized) {
        sendJson(res, 409, { error: 'review already finalised' });
        return;
      }
      let payload: unknown;
      try {
        payload = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }

      const validated = validate(payload, source.length);
      if (typeof validated === 'string') {
        sendJson(res, 400, { error: validated });
        return;
      }

      const comment: Comment = {
        id: newId(),
        body: validated.body ?? '',
        ...(validated.suggestion === undefined ? {} : { suggestion: validated.suggestion }),
        anchor: buildAnchor(
          source,
          validated.startOffset,
          validated.endOffset,
          validated.quote,
          validated.approx,
        ),
        createdAt: now(),
        status: 'open',
      };
      state.open.push(comment);
      persist();
      sendJson(res, 201, comment);
      return;
    }

    const deleteMatch = /^\/api\/comments\/([^/]+)$/.exec(pathname);
    if (deleteMatch && method === 'DELETE') {
      if (finalized) {
        sendJson(res, 409, { error: 'review already finalised' });
        return;
      }
      const id = decodeURIComponent(deleteMatch[1]!);
      const index = state.open.findIndex((c) => c.id === id);
      if (index === -1) {
        sendJson(res, 404, { error: 'no such comment' });
        return;
      }
      state.open.splice(index, 1);
      persist();
      res.writeHead(204).end();
      return;
    }

    if (pathname === '/api/finalize' && method === 'POST') {
      const result = finalize('sent');
      if (result === false) {
        sendJson(res, 409, { error: 'review already finalised' });
        return;
      }
      sendJson(res, 200, { ok: true, report: result.report });
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      await handleStatic(res, pathname);
      return;
    }

    sendText(res, 405, 'Method not allowed');
  };

  const server: Server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.headersSent) sendText(res, 500, 'Internal error');
      else res.end();
    });
  });

  await new Promise<void>((ready) => server.listen(port, '127.0.0.1', ready));
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    finished,
    finalize,
    close: async () => {
      cancelGrace();
      for (const stream of liveStreams) stream.destroy();
      liveStreams.clear();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
