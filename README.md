# md-review

[![CI](https://github.com/rsylvian/md-review/actions/workflows/ci.yml/badge.svg)](https://github.com/rsylvian/md-review/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Review markdown in your browser, hand the comments back to the agent.

## Install

Needs **Node 26 or newer**.

**Clone:**
```
git clone https://github.com/rsylvian/md-review.git
cd md-review
yarn install
npm link
md-review --install-skill   # optional, Claude Code only
```

**Or install globally without cloning:**
```
npm i -g git+https://github.com/rsylvian/md-review.git
```

To upgrade: `git pull && yarn install`.

## The loop

1. The agent runs `md-review draft.md` in the background and waits.
2. You read the rendered page and highlight anything that needs work.
3. When you close the tab (or press Send), the command exits, printing the review.
4. The agent applies the feedback and runs it again for round 2.

On round 2, comments carry over. Any comment whose highlighted passage the agent rewrote is
**auto-resolved** and collapsed into a `Resolved (n)` strip; anything still unaddressed
comes back live on its passage, even if the surrounding text moved.

## Reviewing

- **Highlight any text** to comment on it. The comment automatically attaches to that
  passage so it survives the agent editing around it.
- **Click a highlighted passage** to reopen its comment.
- **Suggest a rewrite** to give the agent exact replacement text instead of a description.
- **Send** ends the review without closing the tab.

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

- **One file per session.**
- **The document is read once.** Editing the file while a review is open won't update the page.
- **Raw HTML in markdown is dropped** rather than rendered.
- Comments live in `~/.cache/md-review/`.

## Development

```
yarn install
yarn test          # unit + server integration
yarn test:e2e      # full browser loop; builds first, uses your installed Chrome
yarn typecheck
```
