# md-review

Review AI-generated markdown in your browser. Highlight text, leave comments on it, close
the tab — and the agent that opened it picks the comments up and iterates.

[difit](https://github.com/yoshiko-pg/difit) for prose instead of diffs, with the
copy-paste step removed.

```
md-review draft.md
```

The command blocks. It opens a rendered view of the file, you comment on it, and when you
close the tab it prints the review to stdout and exits.

## Install

Needs **Node 22 or newer** (`.nvmrc` pins 22.14).

The repo is private, so git needs credentials for it. Use HTTPS — the corporate network
blocks SSH to GitHub on both port 22 and the usual 443 fallback:

```
gh auth login       # pick HTTPS
gh auth setup-git   # lets git authenticate private HTTPS clones
```

Then:

```
git clone https://github.com/rsylvian/md-review.git
cd md-review
yarn install        # installs deps and builds dist/ via the prepare script
npm link            # puts md-review on your PATH, pointing at your clone
md-review --install-skill   # optional, Claude Code only
```

`yarn` is the supported path — `packageManager` pins yarn 1.22 and `yarn.lock` is
committed, so this is the combination that's actually tested. To upgrade, `git pull &&
yarn install`.

<details>
<summary>One-line global install instead</summary>

```
npm i -g git+https://github.com/rsylvian/md-review.git
```

npm builds it on install via `prepare`, so this yields a working `md-review` with no clone.
It resolves fresh from `package.json` rather than `yarn.lock` — fine, since every
dependency is exact-pinned — but it needs working npm registry access, which is
intermittent on the corporate network. If it stalls, use the clone above.

</details>

## Why

When an agent writes a document, reviewing it means reading raw markdown in a terminal and
retyping your feedback as prose. This gives you the document as a document, comments
anchored to the passages they're about, and a handoff that needs no copy-paste.

## The loop

1. The agent runs `md-review draft.md` in the background and waits.
2. You read the rendered page and highlight anything that needs work. Comments save as you
   make them, so a reload or a closed laptop lid loses nothing.
3. You close the tab. The command exits, printing the review.
4. The agent applies the feedback and runs it again for round 2.

On round 2, comments carry over. Any comment whose highlighted passage the agent rewrote is
**auto-resolved** and collapsed into a `Resolved (n)` strip; anything still unaddressed
comes back live on its passage, even if the surrounding text moved. There's no
bookkeeping — the text either changed or it didn't.

## Reviewing

- **Highlight any text** to comment on it. The comment attaches to that passage, not to a
  line number, which is why it survives the agent editing around it.
- **Click a highlighted passage** to reopen its comment. Comments stay out of the page
  until you ask for them, so the document reads as a document.
- **Suggest a rewrite** to give the agent exact replacement text instead of a description.
  It arrives as a `Replace:` / `With:` pair the agent can apply verbatim. The field is
  prefilled with the current source, so you can edit rather than retype.
- **Send ▸** ends the review without closing the tab. Same result.
- **Reload freely.** A brief grace period distinguishes a reload from a closed tab.
- **Ctrl-C** in the terminal also finalises, writing whatever comments exist.
- **Light or dark.** Follows your OS by default, including if you change it while a tab is
  open. The sun/moon button in the header overrides that, and the choice is remembered in
  `localStorage` from then on. Colours follow Atlassian's palette, so it sits comfortably
  next to Confluence.

## What the agent gets

Markdown on stdout, plus the same report at `.md-review/<name>.review.md` in case stdout
is lost. Anything that wants the comments as data reads the sidecar,
`.md-review/<name>.json`, which is the source of truth:

```md
# Review of draft.md

1 open comment. 1 resolved since last round.

## 1 — line 12 · suggested rewrite

> We should probably measure this.

Commit to a metric.

Replace:
```
We should probably measure this.
```

With:
```
Track p95 latency weekly.
```
```

No comments produces an explicit "No open comments" — meaning the draft reads fine, not
that something failed. Exit status is 0 for any completed review; non-zero means the tool
itself failed.

## Claude Code

```
md-review --install-skill
```

Installs a skill to `~/.claude/skills/md-review/` that teaches the agent to run the command
backgrounded, wait rather than poll, and read the result. After that, "let me review that
first" is enough.

## Options

| Flag | Default | |
| ---- | ------- | - |
| `-p, --port <n>` | `5710` | `0` picks a free port |
| `--no-open` | | don't launch a browser |
| `--grace <ms>` | `1500` | how long after the tab closes before finalising |
| `--install-skill` | | install the Claude Code skill and exit |
| `-v, --version` | | print the version and exit |

## Notes and limits

- **One file per session.** No multi-file sidebar, no diff view.
- **The document is read once**, at startup, so anchors stay consistent. Editing the file
  while a review is open won't update the page.
- **Raw HTML in markdown is dropped** rather than rendered. GFM tables, task lists and
  strikethrough work.
- Comments live in `.md-review/` next to where you ran the command. Worth gitignoring.
- Escapes (`\*`) and HTML entities (`&amp;`) make a passage's rendered text shorter than
  its source, so comments there anchor to the whole run rather than a character range. The
  report flags it.

## Beta

This is in beta and the [limits above](#notes-and-limits) are known — no need to report
those. What's worth a bug:

- A comment that lands on the wrong passage, or vanishes between rounds.
- Anything that should have auto-resolved and didn't, or resolved when it shouldn't have.
- Markdown that renders wrong. Attach the source; `test/fixtures/formatting.md` is the
  reference for what's meant to work.
- The command hanging after you close the tab, or exiting before you're done.

File it at [issues](https://github.com/rsylvian/md-review/issues). Include the `md-review`
output from your terminal and the `.md-review/<name>.json` sidecar — that sidecar is the
source of truth for comment state, so it's usually enough to reconstruct what happened.

If port 5710 is already taken, `md-review --port 0 draft.md` picks a free one.

## Development

```
yarn install       # also builds dist/, via the prepare script
yarn test          # unit + server integration
yarn test:e2e      # full browser loop; builds first, uses your installed Chrome
yarn typecheck
yarn docs          # writes docs/how-it-works.html
```

`yarn test:e2e` drives your locally installed Google Chrome. If you don't have it, set
`MD_REVIEW_CHANNEL=bundled` to use Playwright's own chromium instead — that's what CI
does, after a `npx playwright install chromium`.

`yarn docs` builds a deep dive on the anchoring model at `docs/how-it-works.html`. It's
generated rather than committed — the generator imports the real modules, so building it on
demand is what keeps it from drifting from the code.

The client runs with no bundler: Preact and htm are served as one self-contained ES module,
so `client/` is the code that ships. `src/render.ts` stamps source offsets onto every
element and text run, `client/selection.js` maps a browser selection back to those offsets,
and `src/anchors.ts` re-finds them on later rounds. Those three files are the whole trick.
