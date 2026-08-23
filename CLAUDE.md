# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`md-review` is a CLI that serves a markdown file as a rendered page for human review. The reviewer highlights passages and leaves comments (or suggested rewrites); closing the tab (or pressing Send) ends the review and prints a markdown report to stdout, meant to be read by the agent that launched the command. Re-running the command on the same file carries comments forward: any comment whose highlighted source text is no longer present is auto-resolved, on the theory that the agent rewrote that passage.

There is no bundler or framework on the client — `client/*.js` is plain ESM served as-is, using `htm` + `preact` (a single vendored, dependency-free build resolved at runtime via `src/vendor.ts`).

## Commands

Needs Node ≥26 (see `.nvmrc`; local dev may warn/fail under an older Node — that's an environment issue, not a code issue).

```
yarn install
yarn build          # tsc -> dist/, then chmod +x dist/cli.js
yarn dev            # tsc --watch
yarn typecheck       # tsc --noEmit (src) + tsc -p tsconfig.test.json (src+test+client)
yarn test            # vitest: unit + server integration tests, under test/
yarn test:coverage   # same, plus a v8 coverage report; CI runs this and enforces the thresholds in vitest.config.ts
yarn test:watch
yarn test:e2e        # builds first, then runs Playwright specs in test/e2e against your installed Chrome
```

- Single unit test file: `yarn vitest run test/anchors.test.ts`
- Single unit test by name: `yarn vitest run test/anchors.test.ts -t "some test name"`
- Single e2e spec: `yarn playwright test test/e2e/layout.spec.ts` (runs `yarn build` first, or run `yarn build` manually then invoke `playwright test` directly)
- `test:e2e` uses your local Chrome via `channel: 'chrome'` in `playwright.config.ts`; CI sets `MD_REVIEW_CHANNEL=bundled` to use Playwright's own Chromium instead, since a runner has no Chrome installed.
- `test/e2e` is excluded from the `vitest` run (see `vitest.config.ts`) — it drives a real browser and a real CLI subprocess, and belongs to Playwright.

## Architecture

**Server-side pipeline** (`src/`), one file per concern:

- `cli.ts` — entry point. Reads the target file, starts the server, opens a browser, waits on `server.finished`, then writes the report to stdout and to the sidecar (`<sidecar>.review.md`). Everything *except* the final report goes to stderr, so an agent capturing stdout gets a clean report with nothing else mixed in.
- `server.ts` — the whole HTTP layer: serves the client, the `/api/doc` payload, accepts new comments (`POST /api/comments`) and deletions, and — the core mechanism — detects tab-close via a long-lived SSE connection (`/api/live`) rather than `beforeunload`. When the last live stream drops, a grace timer (`--grace`, default 1500ms) fires `finalize('tab-closed')` unless a reload re-establishes the stream first.
- `render.ts` — markdown → HTML via `unified`/`remark`/`rehype`, stamping every element and text run with `data-pos="start:end"` source offsets (and `data-approx` where escapes/entities make rendered length differ from source length). This is what lets the client turn a browser text selection back into exact source offsets.
- `anchors.ts` — the anchor/reanchor mechanism that survives edits between rounds. An anchor keeps the exact source slice plus `CONTEXT_CHARS` of surrounding text and an occurrence index, so a later round can relocate the same passage even with duplicate text elsewhere in the document. `reanchor()` is the function that decides, each round, which prior comments are still open vs. auto-resolved.
- `store.ts` — the sidecar JSON store at `.md-review/<slugified-path>.json`, one file per reviewed document, written through on every mutation so no in-progress review state is ever only in memory.
- `report.ts` — turns the final `{ open, newlyResolved }` state into the markdown report (`formatReport`) and a JSON payload (`buildPayload`). Suggested rewrites render as exact `Replace:` / `With:` code blocks specifically so the agent applies them verbatim.
- `vendor.ts` — locates the non-exported `standalone.module.js` inside the installed `htm`/`preact` packages, since the client has no bundler and needs a real static file path to serve.
- `skill.ts` — copies `skill/SKILL.md` to `~/.claude/skills/md-review/`, for `--install-skill`.

**Client** (`client/`, plain ESM, no build step): `app.js` (preact components + review state), `selection.js` (browser Selection → source offsets, the inverse of `render.ts`'s `data-pos` stamping), `highlight.js` (rendering highlighted ranges over arbitrary DOM), `popover.js` (comment UI), `api.js` (thin fetch wrapper), `theme.js` (light/dark).

**Round-trip data flow:** `render.ts` stamps offsets → client `selection.js` reads them from a Selection → server validates and stores via `anchors.ts`/`store.ts` → next round, `reanchor()` re-locates each anchor in the new source → `report.ts` formats what's left. Changing any of these four together is the usual shape of a real change here; touching one without checking the others is how the anchor mechanism breaks silently (see the now-removed `docs/build-docs.mjs`, which broke exactly this way by calling into these functions directly with no test coverage).

## Notes for changes here

- One review server = one document, one sidecar file. There is no multi-document or multi-session concept to preserve.
- The sidecar (`.md-review/`) is the source of truth for comment state across rounds; `dist/` and `.md-review/` are both gitignored, consistent with a `git clone` + `yarn install` + `npm link` workflow rather than a published npm package (`private: true` in package.json, with a `//private` comment noting that's intentional for now).
- `skill/SKILL.md` documents the *agent-facing* contract (how an agent should invoke `md-review`, read its report, and iterate). Prefer keeping that document and the actual CLI/report behavior in sync over updating one without the other.
