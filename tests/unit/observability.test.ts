import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../src/core/clock.js";
import {
  eventId,
  projectId,
  sessionId,
  taskId,
  workspaceId,
} from "../../src/core/ids.js";
import {
  type Budget,
  DEFAULT_BUDGET_THRESHOLDS,
  evaluateBudget,
  isUnboundedBudget,
  validateBudget,
  validateBudgetThresholds,
} from "../../src/observability/budget.js";
import {
  type ModelRate,
  addCost,
  computeCost,
  createModelRate,
  estimateCost,
  findModelRate,
  formatCost,
  microsFromDollars,
  sumCosts,
  zeroCost,
} from "../../src/observability/cost.js";
import {
  type CreateEventInput,
  type DomainEvent,
  assertTaskScopedEvent,
  createEvent,
  isDomainEvent,
  isEventOfType,
  isTaskScopedEvent,
  nextSequence,
} from "../../src/observability/events.js";
import {
  type LlmCallRecord,
  type TaskMetricsInput,
  computeTaskMetrics,
  formatTaskMetrics,
} from "../../src/observability/metrics.js";
import {
  type AIUsage,
  addUsage,
  assertValidUsage,
  billableInputTokens,
  emptyUsage,
  isValidUsage,
  sumUsage,
  totalTokens,
} from "../../src/observability/usage.js";
import { expectDomainError } from "../support/errors.js";

const INSTANT = "2026-09-20T10:00:00.000Z";
const clock = createFixedClock(INSTANT);
const PRJ = projectId("prj-1");
const WSP = workspaceId("wsp-1");
const TSK = taskId("tsk-1");

const usage = (overrides: Partial<AIUsage> = {}): AIUsage => ({
  inputTokens: 100,
  outputTokens: 50,
  cachedInputTokens: 30,
  ...overrides,
});

describe("token accounting", () => {
  it("starts empty", () => {
    expect(emptyUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
  });

  it("does not double-count cached tokens", () => {
    const value = usage({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 30,
    });
    expect(totalTokens(value)).toBe(150);
    expect(billableInputTokens(value)).toBe(70);
  });

  it("adds usages", () => {
    expect(addUsage(emptyUsage(), usage())).toEqual(usage());
    expect(sumUsage([usage(), usage()])).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      cachedInputTokens: 60,
    });
  });

  it("is associative and commutative", () => {
    const a = usage({
      inputTokens: 1,
      cachedInputTokens: 0,
      reasoningTokens: 2,
    });
    const b = usage({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 1 });
    const c = usage({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 0,
    });
    expect(addUsage(a, b)).toEqual(addUsage(b, a));
    expect(addUsage(addUsage(a, b), c)).toEqual(addUsage(a, addUsage(b, c)));
    expect(sumUsage([a, b, c])).toEqual(sumUsage([c, b, a]));
  });

  it("keeps reasoning tokens absent when no provider reports them", () => {
    const summed = addUsage(usage(), usage());
    expect(summed.reasoningTokens).toBeUndefined();
    expect(
      addUsage(usage({ reasoningTokens: 5 }), usage()).reasoningTokens,
    ).toBe(5);
  });

  it("rejects impossible counters", () => {
    expectDomainError(
      () => assertValidUsage(usage({ inputTokens: -1 })),
      "VALIDATION",
    );
    expectDomainError(
      () => assertValidUsage(usage({ inputTokens: 1.5 })),
      "VALIDATION",
    );
    expectDomainError(
      () => assertValidUsage(usage({ inputTokens: 10, cachedInputTokens: 11 })),
      "VALIDATION",
    );
    expectDomainError(
      () => assertValidUsage(usage({ outputTokens: 10, reasoningTokens: 11 })),
      "VALIDATION",
    );
    expect(() => assertValidUsage(null)).toThrow();
    expect(isValidUsage(usage())).toBe(true);
    expect(isValidUsage({ inputTokens: -1 })).toBe(false);
  });
});

describe("cost accounting", () => {
  const rate: ModelRate = createModelRate({
    providerId: "anthropic",
    modelId: "claude-x",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
    cachedInputUsdPerMillionTokens: 0.3,
  });

  it("stores money as integer micro-USD", () => {
    expect(microsFromDollars(3)).toBe(3_000_000);
    expect(microsFromDollars(0.0000015)).toBe(2);
    expect(zeroCost()).toEqual({ currency: "USD", micros: 0 });
    expectDomainError(() => microsFromDollars(-1), "VALIDATION");
  });

  it("converts rates to micros per million tokens", () => {
    expect(rate.inputMicrosPerMillionTokens).toBe(3_000_000);
    expect(rate.outputMicrosPerMillionTokens).toBe(15_000_000);
    expect(rate.cachedInputMicrosPerMillionTokens).toBe(300_000);
    expect(rate.currency).toBe("USD");
  });

  it("bills cached input at the cached rate and the rest at the input rate", () => {
    const cost = computeCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cachedInputTokens: 200_000,
      },
      rate,
    );
    // 800k * 3 + 200k * 0.3 + 100k * 15  (per million) = 2.40 + 0.06 + 1.50
    expect(cost).toEqual({ currency: "USD", micros: 3_960_000 });
    expect(formatCost(cost)).toBe("$3.96");
  });

  it("formats without floating point noise", () => {
    expect(formatCost({ currency: "USD", micros: 840_000 })).toBe("$0.84");
    expect(formatCost({ currency: "USD", micros: 300 })).toBe("$0.0003");
    expect(formatCost({ currency: "USD", micros: 1_000_000 })).toBe("$1");
    expect(formatCost(zeroCost())).toBe("$0");
    expectDomainError(
      () => formatCost({ currency: "USD", micros: -1 }),
      "VALIDATION",
    );
  });

  it("adds costs exactly", () => {
    const sum = sumCosts([
      { currency: "USD", micros: 1 },
      { currency: "USD", micros: 2 },
      { currency: "USD", micros: 3 },
    ]);
    expect(sum.micros).toBe(6);
    expect(addCost(zeroCost(), zeroCost())).toEqual(zeroCost());
  });

  it("selects the newest applicable rate", () => {
    const newer: ModelRate = createModelRate({
      providerId: "anthropic",
      modelId: "claude-x",
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      inputUsdPerMillionTokens: 4,
      outputUsdPerMillionTokens: 20,
      cachedInputUsdPerMillionTokens: 0.4,
    });
    const rates = [newer, rate];
    expect(
      findModelRate(rates, { providerId: "anthropic", modelId: "claude-x" }),
    ).toBe(newer);
    expect(
      findModelRate(rates, {
        providerId: "anthropic",
        modelId: "claude-x",
        at: "2026-03-01T00:00:00.000Z",
      }),
    ).toBe(rate);
    expect(
      findModelRate(rates, { providerId: "openai", modelId: "claude-x" }),
    ).toBeUndefined();
  });

  it("breaks a rate tie by table order", () => {
    const first: ModelRate = { ...rate, inputMicrosPerMillionTokens: 1 };
    const second: ModelRate = { ...rate, inputMicrosPerMillionTokens: 2 };
    expect(
      findModelRate([first, second], {
        providerId: "anthropic",
        modelId: "claude-x",
      }),
    ).toBe(second);
  });

  it("reports unknown models as unpriced rather than free", () => {
    expect(
      estimateCost({
        usage: usage(),
        providerId: "anthropic",
        modelId: "claude-x",
        rates: [rate],
      }),
    ).toEqual({ currency: "USD", micros: 969 });
    expect(
      estimateCost({
        usage: usage(),
        providerId: "unknown",
        modelId: "mystery",
        rates: [rate],
      }),
    ).toBeUndefined();
  });

  it("validates rate definitions", () => {
    expectDomainError(
      () =>
        createModelRate({
          providerId: "p",
          modelId: "m",
          effectiveFrom: "last tuesday",
          inputUsdPerMillionTokens: 1,
          outputUsdPerMillionTokens: 1,
          cachedInputUsdPerMillionTokens: 1,
        }),
      "VALIDATION",
    );
  });
});

describe("budgets", () => {
  const limit: Budget = { maxTokens: 10_000 };

  it("warns at 80%", () => {
    const evaluation = evaluateBudget(limit, { tokens: 8000 });
    expect(evaluation.level).toBe("warning");
    expect(evaluation.exceeded).toBe(false);
    expect(evaluation.actions).toEqual(["warn"]);
    expect(evaluation.dimensions[0]?.ratio).toBe(0.8);
    expect(evaluation.dimensions[0]?.remaining).toBe(2000);
    expect(evaluation.reasons.join(" ")).toContain("tokens: 80.0%");
  });

  it("goes critical at 90%", () => {
    const evaluation = evaluateBudget(limit, { tokens: 9000 });
    expect(evaluation.level).toBe("critical");
    expect(evaluation.actions).toEqual(["warn", "optimize", "escalate"]);
  });

  it("stops at 100%", () => {
    const evaluation = evaluateBudget(limit, { tokens: 10_000 });
    expect(evaluation.level).toBe("exceeded");
    expect(evaluation.exceeded).toBe(true);
    expect(evaluation.actions).toEqual(["stop"]);
    expect(evaluation.dimensions[0]?.remaining).toBe(0);
    expect(evaluation.reasons[0]).toContain("budget exceeded");
  });

  it("stays ok below the warning threshold", () => {
    const evaluation = evaluateBudget(limit, { tokens: 7999 });
    expect(evaluation.level).toBe("ok");
    expect(evaluation.actions).toEqual([]);
    expect(evaluation.reasons).toEqual([]);
  });

  it("can require approval instead of stopping", () => {
    const evaluation = evaluateBudget(
      { maxTokens: 100, onExceeded: "require-approval" },
      { tokens: 100 },
    );
    expect(evaluation.onExceeded).toBe("require-approval");
    expect(evaluation.actions).toEqual(["require-approval", "escalate"]);
  });

  it("takes the worst level across dimensions", () => {
    const evaluation = evaluateBudget(
      { maxTokens: 1000, maxIterations: 10, maxCostMicros: 1_000_000 },
      { tokens: 100, iterations: 20, costMicros: 100 },
    );
    expect(evaluation.level).toBe("exceeded");
    expect(evaluation.dimensions).toHaveLength(3);
    expect(
      evaluation.dimensions.map((dimension) => dimension.dimension),
    ).toEqual(["tokens", "cost", "iterations"]);
  });

  it("treats an absent limit as unbounded", () => {
    expect(isUnboundedBudget({})).toBe(true);
    expect(isUnboundedBudget({ maxTokens: 1 })).toBe(false);
    const evaluation = evaluateBudget({}, { tokens: 5_000_000 });
    expect(evaluation.level).toBe("ok");
    expect(evaluation.dimensions).toEqual([]);
  });

  it("handles a zero limit as no consumption permitted", () => {
    expect(evaluateBudget({ maxTokens: 0 }, {}).level).toBe("ok");
    const exceeded = evaluateBudget({ maxTokens: 0 }, { tokens: 1 });
    expect(exceeded.level).toBe("exceeded");
    expect(exceeded.dimensions[0]?.ratio).toBe(Number.POSITIVE_INFINITY);
    expect(exceeded.reasons.join(" ")).toContain("over 100%");
  });

  it("honours custom thresholds", () => {
    const thresholds = { warning: 0.5, critical: 0.6 };
    expect(evaluateBudget(limit, { tokens: 6000 }, thresholds).level).toBe(
      "critical",
    );
    expect(evaluateBudget(limit, { tokens: 4000 }, thresholds).level).toBe(
      "ok",
    );
    expect(DEFAULT_BUDGET_THRESHOLDS).toEqual({ warning: 0.8, critical: 0.9 });
  });

  it("validates budgets, thresholds and consumption", () => {
    expectDomainError(() => validateBudget({ maxTokens: -1 }), "VALIDATION");
    expectDomainError(() => validateBudget({ maxTokens: 1.5 }), "VALIDATION");
    expectDomainError(
      () => validateBudget({ onExceeded: "explode" as unknown as "stop" }),
      "VALIDATION",
    );
    expectDomainError(
      () => validateBudgetThresholds({ warning: 0.9, critical: 0.8 }),
      "VALIDATION",
    );
    expectDomainError(
      () => validateBudgetThresholds({ warning: 0, critical: 0.9 }),
      "VALIDATION",
    );
    expectDomainError(
      () => validateBudgetThresholds({ warning: 0.8, critical: 1.2 }),
      "VALIDATION",
    );
    expectDomainError(
      () => evaluateBudget(limit, { tokens: -1 }),
      "VALIDATION",
    );
  });
});

describe("events", () => {
  const llmCall: CreateEventInput<"LLMRequestCompleted"> = {
    type: "LLMRequestCompleted",
    actor: { type: "agent", id: "codebuff" },
    projectId: PRJ,
    workspaceId: WSP,
    taskId: TSK,
    sessionId: sessionId("ses-1"),
    payload: {
      providerId: "anthropic",
      modelId: "claude-x",
      usage: usage(),
      latencyMs: 1200,
      retry: 0,
      escalated: false,
    },
  };

  it("creates a versioned, attributed envelope", () => {
    const event = createEvent(llmCall, {
      id: eventId("evt-1"),
      sequence: 1,
      clock,
    });
    expect(event.schemaVersion).toBe(1);
    expect(event.type).toBe("LLMRequestCompleted");
    expect(event.occurredAt).toBe(INSTANT);
    expect(event.sequence).toBe(1);
    expect(event.actor).toEqual({ type: "agent", id: "codebuff" });
    expect(isTaskScopedEvent(event)).toBe(true);
    expect(() => assertTaskScopedEvent(event)).not.toThrow();
    expect(event.payload.usage).toEqual(usage());
  });

  it("refuses task-scoped events without a task id", () => {
    const orphan = createEvent(
      { ...llmCall, taskId: undefined, sessionId: undefined },
      { id: eventId("evt-2"), sequence: 2, clock },
    );
    expect(isTaskScopedEvent(orphan)).toBe(false);
    expectDomainError(() => assertTaskScopedEvent(orphan), "INVARIANT");
  });

  it("validates payloads at construction", () => {
    const invalid = (payload: unknown) =>
      createEvent(
        {
          ...llmCall,
          payload,
        } as unknown as CreateEventInput<"LLMRequestCompleted">,
        { id: eventId("evt-3"), sequence: 3, clock },
      );

    expectDomainError(() => invalid({ modelId: "claude-x" }), "VALIDATION");
    expectDomainError(
      () =>
        invalid({
          ...llmCall.payload,
          usage: { inputTokens: -1, outputTokens: 0, cachedInputTokens: 0 },
        }),
      "VALIDATION",
    );
    expectDomainError(
      () => invalid({ ...llmCall.payload, escalated: "yes" }),
      "VALIDATION",
    );
    expectDomainError(() => invalid([]), "VALIDATION");
  });

  it("rejects payloads that look like secret material", () => {
    expectDomainError(
      () =>
        createEvent(
          {
            type: "TaskCreated",
            actor: { type: "agent", id: "codebuff" },
            projectId: PRJ,
            workspaceId: WSP,
            payload: {
              title: "sk-abcdefghijklmnop",
              riskLevel: "low",
              workspaceId: WSP,
            },
          },
          { id: eventId("evt-4"), sequence: 4, clock },
        ),
      "VALIDATION",
    );
  });

  it("rejects an unknown enum value and a malformed actor", () => {
    expectDomainError(
      () =>
        createEvent(
          {
            ...llmCall,
            actor: { type: "robot" as unknown as "agent", id: "x" },
          },
          { id: eventId("evt-5"), sequence: 5, clock },
        ),
      "VALIDATION",
    );
    expectDomainError(
      () =>
        createEvent(
          { ...llmCall, actor: { type: "agent", id: " " } },
          { id: eventId("evt-6"), sequence: 6, clock },
        ),
      "VALIDATION",
    );
  });

  it("keeps sequence monotonic per stream", () => {
    expect(nextSequence([])).toBe(1);
    expect(
      nextSequence([{ sequence: 3 }, { sequence: 7 }, { sequence: 5 }]),
    ).toBe(8);
  });

  it("identifies events structurally and narrows by type", () => {
    const created = createEvent(
      {
        type: "TaskCreated",
        actor: { type: "agent", id: "codebuff" },
        projectId: PRJ,
        workspaceId: WSP,
        taskId: TSK,
        payload: {
          title: "Add validation",
          riskLevel: "medium",
          workspaceId: WSP,
        },
      },
      { id: eventId("evt-7"), sequence: 7, clock },
    );
    const tested = createEvent(
      {
        type: "TestStarted",
        actor: { type: "code", id: "verify" },
        projectId: PRJ,
        workspaceId: WSP,
        taskId: TSK,
        payload: { suite: "unit" },
      },
      { id: eventId("evt-8"), sequence: 8, clock },
    );

    expect(isDomainEvent(created)).toBe(true);
    expect(isDomainEvent({ schemaVersion: 2 })).toBe(false);
    expect(isDomainEvent("nope")).toBe(false);
    expect(isEventOfType(created, "TaskCreated")).toBe(true);
    expect(isEventOfType(created, "TestStarted")).toBe(false);

    const stream: DomainEvent[] = [created, tested];
    expect(
      stream
        .filter((event) => isEventOfType(event, "TaskCreated"))
        .map((event) => event.payload.title),
    ).toEqual(["Add validation"]);
  });
});

describe("task metrics", () => {
  const calls: LlmCallRecord[] = [
    {
      providerId: "anthropic",
      modelId: "claude-x",
      usage: {
        inputTokens: 80_000,
        outputTokens: 20_000,
        cachedInputTokens: 10_000,
      },
      cost: { currency: "USD", micros: 840_000 },
      latencyMs: 1200,
      retry: 0,
      escalated: false,
    },
    {
      providerId: "openai",
      modelId: "gpt-y",
      usage: { inputTokens: 2410, outputTokens: 1304, cachedInputTokens: 0 },
      latencyMs: 900,
      retry: 1,
      escalated: true,
    },
  ];

  const input: TaskMetricsInput = {
    taskId: TSK,
    llmCalls: calls,
    toolCalls: 31,
    iterations: 7,
    decisions: [
      { decidedBy: "decision-provider", outcome: "selected" as const },
      { decidedBy: "decision-provider", outcome: "abstained" as const },
      { decidedBy: "code", outcome: "escalated" as const },
    ],
    contextSelections: [
      {
        budgetTokens: 8_000,
        candidateTokens: 5_000,
        selectedTokens: 1_250,
        excludedTokens: 3_500,
        considered: 12,
        selected: 3,
        excluded: 9,
        durationMs: 40,
        budgetExceeded: false,
        overBudgetTokens: 0,
      },
      {
        budgetTokens: 8_000,
        candidateTokens: 0,
        selectedTokens: 0,
        excludedTokens: 0,
        considered: 0,
        selected: 0,
        excluded: 0,
        durationMs: 20,
        budgetExceeded: false,
        overBudgetTokens: 0,
      },
    ],
    startedAt: INSTANT,
    endedAt: "2026-09-20T10:47:00.000Z",
  };

  it("projects totals from the call records", () => {
    const metrics = computeTaskMetrics(input);
    expect(metrics.inputTokens).toBe(82_410);
    expect(metrics.outputTokens).toBe(21_304);
    expect(metrics.cachedInputTokens).toBe(10_000);
    expect(metrics.totalTokens).toBe(103_714);
    expect(metrics.cost.micros).toBe(840_000);
    expect(metrics.llmCalls).toBe(2);
    expect(metrics.toolCalls).toBe(31);
    expect(metrics.iterations).toBe(7);
    expect(metrics.retries).toBe(1);
    expect(metrics.escalations).toBe(2);
    expect(metrics.decisions).toBe(3);
    expect(metrics.decisionsByProvider).toBe(2);
    expect(metrics.open).toBe(false);
    expect(metrics.durationMs).toBe(2_820_000);
  });

  it("admits when cost is incomplete instead of pretending it is zero", () => {
    const metrics = computeTaskMetrics(input);
    expect(metrics.costComplete).toBe(false);
    expect(metrics.unpricedCalls).toBe(1);
    expect(formatTaskMetrics(metrics)).toContain(
      "LLM cost: $0.84 (lower bound; 1 of 2 calls unpriced)",
    );
  });

  it("is independent of call order", () => {
    const reversed = computeTaskMetrics({
      ...input,
      llmCalls: [...calls].reverse(),
    });
    const forward = computeTaskMetrics(input);
    expect(reversed).toEqual(forward);
  });

  it("marks an unfinished task as open", () => {
    const metrics = computeTaskMetrics({ ...input, endedAt: undefined });
    expect(metrics.open).toBe(true);
    expect(metrics.durationMs).toBe(0);
    expect(formatTaskMetrics(metrics)).toContain("Duration: open");
  });

  it("renders a complete report", () => {
    const report = formatTaskMetrics(computeTaskMetrics(input));
    expect(report.split("\n")).toEqual([
      "Task: tsk-1",
      "Input tokens: 82,410",
      "Output tokens: 21,304",
      "Cached input tokens: 10,000",
      "Total tokens: 103,714",
      "LLM cost: $0.84 (lower bound; 1 of 2 calls unpriced)",
      "LLM calls: 2",
      "LLM failures: 0",
      "Provider attempts: 2",
      "LLM latency: 2,100ms",
      "Tool calls: 31",
      "Context selections: 2",
      "Context candidates: 12 (selected 3, excluded 9)",
      "Context tokens: 1,250 selected of 5,000 candidate tokens (selection ratio 25.0%)",
      "Context budget: 16,000 tokens",
      "Context selection latency: 60ms",
      "Iterations: 7",
      "Retries: 1",
      "Escalations: 2",
      // The three answer sources partition the decisions, so they add up to the
      // total; the decision cost line admits what it cannot price instead of
      // reporting an incomplete total as if it were the whole story.
      "Decisions: 3 (2 by decision provider, 1 deterministic, 0 fallback)",
      "Decision latency: 0ms",
      "Decision tokens: 0",
      "Decision cost: $0 (lower bound; 2 unpriced; 2 without usage)",
      "Duration: 47m 0s",
    ]);
  });

  it("aggregates context selections without claiming usefulness", () => {
    const metrics = computeTaskMetrics(input);
    expect(metrics.contextSelections).toBe(2);
    expect(metrics.contextCandidates).toBe(12);
    expect(metrics.contextSelected).toBe(3);
    expect(metrics.contextExcluded).toBe(9);
    expect(metrics.contextSelectedTokens).toBe(1_250);
    expect(metrics.contextCandidateTokens).toBe(5_000);
    expect(metrics.contextSelectionRatio).toBeCloseTo(0.25, 6);
    expect(metrics.contextOverBudgetSelections).toBe(0);
  });

  it("reports a zero selection ratio rather than dividing by nothing", () => {
    const metrics = computeTaskMetrics({ ...input, contextSelections: [] });
    expect(metrics.contextSelectionRatio).toBe(0);
    expect(metrics.contextSelections).toBe(0);
  });

  it("surfaces selections whose mandatory context did not fit", () => {
    const metrics = computeTaskMetrics({
      ...input,
      contextSelections: [
        {
          budgetTokens: 100,
          candidateTokens: 900,
          selectedTokens: 40,
          excludedTokens: 860,
          considered: 4,
          selected: 1,
          excluded: 3,
          durationMs: 5,
          budgetExceeded: true,
          overBudgetTokens: 600,
        },
      ],
    });
    expect(metrics.contextOverBudgetSelections).toBe(1);
    expect(formatTaskMetrics(metrics)).toContain(
      "Context budget exceeded in 1 selection(s)",
    );
  });

  it("rejects impossible counters", () => {
    expectDomainError(
      () => computeTaskMetrics({ ...input, toolCalls: -1 }),
      "VALIDATION",
    );
    expectDomainError(
      () =>
        computeTaskMetrics({
          ...input,
          llmCalls: [{ ...calls[0], retry: 1.5 }],
        }),
      "VALIDATION",
    );
  });
});
