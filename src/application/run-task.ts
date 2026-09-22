import type { ContextConfig } from "../adapters/config/project-config.js";
import { type Clock, durationMsFrom, toIsoString } from "../core/clock.js";
import { DomainError, isDomainError } from "../core/errors.js";
import type { SessionId } from "../core/ids.js";
import type { Policy } from "../decisions/policy.js";
import { evaluatePolicy } from "../decisions/policy.js";
import {
  type OperationKind,
  type RiskLevel,
  effectiveRiskLevel,
  requiresHumanApproval,
} from "../decisions/risk.js";
import {
  ATTEMPT_ROUTE_IDS,
  type AttemptRouteId,
  type CompletionAssessmentId,
  type DecisionOutcomeMeta,
  type EscalationRecommendationId,
  type ToolCandidate,
} from "../decisions/domains.js";
import { evaluateBudget } from "../observability/budget.js";
import type { ModelRate } from "../observability/cost.js";
import { estimateCost } from "../observability/cost.js";
import type { LlmFailureKind } from "../ports/llm-provider.js";
import type { LlmCallRecord } from "../observability/metrics.js";
import { computeTaskMetrics } from "../observability/metrics.js";
import type { AgentSession } from "../sessions/agent-session.js";
import type { Task } from "../tasks/task.js";
import type {
  AgentAttempt,
  AgentDecisionPort,
  AgentRunner,
  AgentToolPlan,
} from "../ports/agent-runner.js";
import {
  LIST_WORKSPACE_TOOL,
  READ_SELECTED_FILE_TOOL,
} from "../ports/agent-runner.js";
import type { ContextEngine } from "../ports/context-engine.js";
import type { StoredTask } from "../ports/task-repository.js";
import type { Workspace } from "../workspaces/workspace.js";
import {
  type ApprovalLedger,
  type ApprovalRequirement,
  type ApprovalState,
  pendingRequest,
  scopeCovers,
  usableGrant,
} from "./approval-ledger.js";
import type { ApprovalService } from "./approval-service.js";
import type { DecisionService } from "./decision-service.js";
import { selectContextForTask } from "./context-service.js";
import type { EventRecorder } from "./event-recorder.js";
import { taskCorrelationId } from "./event-recorder.js";
import {
  OPERATION_GATEWAY_ACTOR,
  type OperationGatewayFactory,
  declareCapabilities,
} from "./operation-gateway.js";
import type { SessionService } from "./session-service.js";
import type { TaskService } from "./task-service.js";
import type { DecisionCoordinatorFactory } from "./decision-coordinator.js";

/**
 * The task run use case: one bounded attempt, fully recorded.
 *
 * This is the composition that turns the domain skeleton into a workflow. It owns
 * ordering and nothing else — every rule it applies (risk, policy, budget,
 * lifecycle, approval, accounting) comes from the domain or from an injected port,
 * and every observable step is written through a service. It never talks to a
 * provider directly: it runs whatever `AgentRunner` it is given, with whatever
 * `LlmProvider` that runner was built on.
 *
 * Gates, in order, each recorded as a decision so the trace can answer "which
 * layer decided this":
 *
 * 1. **Task risk gate** — `high`/`critical` tasks need human approval before any
 *    work happens (ADR-011).
 * 2. **Context budget gate** — the context engine selects under an explicit budget.
 *    If the task's own references do not fit, the attempt fails *before* the first
 *    model call rather than proceeding without the file the task named.
 * 3. **Per-step policy gate** — each tool step's declared operation is evaluated
 *    against the policy engine before its result is accepted.
 * 4. **Budget gate** — evaluated after every model turn; at 100% the attempt stops.
 *
 * A gate that needs approval is answered in one of three ways, in this order
 * (ADR-037):
 *
 * - an **existing grant** covering the requirement is consumed, once, and the
 *   attempt proceeds;
 * - an **outstanding request** for the same requirement is re-stated, and the run
 *   stays suspended;
 * - otherwise a **new request** is recorded, and the run suspends.
 *
 * A grant authorises **one attempt** within its risk and operation boundary. A
 * later gate in the same attempt is covered by the authority already established,
 * but a gate that exceeds that boundary is refused and suspends again: an approval
 * never widens what policy allows.
 *
 * A successful run ends in `review`, not `completed`: closing a task is a human act
 * of ownership (V2-ARCHITECTURE §23).
 */
export type RunOutcome =
  | "awaiting-approval"
  | "policy-denied"
  | "budget-exceeded"
  /** Mandatory context does not fit the selection budget: nothing was spent. */
  | "context-budget-exceeded"
  | "provider-failed"
  | "verification-failed"
  | "awaiting-review";

export interface RunTaskResult {
  readonly outcome: RunOutcome;
  readonly task: Task;
  readonly session?: AgentSession;
  readonly reason?: string;
  /** Human-readable notes for a CLI or dashboard. Never secrets. */
  readonly messages: readonly string[];
  /** True when this run continued a suspended attempt rather than starting one. */
  readonly resumed: boolean;
  /** The approval request that suspended this run, or the grant it consumed. */
  readonly approvalRequestId?: string;
  /** The execution route the decision layer chose (or code chose by default). */
  readonly route?: AttemptRouteId;
  /** The completion assessment, when one was made. Advisory only. */
  readonly completionAssessment?: CompletionAssessmentId;
  /** Whether a human review was recommended, and by which layer. */
  readonly escalation?: EscalationRecommendationId;
  /** Attempt-level retries the bounded retry gate actually authorised. */
  readonly retriesSpent?: number;
}

export interface RunTaskDeps {
  readonly tasks: TaskService;
  readonly sessions: SessionService;
  readonly decisions: DecisionService;
  readonly approvals: ApprovalService;
  readonly ledger: ApprovalLedger;
  readonly runner: AgentRunner;
  readonly policy: Policy;
  /** The workspace the runtime is bound to; the task must belong to it. */
  readonly workspace: Workspace;
  readonly rates: readonly ModelRate[];
  readonly clock: Clock;
  readonly providerId: string;
  readonly modelId: string;
  /** Chooses the context this attempt is run with. Required, not optional. */
  readonly context: ContextEngine;
  readonly contextConfig: ContextConfig;
  /**
   * The enforcement boundary every operation of this attempt goes through.
   *
   * Required, not optional. A run that could be constructed without a boundary
   * would be a run whose runner has no way to touch the world — or worse, a run
   * whose runner reaches the host directly. Making it mandatory means the only way
   * to get work done is through policy, capability and sandbox evaluation (ADR-045).
   */
  readonly operations: OperationGatewayFactory;
  /** Used to declare the attempt's capability envelope before any operation. */
  readonly recorder: EventRecorder;
  /**
   * The decision layer: the only way a bounded question becomes a recorded decision.
   *
   * Required, not optional, for the same reason the operation gateway is: a run that
   * could be constructed without a decision layer would be a run that silently
   * invents answers instead of recording how they were reached. A project with no
   * decision engine configured still passes a coordinator — one whose engine answers
   * deterministically and records that it did (ADR-052).
   */
  readonly decisionLayer: DecisionCoordinatorFactory;
}

export interface RunTask {
  run(stored: StoredTask): Promise<RunTaskResult>;
}

/**
 * The deterministic tool set for one attempt, ordered from the operation a
 * decision-layer-free attempt performs to the ones only a decision may add.
 *
 * Candidates come from the *capability envelope* — the attempt's declared authority
 * — and from the context that was actually selected. A decision layer chooses among
 * these; it cannot add a tool, and it cannot reach an operation the envelope does not
 * contain. `minimal` narrows to the first candidate, so the route semantics are
 * "a decision layer may do less, never more" (ADR-055).
 */
function planAttemptTools(input: {
  readonly envelope: readonly string[];
  readonly selectedRefs: readonly string[];
  readonly route: AttemptRouteId;
}): AgentToolPlan {
  const candidates: ToolCandidate[] = [];
  if (input.envelope.includes("filesystem.read")) {
    candidates.push({
      toolId: LIST_WORKSPACE_TOOL,
      label: "List workspace files",
      operation: "read",
      capability: "filesystem.read",
    });
    const ref = input.selectedRefs[0];
    if (ref !== undefined) {
      candidates.push({
        toolId: READ_SELECTED_FILE_TOOL,
        label: `Read the selected context file ${ref}`,
        operation: "read",
        capability: "filesystem.read",
        ref,
      });
    }
  }
  const narrowed =
    input.route === "minimal" ? candidates.slice(0, 1) : candidates;
  return {
    candidates: narrowed,
    // The declared default is the first candidate: the operation an attempt without
    // a decision layer already performs. A fallback therefore changes nothing.
    defaultToolId: narrowed[0]?.toolId ?? LIST_WORKSPACE_TOOL,
  };
}

/** How a bounded question was answered, for a human reading a run report. */
export function describeDecisionAnswer(meta: DecisionOutcomeMeta): string {
  if (meta.answeredBy === "provider") {
    return `decision provider "${meta.providerId ?? "unknown"}"`;
  }
  if (meta.answeredBy === "fallback") {
    return `deterministic fallback (${meta.fallbackReason ?? "unknown"})`;
  }
  return "deterministic code";
}

/** Options for a step gate: the policy engine's own vocabulary. */
const POLICY_OPTIONS = [
  { id: "allow", label: "Allow" },
  { id: "verify", label: "Verify" },
  { id: "require-approval", label: "Require human approval" },
  { id: "deny", label: "Deny" },
] as const;

/**
 * Cost of the calls accumulated so far, using the same pricing function the trace
 * uses. Unpriced calls contribute nothing here and are reported as unpriced (never
 * as `$0`) by the metrics projection.
 */
function pricedMicros(
  rates: readonly ModelRate[],
  calls: readonly LlmCallRecord[],
): number {
  let micros = 0;
  for (const call of calls) {
    const cost = estimateCost({
      usage: call.usage,
      providerId: call.providerId,
      modelId: call.modelId,
      rates,
    });
    if (cost !== undefined) {
      micros += cost.micros;
    }
  }
  return micros;
}

/** Categories a human can act on, without inventing detail the log does not hold. */
function describeFailure(
  failureKind: LlmFailureKind,
  attempts: number,
  statusCode: number | undefined,
): string {
  const status = statusCode === undefined ? "" : ` (HTTP ${statusCode})`;
  return `provider failure: ${failureKind}${status} after ${attempts} attempt(s)`;
}

export function createRunTask(deps: RunTaskDeps): RunTask {
  return {
    async run(stored): Promise<RunTaskResult> {
      const taskId = stored.task.id;
      const scopeForRead = {
        projectId: stored.task.projectId,
        workspaceId: stored.task.workspaceId,
      };

      // Read the current record *before* doing anything observable. A stale
      // projection is a real possibility — a task suspended an hour ago, an
      // approval granted since — and a run that discovered this only at its first
      // lifecycle write would already have spent a real model call. Refusing up
      // front keeps optimistic concurrency from costing money.
      const latest = await deps.tasks.load(scopeForRead, taskId);
      if (latest.version !== stored.version) {
        throw new DomainError(
          "CONFLICT",
          `task "${taskId}" is at version ${latest.version}, but this attempt was handed version ${stored.version}; re-read the task and retry`,
          {
            field: "task.version",
            currentVersion: latest.version,
            givenVersion: stored.version,
          },
        );
      }

      let current = latest;
      const task = current.task;
      if (task.workspaceId !== deps.workspace.id) {
        throw new DomainError(
          "FORBIDDEN",
          `task "${task.id}" belongs to workspace "${task.workspaceId}", but this runtime runs workspace "${deps.workspace.id}"`,
          { field: "task.workspaceId" },
        );
      }

      const scope = {
        projectId: task.projectId,
        workspaceId: task.workspaceId,
      };
      const resuming = task.status === "in_progress";
      /**
       * True once this attempt has continued a previously suspended one. Set by
       * consuming a grant, which can only happen on a later attempt — a first
       * attempt has no grant to find — so it also covers a task-level suspension
       * that never left `created`.
       */
      let resumedRun = resuming;
      if (!resuming && task.status !== "created") {
        throw new DomainError(
          "TRANSITION",
          `task "${task.id}" is "${task.status}"; only a "created" task or an approval-suspended "in_progress" task can be run`,
          { field: "task.status", status: task.status },
        );
      }
      if (resuming) {
        // Resuming is only legitimate for work that was suspended by an approval
        // request. Anything else in_progress is either crashed or mid-flight, and
        // silently restarting it would fabricate history.
        const states = await deps.ledger.forTask(scope, task.id);
        const actionable = states.some(
          (state) => state.status === "pending" || state.status === "granted",
        );
        if (!actionable) {
          throw new DomainError(
            "INVARIANT",
            `task "${task.id}" is in_progress with no pending or granted approval; refusing to resume work that was not suspended`,
            { field: "task.status" },
          );
        }
      }

      const messages: string[] = [];
      if (resuming) {
        messages.push("resuming an attempt that was suspended for approval");
      }

      /**
       * Every gate is recorded against the task, and against the active session
       * once there is one, so the decision is reachable from both.
       */
      const decisionContext = (sessionId?: SessionId) => ({
        workspaceId: task.workspaceId,
        taskId: task.id,
        ...(sessionId === undefined ? {} : { sessionId }),
        correlationId: taskCorrelationId(
          task.projectId,
          task.workspaceId,
          task.id,
        ),
      });

      let session: AgentSession | undefined;
      function active(): AgentSession {
        if (session === undefined) {
          throw new DomainError(
            "INVARIANT",
            "no agent session is open for this attempt",
            { field: "session" },
          );
        }
        return session;
      }

      function suspension(
        requestId: string,
        reason: string,
        withSession: AgentSession | undefined,
      ): RunTaskResult {
        return {
          outcome: "awaiting-approval",
          task: current.task,
          ...(withSession === undefined ? {} : { session: withSession }),
          reason,
          messages,
          resumed: resumedRun,
          approvalRequestId: requestId,
        };
      }

      /**
       * Authority established during *this* attempt by consuming a grant. It
       * covers later gates inside the grant's own boundary and nothing beyond it.
       */
      let authority:
        | { readonly riskLevel: RiskLevel; readonly operation?: OperationKind }
        | undefined;

      type GateOutcome =
        | { readonly kind: "granted" }
        | {
            readonly kind: "suspended";
            readonly requestId: string;
            readonly reason: string;
          };

      async function resolveGate(
        requirement: ApprovalRequirement,
        subject: string,
        activeSessionId?: SessionId,
      ): Promise<GateOutcome> {
        if (authority !== undefined && scopeCovers(authority, requirement)) {
          return { kind: "granted" };
        }

        const states = await deps.ledger.forTask(scope, task.id);
        const grant = usableGrant(states, requirement);
        if (grant !== undefined) {
          await deps.approvals.consume({
            workspaceId: task.workspaceId,
            taskId: task.id,
            requestId: grant.requestId,
            riskLevel: grant.riskLevel,
            ...(grant.operation === undefined
              ? {}
              : { operation: grant.operation }),
            ...(activeSessionId === undefined
              ? {}
              : { sessionId: activeSessionId }),
          });
          authority = {
            riskLevel: grant.riskLevel,
            ...(grant.operation === undefined
              ? {}
              : { operation: grant.operation }),
          };
          resumedRun = true;
          messages.push(
            `consumed approval ${grant.requestId} (${subject}); it now authorises this attempt only`,
          );
          return { kind: "granted" };
        }

        const outstanding: ApprovalState | undefined = pendingRequest(
          states,
          requirement,
        );
        if (outstanding !== undefined) {
          return {
            kind: "suspended",
            requestId: outstanding.requestId,
            reason: `still awaiting approval ${outstanding.requestId} for ${subject}`,
          };
        }

        const requested = await deps.approvals.request({
          workspaceId: task.workspaceId,
          taskId: task.id,
          riskLevel: requirement.riskLevel,
          ...(requirement.operation === undefined
            ? {}
            : { operation: requirement.operation }),
        });
        messages.push(
          `approval requested (${requested.requestId}) for ${subject}`,
        );
        return {
          kind: "suspended",
          requestId: requested.requestId,
          reason: `approval required for ${subject}: ${requested.requestId}`,
        };
      }

      // 1. Task-level risk gate. Pure: no provider, no model, no I/O.
      const approvalRequired = requiresHumanApproval(task.riskLevel);
      const riskRationale = approvalRequired
        ? `risk level "${task.riskLevel}" requires explicit human approval before any work is attempted`
        : `risk level "${task.riskLevel}" does not require human approval`;
      await deps.decisions.record(
        {
          kind: "escalation",
          question:
            `May task "${task.id}" be attempted at risk level ` +
            `"${task.riskLevel}" without human approval?`,
          options: [
            { id: "proceed", label: "Attempt without approval" },
            { id: "require-approval", label: "Require human approval" },
          ],
        },
        approvalRequired
          ? {
              outcome: "escalated",
              decidedBy: "code",
              rationale: riskRationale,
            }
          : {
              outcome: "selected",
              selectedOptionId: "proceed",
              decidedBy: "code",
              rationale: riskRationale,
            },
        decisionContext(),
      );

      if (approvalRequired) {
        const gate = await resolveGate(
          { riskLevel: task.riskLevel },
          `task risk level "${task.riskLevel}"`,
        );
        if (gate.kind === "suspended") {
          messages.push(
            `task left at status "${current.task.status}"; approve with: ai task approve ${task.id}`,
          );
          return suspension(gate.requestId, gate.reason, undefined);
        }
      }

      // 2. Drive the lifecycle. `created -> planning` also records TaskStarted.
      // A resumed task is already in_progress and must not be re-entered.
      if (!resuming) {
        current = await deps.tasks.start(current);
        current = await deps.tasks.transition(current, "in_progress");
      }

      session = await deps.sessions.start(current.task);
      messages.push(
        `session ${session.id} started by agent "${session.agentId}"`,
      );

      // 3. Context selection, before anything is spent.
      //
      // The selection budget is the *smaller* of the project's context budget and
      // the task's own token budget: a task that declared it may consume 500 tokens
      // must not be handed 8,000 tokens of context and then fail the spend gate for
      // doing exactly what it read. Both numbers are recorded, so the effective
      // bound is never a mystery (ADR-040).
      const selectedContext = await selectContextForTask(
        { context: deps.context, contextConfig: deps.contextConfig },
        current.task,
        { sessionId: session.id },
      );
      const selection = selectedContext.selection;
      messages.push(
        `context ${selection.selectionId} (${selection.strategy} v${selection.selectionVersion}): ` +
          `${selection.selected.length} of ${selection.considered} candidate(s), ` +
          `${selection.selectedTokens}/${selection.budgetTokens} token(s)`,
      );
      if (selection.budgetExceeded) {
        // Nothing has been spent, and nothing will be: the attempt stops before the
        // first model call. Silently dropping the file the task asked for would
        // produce a confident answer to the wrong question.
        const reason =
          `context budget exceeded: ${selection.overBudgetTokens} token(s) of ` +
          `explicitly referenced context do not fit the ${selection.budgetTokens}-token budget ` +
          `(selection ${selection.selectionId})`;
        session = await deps.sessions.end(active(), "aborted", reason);
        current = await deps.tasks.fail(current, reason);
        messages.push(reason);
        return {
          outcome: "context-budget-exceeded",
          task: current.task,
          session,
          reason,
          messages,
          resumed: resumedRun,
        };
      }

      // Declare the attempt's capability envelope, then hand the runner the only
      // interface it has for touching the world. Both happen before the runner
      // starts, so the log states what was authorised before anything was asked.
      const operations = deps.operations.forAttempt({
        projectId: task.projectId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        sessionId: session.id,
        correlationId: decisionContext().correlationId,
      });
      await declareCapabilities({
        recorder: deps.recorder,
        gateway: deps.operations,
        actor: OPERATION_GATEWAY_ACTOR,
        workspaceId: task.workspaceId,
        taskId: task.id,
        sessionId: session.id,
        correlationId: decisionContext().correlationId,
      });
      messages.push(
        `capability envelope (policy ${deps.operations.policyId}): ` +
          (deps.operations.envelope.length === 0
            ? "none — no operation can be performed"
            : deps.operations.envelope.join(", ")),
      );

      /**
       * The decision layer for this attempt, bound to the workspace, task and session
       * it may be asked about. Every question below is bounded, every answer is
       * validated, and none of them can grant authority (`../decisions/domains.ts`).
       */
      const coordinator = deps.decisionLayer.forAttempt({
        workspaceId: task.workspaceId,
        taskId: task.id,
        sessionId: session.id,
        correlationId: decisionContext().correlationId,
      });

      // Routing: which posture this attempt takes. A decision layer may narrow the
      // attempt — fewer tools, or defer to a human — and can never widen it. With no
      // decision layer registered only the standard route is offered, so the
      // deterministic gate answers and nothing is called (ADR-052).
      const routeDecision = await coordinator.route({
        taskRiskLevel: task.riskLevel,
        routes: coordinator.providerConfigured
          ? [...ATTEMPT_ROUTE_IDS]
          : ["standard"],
      });
      messages.push(
        `route "${routeDecision.routeId}" (${describeDecisionAnswer(routeDecision.meta)}` +
          (routeDecision.reasonCode === undefined
            ? ")"
            : `, ${routeDecision.reasonCode})`),
      );

      if (routeDecision.deferToHuman) {
        // No model call and no operation: the attempt is handed to a human. The
        // recommendation is advisory — it creates no approval and grants nothing —
        // and the task lands in `review`, which is the human-owned gate that already
        // exists (ADR-054).
        const escalation = await coordinator.recommendEscalation({
          facts: [`route:${routeDecision.routeId}`, `risk:${task.riskLevel}`],
          securityRefusal: false,
        });
        const reason =
          "the decision layer deferred this attempt to a human; no model call and no operation were performed";
        session = await deps.sessions.end(active(), "aborted", reason);
        current = await deps.tasks.transition(current, "verification");
        current = await deps.tasks.transition(current, "review");
        messages.push(
          `${reason}; escalation recommendation: ${escalation.recommendation} ` +
            `(${describeDecisionAnswer(escalation.meta)})`,
          `close or fail it with: ai task complete ${current.task.id}`,
        );
        return {
          outcome: "awaiting-review",
          task: current.task,
          session,
          reason,
          messages,
          resumed: resumedRun,
          route: routeDecision.routeId,
          escalation: escalation.recommendation,
        };
      }

      const toolPlan = planAttemptTools({
        envelope: deps.operations.envelope,
        selectedRefs: selection.selected.map((candidate) => candidate.ref),
        route: routeDecision.routeId,
      });
      messages.push(
        toolPlan.candidates.length === 0
          ? "no tool is permitted by this attempt's capability envelope"
          : `tool candidates: ${toolPlan.candidates
              .map((candidate) => candidate.toolId)
              .join(", ")}`,
      );

      /**
       * The runner's view of the decision layer: exactly one question, answered and
       * recorded. It never receives the coordinator itself, so it cannot ask about
       * routing, retries, risk or completion.
       */
      const agentDecisions: AgentDecisionPort = {
        selectTool: async (plan) => {
          const chosen = await coordinator.selectTool(plan);
          return {
            toolId: chosen.toolId,
            source: chosen.meta.answeredBy,
            decisionId: chosen.meta.decisionId,
            ...(chosen.reasonCode === undefined
              ? {}
              : { reasonCode: chosen.reasonCode }),
          };
        },
      };

      const llmRecords: LlmCallRecord[] = [];
      let budgetStop: string | undefined;
      let policyStop:
        | { outcome: "policy-denied"; reason: string }
        | { outcome: "awaiting-approval"; reason: string; requestId: string }
        | undefined;
      let verificationFailure: string | undefined;
      let verificationChecks = 0;
      let verificationFailures = 0;
      let providerFailure:
        | {
            failureKind: LlmFailureKind;
            attempts: number;
            retryable: boolean;
            statusCode?: number;
          }
        | undefined;
      let retriesSpent = 0;
      /** The hard cap the retry gate is bounded by. Never extended by a decision. */
      const maxRetries = deps.decisionLayer.config.maxRetriesPerTask;

      /**
       * Bounded invocation loop: the first attempt plus at most `maxRetries` retries,
       * each of which must survive the deterministic retry gate *and* the retry
       * decision. There is no path through this loop that is not capped.
       */
      while (true) {
        providerFailure = undefined;
        let attempt: AgentAttempt;
        try {
          attempt = await deps.runner.attempt({
            task: current.task,
            workspace: deps.workspace,
            providerId: deps.providerId,
            modelId: deps.modelId,
            correlationId: decisionContext().correlationId,
            context: selectedContext.bundle,
            operations,
            tools: toolPlan,
            decisions: agentDecisions,
          });
        } catch (error) {
          // An unexpected runtime error still has to leave an honest log: the
          // session is closed as failed before the error is allowed to propagate.
          const detail = isDomainError(error)
            ? error.code
            : error instanceof Error
              ? error.name
              : "unknown error";
          const ended = await deps.sessions.end(
            active(),
            "failed",
            `runtime error (${detail})`,
          );
          messages.push(
            `runtime error (${detail}); session ${ended.id} ended as failed`,
          );
          throw error;
        }
        messages.push(
          `runner "${deps.runner.id}" (${deps.runner.kind}) reported ` +
            `${attempt.steps.length} step(s)`,
        );

        for (const step of attempt.steps) {
          if (step.kind === "llm-failure") {
            session = await deps.sessions.recordLlmFailure(active(), {
              providerId: deps.providerId,
              modelId: deps.modelId,
              messageCount: step.messageCount,
              failureKind: step.failureKind,
              attempts: step.attempts,
              retryable: step.retryable,
              ...(step.statusCode === undefined
                ? {}
                : { statusCode: step.statusCode }),
              ...(step.contentPresence === undefined
                ? {}
                : { contentPresence: step.contentPresence }),
              ...(step.latencyMs === undefined
                ? {}
                : { latencyMs: step.latencyMs }),
              ...(step.contextSelectionId === undefined
                ? {}
                : { contextSelectionId: step.contextSelectionId }),
              ...(step.contextSelectionVersion === undefined
                ? {}
                : { contextSelectionVersion: step.contextSelectionVersion }),
              ...(step.contextSelectedTokens === undefined
                ? {}
                : { contextSelectedTokens: step.contextSelectedTokens }),
            });
            providerFailure = {
              failureKind: step.failureKind,
              attempts: step.attempts,
              retryable: step.retryable,
              ...(step.statusCode === undefined
                ? {}
                : { statusCode: step.statusCode }),
            };
            break;
          }

          if (step.kind === "llm") {
            session = await deps.sessions.recordLlmCall(active(), {
              providerId: deps.providerId,
              modelId: deps.modelId,
              messageCount: step.messageCount,
              usage: step.usage,
              usageReported: step.usageReported,
              latencyMs: step.latencyMs,
              retry: step.retry,
              escalated: step.escalated,
              ...(step.attempts === undefined
                ? {}
                : { attempts: step.attempts }),
              ...(step.requestId === undefined
                ? {}
                : { requestId: step.requestId }),
              ...(step.contextSelectionId === undefined
                ? {}
                : { contextSelectionId: step.contextSelectionId }),
              ...(step.contextSelectionVersion === undefined
                ? {}
                : { contextSelectionVersion: step.contextSelectionVersion }),
              ...(step.contextSelectedTokens === undefined
                ? {}
                : { contextSelectedTokens: step.contextSelectedTokens }),
            });
            llmRecords.push({
              providerId: deps.providerId,
              modelId: deps.modelId,
              usage: step.usage,
              usageReported: step.usageReported,
              latencyMs: step.latencyMs,
              retry: step.retry,
              escalated: step.escalated,
              ...(step.attempts === undefined
                ? {}
                : { attempts: step.attempts }),
            });

            // 4. Budget gate. Consumption is derived with the same accounting the
            // metrics layer uses, so the running check and the reported numbers
            // cannot diverge.
            const inFlight = computeTaskMetrics({
              taskId: current.task.id,
              llmCalls: llmRecords,
              toolCalls: 0,
              iterations: llmRecords.filter((call) => call.retry === 0).length,
              decisions: [],
              startedAt: current.task.createdAt,
              endedAt: current.task.createdAt,
            });
            const budget = evaluateBudget(current.task.budget, {
              tokens: inFlight.totalTokens,
              costMicros: pricedMicros(deps.rates, llmRecords),
              durationMs: durationMsFrom(
                active().startedAt,
                toIsoString(deps.clock.now()),
              ),
              iterations: inFlight.iterations,
              retries: inFlight.retries,
            });
            if (budget.level !== "ok") {
              messages.push(
                `budget ${budget.level}: ${budget.reasons.join("; ")}`,
              );
            }
            if (budget.exceeded) {
              // `reasons` already names the dimension, the ratio and the policy,
              // so it is used verbatim rather than wrapped in a second summary.
              budgetStop = budget.reasons.join("; ");
              break;
            }
            continue;
          }

          if (step.kind === "tool") {
            // 5. Contextual risk assessment, then the per-step policy gate.
            //
            // The deterministic baseline — the operation's inherent risk raised by the
            // declared level — is computed first and passed *in*. A decision layer can
            // raise the risk a policy gate sees; it can never lower it, and with no
            // decision layer the assessment is the baseline, which is exactly the
            // evaluation the platform performed before Phase G.
            const baselineRisk = effectiveRiskLevel(
              task.riskLevel,
              step.operation,
            );
            const assessment = await coordinator.assessRisk({
              operation: step.operation,
              baselineRisk,
            });
            if (assessment.raised) {
              messages.push(
                `risk assessment raised "${step.operation}" from ${baselineRisk} to ` +
                  `${assessment.effectiveRisk} (${describeDecisionAnswer(assessment.meta)}` +
                  (assessment.reasonCode === undefined
                    ? ")"
                    : `, ${assessment.reasonCode})`),
              );
            }
            const policy = evaluatePolicy(deps.policy, {
              operation: step.operation,
              riskLevel: assessment.effectiveRisk,
            });
            await deps.decisions.record(
              {
                kind: "policy",
                question:
                  `What policy effect applies to operation ` +
                  `"${step.operation}" for this task?`,
                options: POLICY_OPTIONS,
              },
              {
                outcome: "selected",
                selectedOptionId: policy.effect,
                decidedBy: "policy",
                rationale: policy.reason,
              },
              decisionContext(active().id),
            );

            if (policy.effect === "deny") {
              policyStop = {
                outcome: "policy-denied",
                reason:
                  `policy denied operation "${step.operation}": ` +
                  policy.reason,
              };
              break;
            }
            if (policy.effect === "require-approval") {
              const gate = await resolveGate(
                {
                  riskLevel: policy.effectiveRisk,
                  operation: step.operation,
                },
                `operation "${step.operation}" at effective risk "${policy.effectiveRisk}"`,
                active().id,
              );
              if (gate.kind === "suspended") {
                policyStop = {
                  outcome: "awaiting-approval",
                  reason: gate.reason,
                  requestId: gate.requestId,
                };
                break;
              }
            }

            // 6. The enforcement layer's own answer, when it refused the operation.
            //
            // A refusal here is not a failed tool: the operation did not happen at
            // all, and the gateway has already recorded why. A suspension is
            // resumable; a denial is not, so the attempt stops rather than continuing
            // with partial access and calling it a success.
            if (step.refusal !== undefined) {
              const detail =
                `operation "${step.toolId}" was refused by the access boundary ` +
                `(${step.refusal.reasonCode})`;
              if (
                step.refusal.requiresApproval &&
                step.refusal.approvalRequestId !== undefined
              ) {
                policyStop = {
                  outcome: "awaiting-approval",
                  reason: `${detail}; approval required: ${step.refusal.approvalRequestId}`,
                  requestId: step.refusal.approvalRequestId,
                };
                break;
              }
              policyStop = { outcome: "policy-denied", reason: detail };
              break;
            }

            session = await deps.sessions.recordToolCall(active(), {
              toolId: step.toolId,
              operation: step.operation,
              ok: step.ok,
              latencyMs: step.latencyMs,
            });
            continue;
          }
          session = await deps.sessions.recordTestRun(active(), {
            suite: step.suite,
            passed: step.passed,
            failed: step.failed,
            durationMs: step.durationMs,
          });
          verificationChecks += step.passed + step.failed;
          verificationFailures += step.failed;
          if (step.failed > 0) {
            verificationFailure =
              `verification suite "${step.suite}" reported ` +
              `${step.failed} failing check(s)`;
          }
        }

        // Retry: the decision layer may recommend, deterministic code decides. The
        // caps below are hard inputs to the question, not hints it may exceed.
        if (providerFailure === undefined) {
          break;
        }
        const budgetRetries = current.task.budget.maxRetries;
        const retriesRemaining = Math.max(
          0,
          (budgetRetries ?? maxRetries) - retriesSpent,
        );
        const retry = await coordinator.shouldRetry({
          failureKind: providerFailure.failureKind,
          retryable: providerFailure.retryable,
          attemptsSpent: retriesSpent,
          retriesRemaining,
        });
        messages.push(
          `retry decision: ${retry.action} (${describeDecisionAnswer(retry.meta)}` +
            (retry.reasonCode === undefined ? ")" : `, ${retry.reasonCode})`),
        );
        if (retry.action !== "retry") {
          if (retry.action === "escalate") {
            const escalation = await coordinator.recommendEscalation({
              facts: [`provider:${providerFailure.failureKind}`],
              securityRefusal: false,
            });
            messages.push(
              `escalation recommendation: ${escalation.recommendation} ` +
                `(${describeDecisionAnswer(escalation.meta)})`,
            );
          }
          break;
        }
        retriesSpent += 1;
        messages.push(
          `re-running the attempt (${retriesSpent}/${maxRetries}) after a ` +
            `"${providerFailure.failureKind}" failure`,
        );
      }

      if (providerFailure !== undefined) {
        const reason = describeFailure(
          providerFailure.failureKind,
          providerFailure.attempts,
          providerFailure.statusCode,
        );
        session = await deps.sessions.end(active(), "failed", reason);
        current = await deps.tasks.fail(current, reason);
        messages.push(reason);
        return {
          outcome: "provider-failed",
          task: current.task,
          session,
          reason,
          messages,
          resumed: resumedRun,
          route: routeDecision.routeId,
          retriesSpent,
        };
      }

      if (policyStop !== undefined) {
        session = await deps.sessions.end(
          active(),
          "aborted",
          policyStop.reason,
        );
        if (policyStop.outcome === "policy-denied") {
          // A denial cannot be waited out, so the task fails. An approval request
          // can, so the task is left exactly where it is.
          //
          // A refusal by the enforcement boundary is answered by the escalation gate
          // in code, without consulting a provider: a security refusal is never
          // delegated to a decision layer (ADR-053).
          const escalation = await coordinator.recommendEscalation({
            facts: ["operation:denied"],
            securityRefusal: true,
          });
          messages.push(
            `escalation recommendation: ${escalation.recommendation} ` +
              `(${escalation.reasonCode ?? describeDecisionAnswer(escalation.meta)})`,
          );
          current = await deps.tasks.fail(current, policyStop.reason);
          return {
            outcome: policyStop.outcome,
            task: current.task,
            session,
            reason: policyStop.reason,
            messages,
            resumed: resumedRun,
            route: routeDecision.routeId,
            escalation: escalation.recommendation,
          };
        }
        messages.push(
          `task left at status "${current.task.status}"; approve with: ai task approve ${task.id}`,
        );
        return suspension(policyStop.requestId, policyStop.reason, session);
      }

      if (budgetStop !== undefined) {
        session = await deps.sessions.end(active(), "aborted", budgetStop);
        current = await deps.tasks.fail(current, budgetStop);
        return {
          outcome: "budget-exceeded",
          task: current.task,
          session,
          reason: budgetStop,
          messages,
          resumed: resumedRun,
        };
      }

      // The work is finished; verification decides whether it passed.
      current = await deps.tasks.transition(current, "verification");

      if (verificationFailure !== undefined) {
        const escalation = await coordinator.recommendEscalation({
          facts: ["verification:failed"],
          securityRefusal: false,
        });
        session = await deps.sessions.end(
          active(),
          "failed",
          verificationFailure,
        );
        current = await deps.tasks.fail(current, verificationFailure);
        messages.push(
          verificationFailure,
          `escalation recommendation: ${escalation.recommendation} ` +
            `(${describeDecisionAnswer(escalation.meta)})`,
        );
        return {
          outcome: "verification-failed",
          task: current.task,
          session,
          reason: verificationFailure,
          messages,
          resumed: resumedRun,
          route: routeDecision.routeId,
          escalation: escalation.recommendation,
          retriesSpent,
        };
      }

      /**
       * Completion assessment: an assessment, not a proof.
       *
       * The task state machine stays deterministic — a success still ends in `review`,
       * which a human closes — so the worst a decision layer can do here is add
       * context to the human's decision. Nothing below depends on this answer
       * (ADR-054).
       */
      const completion = await coordinator.assessCompletion({
        acceptanceCriteriaTotal: current.task.acceptanceCriteria.length,
        verificationChecks,
        verificationFailures,
      });
      messages.push(
        `completion assessment: ${completion.assessment} ` +
          `(${describeDecisionAnswer(completion.meta)}` +
          (completion.reasonCode === undefined
            ? ")"
            : `, ${completion.reasonCode})`),
      );
      let escalationRecommendation: EscalationRecommendationId | undefined;
      if (completion.assessment !== "complete") {
        const escalation = await coordinator.recommendEscalation({
          facts: [`completion:${completion.assessment}`],
          securityRefusal: false,
        });
        escalationRecommendation = escalation.recommendation;
        messages.push(
          `a human decides whether this task is complete; escalation recommendation: ` +
            `${escalation.recommendation} (${describeDecisionAnswer(escalation.meta)})`,
        );
      }

      session = await deps.sessions.end(active(), "completed");
      current = await deps.tasks.transition(current, "review");
      messages.push(
        `task reached "review"; close it with: ai task complete ${current.task.id}`,
      );
      return {
        outcome: "awaiting-review",
        task: current.task,
        session,
        messages,
        resumed: resumedRun,
        route: routeDecision.routeId,
        completionAssessment: completion.assessment,
        ...(escalationRecommendation === undefined
          ? {}
          : { escalation: escalationRecommendation }),
        retriesSpent,
      };
    },
  };
}
