import type { Clock } from "../core/clock.js";
import { type IdFactory, sessionId as toSessionId } from "../core/ids.js";
import type { EventActor } from "../observability/events.js";
import type { AIUsage } from "../observability/usage.js";
import type { OperationKind } from "../decisions/risk.js";
import { type LlmFailureKind } from "../ports/llm-provider.js";
import {
  type AgentSession,
  type TerminalAgentSessionStatus,
  createAgentSession,
  endAgentSession,
  recordIteration as recordIterationIn,
  recordLlmCall as recordLlmCallIn,
  recordToolCall as recordToolCallIn,
} from "../sessions/agent-session.js";
import type { Task } from "../tasks/task.js";
import { type EventRecorder, taskCorrelationId } from "./event-recorder.js";

/**
 * Agent session use case.
 *
 * One method per observable step. Every method updates the in-memory session
 * projection *and* appends the matching events, so the counters the runtime reads
 * and the numbers a trace reconstructs from the log always agree — a property the
 * tests assert directly.
 *
 * The session object is a convenience projection; the event log is the record. A
 * session that disappears mid-run can be reconstructed from its events alone
 * (V2-ARCHITECTURE §7).
 */
export const DEFAULT_AGENT_ID = "local-agent";

export interface SessionLlmCall {
  readonly providerId: string;
  readonly modelId: string;
  readonly messageCount: number;
  readonly usage: AIUsage;
  /** False when the provider reported no usage. */
  readonly usageReported: boolean;
  readonly latencyMs: number;
  /** 0 for the first attempt, 1 for the first retry, and so on. */
  readonly retry: number;
  readonly escalated: boolean;
  readonly attempts?: number;
  readonly requestId?: string;
  /** The context selection this prompt was built from, when there was one. */
  readonly contextSelectionId?: string;
  readonly contextSelectionVersion?: number;
  readonly contextSelectedTokens?: number;
}

export interface SessionToolCall {
  readonly toolId: string;
  readonly operation: OperationKind;
  readonly ok: boolean;
  readonly latencyMs: number;
}

/**
 * A model turn the provider did not complete.
 *
 * Recorded as `LLMRequestStarted` + `LLMRequestFailed`. A failure does not
 * increment the session's `llmCalls` or `iteration` counters: nothing was
 * produced, so counting it as a turn would overstate what the session achieved.
 * The failure is still counted — by `TaskMetrics.failedLlmCalls` — because a
 * failure that vanishes from the numbers is a failure nobody can see.
 */
export interface SessionLlmFailure {
  readonly providerId: string;
  readonly modelId: string;
  readonly messageCount: number;
  readonly failureKind: LlmFailureKind;
  readonly attempts: number;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly latencyMs?: number;
  /** A failed call still belongs to a selection, and the log should say so. */
  readonly contextSelectionId?: string;
  readonly contextSelectionVersion?: number;
  readonly contextSelectedTokens?: number;
}

export interface SessionTestRun {
  readonly suite: string;
  readonly passed: number;
  readonly failed: number;
  readonly durationMs: number;
}

export interface SessionService {
  start(
    task: Task,
    options?: { readonly agentId?: string },
  ): Promise<AgentSession>;
  end(
    session: AgentSession,
    status: TerminalAgentSessionStatus,
    reason?: string,
  ): Promise<AgentSession>;
  recordLlmCall(
    session: AgentSession,
    call: SessionLlmCall,
  ): Promise<AgentSession>;
  recordToolCall(
    session: AgentSession,
    call: SessionToolCall,
  ): Promise<AgentSession>;
  recordTestRun(
    session: AgentSession,
    run: SessionTestRun,
  ): Promise<AgentSession>;
  recordLlmFailure(
    session: AgentSession,
    failure: SessionLlmFailure,
  ): Promise<AgentSession>;
}

export interface SessionServiceDeps {
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly sessionIds: IdFactory;
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  function actorFor(session: AgentSession): EventActor {
    return { type: "agent", id: session.agentId };
  }

  function correlationFor(session: AgentSession): string {
    return taskCorrelationId(
      session.projectId,
      session.workspaceId,
      session.taskId,
    );
  }

  return {
    async start(task, options) {
      const session = createAgentSession(
        { agentId: options?.agentId ?? DEFAULT_AGENT_ID },
        { id: toSessionId(deps.sessionIds.next()), task, clock: deps.clock },
      );
      await deps.recorder.emit({
        type: "SessionStarted",
        workspaceId: session.workspaceId,
        actor: actorFor(session),
        taskId: session.taskId,
        sessionId: session.id,
        correlationId: correlationFor(session),
        payload: {
          agentId: session.agentId,
          providerIds: session.providerIds,
          modelIds: session.modelIds,
        },
      });
      return session;
    },

    async end(session, status, reason) {
      const ended = endAgentSession(session, status, deps.clock);
      await deps.recorder.emit({
        type: "SessionEnded",
        workspaceId: ended.workspaceId,
        actor: actorFor(ended),
        taskId: ended.taskId,
        sessionId: ended.id,
        correlationId: correlationFor(ended),
        payload: {
          status,
          ...(reason === undefined ? {} : { reason }),
        },
      });
      return ended;
    },

    async recordLlmCall(session, call) {
      // A non-retry call is a new model turn, which is what "iteration" means.
      const turned = call.retry === 0 ? recordIterationIn(session) : session;
      const updated = recordLlmCallIn(turned, {
        providerId: call.providerId,
        modelId: call.modelId,
      });
      const base = {
        workspaceId: updated.workspaceId,
        actor: actorFor(updated),
        taskId: updated.taskId,
        sessionId: updated.id,
        correlationId: correlationFor(updated),
      } as const;

      await deps.recorder.emit({
        ...base,
        type: "LLMRequestStarted",
        payload: {
          providerId: call.providerId,
          modelId: call.modelId,
          messageCount: call.messageCount,
          ...(call.contextSelectionId === undefined
            ? {}
            : { contextSelectionId: call.contextSelectionId }),
          ...(call.contextSelectionVersion === undefined
            ? {}
            : { contextSelectionVersion: call.contextSelectionVersion }),
          ...(call.contextSelectedTokens === undefined
            ? {}
            : { contextSelectedTokens: call.contextSelectedTokens }),
        },
      });
      await deps.recorder.emit({
        ...base,
        type: "LLMRequestCompleted",
        payload: {
          providerId: call.providerId,
          modelId: call.modelId,
          usage: call.usage,
          usageReported: call.usageReported,
          latencyMs: call.latencyMs,
          retry: call.retry,
          escalated: call.escalated,
          ...(call.attempts === undefined ? {} : { attempts: call.attempts }),
          ...(call.requestId === undefined
            ? {}
            : { requestId: call.requestId }),
        },
      });
      return updated;
    },

    async recordLlmFailure(session, failure) {
      const base = {
        workspaceId: session.workspaceId,
        actor: actorFor(session),
        taskId: session.taskId,
        sessionId: session.id,
        correlationId: correlationFor(session),
      } as const;

      await deps.recorder.emit({
        ...base,
        type: "LLMRequestStarted",
        payload: {
          providerId: failure.providerId,
          modelId: failure.modelId,
          messageCount: failure.messageCount,
          ...(failure.contextSelectionId === undefined
            ? {}
            : { contextSelectionId: failure.contextSelectionId }),
          ...(failure.contextSelectionVersion === undefined
            ? {}
            : { contextSelectionVersion: failure.contextSelectionVersion }),
          ...(failure.contextSelectedTokens === undefined
            ? {}
            : { contextSelectedTokens: failure.contextSelectedTokens }),
        },
      });
      await deps.recorder.emit({
        ...base,
        type: "LLMRequestFailed",
        payload: {
          providerId: failure.providerId,
          modelId: failure.modelId,
          failureKind: failure.failureKind,
          attempts: failure.attempts,
          retryable: failure.retryable,
          ...(failure.statusCode === undefined
            ? {}
            : { statusCode: failure.statusCode }),
          ...(failure.latencyMs === undefined
            ? {}
            : { latencyMs: failure.latencyMs }),
        },
      });
      return session;
    },

    async recordToolCall(session, call) {
      const updated = recordToolCallIn(session);
      const base = {
        workspaceId: updated.workspaceId,
        actor: actorFor(updated),
        taskId: updated.taskId,
        sessionId: updated.id,
        correlationId: correlationFor(updated),
      } as const;

      await deps.recorder.emit({
        ...base,
        type: "ToolCallStarted",
        payload: { toolId: call.toolId, operation: call.operation },
      });
      await deps.recorder.emit({
        ...base,
        type: "ToolCallCompleted",
        payload: {
          toolId: call.toolId,
          ok: call.ok,
          operation: call.operation,
          latencyMs: call.latencyMs,
        },
      });
      return updated;
    },

    async recordTestRun(session, run) {
      const base = {
        workspaceId: session.workspaceId,
        actor: actorFor(session),
        taskId: session.taskId,
        sessionId: session.id,
        correlationId: correlationFor(session),
      } as const;

      await deps.recorder.emit({
        ...base,
        type: "TestStarted",
        payload: { suite: run.suite },
      });
      await deps.recorder.emit({
        ...base,
        type: "TestCompleted",
        payload: {
          suite: run.suite,
          passed: run.passed,
          failed: run.failed,
          durationMs: run.durationMs,
        },
      });
      return session;
    },
  };
}
