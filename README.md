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

## Try it

The CLI runs against a project directory. Build once, then run it from the project you want to
work in:

```sh
pnpm build
mkdir -p /tmp/demo-api && cd /tmp/demo-api
node <path-to-this-repo>/dist/cli/run.js init
node <path-to-this-repo>/dist/cli/run.js doctor
node <path-to-this-repo>/dist/cli/run.js task create --title "Add retry" --description "Bound the retries" --acceptance "Retries are bounded"
node <path-to-this-repo>/dist/cli/run.js task context <task-id> --select --explain   # what will be sent, and why
node <path-to-this-repo>/dist/cli/run.js task run <task-id>
node <path-to-this-repo>/dist/cli/run.js task trace <task-id>
node <path-to-this-repo>/dist/cli/run.js task usage <task-id>
node <path-to-this-repo>/dist/cli/run.js task cost <task-id>
```

A high-risk task stops for a human, and the grant is consumed when work resumes:

```sh
node <path-to-this-repo>/dist/cli/run.js task create --title "Rotate the signing key" \
  --description "Replace the release key" --acceptance "A release is signed" --risk high
node <path-to-this-repo>/dist/cli/run.js task run <task-id>          # awaiting-approval (exit 1)
node <path-to-this-repo>/dist/cli/run.js approvals                   # shows the pending request
node <path-to-this-repo>/dist/cli/run.js task approve <task-id> --approver me --resume
node <path-to-this-repo>/dist/cli/run.js task trace <task-id>         # asked, granted, consumed
```

From this repository, `pnpm ai --help` works after a build and runs against the current directory.

## V2 — AI-Native Software Engineering Foundation

This repository is evolving from a workspace baseline into a reusable foundation for
AI-assisted software engineering: first-class tasks, task traceability, token/cost
observability, AI budgets, workspace isolation, policy and human approval.

- `docs/architecture/V2-ARCHITECTURE.md` — the V2 architecture RFC (design).
- `docs/architecture/DECISIONS.md` — the architectural decisions behind it (ADRs).

Status: **Phase E** is implemented and verified. On top of Phase C's domain, append-only JSONL event
log, project-scoped CLI and event-derived token/cost/budget reporting, Phase D added:

- **One real LLM provider adapter** (OpenAI-compatible Chat Completions), selected in
  `.ai/project.json`. The credential is named there and read from the environment at call time —
  never stored, never logged. Requests are wrapped in a **bounded** retry decorator, and failures
  are categorised (`auth`, `rate-limit`, `timeout`, …) and recorded as events.
- **Approval grants are consumed.** `ai approvals` lists what is waiting, and
  `ai task approve <task-id> --approver <name> [--resume]` records a scoped, single-use,
  optionally-expiring grant; resuming consumes it and records that it was used.
- **Append coordination** for the event log (`AppendLock`): two writers cannot append the same
  sequence. `ai doctor` proves it. The guarantee is local and is documented as such.

Phase E adds a **deterministic context engine**: the smallest useful set of files for a task, chosen
under a hard token budget, with a reason recorded for every candidate.

- **No model chooses context and no model is called to choose it.** Discovery is a bounded, read-only
  walk of the workspace; scoring is additive and explainable; ordering is a total order, so the same
  repository state yields the same selection byte for byte.
- **`ai task context <task-id> [--select] [--explain]`** shows the budget, the selected files, the
  excluded ones and why — `--json` included. Reading is read-only; `--select` records a fresh
  selection, because a plain read must never append to the log by surprise. It never prints file
  contents.
- **Secrets are refused by name before any read** (`.env`, keys, credential-shaped paths, `.ai/runtime`),
  and repository text such as `AGENTS.md` or a README is context only — it can never change policy,
  budget or permissions.
- **Context and the LLM call are linked in the trace**: a selection is recorded as events against the
  task and session, and the LLM call references the selection it was built from. The events carry
  metadata and stable references, never prompt text.

The default provider is still the offline deterministic stand-in, so everything works with no vendor
account, no network and no key.

Still designed but **not implemented**: a real agent runtime (the bundled runner is simulated — it
makes real provider calls and real reads but performs no engineering work), sandbox/command
execution, engineering memory, a context cache, embeddings/semantic search, plugins, replay, JEV
routing and the dashboard. See §33, §35 and §36 of the RFC, and the honesty statement in
`DECISIONS.md`.

## Scope

In scope: agent contracts, verification loop, V2 domain model, minimal smoke proof, scripts, docs, CI.

Out of scope: application/business logic, frameworks, Python/uv, Docker, eval infrastructure, databases, APIs. Those belong to future projects cloned from this template.

`src/ports/`, `src/adapters/`, `src/application/`, `src/cli/` and the `ai` CLI now exist. The V2 RFC still reserves — and has not created — `evals/`, `src/ai/`, `src/memory/`, `src/plugins/` and the dashboard.
