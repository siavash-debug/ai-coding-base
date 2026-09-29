import { describe, expect, it } from "vitest";

import {
  CONTEXT_SELECTION_BENCHMARK_SCENARIOS,
  buildContextSelectionBenchmarkResult,
  contextSelectionRatio,
  declaredCandidateTokens,
  naiveBaselineSelection,
  runContextSelectionBenchmark,
  type ContextSelectionBenchmarkScenario,
} from "../../src/evaluation/context-selection-benchmark.js";
import type { ContextSelection } from "../../src/context/selection.js";
import { createContextHarness } from "../support/context.js";

/**
 * The comparative context-selection benchmark (§36.9).
 *
 * Every assertion here is about *packing*: how much of a candidate pool each strategy
 * keeps under one shared budget. The benchmark is offline and deterministic — the
 * engine is the real deterministic context engine over an in-memory reader, with a
 * fixed clock and no provider, frontier or decision port anywhere in reach.
 */

function filesOf(
  scenario: ContextSelectionBenchmarkScenario,
): Record<string, string> {
  return Object.fromEntries(
    scenario.candidates.map((candidate) => [candidate.ref, candidate.content]),
  );
}

/** Feeds one scenario to the real engine and returns its own selection. */
async function selectScenario(
  scenario: ContextSelectionBenchmarkScenario,
): Promise<ContextSelection> {
  const harness = createContextHarness({ files: filesOf(scenario) });
  const { selection } = await harness.engine.select({
    taskText: scenario.taskText,
    budgetTokens: scenario.budgetTokens,
    // The benchmark measures packing, not recording: no event is written.
    record: false,
  });
  return selection;
}

async function runAll() {
  return await runContextSelectionBenchmark(
    CONTEXT_SELECTION_BENCHMARK_SCENARIOS,
    selectScenario,
  );
}

function resultFor(
  results: Awaited<ReturnType<typeof runAll>>,
  scenarioId: string,
) {
  const found = results.find((result) => result.scenarioId === scenarioId);
  if (found === undefined) {
    throw new Error(`no benchmark result for "${scenarioId}"`);
  }
  return found;
}

describe("comparative context-selection benchmark", () => {
  it("is deterministic: identical input produces identical output", async () => {
    const first = await runAll();
    const second = await runAll();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("computes the canonical ratio, and zero when nothing was considered", () => {
    expect(contextSelectionRatio(20, 120)).toBeCloseTo(1 / 6, 10);
    expect(contextSelectionRatio(0, 0)).toBe(0);
    expect(contextSelectionRatio(5, 0)).toBe(0);
  });

  it("keeps the whole pool when every candidate fits", async () => {
    const result = resultFor(await runAll(), "all-candidates-fit");
    expect(result.candidateTokens).toBe(30);
    expect(result.actual.selectedTokens).toBe(30);
    expect(result.baseline.selectedTokens).toBe(30);
    expect(result.actual.ratio).toBe(1);
    expect(result.baseline.ratio).toBe(1);
    expect(result.tokenDelta).toBe(0);
  });

  it("keeps what fits regardless of order where the naive packer stops early", async () => {
    const result = resultFor(await runAll(), "oversize-candidate-first");
    // Engine: the oversize candidate is excluded, then both small files are kept.
    expect(result.candidateTokens).toBe(120);
    expect(result.actual.selectedTokens).toBe(20);
    expect(result.actual.refs).toEqual([
      "src/small/alpha.ts",
      "src/small/beta.ts",
    ]);
    // Baseline: first-fit stops at the oversize file and keeps nothing.
    expect(result.baseline.selectedTokens).toBe(0);
    expect(result.baseline.refs).toEqual([]);
    expect(result.tokenDelta).toBe(20);
    expect(result.keptByEngineOnly).toEqual([
      "src/small/alpha.ts",
      "src/small/beta.ts",
    ]);
    expect(result.keptByBaselineOnly).toEqual([]);
  });

  it("shows the naive prefix truncated by a mid-order oversize candidate", async () => {
    const result = resultFor(await runAll(), "oversize-candidate-mid-order");
    expect(result.actual.selectedTokens).toBe(20);
    expect(result.baseline.selectedTokens).toBe(10);
    expect(result.tokenDelta).toBe(10);
    expect(result.keptByEngineOnly).toEqual(["src/beta.ts"]);
  });

  it("packs mixed sizes differently from a first-fit prefix", async () => {
    const result = resultFor(await runAll(), "mixed-candidate-sizes");
    expect(result.candidateTokens).toBe(85);
    expect(result.actual.selectedTokens).toBe(30);
    expect(result.baseline.selectedTokens).toBe(10);
    expect(result.tokenDelta).toBe(20);
  });

  it("handles an empty candidate set without dividing by zero", async () => {
    const result = resultFor(await runAll(), "empty-candidate-set");
    expect(result.candidateTokens).toBe(0);
    expect(result.actual.selectedTokens).toBe(0);
    expect(result.baseline.selectedTokens).toBe(0);
    expect(result.actual.ratio).toBe(0);
    expect(result.baseline.ratio).toBe(0);
  });

  it("never exceeds the shared budget on either side", async () => {
    for (const result of await runAll()) {
      expect(result.actual.selectedTokens).toBeLessThanOrEqual(
        result.budgetTokens,
      );
      expect(result.baseline.selectedTokens).toBeLessThanOrEqual(
        result.budgetTokens,
      );
      // The engine never keeps more of the pool than it was allowed to.
      expect(result.actual.selectedTokens).toBeLessThanOrEqual(
        result.candidateTokens,
      );
    }
  });

  it("evaluates both strategies against the same candidate set", async () => {
    for (const result of await runAll()) {
      // The declared pool and the engine's own pool are the same tokens.
      expect(result.declaredCandidateTokens).toBe(result.candidateTokens);
      // And every ref either strategy kept came from that same declared pool.
      const pool = new Set(result.candidateRefs);
      for (const ref of [...result.actual.refs, ...result.baseline.refs]) {
        expect(pool.has(ref)).toBe(true);
      }
    }
  });

  it("contains at least one scenario where the strategies differ", async () => {
    const differing = (await runAll()).filter(
      (result) => result.tokenDelta !== 0,
    );
    expect(differing.length).toBeGreaterThan(0);
  });

  it("never writes an event, and reads only candidate files", async () => {
    const scenario = CONTEXT_SELECTION_BENCHMARK_SCENARIOS[1];
    const harness = createContextHarness({ files: filesOf(scenario) });
    const { selection } = await harness.engine.select({
      taskText: scenario.taskText,
      budgetTokens: scenario.budgetTokens,
      record: false,
    });
    // No event was recorded: the benchmark performs nothing.
    expect(harness.store.events).toHaveLength(0);
    // The only reads are the candidates themselves (plus the `.gitignore` probe).
    const nonGitignore = harness.fakeReader.readLog.filter(
      (ref) => ref !== ".gitignore",
    );
    expect(new Set(nonGitignore)).toEqual(
      new Set(scenario.candidates.map((candidate) => candidate.ref)),
    );
    // The result carries no provider, usage or cost surface.
    const json = JSON.stringify(
      buildContextSelectionBenchmarkResult({ scenario, selection }),
    );
    expect(json).not.toMatch(/provider|usage|cost|apiKey|prompt/i);
  });
});

describe("naive baseline packer", () => {
  const scenario: ContextSelectionBenchmarkScenario = {
    scenarioId: "unit",
    note: "hand-checked",
    taskText: ["x"],
    budgetTokens: 25,
    candidates: [
      { ref: "a.ts", content: "a".repeat(40) }, // 10 tokens
      { ref: "big.ts", content: "b".repeat(400) }, // 100 tokens
      { ref: "c.ts", content: "c".repeat(40) }, // 10 tokens
    ],
  };

  it("includes candidates in declared order while they fit", () => {
    expect(naiveBaselineSelection(scenario)).toEqual({
      refs: ["a.ts"],
      selectedTokens: 10,
    });
  });

  it("stops at the first candidate that does not fit", () => {
    // `c.ts` would fit if the packer skipped `big.ts`, but it does not skip.
    const packed = naiveBaselineSelection(scenario);
    expect(packed.refs).not.toContain("c.ts");
    expect(packed.selectedTokens).toBeLessThanOrEqual(scenario.budgetTokens);
  });

  it("uses the engine's own size estimator for the declared pool", () => {
    expect(declaredCandidateTokens(scenario.candidates)).toBe(120);
  });
});
