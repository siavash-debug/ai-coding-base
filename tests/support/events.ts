import type { Clock } from "../../src/core/clock.js";
import {
  type ProjectId,
  type SessionId,
  type TaskId,
  type WorkspaceId,
  eventId,
} from "../../src/core/ids.js";
import type {
  DecidedBy,
  DecisionKind,
  ResolvedDecisionOutcome,
} from "../../src/decisions/decision.js";
import type { OperationKind, RiskLevel } from "../../src/decisions/risk.js";
import {
  type EventActor,
  type EventEnvelope,
  type EventPayloadMap,
  type EventType,
  createEvent,
} from "../../src/observability/events.js";
import type { TerminalAgentSessionStatus } from "../../src/sessions/agent-session.js";
import type { TaskStatus } from "../../src/tasks/lifecycle.js";
import type { AIUsage } from "../../src/observability/usage.js";

/**
 * Typed event builders for tests.
 *
 * Events are constructed through the real `createEvent`, so every fixture is
 * validated exactly as production events are. A test can therefore never assert
 * against an event shape the domain would have rejected.
 */
export interface EventContext {
  readonly clock: Clock;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly actor?: EventActor;
}

const DEFAULT_ACTOR: EventActor = { type: "code", id: "test" };

function build<K extends EventType>(
  ctx: EventContext,
  sequence: number,
  type: K,
  payload: EventPayloadMap[K],
  scope: {
    readonly taskId?: TaskId;
    readonly sessionId?: SessionId;
    readonly occurrenceIndex?: number;
  } = {},
): EventEnvelope<K> {
  return createEvent(
    {
      type,
      actor: ctx.actor ?? DEFAULT_ACTOR,
      projectId: ctx.projectId,
      workspaceId: ctx.workspaceId,
      ...(scope.taskId === undefined ? {} : { taskId: scope.taskId }),
      ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
      correlationId: `${ctx.projectId}:${ctx.workspaceId}:${scope.taskId ?? "none"}`,
      payload,
    },
    {
      id: eventId(`evt-${sequence}-${scope.occurrenceIndex ?? 0}`),
      sequence,
      clock: ctx.clock,
    },
  );
}

export function taskCreated(
  ctx: EventContext,
  sequence: number,
  taskId: TaskId,
  title = "Test task",
): EventEnvelope<"TaskCreated"> {
  return build(
    ctx,
    sequence,
    "TaskCreated",
    {
      title,
      riskLevel: "medium",
      workspaceId: ctx.workspaceId,
    },
    { taskId },
  );
}

export function taskStatusChanged(
  ctx: EventContext,
  sequence: number,
  taskId: TaskId,
  from: TaskStatus,
  to: TaskStatus,
): EventEnvelope<"TaskStatusChanged"> {
  return build(ctx, sequence, "TaskStatusChanged", { from, to }, { taskId });
}

export function taskCompleted(
  ctx: EventContext,
  sequence: number,
  taskId: TaskId,
  met: number,
  total: number,
): EventEnvelope<"TaskCompleted"> {
  return build(
    ctx,
    sequence,
    "TaskCompleted",
    { acceptanceCriteriaMet: met, acceptanceCriteriaTotal: total },
    { taskId },
  );
}

export function sessionStarted(
  ctx: EventContext,
  sequence: number,
  taskId: TaskId,
  sessionId: SessionId,
  agentId = "agent-1",
): EventEnvelope<"SessionStarted"> {
  return build(
    ctx,
    sequence,
    "SessionStarted",
    { agentId, providerIds: [], modelIds: [] },
    { taskId, sessionId },
  );
}

export function sessionEnded(
  ctx: EventContext,
  sequence: number,
  taskId: TaskId,
  sessionId: SessionId,
  status: TerminalAgentSessionStatus,
  reason?: string,
): EventEnvelope<"SessionEnded"> {
  return build(
    ctx,
    sequence,
    "SessionEnded",
    { status, ...(reason === undefined ? {} : { reason }) },
    { taskId, sessionId },
  );
}

export function llmStarted(
  ctx: EventContext,
  sequence: number,
  taskId: TaskId,
  sessionId: SessionId,
  providerId: string,
  modelId: string,
  messageCount = 2,
): EventEnvelope<"LLMRequestStarted"> {
  return build(
    ctx,
    sequence,
    "LLMRequestStarted",
    { providerId, modelId, messageCount },
    { taskId, sessionId },
  );
}

export function llmCompleted(
  ctx: EventContext,
  sequence: number,
  taskId: TaskId,
  sessionId: SessionId,
  input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly usage: AIUsage;
    readonly latencyMs: number;
    readonly retry?: number;
    readonly escalated?: boolean;
  },
): EventEnvelope<"LLMRequestCompleted"> {
  return build(
    ctx,
    sequence,
    "LLMRequestCompleted",
    {
      providerId: input.providerId,
      modelId: input.modelId,
      usage: input.usage,
      latencyMs: input.latencyMs,
      retry: input.retry ?? 0,
      escalated: input.escalated ?? false,
    },
    { taskId, sessionId },
  );
}

export function toolStarted(
  ctx: EventContext,
  sequence: number,
  taskId: TaskId,
  sessionId: SessionId,
  toolId: string,
  operation: OperationKind = "read",
): EventEnvelope<"ToolCallStarted"> {
  return build(
    ctx,
    sequence,
    "ToolCallStarted",
    { toolId, operation },
    { taskId, sessionId },
  );
}

export function toolCompleted(
  ctx: EventContext,
  sequence: number,
  taskId: TaskId,
  sessionId: SessionId,
  toolId: string,
  ok = true,
  latencyMs?: number,
): EventEnvelope<"ToolCallCompleted"> {
  return build(
    ctx,
    sequence,
    "ToolCallCompleted",
    {
      toolId,
      ok,
      ...(latencyMs === undefined ? {} : { latencyMs }),
    },
    { taskId, sessionId },
  );
}

export function testCompleted(
  ctx: EventContext,
  sequence: number,
  taskId: TaskId,
  sessionId: SessionId,
  suite: string,
  passed: number,
  failed: number,
  durationMs?: number,
): EventEnvelope<"TestCompleted"> {
  return build(
    ctx,
    sequence,
    "TestCompleted",
    {
      suite,
      passed,
      failed,
      ...(durationMs === undefined ? {} : { durationMs }),
    },
    { taskId, sessionId },
  );
}

export function decisionRequested(
  ctx: EventContext,
  sequence: number,
  taskId: TaskId,
  kind: DecisionKind,
  question: string,
  optionCount = 2,
): EventEnvelope<"DecisionRequested"> {
  return build(
    ctx,
    sequence,
    "DecisionRequested",
    { kind, question, optionCount },
    { taskId },
  );
}

export function decisionCompleted(
  ctx: EventContext,
  sequence: number,
  taskId: TaskId,
  input: {
    readonly decisionId: string;
    readonly kind: DecisionKind;
    readonly outcome: ResolvedDecisionOutcome;
    readonly decidedBy: DecidedBy;
    readonly selectedOptionId?: string;
    readonly latencyMs?: number;
  },
): EventEnvelope<"DecisionCompleted"> {
  return build(
    ctx,
    sequence,
    "DecisionCompleted",
    {
      decisionId: input.decisionId,
      kind: input.kind,
      outcome: input.outcome,
      decidedBy: input.decidedBy,
      ...(input.selectedOptionId === undefined
        ? {}
        : { selectedOptionId: input.selectedOptionId }),
      ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
    },
    { taskId },
  );
}

export function approvalRequested(
  ctx: EventContext,
  sequence: number,
  taskId: TaskId,
  requestId: string,
  riskLevel: RiskLevel = "high",
): EventEnvelope<"HumanApprovalRequested"> {
  return build(
    ctx,
    sequence,
    "HumanApprovalRequested",
    { requestId, riskLevel },
    { taskId },
  );
}

export function approvalGranted(
  ctx: EventContext,
  sequence: number,
  taskId: TaskId,
  requestId: string,
  approver = "maintainer",
  riskLevel: RiskLevel = "high",
): EventEnvelope<"HumanApprovalGranted"> {
  return build(
    ctx,
    sequence,
    "HumanApprovalGranted",
    { requestId, approver, riskLevel },
    { taskId },
  );
}
