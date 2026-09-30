import type { ModelProfile, RoutingMode } from "../models/model.js";
import type { IndependentSubTask } from "../orchestration/plan.js";
import type { OrchestrationResult } from "../orchestration/orchestrator.js";
import { totalTokens, type AIUsage } from "../observability/usage.js";

/**
 * Comparative frontier benchmark: multi-model routing versus a single-model baseline
 * (V2-ARCHITECTURE §29.1 dimensions, §39.7 requirement).
 *
 * **A measurement, not a ranking.** This module reports the §29.1 dimensions for two
 * paths over the same scenarios. It never says one path is better, computes no overall
 * score, and collapses no dimension into another. Where the paths differ, only the
 * measured difference is reported.
 *
 * **Two paths, one implementation.**
 *
 * - The **multi-model** path runs the real orchestrator with the project's routing
 *   configuration as given (decomposition and parallelism permitted). It uses the real
 *   registry, eligibility filtering, routing mode, bounded plan variants and
 *   `FrontierExecutor`; nothing here bypasses that.
 * - The **single-model** baseline runs the **same orchestrator** with the **same
 *   registry and routing mode**, but with decomposition and parallelism disabled, so
 *   exactly one model must cover the whole task. It is not a second implementation and
 *   not a deliberately weak straw man: it is the strongest single model the same
 *   routing mode would choose, which is precisely the pre-frontier world the comparison
 *   is against.
 *
 * The executor, decision responder, clock and event log are injected by the caller, so
 * the module is pure over already-produced observations and holds no I/O.
 *
 * **Acceptance is explicit.** The orchestration path does not itself verify a task's
 * acceptance criteria, so "it returned without throwing" is never treated as success.
 * Each scenario declares the capabilities its acceptance depends on, and a run is
 * accepted only when models that produced *completed* steps collectively cover every
 * required capability. The check is identical for both paths and is a pure function of
 * the (result, catalog) pair.
 */

export const FRONTIER_BENCHMARK_DATASET = "frontier-baseline-benchmark";
export const FRONTIER_BENCHMARK_VERSION = "1.0.0";

export const FRONTIER_PATHS = ["multi-model", "single-model"] as const;
export type FrontierPath = (typeof FRONTIER_PATHS)[number];

/** One deterministic task scenario, identical for both paths. */
export interface FrontierBenchmarkScenario {
  readonly scenarioId: string;
  /** Why this scenario exists, in one line. */
  readonly note: string;
  /** The task title fed to the orchestrator (its own words drive requirements). */
  readonly title: string;
  /** Capabilities acceptance depends on: every one must be covered by the run. */
  readonly requiredCapabilities: readonly string[];
  /** The catalog both paths route over. */
  readonly models: readonly ModelProfile[];
  readonly mode: RoutingMode;
  readonly maxModelCalls: number;
  readonly maxRetriesPerStep: number;
  /** Declared independent sub-tasks, when the scenario exercises parallelism. */
  readonly subTasks?: readonly IndependentSubTask[];
}

/**
 * What one path produced for one scenario.
 *
 * `ran: false` is the honest encoding of a refusal (for example, no plan exists
 * because no single model covers the task) — it is a result, not an error to swallow.
 */
export type FrontierPathRun =
  | { readonly ran: true; readonly result: OrchestrationResult }
  | { readonly ran: false; readonly reason: string };

export interface FrontierAcceptance {
  readonly requiredCapabilities: readonly string[];
  readonly coveredCapabilities: readonly string[];
  readonly missingCapabilities: readonly string[];
  readonly met: boolean;
}

export interface FrontierPathMeasurement {
  readonly scenarioId: string;
  readonly path: FrontierPath;
  readonly acceptance: FrontierAcceptance;
  /** Acceptance met — never "did not throw". */
  readonly success: boolean;
  /**
   * The run's terminal state from the existing failure model: `accepted`, a
   * `stopped:<reason>`, `failed`, or `refused` (no plan was available).
   */
  readonly reliabilityOutcome: string;
  readonly completedSteps: number;
  readonly callsSpent: number;
  /** Model tokens from the existing usage events. */
  readonly tokens: number;
  /** Cost from the existing rate accounting; absent when any call was unpriced. */
  readonly costMicros?: number;
  /** The platform's own clock-derived task duration. */
  readonly durationMs: number;
  /** Sum of the executed steps' measured latencies — the deterministic speed seam. */
  readonly stepLatencyMs: number;
}

export interface FrontierPathAggregate {
  readonly path: FrontierPath;
  /** Explicit denominator: scenarios attempted. */
  readonly attemptedTasks: number;
  readonly acceptedTasks: number;
  /** `acceptedTasks / attemptedTasks`; the denominator is stated above. */
  readonly reliability: number;
  readonly tokensPerAcceptedTask?: number;
  readonly costMicrosPerAcceptedTask?: number;
  /** Accepted tasks with an unpriced call, so cost is a lower bound, not a total. */
  readonly unpricedAcceptedTasks: number;
  readonly speedMsPerAcceptedTask?: number;
  readonly totalStepLatencyMs: number;
}

/** Plain measured differences (`multi - single`). No verdict, no score. */
export interface FrontierBenchmarkDifference {
  readonly acceptedTasks: number;
  readonly tokens: number;
  /** Absent when either path has an unpriced accepted run. */
  readonly costMicros?: number;
  readonly stepLatencyMs: number;
}

export interface FrontierBenchmarkResult {
  readonly measurements: readonly FrontierPathMeasurement[];
  readonly aggregates: readonly FrontierPathAggregate[];
  readonly difference: FrontierBenchmarkDifference;
}

function usageTokens(usage: AIUsage): number {
  return totalTokens(usage);
}

/** Capabilities declared by the models that produced a completed step. */
export function coveredCapabilities(
  scenario: FrontierBenchmarkScenario,
  result: OrchestrationResult,
): readonly string[] {
  const byId = new Map(scenario.models.map((model) => [model.modelId, model]));
  const covered = new Set<string>();
  for (const step of result.steps) {
    if (step.status !== "completed") {
      continue;
    }
    const model = byId.get(step.modelId);
    if (model === undefined) {
      continue;
    }
    for (const capability of model.capabilities) {
      covered.add(capability);
    }
  }
  return [...covered].sort();
}

/** The explicit, deterministic acceptance check. Identical for both paths. */
export function evaluateAcceptance(
  scenario: FrontierBenchmarkScenario,
  result: OrchestrationResult,
): FrontierAcceptance {
  const covered = coveredCapabilities(scenario, result);
  const coveredSet = new Set(covered);
  const missing = scenario.requiredCapabilities.filter(
    (capability) => !coveredSet.has(capability),
  );
  return {
    requiredCapabilities: [...scenario.requiredCapabilities],
    coveredCapabilities: covered,
    missingCapabilities: missing,
    met: missing.length === 0,
  };
}

function terminalOutcome(
  run: FrontierPathRun,
  result: OrchestrationResult | undefined,
): string {
  if (result === undefined) {
    return "refused";
  }
  if (result.stopReason !== undefined) {
    return `stopped:${result.stopReason}`;
  }
  return result.steps.some((step) => step.status === "failed")
    ? "failed"
    : "accepted";
}

/** Measures one path's run against one scenario. Pure. */
export function measureFrontierPath(
  scenario: FrontierBenchmarkScenario,
  path: FrontierPath,
  run: FrontierPathRun,
): FrontierPathMeasurement {
  if (!run.ran) {
    return {
      scenarioId: scenario.scenarioId,
      path,
      acceptance: {
        requiredCapabilities: [...scenario.requiredCapabilities],
        coveredCapabilities: [],
        missingCapabilities: [...scenario.requiredCapabilities],
        met: false,
      },
      success: false,
      reliabilityOutcome: "refused",
      completedSteps: 0,
      callsSpent: 0,
      tokens: 0,
      durationMs: 0,
      stepLatencyMs: 0,
    };
  }
  const result = run.result;
  const acceptance = evaluateAcceptance(scenario, result);
  const completedSteps = result.steps.filter(
    (step) => step.status === "completed",
  ).length;
  const stepLatencyMs = result.steps.reduce(
    (total, step) => total + step.latencyMs,
    0,
  );
  return {
    scenarioId: scenario.scenarioId,
    path,
    acceptance,
    success: acceptance.met,
    reliabilityOutcome: terminalOutcome(run, result),
    completedSteps,
    callsSpent: result.callsSpent,
    tokens: usageTokens(result.usage),
    ...(result.costMicros === undefined
      ? {}
      : { costMicros: result.costMicros }),
    durationMs: result.durationMs,
    stepLatencyMs,
  };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Aggregates one path over the scenario set. Denominators are explicit. */
export function aggregateFrontierPath(
  measurements: readonly FrontierPathMeasurement[],
  path: FrontierPath,
): FrontierPathAggregate {
  const rows = measurements.filter((measurement) => measurement.path === path);
  const attemptedTasks = rows.length;
  const accepted = rows.filter((row) => row.success);
  const acceptedTasks = accepted.length;
  const tokens = accepted.reduce((total, row) => total + row.tokens, 0);
  const unpricedAcceptedTasks = accepted.filter(
    (row) => row.costMicros === undefined,
  ).length;
  const costMicros = accepted.reduce(
    (total, row) => total + (row.costMicros ?? 0),
    0,
  );
  const stepLatencyMs = accepted.reduce(
    (total, row) => total + row.stepLatencyMs,
    0,
  );
  return {
    path,
    attemptedTasks,
    acceptedTasks,
    reliability: attemptedTasks === 0 ? 0 : acceptedTasks / attemptedTasks,
    ...(acceptedTasks === 0
      ? {}
      : { tokensPerAcceptedTask: round(tokens / acceptedTasks) }),
    ...(acceptedTasks === 0 || unpricedAcceptedTasks > 0
      ? {}
      : { costMicrosPerAcceptedTask: round(costMicros / acceptedTasks) }),
    unpricedAcceptedTasks,
    ...(acceptedTasks === 0
      ? {}
      : { speedMsPerAcceptedTask: round(stepLatencyMs / acceptedTasks) }),
    totalStepLatencyMs: stepLatencyMs,
  };
}

function aggregateOf(
  aggregates: readonly FrontierPathAggregate[],
  path: FrontierPath,
): FrontierPathAggregate | undefined {
  return aggregates.find((aggregate) => aggregate.path === path);
}

/**
 * Runs both paths over every scenario and returns the measurements, the per-path
 * aggregates and the plain difference. `runPath` is the caller's wiring of the real
 * orchestrator for each path; this module never constructs one.
 */
export async function runFrontierBenchmark(
  scenarios: readonly FrontierBenchmarkScenario[],
  runPath: (
    scenario: FrontierBenchmarkScenario,
    path: FrontierPath,
  ) => Promise<FrontierPathRun>,
): Promise<FrontierBenchmarkResult> {
  const measurements: FrontierPathMeasurement[] = [];
  for (const scenario of scenarios) {
    for (const path of FRONTIER_PATHS) {
      const run = await runPath(scenario, path);
      measurements.push(measureFrontierPath(scenario, path, run));
    }
  }
  const aggregates = FRONTIER_PATHS.map((path) =>
    aggregateFrontierPath(measurements, path),
  );
  return {
    measurements,
    aggregates,
    difference: differenceOf(aggregates),
  };
}

function differenceOf(
  aggregates: readonly FrontierPathAggregate[],
): FrontierBenchmarkDifference {
  const multi = aggregateOf(aggregates, "multi-model");
  const single = aggregateOf(aggregates, "single-model");
  const acceptedTasks =
    (multi?.acceptedTasks ?? 0) - (single?.acceptedTasks ?? 0);
  const tokens = acceptedTokens(multi) - acceptedTokens(single);
  const stepLatencyMs =
    (multi?.totalStepLatencyMs ?? 0) - (single?.totalStepLatencyMs ?? 0);
  const costMicros =
    multi?.costMicrosPerAcceptedTask === undefined ||
    single?.costMicrosPerAcceptedTask === undefined ||
    multi === undefined ||
    single === undefined
      ? undefined
      : multi.acceptedTasks * multi.costMicrosPerAcceptedTask -
        single.acceptedTasks * single.costMicrosPerAcceptedTask;
  return {
    acceptedTasks,
    tokens,
    ...(costMicros === undefined ? {} : { costMicros: round(costMicros) }),
    stepLatencyMs,
  };
}

function acceptedTokens(aggregate: FrontierPathAggregate | undefined): number {
  if (
    aggregate === undefined ||
    aggregate.tokensPerAcceptedTask === undefined
  ) {
    return 0;
  }
  return aggregate.tokensPerAcceptedTask * aggregate.acceptedTasks;
}

/** A catalog fixture, owned here so the scenarios are self-contained. */
function benchModel(
  overrides: Partial<ModelProfile> & {
    readonly modelId: string;
    readonly providerId: string;
  },
): ModelProfile {
  return {
    displayName: overrides.modelId,
    capabilities: ["general"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolCalling: false,
    structuredOutput: false,
    latencyClass: "standard",
    priority: 0,
    enabled: true,
    userOwned: false,
    health: "unknown",
    ...overrides,
  };
}

export const BENCH_TEXT_MODEL = benchModel({
  modelId: "bench/text-fast",
  providerId: "bench",
  displayName: "Bench Text Fast",
  capabilities: ["general", "reasoning", "coding"],
  latencyClass: "fast",
  priority: 10,
});

export const BENCH_VISION_MODEL = benchModel({
  modelId: "bench/vision",
  providerId: "bench",
  displayName: "Bench Vision",
  capabilities: ["vision", "reasoning"],
  inputModalities: ["text", "image"],
  latencyClass: "fast",
  priority: 5,
});

export const BENCH_OTHER_MODEL = benchModel({
  modelId: "bench/other-coding",
  providerId: "bench",
  displayName: "Bench Other Coding",
  capabilities: ["general", "reasoning", "coding"],
  latencyClass: "standard",
  priority: 0,
});

/**
 * The deterministic fixture set the tests drive.
 *
 * Small and auditable. Each scenario declares the capabilities its acceptance check
 * requires and the catalog both paths route over; the frontier scripts and decision
 * answers are supplied by the test, because they are I/O and must not live in a pure
 * measurement module.
 */
export const FRONTIER_BENCHMARK_SCENARIOS: readonly FrontierBenchmarkScenario[] =
  [
    {
      scenarioId: "coding-single-model",
      note: "a task one model satisfies: both paths plan a single step",
      title: "Fix the parser bug in src/parser.ts",
      requiredCapabilities: ["coding"],
      models: [BENCH_TEXT_MODEL, BENCH_OTHER_MODEL],
      mode: "balanced",
      maxModelCalls: 4,
      maxRetriesPerStep: 1,
    },
    {
      scenarioId: "vision-coding-split",
      note: "a task no single model covers: only the multi-model path can decompose",
      title: "Analyse this screenshot of the layout and fix the related code",
      requiredCapabilities: ["vision", "coding"],
      models: [BENCH_TEXT_MODEL, BENCH_VISION_MODEL],
      mode: "balanced",
      maxModelCalls: 4,
      maxRetriesPerStep: 1,
    },
    {
      scenarioId: "parallel-subtasks",
      note: "declared independent sub-tasks: the multi-model path can run them in parallel",
      title: "Fix the lexer and the parser",
      requiredCapabilities: ["coding"],
      models: [BENCH_TEXT_MODEL, BENCH_OTHER_MODEL],
      mode: "balanced",
      maxModelCalls: 4,
      maxRetriesPerStep: 1,
      subTasks: [
        {
          id: "lexer",
          instruction: "Fix the lexer",
          requiredCapabilities: ["coding"],
        },
        {
          id: "parser",
          instruction: "Fix the parser",
          requiredCapabilities: ["coding"],
        },
      ],
    },
    {
      scenarioId: "transient-retry",
      note: "a rate-limited first candidate: both paths may switch within the fixed set",
      title: "Fix the parser bug",
      requiredCapabilities: ["coding"],
      models: [BENCH_TEXT_MODEL, BENCH_OTHER_MODEL],
      mode: "balanced",
      maxModelCalls: 4,
      maxRetriesPerStep: 1,
    },
  ];
