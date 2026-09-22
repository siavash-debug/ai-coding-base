import type { Clock } from "../core/clock.js";
import {
  type DecisionId,
  type IdFactory,
  type ProjectId,
  type SessionId,
  type TaskId,
  type WorkspaceId,
  decisionId as toDecisionId,
} from "../core/ids.js";
import type { EventActor } from "../observability/events.js";
import {
  type CreateDecisionInput,
  type Decision,
  type DecisionResolution,
  createDecision,
  resolveDecision,
} from "../decisions/decision.js";
import { type EventRecorder, taskCorrelationId } from "./event-recorder.js";

/**
 * Decision use case.
 *
 * A decision is recorded twice on purpose: once when the question is asked
 * (`DecisionRequested`) and once when it is answered (`DecisionCompleted`). That
 * is what makes "which layer decided this, and how long did it take" answerable
 * from the log alone, and it is why `Decision` is created `pending` and resolved
 * exactly once (ADR-003).
 */
export const DECISION_ACTOR: EventActor = {
  type: "code",
  id: "decision-service",
};

export interface DecisionContext {
  readonly workspaceId: WorkspaceId;
  readonly taskId?: TaskId;
  readonly sessionId?: SessionId;
  readonly correlationId?: string;
}

export interface DecisionService {
  /** Records the question and returns a pending decision. */
  ask(input: CreateDecisionInput, context: DecisionContext): Promise<Decision>;
  /** Records the answer. A decision can only be resolved once. */
  resolve(
    decision: Decision,
    resolution: DecisionResolution,
    context: DecisionContext,
  ): Promise<Decision>;
  /** `ask` + `resolve` for a decision answered immediately. */
  record(
    question: CreateDecisionInput,
    resolution: DecisionResolution,
    context: DecisionContext,
  ): Promise<Decision>;
}

export interface DecisionServiceDeps {
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly projectId: ProjectId;
  readonly decisionIds: IdFactory;
}

export function createDecisionService(
  deps: DecisionServiceDeps,
): DecisionService {
  function correlationFor(
    context: DecisionContext,
    taskId: TaskId | undefined,
  ): string | undefined {
    if (context.correlationId !== undefined) {
      return context.correlationId;
    }
    if (taskId === undefined) {
      return undefined;
    }
    return taskCorrelationId(deps.projectId, context.workspaceId, taskId);
  }

  async function ask(
    input: CreateDecisionInput,
    context: DecisionContext,
  ): Promise<Decision> {
    // Scope comes from the context unless the question names it explicitly. This
    // matters: a decision recorded without a taskId is invisible to that task's
    // trace, so the fallback is what keeps Task -> Decision unbroken.
    const taskId = input.taskId ?? context.taskId;
    const sessionId = input.sessionId ?? context.sessionId;
    const decision = createDecision(
      {
        ...input,
        ...(taskId === undefined ? {} : { taskId }),
        ...(sessionId === undefined ? {} : { sessionId }),
      },
      {
        id: toDecisionId(deps.decisionIds.next()),
        projectId: deps.projectId,
        workspaceId: context.workspaceId,
        clock: deps.clock,
      },
    );
    const correlationId = correlationFor(context, decision.taskId);
    await deps.recorder.emit({
      type: "DecisionRequested",
      workspaceId: context.workspaceId,
      actor: DECISION_ACTOR,
      ...(decision.taskId === undefined ? {} : { taskId: decision.taskId }),
      ...(decision.sessionId === undefined
        ? {}
        : { sessionId: decision.sessionId }),
      ...(correlationId === undefined ? {} : { correlationId }),
      payload: {
        kind: decision.kind,
        question: decision.question,
        optionCount: decision.options.length,
        // Recorded since Phase G. The id makes request/answer pairing exact rather
        // than by kind-and-order, and the candidate ids make "what was on the
        // table?" reconstructable from the log alone.
        decisionId: decision.id,
        optionIds: decision.options.map((option) => option.id),
        ...(input.reasonCodes === undefined
          ? {}
          : { reasonCodes: [...input.reasonCodes] }),
      },
    });
    return decision;
  }

  async function resolve(
    decision: Decision,
    resolution: DecisionResolution,
    context: DecisionContext,
  ): Promise<Decision> {
    const resolved = resolveDecision(decision, resolution, deps.clock);
    const correlationId = correlationFor(context, resolved.taskId);
    await deps.recorder.emit({
      type: "DecisionCompleted",
      workspaceId: context.workspaceId,
      actor: DECISION_ACTOR,
      ...(resolved.taskId === undefined ? {} : { taskId: resolved.taskId }),
      ...(resolved.sessionId === undefined
        ? {}
        : { sessionId: resolved.sessionId }),
      ...(correlationId === undefined ? {} : { correlationId }),
      payload: {
        decisionId: resolved.id as DecisionId,
        kind: resolved.kind,
        outcome: resolution.outcome,
        decidedBy: resolution.decidedBy,
        ...(resolved.selectedOptionId === undefined
          ? {}
          : { selectedOptionId: resolved.selectedOptionId }),
        ...(resolved.latencyMs === undefined
          ? {}
          : { latencyMs: resolved.latencyMs }),
        // Phase G fields. This is the *only* place a `DecisionCompleted` is written:
        // the coordinator records the extra failure and fallback events, and asks here
        // for the answer, so a decision never produces two completion events.
        ...(resolved.answeredBy === undefined
          ? {}
          : { answeredBy: resolved.answeredBy }),
        ...(resolved.providerId === undefined
          ? {}
          : { providerId: resolved.providerId }),
        ...(resolved.modelId === undefined
          ? {}
          : { modelId: resolved.modelId }),
        ...(resolved.reasonCode === undefined
          ? {}
          : { reasonCode: resolved.reasonCode }),
        ...(resolved.confidence === undefined
          ? {}
          : { confidence: resolved.confidence }),
        ...(resolved.ranking === undefined
          ? {}
          : { ranking: resolved.ranking }),
        ...(resolved.fallback === undefined
          ? {}
          : { fallbackReason: resolved.fallback.reason }),
        ...(resolved.usage === undefined ? {} : { usage: resolved.usage }),
        ...(resolved.usageReported === undefined
          ? {}
          : { usageReported: resolved.usageReported }),
        ...(resolved.costMicros === undefined
          ? {}
          : { costMicros: resolved.costMicros }),
        ...(resolved.executionSource === undefined
          ? {}
          : { executionSource: resolved.executionSource }),
      },
    });
    return resolved;
  }

  return {
    ask,
    resolve,
    async record(question, resolution, context) {
      return resolve(await ask(question, context), resolution, context);
    },
  };
}
