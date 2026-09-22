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

What the platform is _allowed_ to do is inspectable, and a decision can be dry-run without performing
anything:

```sh
node <path-to-this-repo>/dist/cli/run.js policy                                              # the policy and the attempt envelope
node <path-to-this-repo>/dist/cli/run.js policy --check \
  --capability filesystem.read --target .                                                     # allowed (exit 0)
node <path-to-this-repo>/dist/cli/run.js policy --check \
  --capability filesystem.read --target ../outside.txt                                        # refused (exit 2)
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

What the decision layer is, and what a task asked it, is inspectable too — offline, and with no
provider call:

```sh
node <path-to-this-repo>/dist/cli/run.js decision                 # the layer, its limits, its fallback policy
node <path-to-this-repo>/dist/cli/run.js task decisions <task-id> # every bounded question, and who answered it
```

From this repository, `pnpm ai --help` works after a build and runs against the current directory.

## V2 — AI-Native Software Engineering Foundation

This repository is evolving from a workspace baseline into a reusable foundation for
AI-assisted software engineering: first-class tasks, task traceability, token/cost
observability, AI budgets, workspace isolation, policy and human approval.

- `docs/architecture/V2-ARCHITECTURE.md` — the V2 architecture RFC (design).
- `docs/architecture/DECISIONS.md` — the architectural decisions behind it (ADRs).

Status: **Phase G** is implemented and verified. On top of Phase C's domain, append-only JSONL event
log, project-scoped CLI and event-derived token/cost/budget reporting, Phase D added:

- **One real LLM provider adapter** (OpenAI-compatible Chat Completions), selected in
  `.ai/project.json`. The credential is named there and read from the environment at call time —
  never stored, never logged. Requests are wrapped in a **bounded** retry decorator, and failures
  are categorised (`auth`, `rate-limit`, `timeout`, …) and recorded as events.
- **Configuring a provider does not make its host reachable.** The host must also be listed in
  `policy.network.providerHosts`, and the check happens at the transport for every provider the
  platform builds — LLM and decision alike — so no adapter can be the one path that skips it.
  `ai doctor` warns when a credentialed provider's host is missing from that list instead of letting
  the refusal appear for the first time mid-run.
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

Phase F adds **policy, capability and sandbox enforcement**: an operation cannot merely be declared
permitted, it has to pass through an enforced boundary before it runs.

- **One enforcement point.** Every operation goes `capability → declared envelope → policy → sandbox
admission → approval → the boundary performing it`. A capable runtime is handed an
  `OperationGateway` and nothing else: no `fs`, no `child_process`, no `fetch`, no `process.env`. A
  runtime given no gateway performs no operation and records the refusal.
- **Policy is explicit and deny-by-default.** `.ai/project.json` declares allowed, denied and
  approval-required capabilities, readable and writable roots, allowed commands, network hosts and
  readable environment variables. An unconfigured project can read inside its own workspace and
  nothing more.
- **The sandbox is real, local and honestly labelled.** Workspace-relative references only; containment
  by path resolution (so `/srv/app-evil` is not inside `/srv/app`, and a symlinked root cannot escape);
  credential-shaped paths and `.git/` writes refused by name; processes run without a shell, inside the
  workspace, with a filtered environment and a hard timeout; network access denied unless a host is
  explicitly listed, with operation egress kept separate from provider egress.
- **Approval confirms, it never opens a boundary.** An operation that needs approval suspends the task,
  `ai task approve --resume` consumes the grant once, and a capability policy denies can never be
  reached by approving it.
- **`ai policy`** shows the effect table and the envelope; **`ai policy --check --capability … --target
…`** runs the identical evaluation and performs nothing (exit 0 allowed, 1 denied, 2 uninterpretable).
  The trace gains `POLICY` and `OPERATIONS` sections, and `ai doctor` probes the boundary offline.

It is **not a container, VM or kernel boundary**, and it does not protect against an already-compromised
host. Host allowlisting is enforced at the transport but is **not** a network sandbox: DNS rebinding, a
listed name that resolves to a private or loopback address, and a redirect from a listed host to an
unlisted one are outside the current guarantee. On Windows a child process also receives a fixed set of OS-level variables that Node adds and
policy cannot remove — enumerated, reported by `ai doctor`, and not glossed over. Token counts from the
context engine remain estimates.

Phase G adds a **decision layer**: bounded judgement gets its own layer instead of being smuggled into
enforcement or into the model prompt.

- **The responsibility split is the architecture.** Deterministic code owns certainty and enforcement
  (rules, validation, policy, capability, approval, sandbox, budgets, scopes, state machines); the
  decision layer owns bounded questions (routing, tool selection, contextual risk, retry, ranking,
  relevance, completion, human escalation); the frontier LLM owns reasoning; a human owns
  consequences.
- **JEV is the first real implementation** — a small JSON contract behind the existing
  `DecisionProvider` port, called over the existing HTTP transport, with its credential referenced by
  environment-variable name in `.ai/project.json` (`decision.provider: "jev-http"`). Configure nothing
  and the layer stays `disabled`, which is a complete, fully functional platform: every question is
  then answered by code and recorded as such.
- **A decision recommends; it never authorises.** Candidates are supplied by code (a route set from the
  risk profile, a tool set from the capability envelope), an answer naming anything else is rejected by
  deterministic validation and replaced by a conservative fallback, and everything that acts still goes
  through the operation gateway. There is no path from a decision to a capability, an approval, or a
  scope change.
- **Certainty is answered by code first**, so no deterministic step becomes a network round-trip, and a
  decision budget is enforced _before_ the provider is called, counted from the event log rather than
  from memory.
- **Failures stay visible and conservative**: `DecisionFailed`, `DecisionFallbackUsed` with its reason,
  and `DecisionCompleted` naming the layer that answered. A missing layer is recorded as missing —
  "JEV was unavailable" never becomes "allow".
- **`ai decision [--json]`** reports the layer, its limits, its per-question fallback policy and the
  decisions recorded in this scope; **`ai task decisions <task-id> [--json]`** lists every bounded
  question a task asked and how it was answered. Neither calls a provider.

Still designed but **not implemented**: a real agent runtime (the bundled runner is simulated — it
makes real provider calls and one real, policy-checked workspace listing but performs no engineering
work), engineering memory, a context cache, embeddings/semantic search, multi-model routing, plugins,
replay, container/remote execution and the dashboard. See §33 and §35–§38 of the RFC, and the honesty
statement in `DECISIONS.md`.

**Queued and explicitly not started** (§33.1): a multi-model orchestration phase — a model registry
with capability, cost and latency profiles plus a second provider adapter — and, separately, a real
OS/container execution boundary. Neither changes the frozen order: Phase G (the decision layer) is
current, Phase H is semantic retrieval, and no new phase begins until Phase G is frozen and verified.

## Scope

In scope: agent contracts, verification loop, V2 domain model, minimal smoke proof, scripts, docs, CI.

Out of scope: application/business logic, frameworks, Python/uv, Docker, eval infrastructure, databases, APIs. Those belong to future projects cloned from this template.

`src/ports/`, `src/adapters/`, `src/application/`, `src/cli/` and the `ai` CLI now exist. The V2 RFC still reserves — and has not created — `evals/`, `src/ai/`, `src/memory/`, `src/plugins/` and the dashboard.
