import { fitsWithin } from "../context/budget.js";
import type { ContextSelection } from "../context/selection.js";
import {
  DEFAULT_BYTES_PER_TOKEN,
  estimateTokensFromBytes,
  estimateTokensFromText,
} from "../context/tokens.js";

/**
 * Comparative context-selection benchmark (V2-ARCHITECTURE §36.9).
 *
 * The evaluation gap §36.9 and §39.7 record is that the deterministic context engine
 * was only ever described by its own numbers: every selection records
 * `contextSelectionRatio` (`selectedTokens / candidateTokens`), but nothing compared
 * that ratio against an alternative selection strategy. This module closes that gap
 * narrowly and honestly.
 *
 * **What it measures — and what it does not.** The only question answered here is
 * *packing behaviour*: given one candidate set and one token budget, how much of the
 * candidate pool does the deterministic engine keep versus a naive packer? It says
 * nothing about usefulness, relevance or answer quality, and it must not be read as
 * claiming any. `contextSelectionRatio` is named for exactly what it measures, and a
 * file that survived selection was not thereby "needed".
 *
 * **Offline and pure.** The module never reads the network, a provider, Frontier, the
 * decision layer or the filesystem. It folds over an already-computed
 * `ContextSelection` plus the declared candidate set, so it is deterministic and
 * reproducible in a test. The engine that produces the `ContextSelection` is injected
 * by the caller (`runContextSelectionBenchmark`), which is how the benchmark feeds the
 * *existing* selector the same inputs rather than re-implementing it.
 *
 * **The baseline is deliberately naive.** It packs candidates in the order they are
 * declared and **stops at the first candidate that does not fit** — the simplest
 * "include everything that fits" strategy, with no ranking, no scoring, no embeddings
 * and no hidden heuristic. Comparing the engine against a strategy this plain is the
 * point: the engine's value shows up as files it keeps that a first-fit packer drops,
 * or as budget it declines to spend.
 */

export const CONTEXT_SELECTION_BENCHMARK_DATASET =
  "context-selection-benchmark";
export const CONTEXT_SELECTION_BENCHMARK_VERSION = "1.0.0";

/** One candidate fed to the selector and to the baseline, in declared order. */
export interface ContextBenchmarkCandidate {
  /** Workspace-relative POSIX path, exactly as the engine would discover it. */
  readonly ref: string;
  /** The file's text. Used to derive the content-based token count. */
  readonly content: string;
}

/**
 * One benchmark scenario: a task text, a budget, and a declared candidate set.
 *
 * `candidates` are ordered, and that order is the baseline's input order. The engine
 * is free to reorder them by its own deterministic ranking; the baseline is not.
 */
export interface ContextSelectionBenchmarkScenario {
  readonly scenarioId: string;
  /** Why this scenario exists, in one line. */
  readonly note: string;
  /** The task text the engine matches candidates against. */
  readonly taskText: readonly string[];
  /** Hard token budget, applied identically to the engine and the baseline. */
  readonly budgetTokens: number;
  /** Declared in deterministic input order: the baseline packs in this order. */
  readonly candidates: readonly ContextBenchmarkCandidate[];
}

/** What one strategy packed: the refs it kept and the content tokens they cost. */
export interface ContextPackedSelection {
  readonly refs: readonly string[];
  readonly selectedTokens: number;
}

/** One strategy's result, with the canonical ratio computed over the shared pool. */
export interface ContextSelectionStrategyResult extends ContextPackedSelection {
  /** `selectedTokens / candidateTokens`; 0 when nothing was considered. */
  readonly ratio: number;
}

/** The auditable result of one scenario, engine versus baseline. */
export interface ContextSelectionBenchmarkResult {
  readonly scenarioId: string;
  readonly note: string;
  readonly budgetTokens: number;
  /**
   * The shared denominator, taken from the engine's own selection so both strategies
   * are scored over the same candidate set. `declaredCandidateTokens` records the
   * same sum recomputed from the scenario, so a test can prove they agree.
   */
  readonly candidateTokens: number;
  /** Size-estimated tokens over the scenario's declared candidates. */
  readonly declaredCandidateTokens: number;
  readonly candidateRefs: readonly string[];
  readonly actual: ContextSelectionStrategyResult;
  readonly baseline: ContextSelectionStrategyResult;
  /** `actual.selectedTokens - baseline.selectedTokens`; positive means the engine kept more. */
  readonly tokenDelta: number;
  /** The refs the engine kept that the baseline dropped. */
  readonly keptByEngineOnly: readonly string[];
  /** The refs the baseline kept that the engine dropped. */
  readonly keptByBaselineOnly: readonly string[];
}

/**
 * The canonical selection ratio, matching `computeTaskMetrics` exactly.
 *
 * `selectedTokens / candidateTokens`, or 0 when nothing was considered. Named for
 * what it measures: how much of the considered context survived, which is not the
 * same as usefulness.
 */
export function contextSelectionRatio(
  selectedTokens: number,
  candidateTokens: number,
): number {
  return candidateTokens === 0 ? 0 : selectedTokens / candidateTokens;
}

/** Size-estimated tokens for one candidate, using the engine's own estimator. */
export function candidateSizeTokens(
  candidate: ContextBenchmarkCandidate,
  bytesPerToken: number = DEFAULT_BYTES_PER_TOKEN,
): number {
  return estimateTokensFromBytes(
    Buffer.byteLength(candidate.content, "utf8"),
    bytesPerToken,
  );
}

/** Sum of size-estimated tokens over a declared candidate set. */
export function declaredCandidateTokens(
  candidates: readonly ContextBenchmarkCandidate[],
  bytesPerToken: number = DEFAULT_BYTES_PER_TOKEN,
): number {
  return candidates.reduce(
    (total, candidate) => total + candidateSizeTokens(candidate, bytesPerToken),
    0,
  );
}

/**
 * The naive baseline: first-fit in declared order, stopping at the first miss.
 *
 * Iterate the candidates in the order they were declared and include each one while it
 * fits within the same budget; stop when the next candidate does not fit. No ranking,
 * no scoring, no reordering, no second pass. This is the "include everything that
 * fits" strategy made explicit, and `fitsWithin` is the engine's own arithmetic, so
 * the two strategies share one notion of "fits".
 */
export function naiveBaselineSelection(
  scenario: ContextSelectionBenchmarkScenario,
  bytesPerToken: number = DEFAULT_BYTES_PER_TOKEN,
): ContextPackedSelection {
  const refs: string[] = [];
  let used = 0;
  for (const candidate of scenario.candidates) {
    const tokens = estimateTokensFromText(candidate.content, bytesPerToken);
    if (!fitsWithin(scenario.budgetTokens, used, tokens)) {
      break;
    }
    refs.push(candidate.ref);
    used += tokens;
  }
  return { refs, selectedTokens: used };
}

function packActual(selection: ContextSelection): ContextPackedSelection {
  return {
    refs: selection.selected.map((entry) => entry.ref),
    selectedTokens: selection.selectedTokens,
  };
}

/**
 * Builds one auditable result from a scenario and the engine's own selection.
 *
 * The engine's `candidateTokens` is the shared denominator for both ratios, so the
 * comparison holds the candidate pool fixed and varies only the packing strategy.
 */
export function buildContextSelectionBenchmarkResult(input: {
  readonly scenario: ContextSelectionBenchmarkScenario;
  readonly selection: ContextSelection;
  readonly bytesPerToken?: number;
}): ContextSelectionBenchmarkResult {
  const bytesPerToken = input.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN;
  const candidateTokens = input.selection.candidateTokens;
  const actualPack = packActual(input.selection);
  const baselinePack = naiveBaselineSelection(input.scenario, bytesPerToken);
  const actualRefs = new Set(actualPack.refs);
  const baselineRefs = new Set(baselinePack.refs);
  return {
    scenarioId: input.scenario.scenarioId,
    note: input.scenario.note,
    budgetTokens: input.scenario.budgetTokens,
    candidateTokens,
    declaredCandidateTokens: declaredCandidateTokens(
      input.scenario.candidates,
      bytesPerToken,
    ),
    candidateRefs: input.scenario.candidates.map((candidate) => candidate.ref),
    actual: {
      ...actualPack,
      ratio: contextSelectionRatio(actualPack.selectedTokens, candidateTokens),
    },
    baseline: {
      ...baselinePack,
      ratio: contextSelectionRatio(
        baselinePack.selectedTokens,
        candidateTokens,
      ),
    },
    tokenDelta: actualPack.selectedTokens - baselinePack.selectedTokens,
    keptByEngineOnly: actualPack.refs.filter((ref) => !baselineRefs.has(ref)),
    keptByBaselineOnly: baselinePack.refs.filter((ref) => !actualRefs.has(ref)),
  };
}

/**
 * Runs the benchmark over a set of scenarios using an injected selector.
 *
 * `select` is how the *existing* engine is fed each scenario's exact inputs (task
 * text, candidates, budget); the module never constructs a selector of its own, so
 * there is no second implementation to drift from the production one. The scenarios
 * run in order and the results are returned in the same order, so the output is
 * deterministic.
 */
export async function runContextSelectionBenchmark(
  scenarios: readonly ContextSelectionBenchmarkScenario[],
  select: (
    scenario: ContextSelectionBenchmarkScenario,
  ) => Promise<ContextSelection>,
  options: { readonly bytesPerToken?: number } = {},
): Promise<readonly ContextSelectionBenchmarkResult[]> {
  const results: ContextSelectionBenchmarkResult[] = [];
  for (const scenario of scenarios) {
    const selection = await select(scenario);
    results.push(
      buildContextSelectionBenchmarkResult({
        scenario,
        selection,
        ...(options.bytesPerToken === undefined
          ? {}
          : { bytesPerToken: options.bytesPerToken }),
      }),
    );
  }
  return results;
}

/**
 * The deterministic fixture set the tests drive.
 *
 * Small and transparent on purpose: token counts are plain multiples of the default
 * four-bytes-per-token estimate, so every expected number can be verified by hand.
 * Each scenario uses only `.ts` source files whose names appear in the task text (so
 * each fires the `filename-token` signal and the engine's candidate set is exactly the
 * declared one), with no imports, no test siblings and no verification-config files —
 * so nothing beyond the declared candidates can enter either strategy's pool.
 */
export const CONTEXT_SELECTION_BENCHMARK_SCENARIOS: readonly ContextSelectionBenchmarkScenario[] =
  [
    {
      scenarioId: "all-candidates-fit",
      note: "every candidate fits: both strategies keep the whole pool",
      taskText: ["update alpha beta gamma"],
      budgetTokens: 1_000,
      candidates: [
        { ref: "src/alpha.ts", content: "a".repeat(40) },
        { ref: "src/beta.ts", content: "b".repeat(40) },
        { ref: "src/gamma.ts", content: "c".repeat(40) },
      ],
    },
    {
      scenarioId: "oversize-candidate-first",
      note: "an oversize candidate first in input order makes the naive packer stop before it reaches what fits",
      taskText: ["update alpha beta gamma"],
      budgetTokens: 25,
      candidates: [
        { ref: "src/big/gamma.ts", content: "g".repeat(400) },
        { ref: "src/small/alpha.ts", content: "a".repeat(40) },
        { ref: "src/small/beta.ts", content: "b".repeat(40) },
      ],
    },
    {
      scenarioId: "oversize-candidate-mid-order",
      note: "an oversize candidate in the middle truncates the naive packer's first-fit prefix",
      taskText: ["update alpha beta gamma"],
      budgetTokens: 25,
      candidates: [
        { ref: "src/alpha.ts", content: "a".repeat(40) },
        { ref: "src/gamma.ts", content: "c".repeat(400) },
        { ref: "src/beta.ts", content: "b".repeat(40) },
      ],
    },
    {
      scenarioId: "mixed-candidate-sizes",
      note: "mixed sizes: the engine packs what fits regardless of order, the baseline stops early",
      taskText: ["update alpha beta gamma delta"],
      budgetTokens: 30,
      candidates: [
        { ref: "src/alpha.ts", content: "a".repeat(40) },
        { ref: "src/delta.ts", content: "d".repeat(200) },
        { ref: "src/beta.ts", content: "b".repeat(80) },
        { ref: "src/gamma.ts", content: "c".repeat(20) },
      ],
    },
    {
      scenarioId: "empty-candidate-set",
      note: "no candidates: both ratios are zero by definition",
      taskText: ["update nothing"],
      budgetTokens: 100,
      candidates: [],
    },
  ];
