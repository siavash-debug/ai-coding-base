import { type Clock, toIsoString } from "../core/clock.js";
import { DomainError } from "../core/errors.js";
import type {
  EventId,
  ProjectId,
  SessionId,
  TaskId,
  WorkspaceId,
} from "../core/ids.js";
import {
  assertIsoTimestamp,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertOneOf,
  assertStringArray,
  containsSecretLikeValue,
} from "../core/validation.js";
import { CONTEXT_EXCLUSION_REASONS } from "../context/selection.js";
import {
  DECIDED_BY,
  DECISION_KINDS,
  type DecidedBy,
  type DecisionKind,
  RESOLVED_DECISION_OUTCOMES,
  type ResolvedDecisionOutcome,
} from "../decisions/decision.js";
import {
  OPERATION_KINDS,
  type OperationKind,
  RISK_LEVELS,
  type RiskLevel,
} from "../decisions/risk.js";
import {
  LLM_FAILURE_KINDS,
  type LlmFailureKind,
} from "../ports/llm-provider.js";
import {
  TERMINAL_AGENT_SESSION_STATUSES,
  type TerminalAgentSessionStatus,
} from "../sessions/agent-session.js";
import { TASK_STATUSES, type TaskStatus } from "../tasks/lifecycle.js";
import { type AIUsage, assertValidUsage } from "./usage.js";

/**
 * The event log is the single source of observability truth: traces, token and
 * cost ledgers, metrics and replay are all projections over it.
 *
 * Payloads carry metadata and references — never secrets, never raw prompts.
 * See docs/architecture/V2-ARCHITECTURE.md §17 and DECISIONS.md ADR-006.
 */
export const EVENT_TYPES = [
  "TaskCreated",
  "TaskStatusChanged",
  "TaskStarted",
  "TaskCompleted",
  "TaskFailed",
  "SessionStarted",
  "SessionEnded",
  "ContextSelectionStarted",
  "ContextSelected",
  "DecisionRequested",
  "DecisionCompleted",
  "LLMRequestStarted",
  "LLMRequestCompleted",
  "LLMRequestFailed",
  "ToolCallStarted",
  "ToolCallCompleted",
  "TestStarted",
  "TestCompleted",
  "CheckpointCreated",
  "HumanApprovalRequested",
  "HumanApprovalGranted",
  "HumanApprovalConsumed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const ACTOR_TYPES = [
  "human",
  "agent",
  "code",
  "decision-provider",
  "llm",
  "system",
] as const;

export type ActorType = (typeof ACTOR_TYPES)[number];

export interface EventActor {
  readonly type: ActorType;
  readonly id: string;
}

export const CHECKPOINT_REASONS = [
  "budget-critical",
  "approval-requested",
  "iteration-limit",
  "manual",
  "before-destructive-op",
] as const;

export type CheckpointReason = (typeof CHECKPOINT_REASONS)[number];

export interface EventPayloadMap {
  TaskCreated: {
    readonly title: string;
    readonly riskLevel: RiskLevel;
    readonly workspaceId: WorkspaceId;
  };
  TaskStatusChanged: {
    readonly from: TaskStatus;
    readonly to: TaskStatus;
  };
  TaskStarted: {
    readonly title: string;
    readonly riskLevel: RiskLevel;
    readonly workspaceId: WorkspaceId;
  };
  SessionStarted: {
    readonly agentId: string;
    readonly providerIds: readonly string[];
    readonly modelIds: readonly string[];
  };
  SessionEnded: {
    readonly status: TerminalAgentSessionStatus;
    readonly reason?: string;
  };
  TaskCompleted: {
    readonly acceptanceCriteriaMet: number;
    readonly acceptanceCriteriaTotal: number;
    readonly reason?: string;
  };
  TaskFailed: {
    readonly reason: string;
    readonly acceptanceCriteriaMet: number;
    readonly acceptanceCriteriaTotal: number;
  };
  ContextSelectionStarted: {
    readonly selectionId: string;
    readonly strategy: string;
    readonly selectionVersion: number;
    readonly budgetTokens: number;
    readonly configFingerprint: string;
  };
  ContextSelected: {
    readonly selectionId: string;
    readonly strategy: string;
    readonly selectionVersion: number;
    readonly configFingerprint: string;
    readonly budgetTokens: number;
    readonly candidateTokens: number;
    readonly selectedTokens: number;
    readonly excludedTokens: number;
    readonly remainingTokens: number;
    readonly mandatoryTokens: number;
    readonly considered: number;
    readonly filteredByScore: number;
    readonly excludedByRules: number;
    readonly budgetExceeded: boolean;
    readonly overBudgetTokens: number;
    readonly durationMs: number;
    readonly capabilities: readonly string[];
    readonly unavailableCapabilities: readonly string[];
    readonly selectedRefs: readonly ContextSelectionRefPayload[];
    readonly excludedRefs: readonly ContextExclusionRefPayload[];
    /** True when the ref lists were capped before being recorded. */
    readonly refsTruncated: boolean;
  };
  DecisionRequested: {
    readonly kind: DecisionKind;
    readonly question: string;
    readonly optionCount: number;
  };
  DecisionCompleted: {
    readonly decisionId: string;
    readonly kind: DecisionKind;
    readonly outcome: ResolvedDecisionOutcome;
    readonly decidedBy: DecidedBy;
    readonly selectedOptionId?: string;
    readonly latencyMs?: number;
  };
  LLMRequestStarted: {
    readonly providerId: string;
    readonly modelId: string;
    readonly messageCount: number;
    /**
     * The context selection this call's prompt was built from, when one was used.
     * A reference, not the content: it is what lets a later question — "how many
     * tokens did this context decision cost?" — be answered from the log alone.
     */
    readonly contextSelectionId?: string;
    readonly contextSelectionVersion?: number;
    readonly contextSelectedTokens?: number;
  };
  LLMRequestCompleted: {
    readonly providerId: string;
    readonly modelId: string;
    /** Zeroes when `usageReported` is false; the flag is the honest signal. */
    readonly usage: AIUsage;
    /**
     * False when the provider reported no usage. Defaults to true for events
     * written before this field existed. A false value makes cost incomplete;
     * it never means "free".
     */
    readonly usageReported?: boolean;
    /** Transport attempts spent, including the successful one. */
    readonly attempts?: number;
    /** The provider's own request id, when it supplies one. */
    readonly requestId?: string;
    readonly latencyMs: number;
    readonly retry: number;
    readonly escalated: boolean;
  };
  LLMRequestFailed: {
    readonly providerId: string;
    readonly modelId: string;
    /**
     * Why it failed, as a category. The vendor's own message is deliberately not
     * recorded: error strings are a common way for a credential to reach a log.
     */
    readonly failureKind: LlmFailureKind;
    readonly attempts: number;
    readonly retryable: boolean;
    readonly statusCode?: number;
    /** How long was spent before giving up, when it was measured. */
    readonly latencyMs?: number;
  };
  ToolCallStarted: {
    readonly toolId: string;
    readonly operation?: OperationKind;
  };
  ToolCallCompleted: {
    readonly toolId: string;
    readonly ok: boolean;
    readonly operation?: OperationKind;
    readonly latencyMs?: number;
  };
  TestStarted: {
    readonly suite: string;
  };
  TestCompleted: {
    readonly suite: string;
    readonly passed: number;
    readonly failed: number;
    readonly durationMs?: number;
  };
  CheckpointCreated: {
    readonly checkpointId: string;
    readonly reason: CheckpointReason;
    readonly eventSequence: number;
  };
  HumanApprovalRequested: {
    readonly requestId: string;
    readonly operation?: OperationKind;
    readonly riskLevel: RiskLevel;
  };
  HumanApprovalGranted: {
    readonly requestId: string;
    readonly approver: string;
    readonly operation?: OperationKind;
    readonly riskLevel: RiskLevel;
    /** When the grant stops being valid. Absent means it does not expire. */
    readonly expiresAt?: string;
  };
  HumanApprovalConsumed: {
    readonly requestId: string;
    readonly riskLevel: RiskLevel;
    readonly operation?: OperationKind;
  };
}

export type EventPayload<K extends EventType> = EventPayloadMap[K];

/**
 * One selected context candidate, as recorded.
 *
 * This is the *metadata* half of a selection. The file's text is not here and
 * cannot be: reasons are reason codes, `ref` is a workspace-relative path, and
 * every field is either a counter or an identifier (ADR-039, ADR-041).
 */
export interface ContextSelectionRefPayload {
  readonly candidateId: string;
  readonly kind: string;
  readonly ref: string;
  readonly tokens: number;
  readonly basis: "size" | "content";
  readonly score: number;
  readonly reasons: readonly string[];
  readonly mandatory: boolean;
}

/** One excluded candidate, with the single reason it was dropped. */
export interface ContextExclusionRefPayload {
  readonly candidateId: string;
  readonly kind: string;
  readonly ref: string;
  readonly tokens: number;
  readonly score: number;
  readonly reason: string;
}

export interface EventEnvelope<
  K extends EventType = EventType,
  P = EventPayloadMap[K],
> {
  readonly schemaVersion: 1;
  readonly id: EventId;
  readonly type: K;
  readonly occurredAt: string;
  /** Monotonic per stream. Replay orders by this, never by wall-clock alone. */
  readonly sequence: number;
  readonly actor: EventActor;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly taskId?: TaskId;
  readonly sessionId?: SessionId;
  readonly correlationId?: string;
  readonly payload: P;
}

export type DomainEvent = { [K in EventType]: EventEnvelope<K> }[EventType];

export interface CreateEventInput<K extends EventType> {
  readonly type: K;
  readonly actor: EventActor;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly taskId?: TaskId;
  readonly sessionId?: SessionId;
  readonly correlationId?: string;
  readonly payload: EventPayloadMap[K];
}

type PayloadFieldKind =
  | "string"
  | "number"
  | "boolean"
  | "string[]"
  | "usage"
  | "risk"
  | "operation"
  | "decisionKind"
  | "decidedBy"
  | "decisionOutcome"
  | "checkpointReason"
  | "taskStatus"
  | "sessionStatus"
  | "failureKind"
  | "timestamp"
  | "selectionRefs"
  | "selectionExclusions";

interface PayloadFieldRule {
  readonly name: string;
  readonly kind: PayloadFieldKind;
  readonly optional?: boolean;
}

const text = (name: string, optional = false): PayloadFieldRule => ({
  name,
  kind: "string",
  optional,
});
const count = (name: string, optional = false): PayloadFieldRule => ({
  name,
  kind: "number",
  optional,
});
const flag = (name: string, optional = false): PayloadFieldRule => ({
  name,
  kind: "boolean",
  optional,
});
const refs = (name: string): PayloadFieldRule => ({ name, kind: "string[]" });
const enumField = (
  name: string,
  kind: PayloadFieldKind,
  optional = false,
): PayloadFieldRule => ({ name, kind, optional });

/**
 * Declared payload schema per event type. Validated at construction so a
 * malformed event fails immediately rather than at read time.
 */
const EVENT_PAYLOAD_RULES: Readonly<
  Record<EventType, readonly PayloadFieldRule[]>
> = {
  TaskCreated: [
    text("title"),
    enumField("riskLevel", "risk"),
    text("workspaceId"),
  ],
  TaskStatusChanged: [
    enumField("from", "taskStatus"),
    enumField("to", "taskStatus"),
  ],
  SessionStarted: [text("agentId"), refs("providerIds"), refs("modelIds")],
  SessionEnded: [enumField("status", "sessionStatus"), text("reason", true)],
  TaskStarted: [
    text("title"),
    enumField("riskLevel", "risk"),
    text("workspaceId"),
  ],
  TaskCompleted: [
    count("acceptanceCriteriaMet"),
    count("acceptanceCriteriaTotal"),
    text("reason", true),
  ],
  TaskFailed: [
    text("reason"),
    count("acceptanceCriteriaMet"),
    count("acceptanceCriteriaTotal"),
  ],
  ContextSelectionStarted: [
    text("selectionId"),
    text("strategy"),
    count("selectionVersion"),
    count("budgetTokens"),
    text("configFingerprint"),
  ],
  ContextSelected: [
    text("selectionId"),
    text("strategy"),
    count("selectionVersion"),
    text("configFingerprint"),
    count("budgetTokens"),
    count("candidateTokens"),
    count("selectedTokens"),
    count("excludedTokens"),
    count("remainingTokens"),
    count("mandatoryTokens"),
    count("considered"),
    count("filteredByScore"),
    count("excludedByRules"),
    flag("budgetExceeded"),
    count("overBudgetTokens"),
    count("durationMs"),
    refs("capabilities"),
    refs("unavailableCapabilities"),
    enumField("selectedRefs", "selectionRefs"),
    enumField("excludedRefs", "selectionExclusions"),
    flag("refsTruncated"),
  ],
  DecisionRequested: [
    enumField("kind", "decisionKind"),
    text("question"),
    count("optionCount"),
  ],
  DecisionCompleted: [
    text("decisionId"),
    enumField("kind", "decisionKind"),
    enumField("outcome", "decisionOutcome"),
    enumField("decidedBy", "decidedBy"),
    text("selectedOptionId", true),
    count("latencyMs", true),
  ],
  LLMRequestStarted: [
    text("providerId"),
    text("modelId"),
    count("messageCount"),
    text("contextSelectionId", true),
    count("contextSelectionVersion", true),
    count("contextSelectedTokens", true),
  ],
  LLMRequestCompleted: [
    text("providerId"),
    text("modelId"),
    { name: "usage", kind: "usage" },
    flag("usageReported", true),
    count("attempts", true),
    text("requestId", true),
    count("latencyMs"),
    count("retry"),
    flag("escalated"),
  ],
  LLMRequestFailed: [
    text("providerId"),
    text("modelId"),
    enumField("failureKind", "failureKind"),
    count("attempts"),
    flag("retryable"),
    count("statusCode", true),
    count("latencyMs", true),
  ],
  ToolCallStarted: [text("toolId"), enumField("operation", "operation", true)],
  ToolCallCompleted: [
    text("toolId"),
    flag("ok"),
    enumField("operation", "operation", true),
    count("latencyMs", true),
  ],
  TestStarted: [text("suite")],
  TestCompleted: [
    text("suite"),
    count("passed"),
    count("failed"),
    count("durationMs", true),
  ],
  CheckpointCreated: [
    text("checkpointId"),
    enumField("reason", "checkpointReason"),
    count("eventSequence"),
  ],
  HumanApprovalRequested: [
    text("requestId"),
    enumField("operation", "operation", true),
    enumField("riskLevel", "risk"),
  ],
  HumanApprovalGranted: [
    text("requestId"),
    text("approver"),
    enumField("operation", "operation", true),
    enumField("riskLevel", "risk"),
    enumField("expiresAt", "timestamp", true),
  ],
  HumanApprovalConsumed: [
    text("requestId"),
    enumField("riskLevel", "risk"),
    enumField("operation", "operation", true),
  ],
};

/** Schema guard: a selection's ref lists are bounded, so the log cannot balloon. */
export const MAX_RECORDED_SELECTION_REFS = 1_024;

export const CONTEXT_REF_BASES = ["size", "content"] as const;

function assertRefList(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new DomainError("VALIDATION", `${field} must be an array`, { field });
  }
  if (value.length > MAX_RECORDED_SELECTION_REFS) {
    throw new DomainError(
      "VALIDATION",
      `${field} must carry at most ${MAX_RECORDED_SELECTION_REFS} entries`,
      { field },
    );
  }
  return value;
}

/**
 * Validated field by field rather than accepted as `unknown`.
 *
 * A context selection is the one artefact a later evaluation harness will compare
 * across runs, so its shape is a contract: a hand-edited or corrupted log must fail
 * here rather than produce a trace with a score of `"high"` in it.
 */
function validateSelectionRefs(value: unknown, field: string): void {
  assertRefList(value, field).forEach((entry, index) => {
    const at = `${field}[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new DomainError("VALIDATION", `${at} must be an object`, {
        field: at,
      });
    }
    const record = entry as Record<string, unknown>;
    assertNoSecret(
      assertNonEmptyString(record["candidateId"], `${at}.candidateId`),
      `${at}.candidateId`,
    );
    assertNonEmptyString(record["kind"], `${at}.kind`);
    assertNoSecret(
      assertNonEmptyString(record["ref"], `${at}.ref`),
      `${at}.ref`,
    );
    assertNonNegativeInteger(record["tokens"], `${at}.tokens`);
    assertOneOf(record["basis"], CONTEXT_REF_BASES, `${at}.basis`);
    assertNonNegativeInteger(record["score"], `${at}.score`);
    assertStringArray(record["reasons"], `${at}.reasons`).forEach((reason) =>
      assertNoSecret(reason, `${at}.reasons`),
    );
    if (typeof record["mandatory"] !== "boolean") {
      throw new DomainError("VALIDATION", `${at}.mandatory must be a boolean`, {
        field: `${at}.mandatory`,
      });
    }
  });
}

function validateSelectionExclusions(value: unknown, field: string): void {
  assertRefList(value, field).forEach((entry, index) => {
    const at = `${field}[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new DomainError("VALIDATION", `${at} must be an object`, {
        field: at,
      });
    }
    const record = entry as Record<string, unknown>;
    assertNoSecret(
      assertNonEmptyString(record["candidateId"], `${at}.candidateId`),
      `${at}.candidateId`,
    );
    assertNonEmptyString(record["kind"], `${at}.kind`);
    assertNoSecret(
      assertNonEmptyString(record["ref"], `${at}.ref`),
      `${at}.ref`,
    );
    assertNonNegativeInteger(record["tokens"], `${at}.tokens`);
    assertNonNegativeInteger(record["score"], `${at}.score`);
    assertOneOf(record["reason"], CONTEXT_EXCLUSION_REASONS, `${at}.reason`);
  });
}

function assertNoSecret(value: string, field: string): void {
  if (containsSecretLikeValue(value)) {
    throw new DomainError(
      "VALIDATION",
      `${field} appears to contain secret material; events record references, not secrets`,
      { field },
    );
  }
}

function validatePayload(type: EventType, payload: unknown): void {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new DomainError("VALIDATION", `${type} payload must be an object`, {
      field: "payload",
    });
  }
  const record = payload as Record<string, unknown>;
  for (const rule of EVENT_PAYLOAD_RULES[type]) {
    const field = `${type}.${rule.name}`;
    const value = record[rule.name];
    if (value === undefined) {
      if (rule.optional !== true) {
        throw new DomainError("VALIDATION", `${field} is required`, { field });
      }
      continue;
    }
    switch (rule.kind) {
      case "string":
        assertNoSecret(assertNonEmptyString(value, field), field);
        break;
      case "number":
        assertNonNegativeInteger(value, field);
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          throw new DomainError("VALIDATION", `${field} must be a boolean`, {
            field,
          });
        }
        break;
      case "string[]":
        assertStringArray(value, field).forEach((entry) =>
          assertNoSecret(entry, field),
        );
        break;
      case "usage":
        assertValidUsage(value, field);
        break;
      case "risk":
        assertOneOf(value, RISK_LEVELS, field);
        break;
      case "operation":
        assertOneOf(value, OPERATION_KINDS, field);
        break;
      case "decisionKind":
        assertOneOf(value, DECISION_KINDS, field);
        break;
      case "decidedBy":
        assertOneOf(value, DECIDED_BY, field);
        break;
      case "decisionOutcome":
        assertOneOf(value, RESOLVED_DECISION_OUTCOMES, field);
        break;
      case "checkpointReason":
        assertOneOf(value, CHECKPOINT_REASONS, field);
        break;
      case "taskStatus":
        assertOneOf(value, TASK_STATUSES, field);
        break;
      case "sessionStatus":
        assertOneOf(value, TERMINAL_AGENT_SESSION_STATUSES, field);
        break;
      case "failureKind":
        assertOneOf(value, LLM_FAILURE_KINDS, field);
        break;
      case "timestamp":
        assertIsoTimestamp(value, field);
        break;
      case "selectionRefs":
        validateSelectionRefs(value, field);
        break;
      case "selectionExclusions":
        validateSelectionExclusions(value, field);
        break;
    }
  }
}

export function createEvent<K extends EventType>(
  input: CreateEventInput<K>,
  options: {
    readonly id: EventId;
    readonly sequence: number;
    readonly clock: Clock;
  },
): EventEnvelope<K> {
  assertOneOf(input.type, EVENT_TYPES, "type");
  validatePayload(input.type, input.payload);
  const actorType = assertOneOf(input.actor.type, ACTOR_TYPES, "actor.type");
  const actorId = assertNonEmptyString(input.actor.id, "actor.id");
  const sequence = assertNonNegativeInteger(options.sequence, "sequence");

  return {
    schemaVersion: 1,
    id: options.id,
    type: input.type,
    occurredAt: toIsoString(options.clock.now()),
    sequence,
    actor: { type: actorType, id: actorId },
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: input.correlationId }),
    payload: input.payload,
  };
}

/** Next monotonic sequence for a stream. Starts at 1. */
export function nextSequence(
  events: readonly { readonly sequence: number }[],
): number {
  let highest = 0;
  for (const event of events) {
    if (event.sequence > highest) {
      highest = event.sequence;
    }
  }
  return highest + 1;
}

export function isEventOfType<K extends EventType>(
  event: EventEnvelope,
  type: K,
): event is EventEnvelope<K> {
  return event.type === type;
}

/**
 * Validates a value that came from outside the type system (a file, a network
 * peer, a plugin) and narrows it to a `DomainEvent`.
 *
 * Envelope AND payload are validated, because a hand-edited or corrupted event
 * log is untrusted input (AGENTS.md §3). Readers MUST use this rather than
 * casting parsed JSON.
 */
export function assertDomainEvent(value: unknown): DomainEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("VALIDATION", "event must be an object", {
      field: "event",
    });
  }
  const candidate = value as Record<string, unknown>;
  const schemaVersion = candidate["schemaVersion"];
  if (schemaVersion !== 1) {
    throw new DomainError(
      "VALIDATION",
      `unsupported event schemaVersion: ${String(schemaVersion)}`,
      { field: "event.schemaVersion" },
    );
  }
  assertNonEmptyString(candidate["id"], "event.id");
  const type = assertOneOf(candidate["type"], EVENT_TYPES, "event.type");
  assertIsoTimestamp(candidate["occurredAt"], "event.occurredAt");
  assertNonNegativeInteger(candidate["sequence"], "event.sequence");
  assertNonEmptyString(candidate["projectId"], "event.projectId");
  assertNonEmptyString(candidate["workspaceId"], "event.workspaceId");
  for (const optional of ["taskId", "sessionId", "correlationId"]) {
    const field = candidate[optional];
    if (field !== undefined) {
      assertNonEmptyString(field, `event.${optional}`);
    }
  }
  const actor = candidate["actor"];
  if (typeof actor !== "object" || actor === null) {
    throw new DomainError("VALIDATION", "event.actor must be an object", {
      field: "event.actor",
    });
  }
  const actorRecord = actor as Record<string, unknown>;
  assertOneOf(actorRecord["type"], ACTOR_TYPES, "event.actor.type");
  assertNonEmptyString(actorRecord["id"], "event.actor.id");

  validatePayload(type, candidate["payload"]);
  return candidate as unknown as DomainEvent;
}

export function isDomainEvent(value: unknown): value is DomainEvent {
  try {
    assertDomainEvent(value);
    return true;
  } catch {
    return false;
  }
}

export function isTaskScopedEvent(event: EventEnvelope): boolean {
  return event.taskId !== undefined;
}

/**
 * Traceability invariant: an event emitted while a task is in scope must carry
 * its `taskId`, and `sessionId` when a session is active, so that
 * Task -> Session -> Decision/LLM/Tool/Test -> Event is an unbroken chain.
 */
export function assertTaskScopedEvent(event: EventEnvelope): void {
  if (event.taskId === undefined) {
    throw new DomainError(
      "INVARIANT",
      `event "${event.type}" is task-scoped and must carry a taskId`,
      { field: "taskId", type: event.type },
    );
  }
}
