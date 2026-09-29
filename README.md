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

### Exit codes

Universal codes: `0` success, `1` general failure, `2` usage error.

A `task run` (and `task approve --resume`, which runs) reports a task-execution outcome with its own
code: `3` policy denied, `4` budget exceeded, `5` approval required/denied. `ai policy --check` is a
_query_ that evaluates a hypothetical operation and performs nothing, so it keeps its own contract —
`0` allowed, `1` denied or approval-required, `2` uninterpretable — rather than the execution codes.

### Dry runs

Every command that can mutate state supports `--dry-run` (`init`, `task create`, `task run`,
`task orchestrate`, `task verdict`, `task complete`, `task approve`, `task context --select`). A dry run
validates, resolves scope, and reports what would happen, but writes no event, changes no task, records
no selection or approval, and makes no provider, decision-layer or agent call. Policy, risk, approval
and deterministic budget checks still run, and a repeated dry run is idempotent.

For the two execution commands this is a **plan-only** boundary: `task run --dry-run` resolves and
validates the attempt and reports the deterministic risk gate, any approval already on record, and the
capability envelope, then stops before the first event, session, decision or model call;
`task orchestrate --dry-run` builds the deterministic plan (extracted requirements, eligible models and
the plan variants the mode permits) and stops before the task is started or any session, decision or
model call happens.

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
node <path-to-this-repo>/dist/cli/run.js task run <task-id>          # awaiting-approval (exit 5)
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

Status: **Phase H** is implemented and verified locally. On top of Phase C's domain, append-only JSONL
event log, project-scoped CLI and event-derived token/cost/budget reporting, Phase D added:

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
…`** runs the identical evaluation and performs nothing (exit 0 allowed, 1 denied, 2 uninterpretable — this
  is the policy-query contract; task-execution outcomes use 3/4/5, see Exit codes above).
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
- **Acceptance has two authorities and they stay distinguishable.** A criterion the author bound to a
  suite or a named check is assessed from that verification; a criterion no check can decide is
  established by a person with `ai task verdict <task-id> --criterion <AC-n> --status
<met|not-met|waived> --by <name>`, recorded as a human act with its transition and replacing the
  machine's evidence rather than sitting beside it (ADR-060, ADR-062). Closing the task is still a
  separate human action.

Phase H adds the **multi-model frontier**: one provider and one model became a registry of declared
models, and routing became a pipeline rather than a guess.

- **The registry is knowledge, not authority.** Models declare capabilities, modalities, a latency
  class, a lifecycle and an availability window, and configuration names which provider serves which
  model. The registry answers "who could do this?" — never "who may?" (policy) or "who should?" (the
  decision layer).
- **Code filters and orders; the decision layer may only reorder.** Requirements are extracted
  deterministically against closed vocabularies, eligibility is rejected in a fixed order, four
  routing modes build an explicit key list, and a decision that reorders candidates must return a
  _permutation_ of what it was offered — it cannot add, drop or resurrect one.
- **Unsupported work fails explicitly.** An unregistered model, a model attributed to the wrong
  provider, a provider that does not serve it, and a requirement nothing satisfies are all refusals
  with stable codes. A model is never silently substituted, because the trace would then lie about
  which model ran; identity is always the requested model id.
- **`ai task orchestrate <task-id>`** plans and runs one step of the frontier; **`ai models [--json]`**
  prints the catalog, its declared capabilities and its current availability. The plan is recorded
  _before_ any call, so a run that dies mid-step still explains what it intended.
- **Availability is a declared window** (`operational.availableFrom`) judged against the runtime's
  injected clock (ADR-057), so a launch-gated model becomes routable on its own rather than failing a
  task that selected it.

**Met locally, and not more than that** — the verification pipeline is green and the frontier has been
exercised end to end, but the phase is **not declared frozen**: the CI gate runs on `main` and has
never seen this branch. A required comparative benchmark against a single-model baseline now exists
and has been run (a measurement of the §29.1 dimensions, not a verdict — §39.10). Reported in full in
§39 of the RFC and ADR-058.

The **agent runtime is selected per project**. The default is simulated — real provider calls and one
real, policy-checked workspace listing but no engineering work (`ai doctor` warns about it); configuring
`agent.runner: "change-set"` selects a bounded real coding path whose writes and verification run
through the operation gateway, with a task's acceptance criteria able to bind to a suite or a named
check and be assessed from that evidence (ADR-059, ADR-060), and a criterion no check can decide
established by a named person through an explicit, recorded verdict (ADR-062). Still designed but
**not implemented**: a full autonomous agent loop (the change-set runner is one-shot, with no repair
loop or rollback), engineering memory, a context cache, embeddings/semantic search, plugins, replay,
container/remote execution and the dashboard. See §33 and §35–§39 of the RFC, and the honesty statement
in `DECISIONS.md`. Dated reconciliation notes — where a later phase amended an earlier claim — are
collected in `docs/architecture/RECONCILIATIONS.md`.

**Recorded proposals** (§33.1): the multi-model orchestration proposal listed there has since been
delivered as **Phase H** (ADR-058, §39), and the roadmap letters were reassigned when that happened —
semantic retrieval is now Phase I and the optional dashboard Phase J. Still queued and explicitly not
started is a real OS/container execution boundary: Phase F's boundaries are in-process and labelled
as such, and kernel-level isolation is a later architectural phase.

## Scope

In scope: agent contracts, verification loop, V2 domain model, minimal smoke proof, scripts, docs, CI.

Out of scope: application/business logic, frameworks, Python/uv, Docker, eval infrastructure, databases, APIs. Those belong to future projects cloned from this template.

`src/ports/`, `src/adapters/`, `src/application/`, `src/cli/` and the `ai` CLI now exist. The V2 RFC still reserves — and has not created — `evals/`, `src/ai/`, `src/memory/`, `src/plugins/` and the dashboard.
