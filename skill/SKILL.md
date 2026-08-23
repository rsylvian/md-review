---
name: md-review
description: Use when a markdown file you wrote or edited is ready for the user to read - a draft, spec, plan, README, report, or any prose document. Opens it in a browser for inline comments and returns them so you can iterate. Triggers on "let me review that", "I want to read it first", "open it for review", "send it to me".
---

# Reviewing markdown with the user

`md-review` serves a markdown file as a rendered page. The user highlights passages and
leaves comments, then closes the tab — at which point the command exits and prints the
review. Your job is to launch it, get out of the way, and then act on what comes back.

## Running it

Run it **in the background**. A review takes as long as it takes to read a document, which
is longer than a foreground command is allowed to run.

```
md-review path/to/draft.md
```

Use `run_in_background: true`. Then:

1. Tell the user the review is open and stop. One short line: "Opened draft.md for review —
   leave comments and close the tab when you're done."
2. **Do not poll, and do not guess at the feedback.** You will be notified when the
   command exits.
3. On the completion notification, read the command's output file. It contains the report.

The same report is also written to a `.review.md` file under `~/.cache/md-review/`, so it
is still there if the command's output goes missing (the CLI prints the exact path to
stderr as `Saved to ...`).

## Reading the report

The report opens with `# Review of <path>`, then a count. Then one section per comment:

````md
## 2 — lines 30–31 · suggested rewrite

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
````

- **`Replace:` / `With:` blocks are exact source text.** Apply them verbatim rather than
  paraphrasing — the reviewer wrote the replacement they want.
- A plain comment is a request to change the quoted passage. The line numbers refer to the
  file as it was when the review started.
- **"No open comments"** means the draft reads fine. Say so and move on; do not invent
  changes to justify another round.
- If any comments were resolved since the last round, the report ends with a
  `## Resolved since last round` section listing them by line and first quoted line —
  informational only, nothing to act on there.

## Iterating

Apply the feedback, then run `md-review` on the same file again for the next round.
Comments carry over automatically: any comment whose quoted passage you rewrote is marked
resolved, and only the ones you have not addressed come back as open. So there is no
bookkeeping to do — just fix things and re-open.

If a comment comes back open and you believe you did address it, you changed something
other than the passage the user highlighted. Re-read that passage and either change it or
say plainly why you left it.

## Notes

- One file per session. To review several documents, run it once per file.
- The user pressing **Send** and the user closing the tab produce the same result.
- If the command exits non-zero, the tool itself failed (missing file, port in use); the
  message on stderr says which. An empty review is a success, not a failure.
