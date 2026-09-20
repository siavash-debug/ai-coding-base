import type {
  DecisionId,
  ProjectId,
  SessionId,
  TaskId,
  WorkspaceId,
} from "../core/ids.js";
import { type Clock, durationMsFrom } from "../core/clock.js";
import { DomainError } from "../core/errors.js";
import type {
  DecidedBy,
  DecisionKind,
  DecisionOutcome,
} from "../decisions/decision.js";
import type { OperationKind, RiskLevel } from "../decisions/risk.js";
import type { LlmFailureKind } from "../ports/llm-provider.js";
import { type ApprovalStatus, approvalStatusOf } from "./approval-ledger.js";
import type {
  AgentSessionStatus,
  TerminalAgentSessionStatus,
} from "../sessions/agent-session.js";
import type { BudgetEvaluation } from "../observability/budget.js";
import { evaluateBudget } from "../observability/budget.js";
import type { Cost, ModelRate } from "../observability/cost.js";
import { estimateCost } from "../observability/cost.js";
import type { DomainEvent } from "../observability/events.js";
import type { LlmCallRecord, TaskMetrics } from "../observability/metrics.js";
import { computeTaskMetrics } from "../observability/metrics.js";
import type { AIUsage } from "../observability/usage.js";
import { type TaskStatus, isTerminalStatus } from "../tasks/lifecycle.js";
import type { EventStore } from "../ports/event-store.js";
import type { StoredTask, TaskRepository } from "../ports/task-repository.js";
import type { ProjectScope } from "../ports/scope.js";

/**
 * Trace reconstruction: the read model over the event log.
 *
 * Everything here is a projection of events. Nothing is read from mutable
 * in-memory state, so a trace can be rebuilt for an old task long after the
 * process that produced it exited (ADR-006).
 *
 * Two derivations are kept deliberately separate, because conflating them is how
 * observability starts lying:
 *
 * - **event-derived** — `status`, durations, sessions, decisions, LLM calls, tool
 *   calls, tests, approvals and every metric. Available even with no repository.
 * - **record-derived** — the full task contract (description, constraints,
 *   acceptance criteria, budget, declared verification). Only present when a
 *   `TaskRepository` is supplied.
 *
 * Where both exist they must agree; disagreement is reported as an integrity
 * issue rather than quietly resolved.
 *
 * This module is CLI-agnostic on purpose: the same `TaskTrace` feeds `ai task
 * trace` today and a dashboard later.
 *
 * The epoch below is a placeholder for "this task has no events", used only in a
 * field that is never rendered and never reaches a duration computation.
 */
const UNKNOWN_INSTANT = "1970-01-01T00:00:00.000Z";

export interface TraceLlmCall {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly sessionId?: SessionId;
  readonly providerId: string;
  readonly modelId: string;
  readonly messageCount?: number;
  readonly usage: AIUsage;
  /** False when the provider reported no usage at all. Never means "free". */
  readonly usageReported?: boolean;
  /** Absent when the model has no known rate. Never a fabricated zero. */
  readonly cost?: Cost;
  readonly latencyMs: number;
  readonly retry: number;
  readonly escalated: boolean;
  /** Transport attempts spent, including the successful one. */
  readonly attempts?: number;
  /** The provider's own request id, when it supplied one. */
  readonly requestId?: string;
}

/**
 * A model request that ended in a categorised failure rather than a response.
 *
 * Failures are first-class trace facts: an attempt that stops because a provider
 * refused, timed out or rejected a credential must be distinguishable from one
 * that simply did less work. Only the category is recorded — never the vendor's
 * message (ADR-035).
 */
export interface TraceLlmFailure {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly sessionId?: SessionId;
  readonly providerId: string;
  readonly modelId: string;
  readonly failureKind: LlmFailureKind;
  readonly attempts: number;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly latencyMs?: number;
}

export interface TraceToolCall {
  readonly toolId: string;
  readonly sessionId?: SessionId;
  readonly operation?: OperationKind;
  readonly ok: boolean;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly latencyMs?: number;
}

export interface TraceTestRun {
  readonly suite: string;
  readonly sessionId?: SessionId;
  readonly occurredAt: string;
  readonly passed: number;
  readonly failed: number;
  readonly durationMs?: number;
}

export interface TraceDecision {
  /** Present once the decision has been answered. */
  readonly decisionId?: DecisionId;
  readonly kind: DecisionKind;
  readonly question?: string;
  readonly optionCount?: number;
  readonly outcome: DecisionOutcome;
  readonly decidedBy?: DecidedBy;
  readonly selectedOptionId?: string;
  readonly requestedAt?: string;
  readonly completedAt?: string;
  readonly latencyMs?: number;
}

export interface TraceSession {
  readonly id: SessionId;
  readonly agentId: string;
  readonly status: AgentSessionStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly endReason?: string;
  readonly providerIds: readonly string[];
  readonly modelIds: readonly string[];
  readonly llmCalls: number;
  readonly toolCalls: number;
  /** Context selections performed while this session was open. */
  readonly contextSelections: number;
  /** Model turns: LLM requests that were not retries. */
  readonly iterations: number;
}

/**
 * One context candidate that was selected, as the trace reports it.
 *
 * A path and reason codes, never content: this is the type that makes "why is this
 * file in my prompt?" answerable from an old log, and it is also the type that would
 * become a leak if it ever carried text (ADR-039).
 */
export interface TraceContextSelectedRef {
  readonly candidateId: string;
  readonly kind: string;
  readonly ref: string;
  readonly tokens: number;
  readonly basis: "size" | "content";
  readonly score: number;
  readonly reasons: readonly string[];
  readonly mandatory: boolean;
}

/** One candidate the selection dropped, with the reason it was dropped. */
export interface TraceContextExcludedRef {
  readonly candidateId: string;
  readonly kind: string;
  readonly ref: string;
  readonly tokens: number;
  readonly score: number;
  readonly reason: string;
}

/**
 * A context selection as reconstructed from its events.
 *
 * `complete` is false when a `ContextSelectionStarted` was never followed by a
 * `ContextSelected` — a crash mid-selection. Reporting a partial selection as if it
 * were a whole one would make a missing decision look like a decision to include
 * nothing.
 */
export interface TraceContextSelection {
  readonly selectionId: string;
  readonly strategy?: string;
  readonly selectionVersion?: number;
  readonly configFingerprint?: string;
  readonly sessionId?: SessionId;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly budgetTokens?: number;
  readonly candidateTokens?: number;
  readonly selectedTokens?: number;
  readonly excludedTokens?: number;
  readonly remainingTokens?: number;
  readonly mandatoryTokens?: number;
  readonly considered?: number;
  readonly filteredByScore?: number;
  readonly excludedByRules?: number;
  readonly budgetExceeded: boolean;
  readonly overBudgetTokens?: number;
  readonly capabilities: readonly string[];
  readonly unavailableCapabilities: readonly string[];
  readonly selected: readonly TraceContextSelectedRef[];
  readonly excluded: readonly TraceContextExcludedRef[];
  readonly refsTruncated: boolean;
  readonly complete: boolean;
}

export interface TraceApproval {
  readonly requestId: string;
  readonly riskLevel: RiskLevel;
  readonly operation?: OperationKind;
  readonly requestedAt: string;
  readonly grantedAt?: string;
  readonly approver?: string;
  /**
   * The risk level the grant actually authorises. Separate from `riskLevel`
   * (what was asked) because a human may deliberately grant broader authority
   * than the request asked for — hiding that difference would defeat the point.
   */
  readonly grantedRiskLevel?: RiskLevel;
  readonly grantedOperation?: OperationKind;
  /** What the grant covers: one operation, or the whole task. */
  readonly grantScope?: "task" | "operation";
  /** Absent means the grant does not expire. */
  readonly expiresAt?: string;
  /** Present once the grant has authorised work: a grant is single-use. */
  readonly consumedAt?: string;
  /**
   * Derived with the same function the ledger uses, so the trace and `ai
   * approvals` cannot disagree. Absent when the reader had no clock.
   */
  readonly status?: ApprovalStatus;
}

/**
 * Structural completeness of the trace. A non-empty `issues` list means the log
 * or the record disagrees with itself, which is exactly what an auditor needs to
 * see rather than a silently repaired view.
 */
export interface TraceIntegrity {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export interface TaskTrace {
  readonly taskId: TaskId;
  /**
   * Whether this scope knows about the task at all: a stored record, or at least
   * one event in scope.
   *
   * It exists so that "this task has no events yet" and "this scope has never
   * heard of this task" stay distinguishable without a caller guessing from empty
   * collections — and without the reader ever confirming whether an unknown id
   * exists somewhere else. That second question is deliberately unanswerable here:
   * the store and repository are scope-scoped, so `found: false` means exactly
   * "not in the scope you asked about", nothing more.
   *
   * Without a repository, the projection degrades honestly to "has events": the
   * reader cannot see the record, so it does not claim to have.
   */
  readonly found: boolean;
  readonly projectId: ProjectId;
  readonly workspaceId?: WorkspaceId;
  readonly title?: string;
  readonly riskLevel?: RiskLevel;
  readonly status: TaskStatus;
  readonly terminal: boolean;
  readonly firstEventAt?: string;
  readonly lastEventAt?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  /** Wall-clock span from the first to the last observed event. */
  readonly elapsedMs: number;
  readonly sessions: readonly TraceSession[];
  readonly decisions: readonly TraceDecision[];
  readonly llmCalls: readonly TraceLlmCall[];
  readonly llmFailures: readonly TraceLlmFailure[];
  readonly toolCalls: readonly TraceToolCall[];
  readonly tests: readonly TraceTestRun[];
  readonly approvals: readonly TraceApproval[];
  readonly contextSelections: readonly TraceContextSelection[];
  readonly events: readonly DomainEvent[];
  readonly metrics: TaskMetrics;
  readonly budget: BudgetEvaluation;
  readonly integrity: TraceIntegrity;
  /** Repository projection, present only when a repository was supplied. */
  readonly record?: StoredTask;
}

export interface TraceReader {
  read(scope: ProjectScope, taskId: TaskId): Promise<TaskTrace>;
}

export interface TraceReaderDeps {
  readonly store: EventStore;
  /**
   * Optional. Supplied so grant expiry can be evaluated at read time; without it
   * approvals are reported without a derived status rather than with a guess.
   */
  readonly clock?: Clock;
  /** Pricing table used to price calls that are not already priced. */
  readonly rates: readonly ModelRate[];
  /**
   * Optional. When supplied, the trace also carries the stored task record so
   * callers can show the full contract without a second query.
   */
  readonly repository?: TaskRepository;
}

interface MutableSession {
  id: SessionId;
  agentId: string;
  status: AgentSessionStatus;
  startedAt: string;
  endedAt?: string;
  endReason?: string;
  providerIds: string[];
  modelIds: string[];
  llmCalls: number;
  toolCalls: number;
  contextSelections: number;
  iterations: number;
}

interface PendingLlmRequest {
  readonly sequence: number;
}

interface PendingToolCall {
  readonly toolId: string;
  readonly operation?: OperationKind;
  readonly startedAt: string;
}

interface PendingDecision {
  readonly kind: DecisionKind;
  readonly question: string;
  readonly optionCount: number;
  readonly requestedAt: string;
}

function groupKey(sessionId: SessionId | undefined, toolId: string): string {
  return `${sessionId ?? ""}\u0000${toolId}`;
}

export function createTraceReader(deps: TraceReaderDeps): TraceReader {
  return {
    async read(scope, taskId): Promise<TaskTrace> {
      const events = await deps.store.readByTask(scope, taskId);
      const record =
        deps.repository === undefined
          ? undefined
          : await deps.repository.find(scope, taskId);

      const issues: string[] = [];
      const first = events[0];
      const last = events[events.length - 1];

      let workspaceId: WorkspaceId | undefined = scope.workspaceId;
      let title: string | undefined;
      let riskLevel: RiskLevel | undefined;
      let status: TaskStatus | undefined;
      let startedAt: string | undefined;
      let endedAt: string | undefined;
      let completedEventType: string | undefined;

      const sessionsById = new Map<string, MutableSession>();
      const sessionOrder: string[] = [];
      const decisions: TraceDecision[] = [];
      const llmCalls: TraceLlmCall[] = [];
      const llmFailures: TraceLlmFailure[] = [];
      const toolCalls: TraceToolCall[] = [];
      const tests: TraceTestRun[] = [];
      const approvals: TraceApproval[] = [];
      const contextSelections: TraceContextSelection[] = [];

      const pendingLlm = new Map<string, PendingLlmRequest[]>();
      const pendingTools = new Map<string, PendingToolCall[]>();
      const pendingDecisions: PendingDecision[] = [];

      const sessionOf = (
        sessionId: SessionId | undefined,
      ): MutableSession | undefined =>
        sessionId === undefined ? undefined : sessionsById.get(sessionId);

      for (const event of events) {
        // A task lives in exactly one workspace; a second one is a real integrity
        // failure, not something to paper over by taking the latest value.
        if (workspaceId === undefined) {
          workspaceId = event.workspaceId;
        } else if (event.workspaceId !== workspaceId) {
          issues.push(
            `event "${event.id}" belongs to workspace "${event.workspaceId}", but the trace already saw workspace "${workspaceId}"`,
          );
        }
        const session = sessionOf(event.sessionId);

        switch (event.type) {
          case "TaskCreated":
            title = event.payload.title;
            riskLevel = event.payload.riskLevel;
            status = "created";
            break;
          case "TaskStarted":
            startedAt = event.occurredAt;
            break;
          case "TaskStatusChanged": {
            status = event.payload.to;
            if (isTerminalStatus(event.payload.to)) {
              endedAt = event.occurredAt;
            }
            break;
          }
          case "TaskCompleted":
            status = "completed";
            completedEventType = event.type;
            endedAt = event.occurredAt;
            break;
          case "TaskFailed":
            status = "failed";
            completedEventType = event.type;
            endedAt = event.occurredAt;
            break;
          case "SessionStarted": {
            const id = event.sessionId;
            if (id === undefined) {
              issues.push(
                `SessionStarted event "${event.id}" carries no sessionId`,
              );
              break;
            }
            const started: MutableSession = {
              id,
              agentId: event.payload.agentId,
              status: "active",
              startedAt: event.occurredAt,
              providerIds: [...event.payload.providerIds],
              modelIds: [...event.payload.modelIds],
              llmCalls: 0,
              toolCalls: 0,
              contextSelections: 0,
              iterations: 0,
            };
            sessionsById.set(id, started);
            sessionOrder.push(id);
            startedAt ??= event.occurredAt;
            break;
          }
          case "SessionEnded": {
            if (session === undefined) {
              issues.push(
                `SessionEnded event "${event.id}" has no matching SessionStarted`,
              );
              break;
            }
            session.status = event.payload.status;
            session.endedAt = event.occurredAt;
            if (event.payload.reason !== undefined) {
              session.endReason = event.payload.reason;
            }
            break;
          }
          case "LLMRequestStarted": {
            const key = event.sessionId ?? "";
            const queue = pendingLlm.get(key) ?? [];
            queue.push({ sequence: event.sequence });
            pendingLlm.set(key, queue);
            for (const providerId of [event.payload.providerId]) {
              if (
                session !== undefined &&
                !session.providerIds.includes(providerId)
              ) {
                session.providerIds.push(providerId);
              }
            }
            for (const modelId of [event.payload.modelId]) {
              if (
                session !== undefined &&
                !session.modelIds.includes(modelId)
              ) {
                session.modelIds.push(modelId);
              }
            }
            break;
          }
          case "LLMRequestCompleted": {
            const key = event.sessionId ?? "";
            const queue = pendingLlm.get(key);
            if (queue === undefined || queue.length === 0) {
              issues.push(
                `LLMRequestCompleted event "${event.id}" has no matching LLMRequestStarted`,
              );
              break;
            }
            queue.shift();
            const usage = event.payload.usage;
            const usageReported = event.payload.usageReported ?? true;
            const priced = estimateCost({
              usage,
              providerId: event.payload.providerId,
              modelId: event.payload.modelId,
              rates: deps.rates,
              at: event.occurredAt,
            });
            llmCalls.push({
              sequence: event.sequence,
              occurredAt: event.occurredAt,
              ...(event.sessionId === undefined
                ? {}
                : { sessionId: event.sessionId }),
              providerId: event.payload.providerId,
              modelId: event.payload.modelId,
              usage,
              usageReported,
              ...(priced === undefined ? {} : { cost: priced }),
              latencyMs: event.payload.latencyMs,
              retry: event.payload.retry,
              escalated: event.payload.escalated,
              ...(event.payload.attempts === undefined
                ? {}
                : { attempts: event.payload.attempts }),
              ...(event.payload.requestId === undefined
                ? {}
                : { requestId: event.payload.requestId }),
            });
            if (session !== undefined) {
              session.llmCalls += 1;
              if (event.payload.retry === 0) {
                session.iterations += 1;
              }
              if (!session.providerIds.includes(event.payload.providerId)) {
                session.providerIds.push(event.payload.providerId);
              }
              if (!session.modelIds.includes(event.payload.modelId)) {
                session.modelIds.push(event.payload.modelId);
              }
            }
            break;
          }
          case "LLMRequestFailed": {
            // A failed request closes its own pending request, so it is not
            // reported as an unpaired start. It is not counted as a turn: nothing
            // was produced.
            const key = event.sessionId ?? "";
            const queue = pendingLlm.get(key);
            if (queue === undefined || queue.length === 0) {
              issues.push(
                `LLMRequestFailed event "${event.id}" has no matching LLMRequestStarted`,
              );
            } else {
              queue.shift();
            }
            if (session !== undefined) {
              for (const providerId of [event.payload.providerId]) {
                if (!session.providerIds.includes(providerId)) {
                  session.providerIds.push(providerId);
                }
              }
              for (const modelId of [event.payload.modelId]) {
                if (!session.modelIds.includes(modelId)) {
                  session.modelIds.push(modelId);
                }
              }
            }
            llmFailures.push({
              sequence: event.sequence,
              occurredAt: event.occurredAt,
              ...(event.sessionId === undefined
                ? {}
                : { sessionId: event.sessionId }),
              providerId: event.payload.providerId,
              modelId: event.payload.modelId,
              failureKind: event.payload.failureKind,
              attempts: event.payload.attempts,
              retryable: event.payload.retryable,
              ...(event.payload.statusCode === undefined
                ? {}
                : { statusCode: event.payload.statusCode }),
              ...(event.payload.latencyMs === undefined
                ? {}
                : { latencyMs: event.payload.latencyMs }),
            });
            break;
          }
          case "ToolCallStarted": {
            const key = groupKey(event.sessionId, event.payload.toolId);
            const queue = pendingTools.get(key) ?? [];
            queue.push({
              toolId: event.payload.toolId,
              ...(event.payload.operation === undefined
                ? {}
                : { operation: event.payload.operation }),
              startedAt: event.occurredAt,
            });
            pendingTools.set(key, queue);
            break;
          }
          case "ToolCallCompleted": {
            const key = groupKey(event.sessionId, event.payload.toolId);
            const queue = pendingTools.get(key) ?? [];
            const started = queue.shift();
            if (started === undefined) {
              issues.push(
                `ToolCallCompleted event "${event.id}" has no matching ToolCallStarted`,
              );
              break;
            }
            const operation =
              started.operation ?? event.payload.operation ?? undefined;
            toolCalls.push({
              toolId: event.payload.toolId,
              ...(event.sessionId === undefined
                ? {}
                : { sessionId: event.sessionId }),
              ...(operation === undefined ? {} : { operation }),
              ok: event.payload.ok,
              startedAt: started.startedAt,
              completedAt: event.occurredAt,
              ...(event.payload.latencyMs === undefined
                ? {}
                : { latencyMs: event.payload.latencyMs }),
            });
            if (session !== undefined) {
              session.toolCalls += 1;
            }
            break;
          }
          case "TestCompleted":
            tests.push({
              suite: event.payload.suite,
              ...(event.sessionId === undefined
                ? {}
                : { sessionId: event.sessionId }),
              occurredAt: event.occurredAt,
              passed: event.payload.passed,
              failed: event.payload.failed,
              ...(event.payload.durationMs === undefined
                ? {}
                : { durationMs: event.payload.durationMs }),
            });
            break;
          case "DecisionRequested":
            pendingDecisions.push({
              kind: event.payload.kind,
              question: event.payload.question,
              optionCount: event.payload.optionCount,
              requestedAt: event.occurredAt,
            });
            break;
          case "DecisionCompleted": {
            // A request and its answer are separate events, and only the answer
            // carries an id, so pairing is by kind in request order. Deterministic
            // for a given log.
            const index = pendingDecisions.findIndex(
              (pending) => pending.kind === event.payload.kind,
            );
            const requested =
              index === -1 ? undefined : pendingDecisions.splice(index, 1)[0];
            if (requested === undefined) {
              issues.push(
                `DecisionCompleted event "${event.id}" has no matching DecisionRequested`,
              );
            }
            decisions.push({
              decisionId: event.payload.decisionId as DecisionId,
              kind: event.payload.kind,
              ...(requested === undefined
                ? {}
                : {
                    question: requested.question,
                    optionCount: requested.optionCount,
                    requestedAt: requested.requestedAt,
                  }),
              outcome: event.payload.outcome,
              decidedBy: event.payload.decidedBy,
              ...(event.payload.selectedOptionId === undefined
                ? {}
                : { selectedOptionId: event.payload.selectedOptionId }),
              completedAt: event.occurredAt,
              ...(event.payload.latencyMs === undefined
                ? {}
                : { latencyMs: event.payload.latencyMs }),
            });
            break;
          }
          case "ContextSelectionStarted":
            contextSelections.push({
              selectionId: event.payload.selectionId,
              strategy: event.payload.strategy,
              selectionVersion: event.payload.selectionVersion,
              configFingerprint: event.payload.configFingerprint,
              ...(event.sessionId === undefined
                ? {}
                : { sessionId: event.sessionId }),
              startedAt: event.occurredAt,
              budgetTokens: event.payload.budgetTokens,
              budgetExceeded: false,
              capabilities: [],
              unavailableCapabilities: [],
              selected: [],
              excluded: [],
              refsTruncated: false,
              complete: false,
            });
            break;
          case "ContextSelected": {
            const index = contextSelections.findIndex(
              (selection) =>
                selection.selectionId === event.payload.selectionId &&
                !selection.complete,
            );
            if (index === -1) {
              // A completion with no start means the log is missing an event, which
              // is worth reporting rather than inventing a start for.
              issues.push(
                `ContextSelected event "${event.id}" has no matching ContextSelectionStarted`,
              );
              break;
            }
            const started = contextSelections[index];
            contextSelections.splice(index, 1, {
              ...started,
              strategy: event.payload.strategy,
              selectionVersion: event.payload.selectionVersion,
              configFingerprint: event.payload.configFingerprint,
              completedAt: event.occurredAt,
              durationMs: event.payload.durationMs,
              budgetTokens: event.payload.budgetTokens,
              candidateTokens: event.payload.candidateTokens,
              selectedTokens: event.payload.selectedTokens,
              excludedTokens: event.payload.excludedTokens,
              remainingTokens: event.payload.remainingTokens,
              mandatoryTokens: event.payload.mandatoryTokens,
              considered: event.payload.considered,
              filteredByScore: event.payload.filteredByScore,
              excludedByRules: event.payload.excludedByRules,
              budgetExceeded: event.payload.budgetExceeded,
              overBudgetTokens: event.payload.overBudgetTokens,
              capabilities: [...event.payload.capabilities],
              unavailableCapabilities: [
                ...event.payload.unavailableCapabilities,
              ],
              selected: event.payload.selectedRefs.map((ref) => ({
                candidateId: ref.candidateId,
                kind: ref.kind,
                ref: ref.ref,
                tokens: ref.tokens,
                basis: ref.basis,
                score: ref.score,
                reasons: [...ref.reasons],
                mandatory: ref.mandatory,
              })),
              excluded: event.payload.excludedRefs.map((ref) => ({
                candidateId: ref.candidateId,
                kind: ref.kind,
                ref: ref.ref,
                tokens: ref.tokens,
                score: ref.score,
                reason: ref.reason,
              })),
              refsTruncated: event.payload.refsTruncated,
              complete: true,
            });
            if (session !== undefined) {
              // Reading context is a session activity; it just does not cost money.
              session.contextSelections += 1;
            }
            break;
          }
          case "HumanApprovalRequested":
            approvals.push({
              requestId: event.payload.requestId,
              riskLevel: event.payload.riskLevel,
              ...(event.payload.operation === undefined
                ? {}
                : { operation: event.payload.operation }),
              requestedAt: event.occurredAt,
            });
            break;
          case "HumanApprovalGranted": {
            const index = approvals.findIndex(
              (approval) =>
                approval.requestId === event.payload.requestId &&
                approval.grantedAt === undefined,
            );
            if (index === -1) {
              issues.push(
                `HumanApprovalGranted event "${event.id}" has no open matching HumanApprovalRequested`,
              );
              break;
            }
            approvals.splice(index, 1, {
              ...approvals[index],
              grantedAt: event.occurredAt,
              approver: event.payload.approver,
              grantedRiskLevel: event.payload.riskLevel,
              grantScope:
                event.payload.operation === undefined ? "task" : "operation",
              ...(event.payload.operation === undefined
                ? {}
                : { grantedOperation: event.payload.operation }),
              ...(event.payload.expiresAt === undefined
                ? {}
                : { expiresAt: event.payload.expiresAt }),
            });
            break;
          }
          case "HumanApprovalConsumed": {
            const index = approvals.findIndex(
              (approval) =>
                approval.requestId === event.payload.requestId &&
                approval.grantedAt !== undefined,
            );
            if (index === -1) {
              issues.push(
                `HumanApprovalConsumed event "${event.id}" has no granted HumanApprovalRequested to consume`,
              );
              break;
            }
            const previous = approvals[index];
            if (previous.consumedAt !== undefined) {
              // A grant authorises one attempt. A second consumption is a real
              // integrity failure, not a repeat of the first.
              issues.push(
                `approval "${previous.requestId}" was consumed more than once (first at ${previous.consumedAt})`,
              );
            }
            approvals.splice(index, 1, {
              ...previous,
              consumedAt: event.occurredAt,
            });
            break;
          }
          default:
            break;
        }
      }

      for (const [key, queue] of pendingLlm) {
        for (const pending of queue) {
          issues.push(
            `LLMRequestStarted at sequence ${pending.sequence}${key === "" ? "" : ` (session ${key})`} was never completed`,
          );
        }
      }
      for (const [key, queue] of pendingTools) {
        for (const pending of queue) {
          issues.push(
            `ToolCallStarted for tool "${pending.toolId}"${key.startsWith("\u0000") ? "" : ` (session ${key.split("\u0000")[0]})`} was never completed`,
          );
        }
      }
      for (const pending of pendingDecisions) {
        decisions.push({
          kind: pending.kind,
          question: pending.question,
          optionCount: pending.optionCount,
          outcome: "pending",
          requestedAt: pending.requestedAt,
        });
      }
      for (const session of sessionsById.values()) {
        if (session.status === "active") {
          issues.push(`session "${session.id}" was started but never ended`);
        }
      }
      for (const selection of contextSelections) {
        if (!selection.complete) {
          issues.push(
            `context selection "${selection.selectionId}" was started but never completed`,
          );
        }
      }

      const resolvedStatus: TaskStatus =
        status ?? record?.task.status ?? "created";
      if (
        completedEventType === "TaskCompleted" &&
        resolvedStatus !== "completed"
      ) {
        issues.push(
          `TaskCompleted was recorded but the task status is "${resolvedStatus}"`,
        );
      }
      if (completedEventType === "TaskFailed" && resolvedStatus !== "failed") {
        issues.push(
          `TaskFailed was recorded but the task status is "${resolvedStatus}"`,
        );
      }
      if (
        record !== undefined &&
        status !== undefined &&
        record.task.status !== status
      ) {
        issues.push(
          `stored task record is at status "${record.task.status}" while the event log says "${status}"`,
        );
      }

      const sessions: TraceSession[] = sessionOrder.map((id) => {
        const session = sessionsById.get(id) as MutableSession;
        return {
          id: session.id,
          agentId: session.agentId,
          status: session.status,
          startedAt: session.startedAt,
          ...(session.endedAt === undefined
            ? {}
            : { endedAt: session.endedAt }),
          ...(session.endReason === undefined
            ? {}
            : { endReason: session.endReason }),
          providerIds: [...session.providerIds],
          modelIds: [...session.modelIds],
          llmCalls: session.llmCalls,
          toolCalls: session.toolCalls,
          contextSelections: session.contextSelections,
          iterations: session.iterations,
        };
      });

      const nowMs = deps.clock?.now().getTime();
      const firstEventAt = first?.occurredAt;
      const lastEventAt = last?.occurredAt;
      const elapsedMs =
        firstEventAt === undefined || lastEventAt === undefined
          ? 0
          : durationMsFrom(firstEventAt, lastEventAt);

      const metricsStartedAt =
        firstEventAt ?? record?.task.createdAt ?? UNKNOWN_INSTANT;
      const llmRecords: LlmCallRecord[] = llmCalls.map((call) => ({
        providerId: call.providerId,
        modelId: call.modelId,
        usage: call.usage,
        ...(call.usageReported === undefined
          ? {}
          : { usageReported: call.usageReported }),
        ...(call.cost === undefined ? {} : { cost: call.cost }),
        latencyMs: call.latencyMs,
        retry: call.retry,
        escalated: call.escalated,
        ...(call.attempts === undefined ? {} : { attempts: call.attempts }),
      }));

      const metrics = computeTaskMetrics({
        taskId,
        llmCalls: llmRecords,
        llmFailures: llmFailures.length,
        toolCalls: toolCalls.length,
        iterations: llmCalls.filter((call) => call.retry === 0).length,
        decisions: decisions.flatMap((decision) =>
          decision.decidedBy === undefined
            ? []
            : [{ decidedBy: decision.decidedBy, outcome: decision.outcome }],
        ),
        // Only completed selections contribute: a selection that never finished has
        // no counters, and counting a partial one would understate the ratio.
        contextSelections: contextSelections
          .filter((selection) => selection.complete)
          .map((selection) => ({
            budgetTokens: selection.budgetTokens ?? 0,
            candidateTokens: selection.candidateTokens ?? 0,
            selectedTokens: selection.selectedTokens ?? 0,
            excludedTokens: selection.excludedTokens ?? 0,
            considered: selection.considered ?? 0,
            selected: selection.selected.length,
            excluded: selection.excluded.length,
            durationMs: selection.durationMs ?? 0,
            budgetExceeded: selection.budgetExceeded,
            overBudgetTokens: selection.overBudgetTokens ?? 0,
          })),
        startedAt: metricsStartedAt,
        ...(endedAt === undefined ? {} : { endedAt }),
      });

      const budget = evaluateBudget(record?.task.budget ?? {}, {
        tokens: metrics.totalTokens,
        costMicros: metrics.cost.micros,
        // Budgets constrain real elapsed time, which is meaningful while a task
        // is still open; `metrics.durationMs` only exists once it is closed.
        durationMs: elapsedMs,
        iterations: metrics.iterations,
        retries: metrics.retries,
      });

      return {
        taskId,
        found: record !== undefined || events.length > 0,
        projectId: first?.projectId ?? scope.projectId,
        ...((workspaceId ?? scope.workspaceId) === undefined
          ? {}
          : { workspaceId: (workspaceId ?? scope.workspaceId) as WorkspaceId }),
        ...(title === undefined ? {} : { title }),
        ...(riskLevel === undefined ? {} : { riskLevel }),
        status: resolvedStatus,
        terminal: isTerminalStatus(resolvedStatus),
        ...(firstEventAt === undefined ? {} : { firstEventAt }),
        ...(lastEventAt === undefined ? {} : { lastEventAt }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(endedAt === undefined ? {} : { endedAt }),
        elapsedMs,
        sessions,
        decisions,
        llmCalls,
        llmFailures,
        toolCalls,
        tests,
        contextSelections,
        approvals:
          nowMs === undefined
            ? approvals
            : approvals.map((approval) => ({
                ...approval,
                status: approvalStatusOf(approval, nowMs),
              })),
        events,
        metrics,
        budget,
        integrity: { ok: issues.length === 0, issues },
        ...(record === undefined ? {} : { record }),
      };
    },
  };
}

/**
 * Terminal session status of a session that has ended, or `undefined` while it is
 * still active. Convenience for renderers that only distinguish "done" from "not".
 */
export function terminalSessionStatus(
  session: TraceSession,
): TerminalAgentSessionStatus | undefined {
  if (session.status === "active") {
    return undefined;
  }
  return session.status;
}

/** Fails loudly when a caller asks for a trace it is not allowed to see. */
export function assertTraceVisible(
  trace: TaskTrace,
  scope: ProjectScope,
): void {
  if (trace.projectId !== scope.projectId) {
    throw new DomainError(
      "FORBIDDEN",
      `trace for task "${trace.taskId}" belongs to project "${trace.projectId}", not "${scope.projectId}"`,
      { field: "trace.projectId" },
    );
  }
}
