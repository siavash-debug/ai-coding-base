# Architecture

`ai-coding-base` is a reusable AI Engineering coding workspace baseline, not an application or framework.

`AGENTS.md` is normative. `CLAUDE.md` and `.cline/rules/workspace.md` are thin adapters that point to it.

## V2

V2 turns this baseline into a provider-agnostic foundation for AI-assisted software
engineering. See `docs/architecture/V2-ARCHITECTURE.md` (RFC) and
`docs/architecture/DECISIONS.md` (ADRs).

Implemented today (Phases C–E): the pure domain, an append-only JSONL event log scoped
to a project/workspace, a project-scoped `ai` CLI, event-derived token/cost/budget
reporting, one real LLM provider adapter (OpenAI-compatible, configured per project,
credential referenced by environment-variable name), approval grants that are scoped,
single-use and consumed on resume, append coordination for the log, and a
**deterministic context engine**.

The context engine selects the smallest useful set of files for a task under a hard
token budget and records a reason for every candidate. It calls no model, uses no
embeddings and no index: discovery is a bounded read-only walk, scoring is additive,
ordering is a total order, so the same repository state produces the same selection.
Credential-shaped paths are refused by name before any read, and repository text
(`AGENTS.md`, READMEs, comments) is data, never policy.

The default provider is offline and deterministic, so the platform needs no vendor
account, no key and no network. Design in full: `docs/architecture/V2-ARCHITECTURE.md`
§34 (Phase C), §35 (Phase D) and §36 (Phase E).

Not implemented: sandbox/command execution, engineering memory, a context cache,
embeddings/semantic search, plugins, replay/checkpoints, JEV routing and the dashboard.
The bundled agent runner is **simulated** — it makes real provider calls and real
reads, but performs no engineering work.

## Layout

- `src/core/` — ids, clock, errors, boundary validation, secret redaction.
- `src/projects/`, `src/workspaces/`, `src/tasks/`, `src/sessions/` — domain entities.
- `src/decisions/` — decision records, risk, policy, the `DecisionProvider` port, routing.
- `src/observability/` — events, token accounting, cost accounting, budgets, task metrics.
- `src/context/` — context domain: candidate vocabulary, token estimation, exclusion policy,
  path/import matching, explainable scoring, budget arithmetic, configuration fingerprint.
- `src/ports/` — the interfaces: event store, task repository, agent runner, LLM provider,
  HTTP transport, sleep, environment, append lock, project scope, context engine,
  repository reader, change provider, process runner.
- `src/adapters/` — the implementations, none of which know about each other: JSONL event
  store + file task repository + append lock, validated project config, deterministic and
  OpenAI-compatible providers, retry decorator, fetch transport, timer sleep, simulated runner,
  read-only repository reader, git change provider, argv-only process runner.
- `src/application/` — composition root, services, approval ledger, context engine pipeline
  and context service, trace read model, task run, `ai doctor`.
- `src/cli/` — argument parsing, rendering, commands, dispatcher, process shim.
- `src/index.ts` — original smoke proof, unchanged (see ADR-014 on why there is no barrel yet).
- `tests/unit/` — deterministic offline Vitest tests.
- `scripts/verify.sh` — single local verification pipeline; CI runs the same script.
- `.github/workflows/ci.yml` — CI gate on `main`.
- `docs/` — workspace notes.

## Deferred (reserved, not created)

- `evals/` — AI evaluation harness, later phase.
- Python/`uv` — when a real Python workload exists.
- Docker — when runtime parity is required.
- Sandbox adapters, engineering memory, a context cache, embeddings/semantic search, plugins,
  replay/checkpoints and the dashboard; any JEV adapter. See the V2 RFC roadmap (§33),
  §35.6 and §36.10.

## Verification order

1. install → 2. format:check → 3. lint → 4. typecheck → 5. test → 6. build → 7. run built artifact.
