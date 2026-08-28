<h1 align="center">md-review</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@rsylvian/md-review"><img src="https://img.shields.io/npm/v/@rsylvian/md-review.svg" alt="npm version"></a>
  <a href="https://github.com/rsylvian/md-review/actions/workflows/ci.yml"><img src="https://github.com/rsylvian/md-review/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
  Review markdown in your browser, hand the comments back to the agent.
</p>

## ⚡ Quick Start

Try it first

```bash
npx @rsylvian/md-review draft.md
```

Install and use

```bash
npm i -g @rsylvian/md-review
md-review draft.md
```

Enable use from Claude Code

```bash
md-review --install-skill
```

Installs a skill to `~/.claude/skills/md-review/` that teaches the agent to run the command
backgrounded, wait rather than poll, and read the result. After that, "let me review that
first" is enough.

## 🔁 The loop

1. The agent runs `md-review draft.md` in the background and waits.
2. You read the rendered page and highlight anything that needs work.
3. When you close the tab (or press Send), the command exits, printing the review.
4. The agent applies the feedback and runs it again for round 2.

On round 2, comments carry over. Any comment whose highlighted passage the agent rewrote is
**auto-resolved** and collapsed into a `Resolved (n)` strip; anything still unaddressed
comes back live on its passage, even if the surrounding text moved.

## 💬 Reviewing

Highlight any text to open a comment on it. The comment automatically attaches to that
passage so it survives the agent editing around it; click a highlighted passage to reopen
its comment. Each comment is one of three kinds:

- **Note** — describe what should change, in your own words.
- **Rewrite** — give the agent exact replacement text instead of a description.
- **Delete** — mark the highlighted passage for removal outright.

**Send** ends the review without closing the tab.

## ⚙️ CLI Options

| Flag              | Default | Description                                      |
| ----------------- | ------- | ------------------------------------------------- |
| `<file>`          | -       | Markdown file to review                            |
| `-p, --port <n>`  | `5710`  | Port to listen on; `0` picks a free port           |
| `--no-open`       | false   | Don't launch a browser automatically               |
| `--grace <ms>`    | `1500`  | How long after the tab closes before finalising    |
| `--install-skill` | -       | Install the Claude Code skill and exit             |
| `-v, --version`   | -       | Print the version and exit                         |

## 📋 Notes and limits

- **One file per session.** To review several documents, run it once per file.
- **The document is read once.** Editing the file while a review is open won't update the page.
- **Raw HTML in markdown is dropped** rather than rendered.
- Comments live in `~/.cache/md-review/`.

## 📦 Preview builds

Adding the `preview` label to a PR publishes a one-off build under the `pr-<number>`
dist-tag (republished on every new push while the label is attached):

```bash
npx @rsylvian/md-review@pr-<number>
```

## 🛠️ Development

Needs **Node 24 or newer**.

```bash
git clone https://github.com/rsylvian/md-review.git
cd md-review
yarn install
npm link
md-review --install-skill   # optional, Claude Code only
```

To upgrade a source install: `git pull && yarn install`.

```bash
yarn test          # unit + server integration
yarn test:e2e      # full browser loop; builds first, uses your installed Chrome
yarn typecheck
yarn lint           # biome check .; yarn lint:fix to apply fixes
```

## 📄 License

MIT
