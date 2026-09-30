import { type Clock, toIsoString } from "../core/clock.js";
import { DomainError } from "../core/errors.js";
import type { ProjectId, SessionId, TaskId, WorkspaceId } from "../core/ids.js";
import { assertNonEmptyString, assertOneOf } from "../core/validation.js";
import type { Task } from "../tasks/task.js";

/**
 * AgentSession: one bounded attempt to advance a task.
 *
 * Counters are a PROJECTION of the session's events and must be recomputable from
 * them. They exist for cheap reads, never as the source of truth.
 * See docs/architecture/V2-ARCHITECTURE.md §7.
 */
export const AGENT_SESSION_STATUSES = [
  "active",
  "completed",
  "failed",
  "aborted",
] as const;

export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

export type TerminalAgentSessionStatus = Exclude<AgentSessionStatus, "active">;

export const TERMINAL_AGENT_SESSION_STATUSES = [
  "completed",
  "failed",
  "aborted",
] as const satisfies readonly TerminalAgentSessionStatus[];

export interface AgentSession {
  readonly id: SessionId;
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly agentId: string;
  readonly providerIds: readonly string[];
  readonly modelIds: readonly string[];
  readonly status: AgentSessionStatus;
  readonly iteration: number;
  readonly llmCalls: number;
  readonly toolCalls: number;
  readonly startedAt: string;
  readonly endedAt?: string;
}

export interface CreateAgentSessionInput {
  readonly agentId: string;
  readonly providerIds?: readonly string[];
  readonly modelIds?: readonly string[];
}

export function createAgentSession(
  input: CreateAgentSessionInput,
  options: {
    readonly id: SessionId;
    readonly task: Task;
    readonly clock: Clock;
  },
): AgentSession {
  const agentId = assertNonEmptyString(input.agentId, "agentId");
  const providerIds = (input.providerIds ?? []).map((providerId, index) =>
    assertNonEmptyString(providerId, `providerIds[${index}]`),
  );
  const modelIds = (input.modelIds ?? []).map((modelId, index) =>
    assertNonEmptyString(modelId, `modelIds[${index}]`),
  );

  return {
    id: options.id,
    taskId: options.task.id,
    projectId: options.task.projectId,
    workspaceId: options.task.workspaceId,
    agentId,
    providerIds,
    modelIds,
    status: "active",
    iteration: 0,
    llmCalls: 0,
    toolCalls: 0,
    startedAt: toIsoString(options.clock.now()),
  };
}

export function isSessionActive(session: AgentSession): boolean {
  return session.status === "active";
}

export function assertSessionActive(session: AgentSession): void {
  if (!isSessionActive(session)) {
    throw new DomainError(
      "INVARIANT",
      `session "${session.id}" is ${session.status} and cannot record more activity`,
      { field: "session.status" },
    );
  }
}

/** One turn of the agent loop. */
export function recordIteration(session: AgentSession): AgentSession {
  assertSessionActive(session);
  return { ...session, iteration: session.iteration + 1 };
}

export function recordLlmCall(
  session: AgentSession,
  call: {
    readonly providerId: string;
    readonly modelId: string;
  },
): AgentSession {
  assertSessionActive(session);
  const providerId = assertNonEmptyString(call.providerId, "providerId");
  const modelId = assertNonEmptyString(call.modelId, "modelId");
  return {
    ...session,
    llmCalls: session.llmCalls + 1,
    providerIds: session.providerIds.includes(providerId)
      ? session.providerIds
      : [...session.providerIds, providerId],
    modelIds: session.modelIds.includes(modelId)
      ? session.modelIds
      : [...session.modelIds, modelId],
  };
}

export function recordToolCall(session: AgentSession): AgentSession {
  assertSessionActive(session);
  return { ...session, toolCalls: session.toolCalls + 1 };
}

export function endAgentSession(
  session: AgentSession,
  status: TerminalAgentSessionStatus,
  clock: Clock,
): AgentSession {
  assertSessionActive(session);
  const terminal = assertOneOf(
    status,
    TERMINAL_AGENT_SESSION_STATUSES,
    "status",
  );
  return {
    ...session,
    status: terminal,
    endedAt: toIsoString(clock.now()),
  };
}
