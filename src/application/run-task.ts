import type { ContextConfig } from "../adapters/config/project-config.js";
import { type Clock, durationMsFrom, toIsoString } from "../core/clock.js";
import { DomainError, isDomainError } from "../core/errors.js";
import type { SessionId } from "../core/ids.js";
import type { Policy } from "../decisions/policy.js";
import { evaluatePolicy } from "../decisions/policy.js";
import {
  type OperationKind,
  type RiskLevel,
  requiresHumanApproval,
} from "../decisions/risk.js";
import { evaluateBudget } from "../observability/budget.js";
import type { ModelRate } from "../observability/cost.js";
import { estimateCost } from "../observability/cost.js";
import type { LlmFailureKind } from "../ports/llm-provider.js";
import type { LlmCallRecord } from "../observability/metrics.js";
import { computeTaskMetrics } from "../observability/metrics.js";
import type { AgentSession } from "../sessions/agent-session.js";
import type { Task } from "../tasks/task.js";
import type { AgentAttempt, AgentRunner } from "../ports/agent-runner.js";
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
import { taskCorrelationId } from "./event-recorder.js";
import type { SessionService } from "./session-service.js";
import type { TaskService } from "./task-service.js";

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
}

export interface RunTask {
  run(stored: StoredTask): Promise<RunTaskResult>;
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

      let attempt: AgentAttempt;
      try {
        attempt = await deps.runner.attempt({
          task: current.task,
          workspace: deps.workspace,
          providerId: deps.providerId,
          modelId: deps.modelId,
          correlationId: decisionContext().correlationId,
          context: selectedContext.bundle,
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

      const llmRecords: LlmCallRecord[] = [];
      let budgetStop: string | undefined;
      let policyStop:
        | { outcome: "policy-denied"; reason: string }
        | { outcome: "awaiting-approval"; reason: string; requestId: string }
        | undefined;
      let verificationFailure: string | undefined;
      let providerFailure:
        | { failureKind: LlmFailureKind; attempts: number; statusCode?: number }
        | undefined;

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
            ...(step.attempts === undefined ? {} : { attempts: step.attempts }),
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
            ...(step.attempts === undefined ? {} : { attempts: step.attempts }),
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
          // 5. Per-step policy gate, evaluated before the step's result is accepted.
          const policy = evaluatePolicy(deps.policy, {
            operation: step.operation,
            riskLevel: task.riskLevel,
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
                `policy denied operation "${step.operation}": ` + policy.reason,
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
        if (step.failed > 0) {
          verificationFailure =
            `verification suite "${step.suite}" reported ` +
            `${step.failed} failing check(s)`;
        }
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
          current = await deps.tasks.fail(current, policyStop.reason);
          return {
            outcome: policyStop.outcome,
            task: current.task,
            session,
            reason: policyStop.reason,
            messages,
            resumed: resumedRun,
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
        session = await deps.sessions.end(
          active(),
          "failed",
          verificationFailure,
        );
        current = await deps.tasks.fail(current, verificationFailure);
        messages.push(verificationFailure);
        return {
          outcome: "verification-failed",
          task: current.task,
          session,
          reason: verificationFailure,
          messages,
          resumed: resumedRun,
        };
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
      };
    },
  };
}
