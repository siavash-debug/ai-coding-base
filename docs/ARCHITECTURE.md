# Architecture

`ai-coding-base` is a reusable AI Engineering coding workspace baseline, not an application or framework.

`AGENTS.md` is normative. `CLAUDE.md` and `.cline/rules/workspace.md` are thin adapters that point to it.

## V2

V2 turns this baseline into a provider-agnostic foundation for AI-assisted software
engineering. See `docs/architecture/V2-ARCHITECTURE.md` (RFC) and
`docs/architecture/DECISIONS.md` (ADRs).

Implemented today (Phases C–H): the pure domain, an append-only JSONL event log scoped
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

Phase F adds **policy, capability and sandbox enforcement**: every operation is derived into a
capability, checked against the attempt's declared envelope, evaluated against the project's access
policy, admitted by a workspace-bound sandbox, and only then possibly handed to the approval ledger.
A runtime holds an `OperationGateway` and nothing else — no `fs`, no `child_process`, no `fetch`, no
`process.env` — and the boundary it delegates to re-checks its own admission rather than trusting an
earlier verdict. Policy is deny-by-default, refusals carry stable reason codes, and `ai policy --check`
performs the identical evaluation while performing nothing.

The sandbox is **in-process**: workspace-relative references only, containment by path resolution,
credential-shaped paths and `.git/` writes refused by name, processes run without a shell with a
filtered environment and a hard timeout, and network access denied unless a host is explicitly
listed. Host allowlisting is enforced at the transport, but it is **not** a network sandbox: DNS
rebinding, a listed name resolving to a private or loopback address, and a redirect from a listed host
to an unlisted one are outside the current guarantee. It is not a container, a VM or a kernel boundary,
and it does not protect against an already-compromised host. On Windows a child process also receives a fixed set of OS-level variables
that Node adds and policy cannot remove; those are enumerated and reported by `ai doctor`.

Phase G adds a **decision layer**: bounded questions (routing, tool selection, contextual risk,
retry, ranking, relevance, completion, human escalation) are asked behind the `DecisionProvider`
port, and JEV is its first real implementation — a small JSON contract over the existing HTTP
transport, with the credential referenced by environment-variable name. The layering is the point:
**deterministic code owns certainty and enforcement, the decision layer owns bounded judgement, the
frontier LLM owns reasoning, and a human owns consequences.**

A decision may recommend and can never authorise: its candidates are supplied by code, its scope is
fixed when the coordinator is created, its answers are validated against a closed vocabulary before
they can affect anything (an answer naming a tool or route outside the offered set is rejected and
replaced by a deterministic fallback), and everything that acts still goes through the operation
gateway. Code answers first — no deterministic step becomes a network round-trip — and a failure,
timeout or absent layer is recorded as a fallback with its reason rather than treated as permission.
Budgets are enforced before the provider is called and counted from the event log. Within that, a
question's answer vocabulary is bounded by what the question is about: the completion question carries
a classified evidence shape and offers only the reason codes that evidence can support (ADR-061), so a
claim the platform never measured cannot be recorded as an answer.

Phase H adds the **multi-model frontier**: a single configured provider and model id became a
**registry** of declared models — each with capabilities, modalities, a latency class, a lifecycle and
an availability window — reachable through one or more configured providers, with a `FrontierExecutor`
port that runs exactly one step of the chosen plan. Routing stays a pipeline rather than a model's job:
code extracts requirements, filters eligibility and orders candidates deterministically, the decision
layer may **reorder** them but only within a permutation of what it was offered, and the frontier
executes. An unregistered model, a model misattributed to a provider, and a requirement nothing
satisfies are all explicit refusals — a model is never silently substituted — and identity is always
the requested `modelId`, so cost rates, events and traces cannot be repointed. Availability is a
declared window judged against the injected clock (ADR-057), and the layer is recorded in ADR-058.

The default provider is offline and deterministic, so the platform needs no vendor
account, no key and no network; the decision layer defaults to `disabled`, which is a fully
functional state. Design in full: `docs/architecture/V2-ARCHITECTURE.md`
§34 (Phase C), §35 (Phase D), §36 (Phase E), §37 (Phase F), §38 (Phase G) and §39 (Phase H).

The agent runtime is selected **per project**. The default is **simulated** — it makes real provider
calls and one real, policy-checked workspace listing, but performs no engineering work, which `ai doctor`
reports as a warning. Configuring `agent.runner: "change-set"` selects a **bounded real coding path**:
one model turn becomes a bounded change set whose writes and verification run through the operation
gateway, and a task's acceptance criteria can be bound to a verification suite or a named check so their
status is assessed from that evidence (ADR-059, ADR-060); a criterion no check can decide is established
by a named person through an explicit, recorded verdict (ADR-062). It is one-shot — no repair loop, no
rollback.

Not implemented: a full autonomous agent loop, engineering memory, a context cache,
embeddings/semantic search, plugins, replay/checkpoints, container/remote execution and the dashboard.

## Layout

- `src/core/` — ids, clock, errors, boundary validation, secret redaction.
- `src/projects/`, `src/workspaces/`, `src/tasks/`, `src/sessions/` — domain entities.
- `src/decisions/` — decision records, risk, policy, the `DecisionProvider` port, routing, and the
  decision layer: the eight bounded domains, the decision engine, deterministic validation, the
  fallback registry.
- `src/models/` — the frontier vocabulary and registry: capabilities, modalities, roles, lifecycle and
  availability, eligibility, deterministic ordering and process-local health. Knowledge, not
  authority — it offers no `select` and no `best`.
- `src/orchestration/` — the frontier use case: requirement extraction, candidate scoring and the four
  routing modes, bounded plan variants, and the plan → decide → execute → account pipeline.
- `src/observability/` — events, token accounting, cost accounting, budgets, task metrics.
- `src/context/` — context domain: candidate vocabulary, token estimation, exclusion policy,
  path/import matching, explainable scoring, budget arithmetic, configuration fingerprint.
- `src/policy/` — the enforcement domain: capability vocabulary, reason codes, operation targets and
  reference rules, path containment arithmetic, the access policy and its pure evaluation.
- `src/ports/` — the interfaces: event store, task repository, agent runner, LLM provider,
  HTTP transport, sleep, environment, append lock, project scope, context engine,
  repository reader, change provider, process runner, the frontier execution port (one step, one model,
  no choice) and operation (requests, results, the sandbox boundary and the gateway).
- `src/adapters/` — the implementations, none of which know about each other: JSONL event
  store + file task repository + append lock, validated project config, deterministic and
  OpenAI-compatible providers, retry decorator, the JEV decision provider, the LLM frontier executor
  (registry → provider → adapter, normalising and never substituting), fetch transport, timer
  sleep, simulated and change-set runners, read-only repository reader, git change provider, argv-only
  process runner, and the local sandbox (filesystem, process, network and environment boundaries).
- `src/application/` — composition root, services, approval ledger, context engine pipeline
  and context service, the operation gateway, the policy dry run, the scope-bound decision
  coordinator, trace read model, task run, `ai doctor`.
- `src/cli/` — argument parsing, rendering, commands, dispatcher, process shim.
- `src/index.ts` — original smoke proof, unchanged (see ADR-014 on why there is no barrel yet).
- `src/skills/` — installed-skill integrity, across two records that are kept apart: the third-party
  installer's own working-tree hash reproduced exactly (read and reported, never redefined), and this
  repository's canonical LF content pins, which are what the read-only check decides on. Exercised by
  tests only; not wired into any CLI command or runtime path (ADR-064).
- `tests/unit/` — deterministic offline Vitest tests.
- `scripts/verify.sh` — single local verification pipeline; CI runs the same script.
- `.github/workflows/ci.yml` — CI gate on `main`.
- `docs/` — workspace notes; `docs/architecture/RECONCILIATIONS.md` is the generated index of
  every dated reconciliation note (`pnpm docs:reconciliations`).

## Deferred (reserved, not created)

- `evals/` — AI evaluation harness, later phase.
- Python/`uv` — when a real Python workload exists.
- Docker — when runtime parity is required.
- Engineering memory, a context cache, embeddings/semantic search, plugins,
  replay/checkpoints and the dashboard; container/namespace execution. See the
  V2 RFC roadmap (§33), §35.6, §36.10, §37.7, §38.8 and §39.8.

## Verification order

1. install → 2. format:check → 3. lint → 4. typecheck → 5. test → 6. build → 7. run built artifact.
