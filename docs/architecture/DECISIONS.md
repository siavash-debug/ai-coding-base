# V2 Architectural Decisions

Status: **Accepted**
Applies to: `docs/architecture/V2-ARCHITECTURE.md` (revision 1)

This file records the initial architectural decisions for the V2 evolution of
`ai-coding-base`. It follows the ADR format used by §22 of the architecture RFC.

**Ownership.** These decisions are human-owned. The AI drafted them (`recordedBy: agent`);
acceptance is an explicit human action. Nothing here becomes authoritative architecture
merely because an agent wrote it down. Treat every entry as `proposed` until a human
accepts it in a commit, review, or explicit approval.

**Everything in this file is a decision, not an implementation claim.** What actually
exists as code is stated at the end of this document and in the change report.

Convention: `decidedBy: human` · `recordedBy: agent` unless stated otherwise.

---

## Validation review (Phase 1.5)

Before recording these decisions, the RFC was reviewed against the eight validation
criteria. Findings and their resolutions:

| #   | Check                                        | Result                      | Evidence / action                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Internal contradictions                      | **Pass, 3 reconciliations** | Declared vs effective risk was ambiguous in two places; unified as `effectiveRisk = max(declared, baseline)` (§12.2, ADR-011). Unbounded-budget semantics (`{}` = unbounded) clarified against the "task always has a budget object" rule (§6, ADR-009). `Decision.outcome` was required on creation while `createdAt`/`decidedAt` implied a pending state; resolved by adding `"pending"` and making `decidedBy` optional until resolution (§8.2, ADR-003). |
| 2   | Isolation consistent everywhere              | **Pass**                    | Isolation exists only as the workspace `IsolationProfile` (§5) consumed by §19; cross-boundary access exists only via human-issued `AccessGrant`. No other path grants access.                                                                                                                                                                                                                                                                               |
| 3   | JEV not mandatory for every decision         | **Pass**                    | The §8.1 ladder is layered and each layer is optional; §9.3 degradation matrix proves operation with no provider at all; §9.2 forbids any code path that stops because JEV is absent. Decisions may be answered by `code`, `policy`, `llm`, or `human`.                                                                                                                                                                                                      |
| 4   | LLM providers replaceable                    | **Pass**                    | All model access is behind `LlmProvider` (§10); vendor types are forbidden in port signatures (§24.2); usage is normalised so the accounting layers never see a vendor's shape.                                                                                                                                                                                                                                                                              |
| 5   | Observability does not leak secrets          | **Pass, 1 hardening**       | Payloads are metadata + references; prompts/completions are not stored by default; redaction precedes candidacy for context. The two highest-risk fields (`ContextSelected.selectedRefs`, `Decision.evidence`) now carry an explicit "references, never payloads" rule (§17.2, §8.2).                                                                                                                                                                        |
| 6   | Task → Session → Event traceability complete | **Pass, 1 fix**             | A real gap was found: `taskId`/`sessionId` being optional in the envelope allowed an emitter to silently break the chain. Fixed by adding a traceability MUST (§17.1) requiring task-scoped events to populate both.                                                                                                                                                                                                                                         |
| 7   | Core remains lightweight                     | **Pass**                    | No database, no server, no network, no runtime dependency; every port has a deterministic or in-memory default (§24.2); the CLI is deferred and thin (§25).                                                                                                                                                                                                                                                                                                  |
| 8   | Supports multiple project types              | **Pass**                    | Project/workspace/task/policy/isolation/budget/observability layers are language-agnostic. Only the context/index layer and toolchain adapters are language-aware, and those sit behind ports (§11, §24). Language/toolchain detection is explicitly deferred (§4).                                                                                                                                                                                          |
| 9   | Migration safety (added check)               | **Pass, 1 correction**      | The planned `src/index.ts` barrel collides with the existing public `WorkspaceStatus` export versus the domain's `WorkspaceStatus` type. A barrel would silently shadow one of them or force renaming a public API. Corrected: no barrel in this phase (§32.2, ADR-014).                                                                                                                                                                                     |

**Deliberate non-goals confirmed by the review:** no dashboard, no database, no JEV call,
no LLM call, no container execution, no agent loop, no prompt storage — all deferred with
named phases rather than left ambiguous.

---

## ADR-001 — V2 is a foundation, not a framework

**Context.** The repository is a baseline intended to be cloned for many different
software projects. The temptation is to grow it into an all-in-one AI agent framework.

**Decision.** V2 provides infrastructure: a domain model, ports, observability, and
policy. It ships no agent loop, no prompt library, and no vendor SDK in its core.

**Consequences.** Projects adopt the foundation incrementally. The platform cannot be
"run" as an autonomous engineer, which is intentional: the human stays the owner.

**Alternatives rejected.** A batteries-included agent framework (couples the base to one
agent design and one provider); a pure template with no code (no shared observability or
traceability).

---

## ADR-002 — Cheapest-sufficient-layer ladder for every decision

**Context.** Routing every judgement to an LLM is slow, expensive, non-deterministic, and
unauditable.

**Decision.** Capabilities are placed at the cheapest layer that can answer correctly:
**deterministic code → policy → decision provider (JEV) → LLM → human**. Higher layers are
consulted only when lower layers cannot produce a bounded, sufficient answer.

**Consequences.** Most behaviour is deterministic and unit-testable offline. Non-determinism
is confined to explicitly bounded decision points. Each layer must be able to _abstain_.

**Alternatives rejected.** LLM-first orchestration; a single monolithic "brain" component.

---

## ADR-003 — Decisions are first-class, recorded entities

**Context.** "Why did the system do that?" must be answerable after the fact.

**Decision.** Every decision that influenced an outcome is recorded as a `Decision` with
its kind, question, enumerated options, outcome, the layer that decided it (`decidedBy`),
rationale, alternatives, evidence references, and cost/latency when applicable. A record is
created when the question is _asked_ (`outcome: "pending"`, no `decidedBy`/`decidedAt`) and is
resolved exactly once; resolution is an immutable transition. This matches the
`DecisionRequested` / `DecisionCompleted` event pair.

**Consequences.** Decisions become traceable and auditable; JEV/LLM override rates become
measurable (§29). Recording is required, not optional, which adds a small write cost per
decision.

**Alternatives rejected.** Log-only diagnostics (unstructured, unqueryable); recording only
"interesting" decisions (unknowable in advance).

---

## ADR-004 — JEV sits behind a `DecisionProvider` port and is never mandatory

**Context.** JEV is valuable for bounded decisions, but a dependency on JEV (or on any single
engine) would make the platform unusable offline, in CI, and for projects without JEV access.

**Decision.** JEV is one implementation of `DecisionProvider`. Core and domain code never
import, name, or require it. Provider selection is a deterministic routing function over
registered capabilities and priorities. Abstention, failure, unavailability, and budget
skips all escalate to the next layer instead of stopping execution.

**Consequences.** The platform runs with zero providers. JEV can be added, swapped, or
removed by configuration and an adapter. JEV may _propose_ but never _authorise_ high-risk
operations.

**Alternatives rejected.** JEV as a hard dependency of the decision engine (violates the
offline/CI requirement and creates vendor lock-in); direct JEV calls from domain code
(untestable, leaks a vendor into core).

---

## ADR-005 — Tasks are first-class; the execution record lives in events, not in `Task`

**Context.** The task is the natural anchor for context, budgets, traceability, and cost.
Embedding all execution data in the task object would make it a mutable god-object and
break replay.

**Decision.** `Task` holds identity and contract (context, constraints, acceptance criteria,
risk, budget, status, verification strategy). Usage, cost, calls, decisions, tests, and
events are attached by `taskId` through the event log.

**Consequences.** `Task` stays small and stable. Task status is a projection of events.
Reading metrics requires the event log, which is the same source the dashboard will use.

**Alternatives rejected.** Fat `Task` aggregate containing sessions and usage; separate
"execution record" model that duplicates the event log.

---

## ADR-006 — The event log is the single source of observability truth

**Context.** The requirement is explicit: metrics must be generated from real events, never
manually entered.

**Decision.** The runtime emits ordered, versioned, attributed events. Traces, token
ledgers, cost ledgers, metrics, and replay are all _projections_ over that log.

**Consequences.** If a number is not derivable from events, it does not appear in a report.
Observability failures must be reported as incomplete accounting, never as complete numbers.
Session counters (iterations, calls) are convenience projections and must be recomputable.

**Alternatives rejected.** Direct metric emission per subsystem (drifts, unorderable,
unreplayable); periodic sampling (loses the tail where incidents live).

---

## ADR-007 — Money is integer micro-USD

**Context.** Floating-point dollars accumulate visible error when summed over thousands of
model calls, and cost is aggregated per call then per task then per project.

**Decision.** All money is an integer count of micro-USD (`1e-6 USD`), combined with a
`currency` field. Cost is always explicitly an **estimate** derived from a versioned
`ModelRate` table.

**Consequences.** Aggregation is exact under summation within `Number.MAX_SAFE_INTEGER`
(≈ $9.0 × 10⁹) and portable to `bigint`/`Decimal` later without changing the domain shape.
Formatting lives at the presentation edge. Per-call rounding is a bounded, documented
approximation.

**Alternatives rejected.** Float dollars (silent drift); `Decimal` dependency now (adds a
runtime dependency before it is justified); storing cents (insufficient resolution for
cheap models).

---

## ADR-008 — Cached tokens are a subset of input tokens

**Context.** Providers report cached/prompt-cache token counts inconsistently, and naive
summation double-counts them.

**Decision.** `AIUsage` has `inputTokens`, `outputTokens`, `cachedInputTokens` (a subset of
input), and optional `reasoningTokens`. `totalTokens = input + output`. Billing subtracts
cached from input before applying the input rate.

**Consequences.** Totals are comparable across providers, and cost matches how providers
actually bill. Adapters that cannot report cached tokens report `0`, which is
distinguishable from "not reported" for optional fields.

**Alternatives rejected.** Cached tokens as a separate additive dimension (over-reports
tokens); provider-specific usage shapes leaking into the domain (reintroduces lock-in).

---

## ADR-009 — Budgets are pure, provider-independent, and evaluated twice

**Context.** The requirement is budget behaviour at 80% / 90% / 100% without coupling budget
logic to an LLM provider. Token counts are only known _after_ a call returns.

**Decision.** Budget evaluation is a pure function of `(budget, consumption, thresholds)`:
`80% → warning`, `90% → critical (optimize/escalate)`, `100% → stop or require approval`
(`onExceeded`). Evaluation runs pre-flight and reconciles after each action. An absent limit
is unbounded; `0` means "no consumption permitted". `{}` is valid and means unbounded, so
policy MAY require an explicit budget for `high`/`critical` risk tasks.

**Consequences.** Budget logic is testable with no providers and no clock. Exceeding a hard
limit never silently continues. Adapters only report usage; they never decide budgets.

**Alternatives rejected.** Budget enforcement inside provider adapters (unportable,
untestable, duplicated); a single post-hoc check (cannot prevent an expensive call).

---

## ADR-010 — Workspace isolation is a declared capability profile, not a Docker dependency

**Context.** Isolation must eventually cover filesystem, git, processes, dependencies,
environment, secrets, network, AI context/memory, task history, telemetry, and resource
limits. Locking the design to Docker now would over-constrain a repository meant to run on
laptops and in many CI systems.

**Decision.** Isolation is expressed as an `IsolationProfile` of 12 dimensions, each with a
`mode` (`none`/`shared`/`scoped`/`process`/`container`/`sandbox`/`vm`) and an `enforcement`
level (`enforced`/`declared`/`unsupported`). Execution goes through a `Sandbox` port with
in-process, process, and container adapters arriving in later phases. Cross-boundary access
requires a human-issued, expiring `AccessGrant`.

**Consequences.** The core runs unconfined on a laptop and containerised in CI with no domain
change. The platform must state honestly whether a boundary is enforced or merely declared —
overstated isolation is treated as a defect, not a rounding error.

**Alternatives rejected.** Docker as the assumed runtime (excludes local/offline use);
no isolation model (fails the isolation-by-default requirement); pretending isolation is
enforced when it is only declared.

---

## ADR-011 — Policy evaluation is pure, most-restrictive-wins, with baseline risk floors

**Context.** "Low risk → automatic, medium → verify, high → approval" must be enforced
consistently and must not be talkable-down by a low declared risk.

**Decision.** `evaluatePolicy(policy, request)` is a pure function. The most restrictive
matching effect wins (`deny > require-approval > verify > allow`); ties are broken by
specificity (fewer matched operations first, so a targeted rule explains the decision
better than a broad safety net), then by rule id. When no rule matches, `defaultEffect`
applies and the default is `verify`, never `allow`. Effective risk is
`max(declaredRisk, baselineRiskForOperation)`, with published baseline floors per
operation.

**Consequences.** Policy is offline-testable and auditable, and an agent cannot reduce the
risk of an inherently dangerous operation. AI/JEV proposals may only escalate effects,
never weaken them.

**Alternatives rejected.** First-match rule evaluation (order-dependent, fragile); trusting
declared risk alone; default `allow` on no match (fails closed-open).

---

## ADR-012 — No database in Phase 2; local, inspectable persistence later

**Context.** The instruction is explicit: do not implement a database unless the existing
architecture absolutely requires one. Nothing in the current repository does.

**Decision.** Phase 2 ships a pure, persistence-free domain. Phase C adds an append-only
JSONL event log and file-backed task records (zero runtime dependencies, human-inspectable,
grep-able, git-diffable). A `StorageAdapter` port with SQLite/Postgres adapters is added only
if measurement justifies it.

**Consequences.** The domain stays pure and fast to test. Persistence shapes are separated
from domain shapes with explicit mappers and per-record `schemaVersion`. Repository writes
use optimistic concurrency (read version, compare, reject conflicts).

**Alternatives rejected.** SQLite/Postgres now (unjustified complexity, new dependency, no
existing consumer); in-memory only forever (blocks task history and replay).

---

## ADR-013 — Branded ids and injected time; timestamps are ISO-8601 UTC strings

**Context.** Entity identity mix-ups and non-deterministic time are the two most common
causes of untestable domain code and unreplayable traces.

**Decision.** All ids are branded string types (`ProjectId`, `WorkspaceId`, `TaskId`,
`SessionId`, `DecisionId`, `EventId`) created through validating factories. All timestamps
are ISO-8601 UTC strings. Domain logic never calls `Date.now()`; it receives a `Clock`.

**Consequences.** Ids from different entities cannot be accidentally interchanged at compile
time. Tests are deterministic. Replay and checkpointing are possible because time is a
parameter, not an ambient fact.

**Alternatives rejected.** Plain `string` ids (silent mix-ups); `Date` objects in persisted
shapes (timezone/serialization ambiguity); a global clock or `Date.now()` in domain logic.

---

## ADR-014 — Migration is additive and non-destructive; no speculative directories

**Context.** The repository has a working, deliberate baseline (contracts, verification
pipeline, 36 tests). The RFC lists a target layout that includes directories such as
`ai/agents`, `infrastructure/storage`, and `plugins/`.

**Decision.** Existing functionality is preserved: `AGENTS.md`, `docs/TASK_CONTRACT.md`,
`src/result.ts`, `src/index.ts`, `scripts/verify.sh`, and CI keep working unchanged.
`src/index.ts` is left **untouched** in this phase: it already exports a `WorkspaceStatus`
interface, and the workspace model defines its own `WorkspaceStatus` type; a barrel would
either silently shadow one or force renaming an existing public API, which `AGENTS.md` §2.2
forbids. The barrel arrives in Phase C, when the CLI/application layer defines the real
public surface — until then the domain is imported from its module paths.
New directories are created **only in the phase that fills them** — no empty `ai/`,
`infrastructure/`, or `plugins/` trees. The verification pipeline grows by appending steps;
existing steps and their order are frozen.

**Consequences.** Every phase lands green and reviewable. Reviewers can trust that an absent
directory means "not built yet", not "forgotten". Some RFC-listed modules do not exist yet,
by design.

**Alternatives rejected.** Big-bang restructure of `src/` (breaks the baseline, large
unreviewable diff); scaffolding all planned directories now (speculative structure, the exact
anti-pattern the RFC forbids).

---

## ADR-015 — Human approval is blocking, scoped, and non-transferable

**Context.** Risk-aware execution requires that high-risk operations cannot be automated
away, and that a previous approval cannot be reused as blanket consent.

**Decision.** `high` and `critical` risk operations require an explicit human approval record
scoped to an operation, target, and session. Approvals expire; timeouts resolve to the safe
path (abort), never implicit consent. Denials and expiries are recorded with the same rigour
as grants. Approval summaries contain references and intent, never secret values.

**Consequences.** No autonomous path to destructive database operations, production changes,
authentication/security changes, destructive filesystem operations, or sensitive
configuration changes. Human latency is on the critical path for those operations, which is
accepted as the price of ownership.

**Alternatives rejected.** Non-blocking "approve later" default (unsafe); session-wide or
project-wide approval (blanket consent); retry-until-approved (turns approval into a
formality).

---

## ADR-016 — Engineering memory is project-scoped; AI-authored knowledge stays `proposed`

**Context.** "Do not allow AI-generated decisions to silently become authoritative
architecture." Memory also must never leak between projects.

**Decision.** Memory lives under `.ai/memory/` with a `scope` of `project` or `workspace` and
no global tier. Every entry has provenance (`sourceTaskId` or `human`), a `reviewStatus`, and
content-addressed, diffable content. Entries created by AI are `proposed` and only become
`authoritative` through explicit human acceptance.

**Consequences.** Context selection can rely on `accepted` entries only. Cross-project sharing
is an explicit export/import with human review. Repositories cloned from the base never share
memory by default.

**Alternatives rejected.** A global memory store (cross-project leakage); auto-accepting
AI-written conventions (silent architecture drift); git-history-only memory (unstructured,
unreviewable).

---

## ADR-017 — ADRs are human-decided; AI may draft only

**Context.** Architecture decisions must be traceable to the task, session, decisions, and
context that produced them — with explicit human ownership.

**Decision.** An `ArchitectureDecisionRecord` has `decidedBy: "human"` and `recordedBy`
`human` or `agent`. Acceptance produces a `HumanApprovalGranted` event. Records may reference
the originating task, session, decision ids, and context refs. Superseding is additive;
history is never rewritten. AI `proposed` records must be visibly distinguishable from
human-`accepted` ones everywhere they appear.

**Consequences.** This very document is `proposed` until a human accepts it — the rule
applies to the platform's own design, not just to projects using it.

**Alternatives rejected.** AI-accepted ADRs (violates human ownership); free-form markdown
with no structure (not queryable, not traceable).

---

## ADR-018 — The context engine's default selector is deterministic; JEV assistance is bounded

**Context.** Context selection is the largest lever on token cost and a common leak path.

**Decision.** The default `ContextSelector` is a pure, deterministic scorer
(relevance/authority/recency over token cost, stable tie-breaking) with a hard token budget,
mandatory inclusion of `requiredRefs`, and an explicit record of what was dropped and why.
Redaction happens before an item becomes a candidate. JEV/LLM assistance may produce scores
only; it can never bypass the budget. The engine is testable with no providers.

**Consequences.** Context cost is predictable and testable; selection is reproducible.
Quality of selection depends on the ranker, which is a port and therefore replaceable.

**Alternatives rejected.** Embedding-similarity-only selection (non-deterministic, opaque);
LLM-driven selection as the default (expensive, unpredictable, leaks context by design);
no budget (unbounded cost).

---

## ADR-019 — Trace replay is exact; decision replay reports differences honestly

**Context.** Reproducibility is a stated goal, but LLM and JEV layers are not deterministic.
Presenting a re-run as "what happened" would be a lie.

**Decision.** Two replay modes: **trace replay** (exact reconstruction of the timeline and
metrics from the event log; no providers, no network) and **decision replay** (re-asks
non-deterministic layers and reports the diff). The determinism boundary is declared per
layer: `code`/`policy` deterministic, `decision-provider`/`llm` not. Original decisions
remain authoritative. Checkpoints are written before risky operations and at budget
thresholds, and record the event sequence they correspond to.

**Consequences.** Incident review is always possible offline. Re-running to compare model
behaviour is possible without corrupting the audit trail.

**Alternatives rejected.** Claiming full determinism (false); no replay (loses the
reproducibility goal); recording raw prompts to enable replay (secret-leak risk, so prompts
stay unstored by default).

---

## ADR-020 — The CLI is a thin adapter; the core has zero mandatory runtime dependencies

**Context.** The platform's CLI surface is large (§25.1), but projects must not inherit a
heavy server/UI/CLI stack.

**Decision.** Command handlers parse and validate arguments, call an application use-case,
and format output. Business logic lives in the application/domain layers. The core requires
no runtime dependency and no server; `util.parseArgs` or a minimal parser is preferred over
a CLI framework. Every command supports `--json` and `--dry-run` where applicable, and exit
codes are stable and documented. `ai doctor` reports honestly which optional adapters are
configured and at what isolation enforcement level.

**Consequences.** Projects can consume the library without the CLI. Human-readable output is
not a stable contract; `--json` is.

**Alternatives rejected.** A CLI framework dependency now (unjustified); logic in command
handlers (untestable, duplicated).

---

## ADR-021 — The dashboard is deferred and must remain removable

**Context.** The RFC explicitly forbids building the dashboard in this phase, while listing
its eventual panels.

**Decision.** No web UI, no server, no backend. When built (Phase I), the dashboard is a
read-mostly projection over the same versioned JSON that `--json` emits. Removing it must not
require changes to `core/`, the domain, or adapters.

**Consequences.** The core must never depend on a UI concern. Any future UI work must consume
the projection contract rather than reach into domain internals.

**Alternatives rejected.** Dashboard-first development (inverts the priority of correct
architecture); embedding UI concerns in the domain (makes the core unremovable).

---

## ADR-022 — The composition root is the only module that names an adapter

**Context.** Phase C introduces the first real adapters (JSONL event store, file task
repository, deterministic LLM provider, simulated agent runner). Without a rule, adapter
knowledge leaks upward into services and the ports stop meaning anything.

**Decision.** Exactly one module — `application/runtime.ts` — selects concrete adapters and
constructs the application services. Everything above it depends on ports and on pure domain
modules; adapters know nothing about each other. Swapping JSONL for SQLite, or the simulated
runner for a real agent, is a change to that one file.

**Consequences.** `openRuntime()` is the seam a future dashboard, worker or test reuses. A
service that needs a new capability must take a port, not import an adapter.

**Alternatives rejected.** Importing adapters directly in services (inverts the dependency); a
global service locator (hidden dependencies, untestable).

---

## ADR-023 — Write order is event first, projection second

**Context.** Creating or transitioning a task writes to two places: the event log (truth) and
the task record (a projection for cheap reads). These two writes cannot be made atomic without
a transaction manager, which Phase C deliberately does not have (ADR-012).

**Decision.** The event is always appended first, and the record is saved second. A failure
between the two leaves an honest log plus a stale record, which `ai doctor` detects and reports
as an integrity issue. The reverse order would leave the log lying about what happened.

**Consequences.** The log is authoritative under partial failure. Projections must be treated as
possibly stale, and the trace reports record/log disagreement instead of silently resolving it.

**Alternatives rejected.** Record-first (a log that under-reports reality); two-phase commit or a
journal (a persistence engine the phase does not need).

---

## ADR-024 — Project configuration is JSON, not YAML

**Context.** The RFC sketched `.ai/project.yaml`. A YAML parser would be the first runtime
dependency of a repository whose core must stay dependency-free (ADR-020).

**Decision.** Project configuration is `.ai/project.json`, validated as untrusted input at every
read, including cross-checks that each workspace belongs to the configured project and stays
inside the project root.

**Consequences.** No runtime dependency is added. If YAML becomes genuinely necessary, it is a
format adapter behind the same validated `ProjectConfig` shape, not a change to the domain.

**Alternatives rejected.** Adding a YAML dependency for authoring comfort; a JS config file
(executable configuration is a security and reproducibility problem).

---

## ADR-025 — Event storage is a project-scoped JSONL log, partitioned per workspace

**Context.** Phase C needs a durable, append-only event store with no database, no service and
no network (ADR-012).

**Decision.** One append-only JSONL file per workspace, inside the project's own tree:
`<projectRoot>/.ai/runtime/events/<workspaceId>.jsonl`. Appends use `appendFile` and never
rewrite; serialization is canonical JSON (recursively sorted keys) so equal events produce
identical bytes; appends are sequence-guarded, so a non-extending sequence is a `CONFLICT`
rather than a silent overwrite; every line is re-validated on read. A project-wide read is an
explicit union over the partitions, never a shared file.

**Consequences.** The log is inspectable with `cat`, diffable, and trivially replayable. The
sequence guard assumes a single writer per workspace stream; genuine multi-writer coordination
is deferred until an adapter that needs it exists.

**Alternatives rejected.** One global log for all projects (breaks isolation); SQLite now
(ADR-012); a binary or columnar format (uninspectable at this stage).

---

## ADR-026 — Scope is inherited from context, never restated per call

**Context.** During Phase C review, decisions were being recorded with the correct `taskId` in
their _context_ while the emitted event was built only from the _input_. The decisions were
valid, and invisible in the owning task's trace — an observability failure that no type checker
would catch, because both values were optional.

**Decision.** A service derives scope (`taskId`, `sessionId`) from its context and applies it
unless the call explicitly overrides it. `EventRecorder` additionally rejects any event carrying
a `sessionId` without a `taskId`, so the `Task → Session → Event` chain cannot be broken by
a writer that forgets.

**Consequences.** Traceability is enforced at the writer, which is the only place that can
guarantee it. New event-emitting services must take a scope-bearing context rather than loose
optional ids.

**Alternatives rejected.** Inferring scope in the trace reader (repairs the symptom, keeps the
bad data, and fails for consumers that never read traces); making the ids required everywhere
(would forbid genuinely project-level decisions).

---

## ADR-027 — A task id is not authorization; every read and write names its scope

**Context.** Storage must not be reachable by guessing or holding an id. Isolation must survive a
caller that is merely mistaken about which project or workspace it is operating on.

**Decision.** Every port method takes an explicit `ProjectScope`, and every adapter is bound to
one project at construction. A scope for a foreign project is `FORBIDDEN`; a workspace outside
the project's configured set is `FORBIDDEN`; an event or record whose own ids disagree with the
file it was found in is `INVARIANT`. Reads are project-scoped by default and narrowed with
`--workspace`; only writes must name a workspace.

**Consequences.** Two projects can share one disk and one id space without either being able to
reach the other. The project is the isolation boundary, so cross-workspace reads inside one
project are allowed and are tested as such.

**Alternatives rejected.** Trusting ids (Phase C would ship a privilege-escalation pattern); a
single global store with namespacing (one bug away from cross-project leakage).

---

## ADR-028 — A successful run ends in `review`; closing a task is a human act

**Context.** An automated attempt must not be able to declare its own work done. At the same
time, a slice whose tasks can never be closed is not a usable workflow.

**Decision.** `ai task run` drives `created → planning → in_progress → verification → review` and
stops. Reaching `completed` is a separate, explicit human action (`ai task complete`), which is
recorded as such. Acceptance criteria are never marked met by the run, so a completion reports
the true acceptance summary rather than a flattering one.

**Consequences.** `review` is intentionally not terminal, so metrics report the task as `open`
until it is closed; the trace shows elapsed time meanwhile. Completion with unmet criteria is
possible and is recorded honestly, which is what makes the number trustworthy.

**Alternatives rejected.** Auto-completing on a passing verification (the runner would be grading
its own homework); leaving tasks unclosable (an unusable slice).

---

## ADR-029 — Approval requests suspend the task; policy denials fail it

**Context.** Two different stops can interrupt an attempt: a policy says the operation is not
permitted, or a human must decide before it proceeds.

**Decision.** A `deny` effect fails the task with the policy's reason — there is nothing to wait
for. A `require-approval` effect records an approval request, ends the session as `aborted`, and
leaves the task exactly where it was, so the pending decision is visible in the trace and the
task still reflects reality.

**Consequences.** An approval request is always accompanied by a recorded decision naming the
escalation, so "who is waiting, for what, and why" is answerable from the log alone. Phase C does
not consume grants; wiring a grant back into a suspended run is Phase D.

**Alternatives rejected.** Failing the task on an approval request (destroys the pending state);
suspending on a denial (a denial is an answer, not a question).

---

## ADR-030 — `ai doctor` checks only what it can actually know, and says so

**Context.** A health check is easy to write in a way that looks reassuring and proves nothing.

**Decision.** Every check performs the thing it claims to verify: it opens the configuration,
appends and re-reads a real event through the real adapter (in a throwaway temp directory, so
the project log is never polluted), reads the project's own log, and reconstructs a real trace.
A deliberately absent capability — no real agent runtime, no vendor LLM provider — is reported as
`warn`, not `ok` and not `fail`. A failing check exits non-zero; a warning does not.

**Consequences.** `ai doctor` is usable in CI as a gate, and its output is honest about the
difference between "this works" and "this is not installed yet".

**Alternatives rejected.** Probing the project's own log (writes health-check noise into the
record of engineering work); asserting that files or symbols merely exist (a check that cannot
fail for a real reason).

---

## ADR-031 — The deterministic provider is a stand-in, and its rates are illustrative

**Context.** Phase C must demonstrate token and cost accounting end to end without installing a
vendor adapter, and must not appear to ship one.

**Decision.** The only `LlmProvider` implementation is offline, deterministic and named
`deterministic` / `deterministic-1`, registered as such in the doctor's output. Its pricing table
is labelled illustrative placeholder data, not a claim about any real vendor. A model with no
configured rate is reported as _unpriced_ with a lower-bound total — never as `$0` (ADR-007).

**Consequences.** Cost accounting is demonstrable and testable offline. Real rates belong in a
project's own configuration from a source the project trusts.

**Alternatives rejected.** Inventing prices for real model names (misleading); shipping a vendor
adapter (out of scope for this phase).

---

## ADR-032 — The CLI is a pure function plus a process shim, with no CLI framework

**Context.** The CLI must be testable without spawning processes or faking a terminal, and must
not become a second implementation of the platform.

**Decision.** `main(argv, io, env)` is a pure function returning an exit code, taking injected
stdout/stderr, working directory, clock and runtime version; `run.ts` is the only module that
touches `process`, and it sets `process.exitCode` rather than calling `process.exit`. Argument
parsing is a pure function with a declared spec per command. Commands parse, call one application
service, and render — they contain no lifecycle, accounting or storage rules, and the renderers
know nothing about policy.

**Consequences.** The whole CLI is tested in-process against a temporary project, offline and
deterministically, at no dependency cost. A future dashboard reuses the same services rather
than the terminal.

**Alternatives rejected.** A CLI framework (the largest dependency in the repository for the
least value); direct `process` access in commands (untestable, and untestable is how business
logic creeps in).

---

## ADR-033 — One real provider adapter speaks a protocol, not a vendor; credentials are references

**Context.** Phase D needs a real model call behind the existing `LlmProvider` port without the
platform taking a position on which vendor is correct, and without a key ever entering a
committed file, an event or a log.

**Decision.** Exactly one real adapter: **OpenAI-compatible Chat Completions**, parameterised by a
base URL, a model id and the _name_ of an environment variable holding the credential. The
provider id is the protocol (`openai-compatible`), so a project's rate table is vendor-agnostic
and a different endpoint is a configuration change, not a code change. Credentials are read
through the `Environment` port at call time, used for one request and dropped; project
configuration validation rejects a `credentialEnvVar` that looks like a value (a pasted key) or
that is not an environment-variable name, and rejects a base URL that embeds credentials. Only one
port (`HttpTransport`) can open a socket, and it never puts headers or bodies into a failure.

**Consequences.** A full run through the real adapter is testable offline by scripting the
transport (see `tests/unit/llm-gateway.test.ts`). Multiple vendors are a Phase E concern; adding a
second protocol means a second adapter and no change above the port.

**Alternatives rejected.** A vendor SDK per provider (couples the core to vendors, bloats the
dependency policy, and makes deterministic testing impossible); storing keys in project
configuration (committed secrets).

---

## ADR-034 — Retry is a bounded decorator over the provider port, never a provider's own behaviour

**Context.** Providers fail transiently. Retrying can also burn money without limit, and a
provider that decides its own retry policy makes spend unpredictable and untraceable.

**Decision.** Retry is a decorator (`createRetryingProvider`) applied by the composition root to
any provider. It retries only categories the taxonomy calls retryable (rate-limit, timeout,
network, server), is bounded by `maxAttempts` (default 3, hard maximum 10, validated in
configuration), uses capped exponential backoff, honours a provider `retry-after` within that cap,
and reports the total attempt count on success and failure. Waiting is an injected `Sleep`, so
backoff is deterministic in tests. Attempt counts are recorded on the completed event and summed
into `providerAttempts`, so "how hard did we try" is answerable from the log.

**Consequences.** No unbounded loop exists anywhere in the platform, and every retry is visible
in metrics. A non-provider error is never retried or wrapped: a programming error stays a
programming error.

**Alternatives rejected.** Retrying inside each adapter (duplicated, unbounded, invisible to
metrics); no retry at all (a transient 429 fails a task).

---

## ADR-035 — Failures are categorised; absent usage is _unavailable_; vendor text is never persisted

**Context.** A provider can fail in ways that need different responses (a rejected credential and
a rate limit are not the same problem), and vendor error strings are a classic channel for
leaking credentials into logs.

**Decision.** Failures are normalised into a closed set (`auth`, `rate-limit`, `timeout`,
`network`, `server`, `malformed-response`, `refused`, `unknown`), carried on `LlmProviderError`
with a status code, an attempt count and retryability. The vendor's message, the request body and
the response body never reach an event, a trace or an error's public surface; operator-facing
text passes through `redactSecretLikeValues` first. Missing usage is represented as _absent_
(`usage: undefined`, `usageReported: false`), never as zeroes, and a self-contradictory usage
report (cached tokens exceeding input tokens) is a `malformed-response`, not a rounding fix. A
failed request is recorded as `LLMRequestFailed` with both `LLMRequestStarted` and the failure, so
the attempt keeps a truthful record of what it tried; it is not counted as a model turn.

**Consequences.** The trace distinguishes "the provider refused" from "we did less work". Cost
becomes explicitly incomplete rather than silently wrong (`costComplete: false`,
`usageUnavailableCalls`). A test asserts that a credential and an `authorization` header never
appear in a failure for 401/429/500 responses.

**Alternatives rejected.** Recording the vendor message for “better debugging” (a secret leak with
extra steps); defaulting usage to zero (turns "unknown" into "free").

---

## ADR-036 — Append coordination is a port with an honestly stated local guarantee

**Context.** The event log is append-only, but "append" is not atomic with "decide what sequence
comes next". Two writers that both read `tail = 7` would both write sequence 8 and the log would
stop being a reliable ordering. Phase D also explicitly does _not_ want distributed coordination.

**Decision.** `AppendLock` is a port with a declared guarantee (`none` |
`local-process-and-file`). The local adapter combines an in-process queue (exact, free) with an
atomic exclusive-create lock file (`open(…, "wx")`), and the JSONL store performs its
**tail-read and append inside the lock**, so a second writer cannot append a sequence that already
exists — it is rejected as `CONFLICT`. Acquisition failure is explicit (`LOCK_TIMEOUT`, never a
silent proceed). Locks older than `staleLockMs` are reclaimed so a crashed process cannot wedge a
project; the threshold is far larger than any append. Readers never take the lock. The limits are
documented rather than implied: this coordinates cooperating writers on one machine with atomic
exclusive create, it is **not** a distributed lock, and reclaim is best-effort. `ai doctor`
exercises the mechanism for real — it holds the lock and proves a second writer is refused — and
reports the guarantee string.

**Consequences.** Parallel execution within one machine is safe; append cost is linear in log size
(the tail is re-read under the lock), which is acceptable for a local JSONL log and is the price
of correctness here. A SQLite or database adapter can implement the same port with row locking.

**Alternatives rejected.** An in-process mutex only (does not protect against a second process); a
database (deferred by ADR-012); pretending the lock is distributed (an honesty failure).

---

## ADR-037 — A grant is single-use, scoped, and never widens permission; consumption is an event

**Context.** Phase C could ask for approval and suspend a task; nothing consumed the answer. A grant
that is implicit, reusable or expandable turns "a human accepted this risk" into a claim the log
cannot support.

**Decision.** The approval lifecycle is ask → grant → consume, each a first-class event, with state
projected by the `ApprovalLedger`. A grant is **scoped** (a risk level, and either one operation or
the whole task) and **single-use**; consumption is recorded, so "which approval authorised this
attempt, and when" is answerable from the trace alone. At each gate the run resolves in a fixed
order: consume a usable grant, else re-state an outstanding request, else raise a new one and
suspend. A later gate inside the same attempt is covered by the authority already established, but
a gate that exceeds that boundary suspends again: **an approval never widens what policy allows**.
Expired, consumed, narrower or lower-risk grants are ignored (and one narrower than the question
is not counted as an answer to it). Expiry is evaluated with one shared function, so the ledger,
the trace and `ai approvals` cannot disagree. A grant that a run discovers late is not silently
reused: a grant authorises _one attempt_.

**Consequences.** Resuming is a validated act (`ai task approve --resume`, or `ai task run` against
an existing grant), and a denial is still a failure rather than a wait (ADR-029). Grants that are
granted but unused are visible in `ai approvals`, which is what makes "nothing is waiting" and "one
step left" distinguishable.

**Alternatives rejected.** A boolean `approved` flag on the task (loses who, when, what for, and
how many times); auto-consuming any grant for any requirement (permission expansion); reusing a
grant for repeated attempts (breaks single-use).

---

## ADR-038 — A stale task projection is refused before anything is spent

**Context.** A run takes a task record from the caller. A task can be suspended for an hour and
resumed later, so the caller's projection may be behind. The first write of an attempt would fail
the version check — but only _after_ a real, paid model call had already happened.

**Decision.** `runTask` re-reads the record before doing anything observable and refuses the
attempt with `CONFLICT` if the version differs from the one it was handed, telling the caller to
re-read and retry. The attempt then proceeds against the fresh record. Optimistic concurrency is
unchanged — every lifecycle write is still version-guarded.

**Consequences.** Acting on a stale view costs nothing and is diagnosed precisely. Callers (the CLI
included) load the task immediately before running it, which is now an enforced expectation rather
than a hope.

**Alternatives rejected.** Silently using the fresh record (hides a caller bug and makes the
caller's arguments meaningless); ignoring the mismatch until the first write (spends money before
failing).

---

## ADR-039 — The context engine is deterministic, and content is never an event payload

**Context.** The Context Engine is the largest lever on token cost and the most likely place for a
leak: the one component that reads arbitrary repository text and decides what enters a prompt. It is
also the component most temptingly implemented as "ask a model which files matter".

**Decision.** Selection is a pure function of `(repository listing, task text, configuration)`: no
embeddings, no model calls, no learned weights. Two objects are kept structurally apart —
`ContextSelection` (metadata: paths, kinds, token estimates, scores, reason codes, budget arithmetic)
and `ContextBundle` (content, held in memory for exactly one prompt). Content is never written to an
event, a trace field, a log line or a CLI output; the `ContextSelected` payload carries paths, codes
and counters only. `LLMRequestStarted` references the selection by id, which is what joins "which
files were chosen" to "what that call cost" without either side storing prompt text.

**Consequences.** A selection is reproducible and re-derivable from the log alone; "why is this file
in my prompt?" is answerable from an old trace; a leaked event log leaks no source text. The cost is
that ranking is weaker than a semantic ranker — accepted deliberately, because a selection nobody can
re-derive is a selection nobody can debug or evaluate.

**Alternatives rejected.** An LLM-assisted ranker as the _default_ (irreproducible, paid, unauditable
per run); one polymorphic object carrying both metadata and content (the exact shape that turns a
file into an event payload); storing content behind a "contentRef" in Phase E (an abstraction with no
consumer yet, and the seam already exists in the port split).

---

## ADR-040 — Context has an explicit budget; mandatory overflow is loud, and nothing is truncated

**Context.** A selection has to fit a token budget, but a task may explicitly require a file that
cannot fit. Silently dropping it produces a confident answer about a file the run never read — the
worst possible failure mode for an engineering platform.

**Decision.** The budget is hard: it is never exceeded, and no file is ever truncated (a half-file
reads as valid context and is not). A candidate becomes **mandatory** only by being explicitly named
by the task, and a mandatory candidate that does not fit — for budget _or_ per-file size — is
reported as `budget-exceeded`, sets `budgetExceeded`, and yields an **empty bundle**. `runTask` then
fails the task with `context-budget-exceeded` before the first model call. Token counts use two units:
`candidateTokens` is the sum of size-based estimates over everything scored, `selectedTokens` the sum
of content-based estimates over what was selected, and `excludedTokens` is the difference — so the
arithmetic is complete and each unit is labelled.

The effective budget is `min(context.maxTokens, task.budget.maxTokens)`: a task that declared a
500-token budget must not be handed 8,000 tokens of context and then fail its own spend gate for doing
exactly what it was read. The bound used is recorded as the selection's `budgetTokens`, so it is never
a mystery.

**Consequences.** Context never quietly degrades the answer's basis; an over-budget task fails for
free, with the numbers in the trace. The cost is that a too-small budget fails a run outright rather
than proceeding degraded — which is the intended trade.

**Alternatives rejected.** Truncating the largest file to fit (produces syntactically valid nonsense);
proceeding with a warning (spends money to answer a different question); treating an oversize file as
an ordinary `oversize-after-sizing` exclusion when the task required it (quiet, and indistinguishable
from a trim); a knapsack optimiser (maximises token fill while preferring many small irrelevant files
over the one that mattered).

---

## ADR-041 — Exclusion is a single ordered policy, and repository text is data

**Context.** Context selection reads untrusted, adversarial input. Two distinct risks: a credential
file entering a prompt, and repository _instructions_ (`AGENTS.md`, READMEs, comments) being treated
as executable policy.

**Decision.** One function decides whether a path may be considered at all, in a fixed order of
authority: **credential-shaped name → hard-excluded directory → operator exclusions → `.gitignore`**.
Only the last two are negotiable, so neither a `!` rule nor an operator pattern can re-include a
credential file, and the decision is taken _before_ any read — a matching file's bytes never enter the
process. `gitignore` support is a documented subset (comments, `!`, trailing-`/`, leading-`/`, `*`,
`?`, `**`, last-match-wins, directory-prefix semantics); what is not implemented is listed rather than
approximated. Exclusion matching is deliberately over-broad — a document _about_ secrets is refused —
because a false positive costs one visible candidate and a false negative puts a key in a prompt.

Repository text cannot change policy, budget, isolation or permissions, and not by discipline:
nothing downstream of discovery reads file content for control. Tests assert that a hostile file
changes neither the selection it appears in nor the budget it ran under.

**Consequences.** The security argument is one function and one test suite. The cost is a small,
stated set of unimplemented gitignore features and some over-broad exclusions.

**Alternatives rejected.** Shelling out to `git check-ignore` (makes selection depend on a git
checkout and a subprocess for a security decision); a full gitignore implementation (more surface
than the platform needs, with the gaps invisible); letting configuration override credential
exclusion (an operator typo becomes a leak).

---

## ADR-042 — Change detection reports capability, and degrades explicitly

**Context.** Git history is a genuinely useful deterministic signal, and it is the one input that may
simply not exist: an exported tarball, a shallow CI clone, a container without `git`, a workspace that
is not a repository.

**Decision.** `ChangeProvider` answers `{available, refs?, reason?, revision?}` and never returns an
empty change set for a question it could not answer. The reasons are a closed set (`no-vcs`,
`not-a-repository`, `query-failed`, `disabled`) and are reported in the selection's capability record,
so a reviewer can see that a selection was made without change information instead of inferring it.
The adapter runs one `git status --porcelain -z` through a `ProcessRunner` port: argv and no shell, a
mandatory timeout, a captured-output cap, and a non-zero exit treated as a _result_ rather than an
exception. Paths are mapped to workspace-relative refs; a workspace above its own repository root is
reported unavailable rather than guessed at.

**Consequences.** Git improves selection when present and **cannot** be required for it: the engine
works with the provider disabled, absent or failing. The stated cost is that an environment without
git gets a slightly smaller selection, which the trace says out loud.

**Alternatives rejected.** Requiring a git checkout (makes the same task select different context in
different environments, silently); returning `[]` on failure ("nothing changed" and "I could not look"
are different facts and only one is safe to select on); reading history/branches (more surface, no
deterministic benefit for this phase).

---

## ADR-043 — A `ContextEngine` that records; an inspector that selects only when told to

**Context.** Somebody has to write the context events, and somebody has to answer "what context _will_
this task get?" before it runs. If the CLI selected context to answer that question, a read command
would append to the event log.

**Decision.** `ContextEngine.select()` records its own two events: every selection is a fact about a
task, and the engine is the only component that can guarantee the event is written _even when the
selection fails to fit_. The task-to-request mapping (`taskContextText`, `effectiveContextBudget`,
`selectContextForTask`) lives once in the application layer, so the run use case and the CLI cannot
drift into reporting different selections.

`ai task context <task-id>` reads recorded selections. `ai task context <task-id> --select` performs
and records a fresh one and says so in its output. Writing to the log is therefore always explicit,
visible and never a side effect of looking.

**Consequences.** A pre-run inspection is possible and auditable, and a selection that never fed a
model call is still visible as a fact (with no `LLMRequestStarted` referencing it, which is exactly
what happened). The cost is that `--select` is a mutating flag, mitigated by being named and echoed.

**Alternatives rejected.** A separate `ai task context plan` command (two commands for one concept);
the CLI building the request itself (a second mapping that would drift from the run's); the engine
returning a selection for a caller to record (a call site that forgets produces an unrecorded, and
therefore unevaluable, selection).

---

## ADR-044 — Commits carry the repository owner's identity, never a tool's

**Context.** This repository is developed with AI agents in the loop. Several of those agents
propose a default Git identity of their own, and a tool identity that lands in history is public,
permanent, and misrepresents authorship: it makes a contributor out of something that did not
decide anything. Agent metadata is also duplicated into `.freebuff/`-style local state, which is
tooling concerned with _execution_, not with _authorship_.

**Decision.** Every commit produced for this repository — normal, merge, generated, automated, and
release — MUST use the repository owner's GitHub identity as author **and** committer, and no tag may
carry any other attribution. Concretely:

- Agent, tool and bot names (`FreeBuff`, `freebuff`, `Codebuff`, and any bot identity) MUST NEVER be
  used as a Git author or committer identity.
- The repository's local Git identity MUST NEVER be set to a tool identity.
- Before creating any commit, `git config user.name` and `git config user.email` MUST be inspected
  and confirmed as the owner's identity. If the identity is missing, ambiguous, or not the owner's,
  the agent MUST STOP and MUST NOT commit. Inventing, guessing or fabricating an address — including
  a GitHub noreply address — to satisfy the check is explicitly forbidden.
- Existing commits MUST NOT be rewritten to change attribution unless explicitly instructed.
- Agent/tool names MAY appear in local tooling metadata (`.freebuff/` state, internal execution
  logs) where the tool requires it. Authorship is not tooling metadata.

The rule is recorded in `AGENTS.md` §8.1 as a permanent engineering instruction, and enforced by a
lightweight, opt-in guard: `scripts/check-git-identity.sh` (also `pnpm git:identity`). It reads the
_effective_ identity, refuses unset identities and agent/tool/bot markers, supports a strict mode via
`AI_GIT_EXPECTED_NAME` / `AI_GIT_EXPECTED_EMAIL`, never modifies the Git configuration, and can be
installed as a client-side `pre-commit` hook. It is honestly partial: a GitHub noreply address
passes, because it can be a legitimate owner identity, so "never _invent_ a noreply address" is a
rule the guard documents rather than something a string match can enforce. The guard also does not
touch `.freebuff/`-style local state, which `.gitignore` keeps out of history instead.

**Why not in `scripts/verify.sh`.** CI runs under the runner's own identity and never commits, so an
identity assertion there would fail for a reason unrelated to the change under test — a check that is
wrong in the only place it runs is worse than no check. It stays a local, pre-commit concern, which is
exactly where authorship is decided.

**Why not in `src/cli` or `ai doctor`.** The CLI inspects the _project under work_; the platform's own
Git authorship is not a property of the user's project, and putting it there would make a governance
rule depend on the product's runtime. A shell script beside `verify.sh` is the smallest thing that
fits.

**Consequences.** Attribution is unambiguous and history cannot acquire an accidental contributor.
The honest limit, stated in the script's own output and in §8.1: the guard proves the identity is
_not_ a tool, but it cannot prove the identity _is_ the owner's — that confirmation remains a human
or agent responsibility, which is why the rule is written as "stop, do not commit" rather than
"substitute a default".

**Alternatives rejected.** A `post-commit`/`commit-msg` hook installed automatically (modifies the
user's environment without asking); embedding the expected identity in `package.json` (publishes an
address in a machine-readable file and makes a governance change look like a build change); a default
fallback identity (the precise failure mode this ADR exists to prevent); gating CI on authorship
(wrong place, and it would break the runner's own verification).

---

## ADR-045 — Every operation goes through one enforcement boundary

**Context.** Through Phase E the platform could plan, select context and record what happened, but
nothing constrained what it _did_: the simulated runtime read the filesystem directly, and the only
gate was the risk policy, which answers "how much oversight does this need?" rather than "is this
permitted, and where may it reach?". An agent runtime with a filesystem handle and a policy check
somewhere above it is not an enforced boundary — it is a convention, and a convention is one refactor
away from being bypassed by a second caller.

**Decision.** Authorization is derived, evaluated and enforced in one place, in this order:

```text
operation request → capability (derived from the request kind, never claimed by the caller)
                  → declared envelope        (was this capability declared for this attempt?)
                  → policy                   (is it allowed, for this exact target?)
                  → boundary admission       (is the real target inside the sandbox at all?)
                  → approval                 (only if policy already said "approvable")
                  → sandbox performs it      (re-checking admission itself)
```

Concretely:

- A closed, typed `Capability` vocabulary; `capabilityForRequest` is the only mapping from an
  operation to a capability, so a request cannot name a cheaper one for an expensive operation.
- `evaluateAccess` is **pure and total**: no clock, no I/O, no provider — and a malformed target is a
  denial (`TARGET_REFUSED`) rather than a thrown error, because an evaluation that could throw would
  let a caller turn a refusal into an unhandled failure.
- The enforcement object (`createOperationGateway`) exposes exactly one method, `execute`. It has no
  `executeUnchecked`, no `force`, and it does not expose the boundary it holds. The opaqueness _is_
  the guarantee the type provides.
- The boundary is constructed per workspace and refuses to be paired with a mismatched scope, and it
  re-checks its own admission inside `perform` rather than trusting a verdict it was handed. Its
  lists (readable/writable roots, allowed/denied commands, hosts, variables) are the same policy
  lists the policy layer evaluates, so a caller that reached the adapter directly still cannot
  escape — one source of truth, two enforcement points.
- The agent runtime receives the gateway and nothing else: no `fs`, no `child_process`, no `fetch`,
  no `process.env`. A runtime given no gateway performs no operation and records the refusal.

**Consequences.** "No capability → no operation" and "policy deny → no operation" are properties of
the call graph rather than of discipline. Every decision is recorded before the operation is
attempted, so a crash cannot lose it. The cost is one extra layer of indirection on every operation
and a deliberate duplication of the allowlists at the boundary — accepted, because a boundary that
trusted the layer above it would be bypassable by the next caller.

**Alternatives rejected.** Policy checks in the CLI and the runner only (the exact shape this ADR
exists to prevent); a single boolean-returning `isAllowed` (no reason code, so no auditable denial);
letting the runner hold the boundary and ask it to check itself; inferring authorization from free
text or from model output.

---

## ADR-046 — Denials are structured, and stable enough to be audited

**Context.** A denial is a security artefact. It is written to the log, projected into a trace and
read by an operator at the worst possible moment, so "it was refused" is not an answer: the _why_
must be machine-readable, stable across versions, and incapable of leaking what it refuses.

**Decision.** `PolicyReasonCode` is a closed set with one description each, and every refusal carries
one. `ALLOWED` is the only non-denial, and `isDenial` is defined as `code !== "ALLOWED"` so a new
code cannot accidentally read as success. Denial messages name the _reference_ the caller used —
never an absolute host path, never a resolved link target, never a variable's value, never a header.
A recorded target passes through `redactSecretLikeValues` first, so a caller that builds a command out
of a credential gets a redacted description in the log rather than either a leak or an unrecordable
decision. The event layer's own secret-shape validation remains as a backstop, not as the mechanism.

**Consequences.** Traces, tests and (later) evaluation harnesses can count refusals by cause without
parsing prose; a denial cannot become an exfiltration channel; and adding a capability or a refusal
mode forces a conscious vocabulary change rather than a new string.

**Alternatives rejected.** Free-text-only reasons (unaggregatable, and drift silently); a single
`DENIED` code (indistinguishable causes make an incident unreadable); reusing vendor or OS error
strings (unbounded, and they carry user-supplied text).

---

## ADR-047 — Operations act on workspace-relative references, never absolute paths

**Context.** An operation has to say _where_ it points, and the obvious vocabulary — an absolute
filesystem path — is wrong for this platform in three ways: it is a fact about one machine, it
commonly embeds a username, and accepting one would move boundary enforcement into string comparison
at every call site.

**Decision.** Every operation target is a reference resolved against the workspace root:
`file` targets are workspace-relative (`.` for the root), commands are program names or
workspace-relative paths, URLs are absolute but recorded without query string or credentials, and
environment targets are variable _names_. `assertWorkspaceRef` refuses rather than repairs: a NUL, an
absolute path, a drive letter, a UNC prefix or any `..` segment is rejected, and a bare `.` is the
only meaningful dot segment. Only the workspace-relative form is ever recorded — never the absolute
path, which is also why `toWorkspaceRef` exists rather than a `path.join` at the call site. The
platform's own runtime state (`.git/`, `.ai/`) is refused for writes at both the policy and boundary
layers: one is history, the other is the log and the policy that governs the check.

**Consequences.** A reference means the same thing in every process, a denial cannot leak a host
path, and the workspace fence is expressible as a single containment question. The cost is that an
operation cannot name something outside its workspace at all — which is the point, and is why
`ai doctor` reports out-of-workspace roots as a misconfiguration.

**Alternatives rejected.** Absolute paths with a prefix check (the classic `/srv/app-evil` bug, and
a leak per event); normalising `..` away (silently repairing an input that was not understood);
letting the caller pass a capability alongside a path (invites claiming a cheaper one).

---

## ADR-048 — Containment is by resolution; the boundary is a constructed, scope-bound object

**Context.** Two implementations of "is this inside that?" is one too many, and both of the easy
versions are wrong: string prefixes accept `/srv/app-evil`, and comparing a target against a root
measured _as it really is_ accepts a root that is itself a symlink out of the workspace.

**Decision.**

- Containment is `path.relative` on resolved paths, never a string prefix, and both sides are
  case-folded first on a platform whose filesystem does not distinguish case — because there
  `/Srv/App/x` and `/srv/app/x` really are the same file, while on a case-sensitive filesystem a case
  variant resolves to a different location. The comparison is only ever loosened by the platform's own
  rules: a case variant judged _outside_ is a refused operation, never a boundary escape.
- The boundary is one object per workspace, fixed at construction, with no `withScope()` and no
  per-request scope argument; it refuses to be constructed against a mismatched scope, and refuses a
  request that names another one. Symlinks (and Windows reparse points) are resolved before a verdict:
  an unresolvable target is `UNRESOLVED_TARGET`, a link out of the fence is `SYMLINK_ESCAPE`, and a
  _configured root_ that resolves outside the workspace is refused outright.
- The workspace root is an unconditional fence over and above configuration: a misconfigured root
  narrows what is reachable, never widens it. A directory that does not exist yet falls back to the
  workspace fence and the ancestor check, so a first write to `out/` works and a path that is merely
  absent is reported as absent.
- `perform` re-runs every admission check. This is not redundancy: `perform` is reached from `admit`
  through policy and approval code, and a boundary that trusted an earlier verdict would be one
  refactor from being bypassable.

**Consequences.** The guarantees are provable by test rather than by inspection, and the honest
platform difference is stated instead of smoothed over: on Windows, `spawn` gives a child a fixed set
of OS-level variables (`HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`, `SYSTEMROOT`,
`TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, `WINDIR`) even when an explicit `env` is passed, so
every platform-scoped variable is dropped unless policy allowlists it _and_ those OS facts remain.
They are enumerated in `WINDOWS_CHILD_INHERITED_VARIABLES` and reported by `ai doctor`.

**Alternatives rejected.** Prefix comparison (wrong); trusting `admit`'s earlier answer inside
`perform` (bypassable by the next caller); normalising a traversal into a contained path (repairs an
untrusted input); refusing every path whose root does not exist yet (makes a legitimate first write
impossible).

---

## ADR-049 — Approval confirms an operation; it never opens a boundary

**Context.** Phase D made a grant single-use, scoped and non-widening (ADR-037). Phase F adds the
tempting next step — "this looks dangerous, ask a human" — and the obvious implementation puts the
human in front of the capability check. That ordering is wrong: if approval were evaluated first, a
human approving something would _create_ authority, and a hard boundary would become negotiable.

**Decision.** Policy is evaluated before the ledger is consulted, and a grant is only ever looked up
for a decision policy already marked `approval-required`. A capability that policy denies can never
be reached by approving anything — the configuration validator even refuses a policy that lists a
denied capability under `requireApproval`, because it reads as an authorization that does not exist.
Boundary admission likewise runs _before_ a request is raised, so a human is never asked to approve a
traversal, a symlink escape or a credential path that could never be allowed. Grants remain bound to
project, workspace, task, risk level and operation kind, are consumed exactly once, and an authority
established within one attempt covers later gates inside its own boundaries and nothing beyond them.

**Consequences.** Approval can only ever make an already-permitted operation happen, and the trace
distinguishes "allowed" from "approval-required" from "denied" at every step. A suspension raised by
an operation happens _after_ the model turn that preceded it, so an operation-level suspension can
have spent a call — visible in the trace, and stated in the RFC rather than glossed: the task-level
risk gate is what suspends before anything is spent.

**Alternatives rejected.** Checking the ledger before policy (approval as escalation); accepting a
broad task-scoped grant as covering a narrower operation-scoped question; treating an expired or
consumed grant as reusable for convenience.

---

## ADR-050 — Operation egress and provider egress are separate allowlists

**Context.** The platform needs outbound network access for its own provider calls, and an operation
may need it for a task. Collapsing those into one policy list makes configuring a vendor equivalent
to granting an agent that vendor's reach.

**Decision.** `network.allowedHosts` governs operations (`network.connect`) and
`network.providerHosts` governs the platform's own LLM egress. Both are enforced at the transport,
not at the call site: the provider transport is wrapped so that a host outside its list raises a
`DomainError("FORBIDDEN")` which the retry decorator treats as fatal, and an operation transport
refuses any host outside its list. Network access is disabled by default, enabling it without naming
a host is a configuration error, and no operation can add a host to either list. Provider refusals
carry no header value, query string or body.

**Consequences.** Configuring a provider cannot silently widen what an agent may reach, and the two
questions can be answered separately by `ai policy`. The cost is one more list to keep in sync when a
provider base URL changes — which is exactly the moment an operator should be thinking about it.

The composition root installs the guard on the transport it hands to _every_ provider it builds — the
LLM adapter and the decision adapter together — so provider egress is a property of the runtime rather
than of each adapter remembering to ask. A configured provider whose host is absent is constructible
and credentialed but unreachable, which would otherwise surface as an unexplained `FORBIDDEN` on the
first real call; `ai doctor` therefore reports it as a warning naming the host and the key to set,
without either treating it as a failure or making a network request to find out.

**Alternatives rejected.** One shared list (vendor configuration as an implicit grant); enforcement at
the call site (an adapter that forgets to ask gets through); allowing `*.` patterns for a provider
without a host (opens the network to satisfy one call).

---

## ADR-051 — JEV is the decision layer, not the control plane

**Context.** The platform has three layers that could each be described as "the intelligent one":
reasoning (the frontier LLM), bounded judgement (which retry, which tool, which route), and
enforcement (policy, capability, approval, sandbox). Merging bounded judgement into the reasoning
layer makes every routing question a paid model call; merging it into enforcement makes the boundary
depend on a network service. Either mistake costs the platform its determinism.

**Decision.** Bounded judgement is a first-class layer behind the existing `DecisionProvider` port
(ADR-004), and JEV is the first real implementation of it:

- **A closed question set.** Eight decision domains (`routing`, `tool-selection`, `risk-assessment`,
  `retry`, `completion`, `ranking`, `relevance`, `human-escalation`), each with typed input and typed
  result, a closed candidate set, a closed explanation vocabulary and hard input bounds. Nothing in
  the platform asks a decision layer an open-ended question, and `Record<string, unknown>` is never
  the interface.
- **A bounded engine.** `createDecisionEngine` owns exactly one responsibility — how a question gets
  answered — and perform no I/O beyond one provider call. Validation lives in `validate.ts`, fallback
  in `fallback.ts`, candidates in the caller. Recording is the application layer's job, so the event
  log stays the single source of truth.
- **A provider, not a vendor.** `DecisionProvider` is the only shape the application sees. The JEV
  adapter speaks a small documented JSON contract over the existing `HttpTransport` port; a JEV
  deployment implements that contract offline, in CI, or without JEV at all. Nothing JEV-specific
  leaves the adapter.
- **No authority.** A decision layer can narrow a route, prefer a tool, or recommend review. It
  cannot grant a capability, approve an operation, widen a scope, bypass policy, or perform
  anything. Its answers flow through the same enforcement pipeline as any other request (ADR-045).

**Consequences.** The architecture reads as `deterministic code → bounded judgement → reasoning →
human`, with each layer optional and each layer's failures visible. JEV can be added, replaced, or
removed by configuration. The cost is a vocabulary to maintain (eight domains and their reason codes)
and a disciplined refusal to ask a decision layer anything the platform cannot bound.

**Alternatives rejected.** JEV as the task orchestrator (the control plane must not be a network
service); JEV answering free-form questions (unvalidatable, unpriceable, unbounded); a `JevService`
module containing routing, retry and validation together (one god-object, and no port left to swap);
JEV-specific types in the domain models (vendor lock-in by type).

---

## ADR-052 — Certainty is answered by code; a decision layer is consulted only for judgement

**Context.** A decision layer is only worth its cost if it is asked _only_ the questions code cannot
answer. A platform that consults it for every step pays a round trip for facts it already knows, and
a platform that consults it for nothing has no decision layer at all. The same question applies when
the layer is absent, slow, or failing: what happens to a bounded question with nobody to answer it?

**Decision.** Three deterministic rules, applied in this order:

1. **Certainty first.** If a question has only one defensible answer, `code` answers it and the
   provider is never consulted — a hard retry cap reached, a failure that is not retryable, a single
   registered route, a single permitted tool, a critical risk floor, failed verification evidence, a
   security refusal. This is both a correctness rule and the cost rule: JEV is never a mandatory
   network round-trip for a deterministic step.
2. **A declared default always exists.** Every question carries the option to assume when no provider
   answer exists, and the fallback registry (`DOMAIN_FALLBACKS`) is one readable table, not `?? "stop"`
   scattered at call sites. Fallbacks are conservative: completion is never assumed, relevance is
   never asserted, escalation defaults to review, risk keeps the deterministic floor, retry stops.
3. **Degradation is recorded, never inferred.** A provider failure emits `DecisionFailed`; the
   deterministic answer that replaced it emits `DecisionFallbackUsed` with the reason; the answer is
   recorded with `answeredBy` naming the layer that answered. A _missing_ decision layer is a
   different state from a broken one and is recorded as such (`decision-layer-disabled`), so an
   operator is never shown a degradation that did not happen.

**Consequences.** The platform is fully functional with no decision layer installed, and the log
always explains which layer answered and why. Budgets are enforced _before_ the provider is called —
asking first and discarding the answer would spend exactly what the budget exists to bound. The cost
is that every decision domain must declare a defensible default, which is a design conversation worth
having anyway.

**Alternatives rejected.** Consulting the layer unconditionally (pays for facts); treating a missing
provider as a failure (misreports a supported configuration); estimating or hedging a fallback
afterwards (invents a judgement); silently skipping the question when the budget is exhausted (hides
the degradation, which is the one thing an auditable budget must not do).

---

## ADR-053 — A decision layer's output is untrusted input; security refusals are never delegated

**Context.** A decision provider is an external service. Its output is no more trustworthy than any
other API response, and it arrives exactly where the platform is deciding what to do next — the worst
possible place for an unvalidated answer. The same layer is also the platform's best chance of
handling genuine judgement, which means it must be genuinely usable, not merely quarantined.

**Decision.** Everything a provider says passes through one deterministic validator before it can
affect anything, and the rule is strict: an answer that does not fit the question is _rejected_, not
repaired. Specifically: the named candidate must exist in the set the caller supplied; the outcome
must be legal for that question (`escalated` is meaningless for risk and refused); an ordering must be
a complete, duplicate-free permutation; confidence is a probability or absent; and every explanation
is a **code from a closed vocabulary**, never prose — which is what keeps untrusted text out of the
event log entirely. A rejection is recorded with its own reason code and replaced by the
deterministic fallback.

Two consequences are part of the decision rather than side effects:

- **A security or policy refusal is answered in code.** Whether a human must review a refusal is not
  a judgement to delegate; `buildEscalationSpec` answers it deterministically, and the provider is not
  consulted.
- **An escalation recommendation is not an approval.** A recommendation creates no request, no grant
  and no state change; the approval ledger (ADR-037) remains the only source of authority, and a human
  remains the only source of a grant.

**Consequences.** A provider cannot invent a tool, a route, a risk level or a candidate; it cannot
put free text into the log; it cannot approve its own escalation. The cost is that a provider whose
vocabulary does not match the platform's will see its answers rejected — which is visible, countable,
and far better than the alternative.

**Alternatives rejected.** Trusting a provider's candidate list (an invented tool becomes an
executable one); truncating prose into a reason code (untrusted text in the log, and no longer
countable); repairing a partial ranking (a hidden choice); delegating approval to the layer that
recommends it (it would be approving its own proposal).

---

## ADR-054 — A decision's assessment is advisory; the task state machine stays deterministic

**Context.** Two of the eight decision domains make statements _about the task itself_: whether the
recorded evidence suggests completion, and whether a human should review the outcome. Those are
exactly the statements that must not be able to close a task, because a task's state is an ownership
fact, not an inference (ADR-028).

**Decision.** A decision layer's assessment is an input to a deterministic gate, never a transition:

- `assessCompletion` returns `complete` / `incomplete` / `uncertain`, and the task's authoritative
  state changes only through the existing task state machine. Nothing in the decision path can write a
  status.
- `recommendEscalation` returns a recommendation and creates no approval request, no suspension and
  no grant. A route of `defer-to-human` moves the task to the `review` state that already means "a human
  ows this", through the same transitions any other run uses — and the recommendation is recorded
  beside it, attributed to the layer that made it.
- **The directions are asymmetric.** Risk assessment may raise the effective risk and never lower it;
  completion may withhold an assessment and never close; ranking may reorder supplied candidates and
  never add one. Where a layer can only move in the conservative direction, the enforcement path does
  not depend on its answer being right.

**Consequences.** "Which layer decided this, and what did it actually change?" is answerable from the
log, and no decision provider can close work a human has not reviewed. The cost is that a completion
assessment is sometimes ignored by a deterministic gate that disagrees with it — which is the
intended behaviour, not a defect.

**Alternatives rejected.** Letting a completion assessment drive a transition (inference as
authority); treating an escalation recommendation as an approval request (a service could then create
work for a human without one asking); letting a risk assessment lower a baseline (declaring an
operation safe would become a bypass).

---

## ADR-055 — The decision layer is scope-bound, and its candidates are supplied by code

**Context.** A decision layer that can be pointed at another project, or that can name any tool it
likes, is a permission-escalation surface: it needs no capability of its own to widen what the
platform may do, only influence over the layer that does. The Phase F guarantee (ADR-045, ADR-048) is
that authority is constructed with a scope and never taken from input, and the decision layer must not
become the exception.

**Decision.** Scope and candidates are inputs the decision layer cannot change:

- **Scope is fixed at construction.** `DecisionCoordinatorFactory.forAttempt(scope)` produces a
  coordinator bound to one workspace and, when there is one, one task and session — exactly as the
  operation gateway is bound (ADR-048). There is no `withScope`, no scope argument on a question, and
  no way to ask about another project. Every decision event is recorded with that scope.
- **Candidates come from deterministic code.** Routes come from a closed route vocabulary filtered by
  the attempt's risk profile; tools come from a registry filtered by the attempt's capability
  envelope; ranking candidates and relevance candidates are passed in. A decision layer chooses from
  a set it did not build, and an answer naming anything outside it fails validation (ADR-053).
- **A decision may narrow a plan, never widen it.** The route set is ordered from narrowest to widest,
  `minimal` selects the smallest operation set, and the tool plan bounds what a _decision_ may choose
  — while never bounding what the runtime may _ask for_, which remains the gateway's decision. A
  runner is given exactly one decision question (`selectTool`); routing, retry, risk, completion and
  escalation belong to the use case, which knows the budget and the task state.
- **Budgets are counted from the log, not from memory.** Consultations are re-counted from recorded
  events, so a decision cap cannot be reset by restarting a process, and one task's consultations never
  consume another's.

**Consequences.** "JEV cannot widen scope" is a property of the types and of the recorded events
rather than of trust. The cost is that adding a decision question means declaring its candidate
source explicitly, and that a runner cannot ask a question outside its envelope even when a decision
layer would like it to.

**Alternatives rejected.** Passing a scope per question (an input that can be wrong); letting a
decision layer produce tool identifiers (an invented tool would have to be executed or refused at the
last moment); counting consultations in memory (a budget that a restart could clear); giving the
runner the coordinator itself (a runner that could ask about retries would decide its own retries).

---

## ADR-056 — The decision layer decides _whether_ to spend; code decides what is eligible

**Context.** A decision layer that only ranks candidates is a routing ornament: it chooses between
options code has already narrowed to one sensible set, and every task pays a round trip whatever it
asked for. The decisions that actually determine cost and correctness are earlier and later than
"which model?" — whether to spend a model call at all, whether a failure deserves a retry, and
whether the evidence produced is enough to call the work done. At the same time, the opposite error is
worse: a layer consulted for facts about the registry would be a mandatory network round trip for
questions that are set membership, and it would put model selection in the same place as model
execution (ADR-052 already forbids the second).

**Decision.** The brain owns the judgement decisions; code owns the set questions; both are recorded.

- **A strategy question precedes the plan** (`execution-strategy`): `deterministic`, `model`, or
  `human`. It is asked after the bounded plan variants are built — building them spends nothing — and
  before a variant is chosen, so a `human` answer reserves no call, spends no context and selects no
  variant. A `human` answer is honoured by attempting nothing at all, recorded as
  `stopReason: strategy-human` rather than as a run that failed to start.
- **Three of its four cases are answered by code**, because each has one defensible answer: a model is
  required and candidates exist (`model`); a model is required and nothing registered matches
  (`human`); no model-only capability is required and risk is below high (`deterministic`). The fourth
  — no model-only capability required, but the task is high risk — is a judgement, so it goes to the
  provider with a conservative `human` default.
- **Eligibility is a set question and stays in code.** The registry answers `eligible(requirements)`;
  the plan builder filters and orders; the classifier derives required capabilities from the task's own
  words. The decision layer is _told_ who is eligible and never asked to compute it.
- **Eligibility is judged against the plan, not against one model.** The strategy question receives the
  number of models reachable by some viable plan variant, not the number that satisfies the whole
  requirement set alone — otherwise a task needing `vision` plus `coding`, which decomposes perfectly
  well, would be handed to a human because no single model declared both.
- **Retry, completion and escalation are questions, not settings.** A failure produces a retry
  question whose answer is bounded twice over (the frontier's per-step cap and the per-task decision
  cap); an empty or unusable completion is evidence that nothing was produced and reaches the
  completion question as a failure, never as a quiet success; completion is answered by code whenever
  verification evidence settles it, and only then by the provider.
- **Consultations are capped per task and counted from the log** (ADR-055), and when the cap is
  exhausted the answer degrades to the declared deterministic fallback _and says so_ in the trace.

**Consequences.** Model-call efficiency becomes an explainable property rather than an emergent one:
"this task needed no model" is a recorded decision with a reason code, and the offline benchmark can
compare the platform's call count against a baseline that sends every task to a model. The cost is
that the decision layer now has a question whose answer can _stop_ work, which means the conservative
default has to be genuinely conservative — it is: `human`.

**Alternatives rejected.** Deriving the model requirement from the registry instead of the task (the
requirement would then be whatever the registry happens to contain); asking the decision layer to
compute eligibility (a network round trip for set membership, and selection leaking into the layer that
executes); letting a `deterministic` answer mean "code will do it" when no deterministic executor
exists (it means "spend nothing", and the run is reported as unverified rather than complete);
widening the plan set to honour a `model` answer for a task whose words require no capability only a
model supplies (that would mean inventing requirements — the honest state is that the answer cannot
widen the plan, which the recorded report shows).

---

## ADR index

| ADR | Title                                                                | Area          |
| --- | -------------------------------------------------------------------- | ------------- |
| 001 | V2 is a foundation, not a framework                                  | Scope         |
| 002 | Cheapest-sufficient-layer ladder for every decision                  | Architecture  |
| 003 | Decisions are first-class, recorded entities                         | Decisions     |
| 004 | JEV behind a `DecisionProvider` port, never mandatory                | Decisions     |
| 005 | Tasks are first-class; execution record lives in events              | Tasks         |
| 006 | Event log is the single source of observability truth                | Observability |
| 007 | Money is integer micro-USD                                           | Cost          |
| 008 | Cached tokens are a subset of input tokens                           | Tokens        |
| 009 | Budgets are pure, provider-independent, evaluated twice              | Budgets       |
| 010 | Workspace isolation is a declared capability profile                 | Isolation     |
| 011 | Policy is pure, most-restrictive-wins, with risk floors              | Security      |
| 012 | No database in Phase 2; local inspectable persistence later          | Storage       |
| 013 | Branded ids and injected time; ISO-8601 UTC timestamps               | Core          |
| 014 | Additive non-destructive migration; no speculative directories       | Migration     |
| 015 | Human approval is blocking, scoped, non-transferable                 | Human control |
| 016 | Memory is project-scoped; AI knowledge stays `proposed`              | Memory        |
| 017 | ADRs are human-decided; AI may draft only                            | Governance    |
| 018 | Deterministic default context selector; bounded JEV assist           | Context       |
| 019 | Trace replay exact; decision replay reports differences              | Replay        |
| 020 | CLI is a thin adapter; zero mandatory runtime dependencies           | Interface     |
| 021 | Dashboard deferred and removable                                     | Interface     |
| 022 | Composition root is the only module naming an adapter                | Architecture  |
| 023 | Event first, projection second                                       | Observability |
| 024 | Project configuration is JSON, not YAML                              | Configuration |
| 025 | Project-scoped JSONL log, partitioned per workspace                  | Storage       |
| 026 | Scope is inherited from context; session implies task                | Traceability  |
| 027 | A task id is not authorization; scope is explicit                    | Security      |
| 028 | A run ends in `review`; a human closes the task                      | Human control |
| 029 | Approval suspends; denial fails                                      | Policy        |
| 030 | `ai doctor` checks only what it can know, honestly                   | Operations    |
| 031 | Offline deterministic provider; illustrative rates only              | Providers     |
| 032 | CLI is a pure dispatcher plus a process shim, no framework           | Interface     |
| 033 | One real adapter speaks a protocol; credentials are references       | Providers     |
| 034 | Retry is a bounded decorator over the provider port                  | Providers     |
| 035 | Failures categorised; absent usage is unavailable, not zero          | Providers     |
| 036 | Append coordination is a port with a local guarantee                 | Storage       |
| 037 | A grant is single-use, scoped, and never widens permission           | Human control |
| 038 | A stale task projection is refused before anything is spent          | Concurrency   |
| 039 | Deterministic context selection; content is never an event           | Context       |
| 040 | Explicit context budget; mandatory overflow is loud, no truncation   | Context       |
| 041 | One ordered exclusion policy; repository text is data                | Security      |
| 042 | Change detection reports capability and degrades explicitly          | Context       |
| 043 | The engine records; the inspector selects only when told             | Interface     |
| 044 | Commits carry the owner's identity, never a tool's                   | Governance    |
| 045 | Every operation goes through one enforcement boundary                | Security      |
| 046 | Denials are structured, and stable enough to be audited              | Security      |
| 047 | Operations act on workspace-relative references                      | Security      |
| 048 | Containment by resolution; a constructed, scope-bound boundary       | Security      |
| 049 | Approval confirms an operation; it never opens a boundary            | Human control |
| 050 | Operation egress and provider egress are separate allowlists         | Security      |
| 051 | JEV is the decision layer, not the control plane                     | Decisions     |
| 052 | Certainty is answered by code; judgement by the decision layer       | Decisions     |
| 053 | A decision layer's output is untrusted; refusals are never delegated | Security      |
| 054 | A decision assessment is advisory; state stays deterministic         | Human control |
| 055 | The decision layer is scope-bound; candidates come from code         | Security      |
| 056 | The brain decides whether to spend; code decides eligibility         | Decisions     |

---

## What is implemented vs designed (honesty statement)

**Implemented and verified as code** (766 unit tests, typecheck, lint, build all green):

_Phase B — pure domain (no I/O, no provider, no clock reads):_

- Project, Workspace + `IsolationProfile`, Task + lifecycle transition table.
- Decision, risk levels, baseline risk floors, pure policy evaluation.
- `DecisionProvider` port, deterministic provider routing, abstaining provider.
- AgentSession counters/state.
- Event envelope + payload map + validated event factory.
- `AIUsage` normalization and summation; micro-USD cost computation; pure budget evaluation;
  task metric projection from usage/call records.

_Phase C — one executable vertical slice (Task → Session → events → trace → metrics → CLI):_

- Ports: `EventStore`, `TaskRepository`, `AgentRunner`, `LlmProvider`, `ProjectScope`.
- Adapters: append-only JSONL event store; version-guarded file task repository; deterministic
  offline `LlmProvider`; simulated `AgentRunner`. All three write inside the project's own
  `.ai/runtime/` tree.
- Application layer: event recorder, project init, task service, session service, decision
  service, approval service, task run, trace reader, doctor.
- Trace read model reconstructing status, sessions, decisions, approvals, LLM and tool calls,
  verification runs, event-derived metrics and budget evaluation, plus structural integrity
  checks. Available as a stable object and as `--json`.
- CLI: `init`, `doctor`, `task create`, `task list`, `task status`, `task run`, `task trace`,
  `task usage`, `task cost`, `task complete`.

_Phase D — one real provider, approval resume, and append coordination:_

- One real LLM adapter: **OpenAI-compatible Chat Completions**, selected by project configuration,
  behind a bounded retry decorator (ADR-033, ADR-034). Credentials are read from an environment
  variable named in configuration — never stored, never logged.
- Failure taxonomy with `LLMRequestFailed` events; absent usage stays unavailable and unpriced
  never becomes `$0` (ADR-035). `LLMRequestCompleted` carries provider, model, usage,
  `usageReported`, latency, attempt count and the provider's request id.
- Approval grants are consumable: `ai approvals`, `ai task approve <task-id> [--resume]`, and
  `ai task run` against an existing grant. Scoped, single-use, expiring, never permission-widening
  (ADR-037).
- `AppendLock` port with a local file lock; the JSONL store reads its tail and appends inside the
  lock, so two writers cannot append the same sequence (ADR-036). `ai doctor` proves it.
- A stale task projection is refused before any spend (ADR-038).
- `ai doctor` additionally reports the configured provider, whether the named credential is present
  (never its value), the append-coordination guarantee, and approval-ledger state. It performs no
  network call, deliberately.

_Phase F — policy, capability and sandbox enforcement:_

- A closed `Capability` vocabulary and a pure, total `evaluateAccess` that returns a structured
  `AccessDecision` with a stable `PolicyReasonCode` (ADR-045, ADR-046).
- An `OperationGateway` that is the single enforcement point for every operation: derived capability →
  declared envelope → policy → boundary admission → approval → sandbox → audit events. One public
  method, no unchecked path, and the boundary is not reachable through it.
- A local sandbox over four boundaries — filesystem, process, network and environment — each
  re-checking its own admission, with the same policy lists the policy layer evaluates.
- Filesystem: workspace-relative references only, `path.relative` containment with platform-appropriate
  case folding, `realpath` verification of roots and ancestors, a configured root that escapes the
  workspace refused, and the workspace root as an unconditional fence. Credential-shaped paths and
  runtime state are refused by name, and the Phase E exclusion philosophy is preserved.
- Process: no shell on any code path (argv arrays only), an allowlist/denylist check in the boundary as
  well as in policy, a workspace-relative `cwd` fence, a hard timeout with capped output, and a
  filtered child environment (`WINDOWS_CHILD_INHERITED_VARIABLES` documents the platform's own
  survivors).
- Network: denied by default, host allowlists enforced at the transport, and operation egress kept
  separate from provider egress (ADR-050).
- Environment: an allowlist/denylist over a `get(name)`-only port, so there is no enumeration to leak;
  a refused variable is indistinguishable from a missing one.
- Approvals: reused, not duplicated. An operation-level suspension suspends the task, `ai task approve
--resume` consumes the grant exactly once and continues, and a spent grant never authorises a second
  attempt (ADR-049).
- Audit events (`CapabilitiesDeclared`, `CapabilityCheckRequested`/`Completed`, `OperationStarted`/
  `Completed`/`Failed`, `OperationDenied`, `SandboxViolation`) carry project, workspace, task, session,
  capability, operation, target kind, a redacted target, a reason code and the approval reference. A
  trace projects them into `POLICY` and `OPERATIONS` sections with integrity checks that report an
  unanswered check, an unterminated operation, or an `allowed` verdict no declared envelope contains.
- CLI: `ai policy` (effect table and envelope) and `ai policy --check --capability … --target …`
  (a dry run through the same evaluation, performing and recording nothing; exit 0 allowed, 1 denied,
  2 uninterpretable). `ai doctor` adds an offline enforcement check that probes traversal, absolute
  paths, credential-shaped paths and runtime-state writes, verifies configured roots are really inside
  the workspace, and reports the boundary's own honest label.

_Phase G — the decision layer:_

- A closed set of eight decision domains with typed input/result, bounded candidates, a closed
  explanation vocabulary and hard input bounds (`src/decisions/domains.ts`).
- `createDecisionEngine`: validate the question → answer from code when certainty exists → refuse to
  consult a provider that cannot handle it → one provider call → validate the answer → fall back
  deterministically. It records nothing, so the log stays the single source of truth (ADR-051).
- Deterministic validation of every provider answer, and a per-domain fallback registry that is one
  readable table (ADR-052, ADR-053).
- One real decision provider: a JEV adapter behind the `DecisionProvider` port, speaking a small JSON
  contract over the existing `HttpTransport`. Credentials are read from a named environment variable,
  used for one header and dropped; every failure is categorised; usage is optional and never
  fabricated. Fully testable offline by scripting the transport.
- A scope-bound `DecisionCoordinator`: budget counted from the log, decisions recorded
  (`DecisionRequested`/`DecisionCompleted`/`DecisionFailed`/`DecisionFallbackUsed`), cost priced with
  the project's own rate table, fallbacks recorded with their reason (ADR-055).
- Run integration: routing, per-step risk assessment, tool selection, bounded retry, completion
  assessment and escalation recommendation. A decision may narrow an attempt; it can never authorise
  an operation, and the enforcement pipeline is unchanged (ADR-054).
- Trace and metrics: a `DECISIONS` section, per-kind counts, answer-source partition, decision
  latency, decision tokens and decision cost with an explicit note about what it excludes.
- CLI: `ai decision [--json]` and `ai task decisions <task-id> [--json]`; `ai doctor` adds
  `decision-layer` and `decision-audit` checks. None of them calls a provider.

**Designed but deliberately NOT implemented** (see the RFC's phase markers):

- A second provider protocol or vendor SDK; engineering memory; the ADR workflow;
  plugins; replay and checkpoint storage; the dashboard; `evals/`.
- **Multi-model routing and execution.** There is exactly one LLM provider per project and one model
  id in configuration: no model registry, no capability-aware model selection, no delegation across
  vendors, no parallel execution. The decision domains exist for it (`routing`, `ranking`,
  `relevance`), but nothing in Phase G selects a _model_.
- **Embeddings, semantic retrieval, MongoDB and vector search.** `relevance` operates only over
  explicitly supplied, bounded candidates.
- **Decision caching.** No cache of any kind: a repeated question is asked again, and a cache would
  need a defined key, scope, TTL, invalidation and replay semantics before it could be safe
  (ADR-052 explains why guessing is worse than paying).
- **Deterministic replay of a decision provider.** A recorded decision is _recorded_, which is
  different from _reproducible_: the log says what was asked, who answered, why and at what cost, but
  re-running the same question against a live JEV service may answer differently. Nothing in the
  platform claims otherwise.
- Distributed append coordination. The guarantee is local and is stated as such (ADR-036);
  single-writer-per-stream across machines is not provided.
- The agent runtime is explicitly _simulated_: it makes a **real** provider call through the
  configured adapter and performs one real, policy-checked workspace listing, but it performs no
  engineering work (ADR-030 reports this as a warning). With `provider: "simulated"` the model call is
  offline and deterministic too; with a real provider configured, the call is real and its usage,
  latency, pricing and failures are recorded from what actually happened.
- The sandbox is an **in-process** boundary, not a container, a VM, a namespace or a seccomp filter.
  It cannot protect against an already-compromised host, a malicious native extension, or a child
  process that escapes by means other than the ones it filters. Its guarantees are the ones the tests
  prove: which paths may be read or written, which programs may run with which `cwd` and which
  environment, which hosts may be reached, and which variables may be read (ADR-045, ADR-048).
- No autonomous execution loop, no tool registry, no plugin surface and no remote execution. The
  runtime performs the operations its own code asks for, through the gateway that evaluates them.
- No container or VM isolation, no distributed coordination, and no protection against a task that is
  legitimately allowed to write somewhere it should not — policy authorises locations, not intentions.
- A live end-to-end call against a vendor endpoint is not part of the automated suite (it needs a
  key and spends money). The real adapter's full path — request building, credential handling,
  response normalisation, every failure category and privacy — is covered offline by scripting the
  `HttpTransport` port.
