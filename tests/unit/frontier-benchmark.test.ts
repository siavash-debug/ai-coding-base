import { afterAll, describe, expect, it } from "vitest";

import type { Runtime } from "../../src/application/runtime.js";
import { hasDomainErrorCode } from "../../src/core/errors.js";
import { DECISION_KINDS } from "../../src/decisions/decision.js";
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
} from "../../src/decisions/provider.js";
import type { ModelProfile } from "../../src/models/model.js";
import {
  BENCH_TEXT_MODEL,
  FRONTIER_BENCHMARK_SCENARIOS,
  type FrontierBenchmarkResult,
  type FrontierBenchmarkScenario,
  type FrontierPath,
  type FrontierPathRun,
  runFrontierBenchmark,
} from "../../src/evaluation/frontier-benchmark.js";
import { LlmProviderError } from "../../src/ports/llm-provider.js";
import {
  FIXTURE_USAGE,
  createScriptedFrontier,
  frontierConfig,
  ratesFor,
  type ScriptedFrontier,
  type ScriptedFrontierStep,
} from "../support/frontier.js";
import { createTestProject, type TestProject } from "../support/project.js";

/**
 * The comparative frontier benchmark, over the real orchestrator.
 *
 * Both paths run `runtime.orchestrator.run` — the real registry, eligibility,
 * routing mode, plan builder, decision coordinator and event log — with the frontier
 * scripted and the decision layer answered deterministically. The *only* difference
 * between the paths is the routing configuration: the single-model baseline disables
 * decomposition and parallelism, so exactly one model must cover the task. Nothing
 * here is a second implementation.
 *
 * The benchmark is run once up front and shared, so the file creates a handful of
 * temporary projects rather than scores of them.
 */

const projects: TestProject[] = [];

/** Windows cleans up temp trees lazily; a transient ENOTEMPTY is retried. */
async function cleanup(project: TestProject): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await project.cleanup();
      return;
    } catch (error) {
      if (attempt >= 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

afterAll(async () => {
  while (projects.length > 0) {
    const project = projects.pop();
    if (project !== undefined) {
      await cleanup(project);
    }
  }
});

function responder(overrides: Partial<Record<string, DecisionResponse>> = {}): {
  readonly provider: DecisionProvider;
  readonly requests: DecisionRequest[];
} {
  const requests: DecisionRequest[] = [];
  return {
    requests,
    provider: {
      id: "bench-decisions",
      family: "rules",
      capabilities: () => ({
        kinds: DECISION_KINDS,
        deterministic: false,
        maxOptions: 8,
      }),
      async decide(request: DecisionRequest): Promise<DecisionResponse> {
        requests.push(request);
        const override = overrides[request.kind];
        if (override !== undefined) {
          return override;
        }
        const first = request.options[0];
        if (first === undefined) {
          return { outcome: "abstained", reason: "no options offered" };
        }
        return request.ranked === true
          ? {
              outcome: "selected",
              optionId: first.id,
              rankedOptionIds: request.options.map((option) => option.id),
            }
          : { outcome: "selected", optionId: first.id };
      },
    },
  };
}

const rateLimited = (model: ModelProfile): LlmProviderError =>
  new LlmProviderError(
    {
      failureKind: "rate-limit",
      providerId: model.providerId,
      modelId: model.modelId,
      attempts: 1,
      retryable: true,
      statusCode: 429,
    },
    "scripted rate limit",
  );

/** The frontier script per scenario (the same script is offered to both paths). */
const SCRIPTS: Readonly<Record<string, readonly ScriptedFrontierStep[]>> = {
  "coding-single-model": [{ usage: FIXTURE_USAGE }],
  "vision-coding-split": [
    { content: "the header overflows its container", usage: FIXTURE_USAGE },
    { content: "patched src/layout.ts", usage: FIXTURE_USAGE },
  ],
  "parallel-subtasks": [{ usage: FIXTURE_USAGE }, { usage: FIXTURE_USAGE }],
  "transient-retry": [
    { error: rateLimited(BENCH_TEXT_MODEL) },
    { content: "the second candidate answered", usage: FIXTURE_USAGE },
  ],
};

/** The decision answers that make a scenario deterministic. */
const OVERRIDES: Readonly<
  Record<string, Partial<Record<string, DecisionResponse>>>
> = {
  // A ranking answer must be a permutation of what was offered AND use a reason code
  // from the closed set, so this one carries none.
  "parallel-subtasks": {
    ranking: {
      outcome: "selected",
      optionId: "plan:parallel",
      rankedOptionIds: ["plan:parallel", "plan:single"],
    },
  },
  "transient-retry": {
    retry: {
      outcome: "selected",
      optionId: "retry",
      reasonCode: "transient-failure",
    },
  },
};

/** A record of one path of one scenario, for assertions. */
interface RunCapture {
  readonly scenarioId: string;
  readonly path: FrontierPath;
  readonly runtime: Runtime;
  readonly frontier: ScriptedFrontier;
}

/** Runs one path of one scenario through the real orchestrator. */
async function runPath(
  scenario: FrontierBenchmarkScenario,
  path: FrontierPath,
): Promise<FrontierPathRun> {
  const single = path === "single-model";
  const frontier = createScriptedFrontier(SCRIPTS[scenario.scenarioId] ?? []);
  const decision = responder(OVERRIDES[scenario.scenarioId] ?? {});
  const project = await createTestProject({
    frontierConfig: frontierConfig({
      models: scenario.models,
      routing: {
        mode: scenario.mode,
        // The baseline is the same orchestrator with composition disabled: one model
        // must cover the whole task.
        allowDecomposition: !single,
        allowParallel: !single,
        maxModelCalls: scenario.maxModelCalls,
        maxRetriesPerStep: scenario.maxRetriesPerStep,
      },
    }),
    modelRates: ratesFor(scenario.models),
    decisionProvider: decision.provider,
    frontier,
  });
  projects.push(project);
  captures.push({
    scenarioId: scenario.scenarioId,
    path,
    runtime: project.runtime,
    frontier,
  });
  const stored = await project.runtime.tasks.create(
    {
      title: scenario.title,
      description: scenario.title,
      acceptanceCriteria: ["The change is recorded"],
    },
    { project: project.runtime.project, workspace: project.runtime.workspace },
  );
  try {
    const result = await project.runtime.orchestrator.run({
      workspaceId: project.runtime.workspace.id,
      taskId: stored.task.id,
      ...(scenario.subTasks === undefined
        ? {}
        : { subTasks: scenario.subTasks }),
    } as never);
    return { ran: true, result };
  } catch (error) {
    return {
      ran: false,
      reason: hasDomainErrorCode(error, "NOT_FOUND") ? "NOT_FOUND" : "refused",
    };
  }
}

const captures: RunCapture[] = [];
let result: FrontierBenchmarkResult;
let firstCaptures: readonly RunCapture[];

async function benchmark(): Promise<FrontierBenchmarkResult> {
  return await runFrontierBenchmark(FRONTIER_BENCHMARK_SCENARIOS, runPath);
}

function measurementFor(
  benchmarkResult: FrontierBenchmarkResult,
  scenarioId: string,
  path: FrontierPath,
) {
  const found = benchmarkResult.measurements.find(
    (measurement) =>
      measurement.scenarioId === scenarioId && measurement.path === path,
  );
  if (found === undefined) {
    throw new Error(`no measurement for ${scenarioId}/${path}`);
  }
  return found;
}

function aggregateFor(
  benchmarkResult: FrontierBenchmarkResult,
  path: FrontierPath,
) {
  const found = benchmarkResult.aggregates.find(
    (aggregate) => aggregate.path === path,
  );
  if (found === undefined) {
    throw new Error(`no aggregate for ${path}`);
  }
  return found;
}

describe("frontier benchmark: both paths use the real orchestrator", () => {
  it("supplies the same scenarios to both paths", async () => {
    result = await benchmark();
    firstCaptures = [...captures];
    const seen = new Set(firstCaptures.map((c) => `${c.scenarioId}/${c.path}`));
    expect(seen.size).toBe(FRONTIER_BENCHMARK_SCENARIOS.length * 2);
    for (const capture of firstCaptures) {
      expect(capture.runtime.orchestrator.strategy).toBe(
        "frontier-multi-model",
      );
    }
  });

  it("runs the multi-model path with composition and the baseline without", () => {
    const multi = measurementFor(result, "parallel-subtasks", "multi-model");
    const single = measurementFor(result, "parallel-subtasks", "single-model");
    expect(multi.completedSteps).toBe(2);
    expect(multi.callsSpent).toBe(2);
    expect(single.completedSteps).toBe(1);
    expect(single.callsSpent).toBe(1);
  });

  it("compares capability-split work that only the multi-model path can serve", () => {
    const multi = measurementFor(result, "vision-coding-split", "multi-model");
    const single = measurementFor(
      result,
      "vision-coding-split",
      "single-model",
    );
    expect(multi.success).toBe(true);
    expect(multi.completedSteps).toBe(2);
    expect(multi.acceptance.coveredCapabilities).toEqual(
      expect.arrayContaining(["vision", "coding"]),
    );
    // One model cannot cover vision + coding, so the baseline refuses honestly.
    expect(single.success).toBe(false);
    expect(single.reliabilityOutcome).toBe("refused");
    expect(aggregateFor(result, "multi-model").acceptedTasks).toBeGreaterThan(
      aggregateFor(result, "single-model").acceptedTasks,
    );
  });
});

describe("frontier benchmark: identical measurement mechanism", () => {
  it("evaluates acceptance identically for both paths", () => {
    for (const scenario of FRONTIER_BENCHMARK_SCENARIOS) {
      const multi = measurementFor(result, scenario.scenarioId, "multi-model");
      const single = measurementFor(
        result,
        scenario.scenarioId,
        "single-model",
      );
      expect(multi.acceptance.requiredCapabilities).toEqual(
        scenario.requiredCapabilities,
      );
      expect(single.acceptance.requiredCapabilities).toEqual(
        scenario.requiredCapabilities,
      );
      // Success is acceptance — never "did not throw".
      expect(multi.success).toBe(multi.acceptance.met);
      expect(single.success).toBe(single.acceptance.met);
    }
  });

  it("uses the same token and cost accounting where both paths succeed", () => {
    const multi = measurementFor(result, "coding-single-model", "multi-model");
    const single = measurementFor(
      result,
      "coding-single-model",
      "single-model",
    );
    expect(multi.success).toBe(true);
    expect(single.success).toBe(true);
    expect(multi.tokens).toBe(
      FIXTURE_USAGE.inputTokens + FIXTURE_USAGE.outputTokens,
    );
    expect(single.tokens).toBe(multi.tokens);
    // 1,000 in @1,000µ$/M + 500 out @2,000µ$/M = 2µ$.
    expect(multi.costMicros).toBe(2);
    expect(single.costMicros).toBe(multi.costMicros);
    expect(multi.stepLatencyMs).toBe(single.stepLatencyMs);
  });

  it("keeps the reliability denominator explicit", () => {
    for (const path of ["multi-model", "single-model"] as const) {
      const aggregate = aggregateFor(result, path);
      expect(aggregate.attemptedTasks).toBe(
        FRONTIER_BENCHMARK_SCENARIOS.length,
      );
      expect(aggregate.reliability).toBeCloseTo(
        aggregate.acceptedTasks / aggregate.attemptedTasks,
        10,
      );
    }
  });
});

describe("frontier benchmark: determinism and neutrality", () => {
  it("produces identical output on repeated execution", async () => {
    const second = await benchmark();
    expect(JSON.stringify(second)).toBe(JSON.stringify(result));
  });

  it("measures a real difference where the paths diverge, without ranking", () => {
    // The capability-split scenario: the multi path accepts, the baseline refuses.
    expect(result.difference.acceptedTasks).toBeGreaterThan(0);
    const parallel = measurementFor(result, "parallel-subtasks", "multi-model");
    const parallelSingle = measurementFor(
      result,
      "parallel-subtasks",
      "single-model",
    );
    expect(parallel.tokens).toBeGreaterThan(parallelSingle.tokens);
    // No verdict anywhere in the result: no score, no winner, no recommendation.
    const json = JSON.stringify(result);
    expect(json).not.toMatch(
      /better|worse|superior|inferior|winner|loser|recommend|score/i,
    );
  });

  it("executes only through the scripted frontier port, never a network", () => {
    const multi = firstCaptures.find(
      (capture) =>
        capture.scenarioId === "vision-coding-split" &&
        capture.path === "multi-model",
    );
    expect(multi?.frontier.requests).toHaveLength(2);
    expect(multi?.frontier.id).toBe("scripted-frontier");
  });
});
