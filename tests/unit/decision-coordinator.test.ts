import { afterEach, describe, expect, it } from "vitest";

import { createDecisionCoordinatorFactory } from "../../src/application/decision-coordinator.js";
import { createDecisionEngine } from "../../src/decisions/engine.js";
import { DECISION_LAYER_DISABLED_REASON } from "../../src/decisions/domains.js";
import type { DecisionProvider } from "../../src/decisions/provider.js";
import { createManualClock } from "../../src/core/clock.js";
import type { ModelRate } from "../../src/observability/cost.js";
import type { DomainEvent } from "../../src/observability/events.js";
import type { DecisionConfig } from "../../src/adapters/config/project-config.js";
import {
  createMetadataDecisionProvider,
  createScriptedDecisionProvider,
  decisionProviderFailure,
  DECISION_USAGE,
  SCRIPTED_TOOLS,
} from "../support/decisions.js";
import { FIXED_INSTANT, createTestProject } from "../support/project.js";
import type { TestProject } from "../support/project.js";

/**
 * The decision coordinator: where a bounded question becomes a recorded decision.
 *
 * Everything asserted here is observable from the event log, because that is the
 * point: "why did the system do that, and who decided" must be answerable without
 * trusting the process that did it. The budget tests matter most — a hard budget is
 * only hard if the provider is *not called* when it is exhausted, so those tests count
 * provider requests rather than inspecting a reported number.
 */

const projects: TestProject[] = [];

afterEach(async () => {
  await Promise.all(
    projects.splice(0).map(async (subject) => subject.cleanup()),
  );
});

async function project(provider?: DecisionProvider): Promise<TestProject> {
  const subject = await createTestProject({
    clock: createManualClock(FIXED_INSTANT),
    ...(provider === undefined ? {} : { decisionProvider: provider }),
  });
  projects.push(subject);
  return subject;
}

async function taskIn(subject: TestProject) {
  return await subject.runtime.tasks.create(
    {
      title: "Reduce the retry storm",
      description: "Bound retries and record why each one was allowed.",
      acceptanceCriteria: ["Retries are bounded"],
    },
    { project: subject.runtime.project, workspace: subject.runtime.workspace },
  );
}

function scopeOf(subject: TestProject) {
  return {
    projectId: subject.runtime.project.id,
    workspaceId: subject.runtime.workspace.id,
  };
}

/** The runtime's decisions service, recorder and store, re-composed with a chosen config. */
function coordinatorFor(
  subject: TestProject,
  input: {
    readonly provider?: DecisionProvider;
    /** The limits under test. Only the caps matter here; the provider is injected. */
    readonly config?: {
      readonly maxDecisionsPerTask?: number;
      readonly maxRetriesPerTask?: number;
      readonly maxDecisionCostMicrosPerTask?: number;
    };
    readonly rates?: readonly ModelRate[];
    readonly taskId?: string;
  },
) {
  const config: DecisionConfig = {
    provider: "disabled",
    maxDecisionsPerTask: 24,
    maxRetriesPerTask: 1,
    ...(input.config ?? {}),
  };
  const engine = createDecisionEngine({
    clock: createManualClock(FIXED_INSTANT),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
  });
  const factory = createDecisionCoordinatorFactory({
    engine,
    decisions: subject.runtime.decisions,
    recorder: subject.runtime.recorder,
    store: subject.runtime.store,
    clock: createManualClock(FIXED_INSTANT),
    config,
    rates: input.rates ?? subject.runtime.modelRates,
    projectId: subject.runtime.project.id,
  });
  return {
    info: factory.info,
    forAttempt: (scope: {
      readonly workspaceId: string;
      readonly taskId?: string;
    }) =>
      factory.forAttempt({
        workspaceId: scope.workspaceId as never,
        ...(scope.taskId === undefined
          ? {}
          : { taskId: scope.taskId as never }),
        correlationId: "corr-coordinator",
      }),
  };
}

const RATE: ModelRate = {
  providerId: "jev",
  modelId: "jev-1",
  currency: "USD",
  inputMicrosPerMillionTokens: 1_000_000,
  outputMicrosPerMillionTokens: 2_000_000,
  cachedInputMicrosPerMillionTokens: 500_000,
  effectiveFrom: FIXED_INSTANT,
};

function eventsOfType(events: readonly DomainEvent[], type: string) {
  return events.filter((event) => event.type === type);
}

describe("decision coordinator: recording", () => {
  it("records the question, the answer and which layer gave it", async () => {
    const provider = createMetadataDecisionProvider(
      [
        {
          metadata: {
            response: {
              outcome: "selected",
              optionId: "minimal",
              reasonCode: "narrow-scope-preferred",
              confidence: 0.7,
            },
            usage: DECISION_USAGE,
            modelId: "jev-1",
            requestId: "req-1",
          },
        },
      ],
      { id: "jev" },
    );
    const subject = await project(provider);
    const stored = await taskIn(subject);
    const coordinator = coordinatorFor(subject, { provider }).forAttempt({
      workspaceId: subject.runtime.workspace.id,
      taskId: stored.task.id,
    });

    const decision = await coordinator.route({
      taskRiskLevel: "medium",
      routes: ["standard", "minimal"],
    });
    expect(decision.routeId).toBe("minimal");
    expect(decision.meta.answeredBy).toBe("provider");
    expect(decision.meta.providerId).toBe("jev");
    expect(decision.meta.usageTokens).toBe(1020);

    const events = await subject.runtime.store.readByTask(
      scopeOf(subject),
      stored.task.id,
    );
    const requested = eventsOfType(events, "DecisionRequested");
    const completed = eventsOfType(events, "DecisionCompleted");
    expect(requested).toHaveLength(1);
    expect(completed).toHaveLength(1);
    // The request and the answer are paired by id, not by kind-and-order.
    const request = requested[0]!.payload as { decisionId: string };
    const answer = completed[0]!.payload as Record<string, unknown>;
    expect(answer["decisionId"]).toBe(request.decisionId);
    expect(answer["kind"]).toBe("routing");
    expect(answer["selectedOptionId"]).toBe("minimal");
    expect(answer["answeredBy"]).toBe("provider");
    expect(answer["providerId"]).toBe("jev");
    expect(answer["reasonCode"]).toBe("narrow-scope-preferred");
    expect(answer["confidence"]).toBe(0.7);
    expect(answer["usageReported"]).toBe(true);
    expect(answer["modelId"]).toBe("jev-1");
    // Unpriced here (no rate table was supplied), and recorded as unpriced rather
    // than as zero.
    expect(answer["costMicros"]).toBeUndefined();
  });

  it("prices a decision with the project's own rate table", async () => {
    const provider = createMetadataDecisionProvider(
      [
        {
          metadata: {
            response: { outcome: "selected", optionId: "minimal" },
            usage: {
              inputTokens: 1_000,
              outputTokens: 0,
              cachedInputTokens: 0,
            },
            modelId: "jev-1",
          },
        },
      ],
      { id: "jev" },
    );
    const subject = await project(provider);
    const stored = await taskIn(subject);
    const coordinator = coordinatorFor(subject, {
      provider,
      rates: [RATE],
    }).forAttempt({
      workspaceId: subject.runtime.workspace.id,
      taskId: stored.task.id,
    });
    await coordinator.route({
      taskRiskLevel: "medium",
      routes: ["standard", "minimal"],
    });

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    const recorded = trace.decisions.find(
      (decision) => decision.kind === "routing",
    );
    expect(recorded?.answeredBy).toBe("provider");
    // 1,000 input tokens at $1 per million tokens is $0.001.
    expect(recorded?.cost?.micros).toBe(1_000);
    expect(trace.metrics.decisionCost.micros).toBe(1_000);
    expect(trace.metrics.decisionCostComplete).toBe(true);
  });

  it("records a provider failure and the fallback that replaced it", async () => {
    const provider = createScriptedDecisionProvider([
      {
        error: decisionProviderFailure({
          failureKind: "timeout",
          providerId: "jev",
          retryable: true,
        }),
      },
    ]);
    const subject = await project(provider);
    const stored = await taskIn(subject);
    const coordinator = coordinatorFor(subject, { provider }).forAttempt({
      workspaceId: subject.runtime.workspace.id,
      taskId: stored.task.id,
    });
    const decision = await coordinator.route({
      taskRiskLevel: "medium",
      routes: ["standard", "minimal"],
    });

    // The attempt still gets an answer: a bounded question is never left unanswered
    // because the layer that was supposed to answer it broke.
    expect(decision.routeId).toBe("standard");
    expect(decision.meta.answeredBy).toBe("fallback");
    expect(decision.meta.fallbackReason).toBe("provider-timeout");

    const events = await subject.runtime.store.readByTask(
      scopeOf(subject),
      stored.task.id,
    );
    // One completion, not two: the recorder owns that event (ADR-003).
    expect(eventsOfType(events, "DecisionCompleted")).toHaveLength(1);
    expect(eventsOfType(events, "DecisionFailed")).toHaveLength(1);
    const fallback = eventsOfType(events, "DecisionFallbackUsed");
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.payload).toMatchObject({
      kind: "routing",
      reason: "provider-timeout",
      selectedOptionId: "standard",
    });

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.decisionFailures).toHaveLength(1);
    expect(trace.decisionFailures[0]).toMatchObject({
      kind: "routing",
      providerId: "jev",
      failureKind: "timeout",
    });
    expect(trace.metrics.decisions).toBe(1);
    expect(trace.metrics.decisionFallbacks).toBe(1);
    expect(trace.metrics.decisionFailures).toBe(1);
  });

  it("records an absent decision layer without pretending anything failed", async () => {
    const subject = await project();
    const stored = await taskIn(subject);
    const coordinator = coordinatorFor(subject, {}).forAttempt({
      workspaceId: subject.runtime.workspace.id,
      taskId: stored.task.id,
    });
    const decision = await coordinator.route({
      taskRiskLevel: "medium",
      routes: ["standard", "minimal"],
    });
    expect(decision.routeId).toBe("standard");
    expect(decision.reasonCode).toBe(DECISION_LAYER_DISABLED_REASON);
    expect(decision.meta.answeredBy).toBe("deterministic");

    const events = await subject.runtime.store.readByTask(
      scopeOf(subject),
      stored.task.id,
    );
    expect(eventsOfType(events, "DecisionFallbackUsed")).toHaveLength(0);
    expect(eventsOfType(events, "DecisionFailed")).toHaveLength(0);
  });

  it("reports whether a decision layer is installed for the workspace", async () => {
    const withProvider = await project(createScriptedDecisionProvider([]));
    const withoutProvider = await project();
    expect(
      coordinatorFor(withProvider, {
        provider: createScriptedDecisionProvider([]),
      }).info.configured,
    ).toBe(true);
    expect(coordinatorFor(withoutProvider, {}).info.configured).toBe(false);
  });
});

describe("decision coordinator: budget", () => {
  it("stops consulting the layer once the per-task cap is reached", async () => {
    const provider = createScriptedDecisionProvider([
      { response: { outcome: "selected", optionId: "minimal" } },
    ]);
    const subject = await project(provider);
    const stored = await taskIn(subject);
    const coordinator = coordinatorFor(subject, {
      provider,
      config: { maxDecisionsPerTask: 1 },
    }).forAttempt({
      workspaceId: subject.runtime.workspace.id,
      taskId: stored.task.id,
    });

    const first = await coordinator.route({
      taskRiskLevel: "medium",
      routes: ["standard", "minimal"],
    });
    expect(first.meta.answeredBy).toBe("provider");
    expect(provider.calls).toBe(1);

    const second = await coordinator.assessCompletion({
      acceptanceCriteriaTotal: 1,
      acceptanceCriteriaMet: 1,
      verificationChecks: 1,
      verificationFailures: 0,
    });
    // The provider is not called: that is what makes the cap a budget rather than a
    // suggestion. The question is still answered and still recorded.
    expect(provider.calls).toBe(1);
    expect(second.meta.answeredBy).toBe("fallback");
    expect(second.meta.fallbackReason).toBe("budget-exhausted");
    expect(second.assessment).toBe("uncertain");

    const state = await coordinator.budget();
    expect(state.limit).toBe(1);
    expect(state.consultations).toBe(1);
    expect(state.remaining).toBe(0);
    expect(state.exhausted).toBe(true);
  });

  it("stops consulting the layer once the known cost reaches the cost cap", async () => {
    const provider = createMetadataDecisionProvider(
      [
        {
          metadata: {
            response: { outcome: "selected", optionId: "minimal" },
            usage: {
              inputTokens: 1_000,
              outputTokens: 0,
              cachedInputTokens: 0,
            },
            modelId: "jev-1",
          },
        },
      ],
      { id: "jev" },
    );
    const subject = await project(provider);
    const stored = await taskIn(subject);
    const coordinator = coordinatorFor(subject, {
      provider,
      rates: [RATE],
      config: { maxDecisionCostMicrosPerTask: 1_000 },
    }).forAttempt({
      workspaceId: subject.runtime.workspace.id,
      taskId: stored.task.id,
    });

    await coordinator.route({
      taskRiskLevel: "medium",
      routes: ["standard", "minimal"],
    });
    expect(provider.calls).toBe(1);
    const state = await coordinator.budget();
    expect(state.knownCostMicros).toBe(1_000);
    expect(state.costCapMicros).toBe(1_000);
    expect(state.exhausted).toBe(true);

    await coordinator.rank({
      candidates: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    });
    expect(provider.calls).toBe(1);
  });

  it("counts consultations from the log, not from memory", async () => {
    const provider = createScriptedDecisionProvider([
      { response: { outcome: "selected", optionId: "minimal" } },
    ]);
    const subject = await project(provider);
    const stored = await taskIn(subject);
    await coordinatorFor(subject, { provider })
      .forAttempt({
        workspaceId: subject.runtime.workspace.id,
        taskId: stored.task.id,
      })
      .route({ taskRiskLevel: "medium", routes: ["standard", "minimal"] });

    // A *second*, independent coordinator over the same task sees the first
    // consultation: the budget cannot be reset by rebuilding the process state.
    const second = coordinatorFor(subject, {
      provider,
      config: { maxDecisionsPerTask: 1 },
    }).forAttempt({
      workspaceId: subject.runtime.workspace.id,
      taskId: stored.task.id,
    });
    const state = await second.budget();
    expect(state.consultations).toBe(1);
    expect(state.exhausted).toBe(true);
  });

  it("does not charge one task's budget for another task's decisions", async () => {
    const provider = createScriptedDecisionProvider([
      { response: { outcome: "selected", optionId: "minimal" } },
      { response: { outcome: "selected", optionId: "minimal" } },
    ]);
    const subject = await project(provider);
    const first = await taskIn(subject);
    const second = await taskIn(subject);
    const factory = coordinatorFor(subject, {
      provider,
      config: { maxDecisionsPerTask: 1 },
    });
    await factory
      .forAttempt({
        workspaceId: subject.runtime.workspace.id,
        taskId: first.task.id,
      })
      .route({ taskRiskLevel: "medium", routes: ["standard", "minimal"] });

    const other = factory.forAttempt({
      workspaceId: subject.runtime.workspace.id,
      taskId: second.task.id,
    });
    const state = await other.budget();
    expect(state.consultations).toBe(0);
    expect(state.exhausted).toBe(false);
    const decision = await other.route({
      taskRiskLevel: "medium",
      routes: ["standard", "minimal"],
    });
    expect(decision.meta.answeredBy).toBe("provider");
  });
});

describe("decision coordinator: bounded answers", () => {
  it("cannot be told to retry past the deterministic cap", async () => {
    const provider = createScriptedDecisionProvider([
      {
        response: {
          outcome: "selected",
          optionId: "retry",
          reasonCode: "transient-failure",
        },
      },
    ]);
    const subject = await project(provider);
    const stored = await taskIn(subject);
    const coordinator = coordinatorFor(subject, {
      provider,
      config: { maxRetriesPerTask: 2 },
    }).forAttempt({
      workspaceId: subject.runtime.workspace.id,
      taskId: stored.task.id,
    });

    // Room for one more retry: the layer may answer.
    const allowed = await coordinator.shouldRetry({
      failureKind: "server",
      retryable: true,
      attemptsSpent: 0,
      retriesRemaining: 2,
    });
    expect(allowed.action).toBe("retry");
    expect(provider.calls).toBe(1);

    // The task's retry budget is spent: the question never reaches the provider, and
    // the effective answer is `stop` whatever a layer would have preferred.
    const refused = await coordinator.shouldRetry({
      failureKind: "server",
      retryable: true,
      attemptsSpent: 1,
      retriesRemaining: 0,
    });
    expect(refused.action).toBe("stop");
    expect(refused.reasonCode).toBe("budget-exhausted");
    expect(provider.calls).toBe(1);
  });

  it("never returns a tool outside the candidates it was given", async () => {
    const provider = createScriptedDecisionProvider([
      { response: { outcome: "selected", optionId: "shell-anything" } },
    ]);
    const subject = await project(provider);
    const stored = await taskIn(subject);
    const coordinator = coordinatorFor(subject, { provider }).forAttempt({
      workspaceId: subject.runtime.workspace.id,
      taskId: stored.task.id,
    });
    const selection = await coordinator.selectTool({
      candidates: SCRIPTED_TOOLS,
      defaultToolId: SCRIPTED_TOOLS[0]!.toolId,
    });
    // The invented tool is rejected by validation, and the declared default answers.
    expect(selection.toolId).toBe(SCRIPTED_TOOLS[0]!.toolId);
    expect(selection.meta.answeredBy).toBe("fallback");
    expect(selection.meta.fallbackReason).toBe("invalid-answer");
  });

  it("reports an escalation recommendation without creating an approval", async () => {
    const provider = createScriptedDecisionProvider([
      {
        response: {
          outcome: "selected",
          optionId: "review",
          reasonCode: "repeated-failure",
        },
      },
    ]);
    const subject = await project(provider);
    const stored = await taskIn(subject);
    const coordinator = coordinatorFor(subject, { provider }).forAttempt({
      workspaceId: subject.runtime.workspace.id,
      taskId: stored.task.id,
    });
    const escalation = await coordinator.recommendEscalation({
      facts: ["two-attempts-failed"],
      securityRefusal: false,
    });
    expect(escalation.recommendation).toBe("review");

    // A recommendation is not a grant: nothing was requested and nothing is pending.
    const states = await subject.runtime.ledger.forTask(
      scopeOf(subject),
      stored.task.id,
    );
    expect(states).toEqual([]);
    const events = await subject.runtime.store.readByTask(
      scopeOf(subject),
      stored.task.id,
    );
    expect(eventsOfType(events, "ApprovalRequested")).toHaveLength(0);
    expect(eventsOfType(events, "ApprovalGranted")).toHaveLength(0);
  });

  it("assesses completion without touching the task state", async () => {
    const provider = createScriptedDecisionProvider([
      {
        response: {
          outcome: "selected",
          optionId: "complete",
          reasonCode: "criteria-met",
        },
      },
    ]);
    const subject = await project(provider);
    const stored = await taskIn(subject);
    const coordinator = coordinatorFor(subject, { provider }).forAttempt({
      workspaceId: subject.runtime.workspace.id,
      taskId: stored.task.id,
    });
    const assessment = await coordinator.assessCompletion({
      acceptanceCriteriaTotal: 1,
      acceptanceCriteriaMet: 1,
      verificationChecks: 1,
      verificationFailures: 0,
    });
    expect(assessment.assessment).toBe("complete");

    // The assessment is an opinion. The authoritative state is unchanged, and the log
    // contains no completion event.
    const reread = await subject.runtime.tasks.load(
      scopeOf(subject),
      stored.task.id,
    );
    expect(reread.task.status).toBe("created");
    const events = await subject.runtime.store.readByTask(
      scopeOf(subject),
      stored.task.id,
    );
    expect(
      eventsOfType(events, "TaskStatusChanged").filter(
        (event) => (event.payload as { to?: string }).to === "completed",
      ),
    ).toHaveLength(0);
  });

  it("refuses a question carrying secret-shaped context before asking anyone", async () => {
    const provider = createScriptedDecisionProvider([]);
    const subject = await project(provider);
    const stored = await taskIn(subject);
    const coordinator = coordinatorFor(subject, { provider }).forAttempt({
      workspaceId: subject.runtime.workspace.id,
      taskId: stored.task.id,
    });
    await expect(
      coordinator.assessRelevance({
        candidateRefs: ["sk-live-abcdefghijklmnop"],
      }),
    ).rejects.toThrow();
    expect(provider.calls).toBe(0);
  });

  it("narrows an oversized ranking pool to the decision contract and composes the tail", async () => {
    // Ten candidates: one more than MAX_DECISION_OPTIONS. The provider must be
    // shown exactly the contract bound, in the caller's deterministic pre-order,
    // and the composed result must be a permutation of the full pool.
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const provider = createScriptedDecisionProvider([
      {
        response: {
          outcome: "selected",
          optionId: "m7",
          rankedOptionIds: [...ids.slice(0, 8)].reverse(),
        },
      },
    ]);
    const subject = await project(provider);
    const stored = await taskIn(subject);
    const coordinator = coordinatorFor(subject, { provider }).forAttempt({
      workspaceId: subject.runtime.workspace.id,
      taskId: stored.task.id,
    });

    const result = await coordinator.rank({
      candidates: ids.map((id) => ({ id, label: id.toUpperCase() })),
    });

    // The provider saw only the first eight (the caller's pre-order), and its
    // reversed order was honored for that field.
    expect(provider.calls).toBe(1);
    expect(result.ranking).toEqual([
      "m7",
      "m6",
      "m5",
      "m4",
      "m3",
      "m2",
      "m1",
      "m0",
      // The two un-asked candidates trail, in the caller's order.
      "m8",
      "m9",
    ]);
    // And the composition is still a permutation of the full pool.
    expect([...result.ranking].sort()).toEqual([...ids].sort());
  });

  it("forwards a contract-sized ranking pool to the provider unchanged", async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `m${i}`);
    const provider = createScriptedDecisionProvider([
      {
        response: {
          outcome: "selected",
          optionId: "m7",
          rankedOptionIds: [...ids].reverse(),
        },
      },
    ]);
    const subject = await project(provider);
    const stored = await taskIn(subject);
    const coordinator = coordinatorFor(subject, { provider }).forAttempt({
      workspaceId: subject.runtime.workspace.id,
      taskId: stored.task.id,
    });

    const result = await coordinator.rank({
      candidates: ids.map((id) => ({ id, label: id.toUpperCase() })),
    });
    expect(provider.calls).toBe(1);
    expect(result.ranking).toEqual([...ids].reverse());
  });
});
