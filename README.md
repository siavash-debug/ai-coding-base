# ai-coding-base

Reusable professional AI Engineering coding workspace. This repository is a workspace baseline, not an application or framework.

`AGENTS.md` is the normative engineering contract and source of truth.

## Prerequisites

- Node.js `24.21.0` (see `.nvmrc`)
- pnpm `12.3.4` via corepack

## Quickstart

```sh
corepack enable
pnpm install
pnpm verify
```

## Commands

| Command             | Runs                              |
| ------------------- | --------------------------------- |
| `pnpm format:check` | Prettier check                    |
| `pnpm lint`         | ESLint                            |
| `pnpm typecheck`    | TypeScript `--noEmit`             |
| `pnpm test`         | Vitest, single run                |
| `pnpm build`        | TypeScript emit to `dist/`        |
| `pnpm verify`       | `scripts/verify.sh` full pipeline |

## Scope

In scope: agent contracts, verification loop, minimal smoke proof, scripts, docs, CI.

Out of scope: application/business logic, frameworks, Python/uv, Docker, eval infrastructure, databases, APIs. Those belong to future projects cloned from this template.
