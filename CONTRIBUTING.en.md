# Contributing

**English** | [中文](CONTRIBUTING.md)

## Getting started

```bash
bun install
cp .env.example apps/server/.env   # set MODEL_KEY_SECRET (≥16 chars)
bun run dev                        # http://127.0.0.1:8788
bun run mock                       # optional fake upstream: http://127.0.0.1:8789/v1
```

Requires [Bun](https://bun.sh) 1.4+. Intro page locally: http://127.0.0.1:8788/intro

## Layout

| Path | Contents |
|---|---|
| `apps/web` | Frontend (canvas, chat, settings) |
| `apps/server` | Local Bun server |
| `apps/cloudflare` | Workers + D1 hosted app |
| `packages/ui-dsl` | UI DSL parse & validate |
| `packages/catalog` | Component catalog |
| `packages/compiler` `runtime` `protocol` | Compile, sandbox runtime, protocol |
| `docs/` `DESIGN.md` | Design notes and intro page source |

## Before you push

```bash
bun run test            # smoke
bun run test:server
bun run test:dsl
bun run test:catalog
bun run typecheck:dsl
```

- Run the suites that match what you changed; for `packages/ui-dsl`, always run `test:dsl` and `typecheck:dsl`
- New behavior should include tests

## Branches & commits

- Branch from `main`: `feat/…`, `fix/…`, `docs/…`
- Commit message: `type(scope): summary` — `feat` `fix` `chore` `docs` `refactor` `test`
- One concern per PR; target `main`

## Do not commit

`.env`, `*.db`, API keys, `node_modules`. Keep `.env.example` placeholders only.

## Issues

- Bugs and feature ideas: use the Issue templates
- Security issues: do not open a public Issue — see [SECURITY.en.md](SECURITY.en.md)
