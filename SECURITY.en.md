# Security

**English** | [中文](SECURITY.md)

## Reporting a vulnerability

Please do **not** open a public Issue for security reports.

Email the maintainer address on the GitHub account, or report privately via GitHub Security Advisories:

https://github.com/CCharlie-xiu/wuch-ai/security/advisories/new

Include impact, reproduction steps, and whether a public exploit exists if known. We will confirm and reply with a handling plan as soon as we can.

## Scope notes

- The hosted trial (wuch-ai.net) isolates data by account; do not attempt to access other users’ sessions or data.
- Local `bun run dev` is for single-machine development and returns stored model API keys to the page by design — do not expose the dev port to the public internet.
