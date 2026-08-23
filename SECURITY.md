# Security Policy

## Supported Versions

md-review is pre-1.0 (currently `0.x`). Only the latest release is supported;
please make sure you're on the latest version before reporting an issue.

## Reporting a Vulnerability

`md-review` runs a local HTTP server (`src/server.ts`) that accepts connections
and writes files to disk, so please report security issues privately rather
than opening a public GitHub issue.

Use GitHub's [private vulnerability reporting](https://github.com/rsylvian/md-review/security/advisories/new)
for this repository. This opens a private conversation with the maintainer so
the issue can be assessed and fixed before public disclosure.

You should receive an initial response within a few days. If the vulnerability
is confirmed, a fix will be released and the advisory published once a patch
is available.
