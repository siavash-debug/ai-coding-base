import type { DecisionDomain } from "../../src/decisions/domains.js";
import type { DecisionOption } from "../../src/decisions/decision.js";

/**
 * The Decision Brain benchmark dataset: typed cases derived from real production
 * decision questions.
 *
 * **Where the cases come from.** Every case's `question`, `options`, `reasonCodes`
 * and `context` are produced by the production `build*Spec` functions
 * (`src/decisions/domains.ts`) over representative production inputs — the same
 * inputs the orchestrator, coordinator and tool registry hand those builders in a
 * real run (`buildRoutingSpec` over registered routes, `buildRetrySpec` over a real
 * LLM failure taxonomy value, `buildToolSelectionSpec` over the runtime's two real
 * tools, `buildRankingSpec` over the registry's model profiles, etc.). The cases are
 * therefore *derived* from production code, not invented prose: the option ids are
 * the ids the platform actually offers, the risk baselines are the policy's own
 * `baselineRiskForOperation` values, and the failure kinds are the shared taxonomy
 * values.
 *
 * **Label honesty.** Labels are authored (a human statement of what the right answer
 * is, written into this file with its source), never copied from any model. Where an
 * answer is a judgement call with no defensible single answer, the case is carried
 * `unlabeled` and participates only in agreement analysis. Deterministic-expectation
 * is recorded separately from the label: it is what the production deterministic
 * gate answers, which is frequently "no rule" — a state, not a label.
 *
 * **What never enters a case:** raw prompts beyond the bounded spec question, secret
 * values, credential-shaped strings, and model outputs of any kind. Case state is
 * bounded by the same `MAX_DECISION_*` limits the spec validators enforce.
 */

export const BENCHMARK_SCHEMA_VERSION = 2 as const;
/** The dataset name, printed by the benchmark command. */
export const BENCHMARK_DATASET_NAME = "decision-brain-benchmark";
export const BENCHMARK_DATASET_VERSION = "2.0.0";

/**
 * The size of the legacy authored benchmark this dataset supersedes.
 *
 * The benchmark command refuses to present a dataset this small as the large
 * benchmark: if the resolved case count is this value, the command says
 * "LEGACY 36-CASE BENCHMARK" and exits non-zero instead of silently
 * substituting the old slice.
 */
export const LEGACY_CASE_COUNT = 36;

/** True when the given case list is only the legacy authored slice. */
export function isLegacyDataset(
  cases: readonly { readonly source: CaseSource }[],
): boolean {
  return cases.length <= LEGACY_CASE_COUNT;
}

/** Where a case came from — closed vocabulary, never silently mixed. */
export const CASE_SOURCES = [
  /** Built by the production spec builders over representative production inputs. */
  "derived-production-spec",
  /**
   * The state appears in, or is the direct parameter family of, an input the
   * repo's own test suite builds with the production builders
   * (`tests/unit/decision-domains.test.ts`, `tests/support/decisions.ts`).
   * Where a test asserts the deterministic gate's answer, the label authority
   * is DETERMINISTIC_POLICY; judgment labels stay GROUND_TRUTH with the rule
   * noted.
   */
  "test-derived",
  /** Authored by hand for this benchmark, following the production shapes. */
  "synthetic-authored",
] as const;
export type CaseSource = (typeof CASE_SOURCES)[number];

/**
 * The four answer authorities the benchmark distinguishes (Part 4 of the charter).
 *
 * `groundTruth: "unavailable"` is an explicit, honest state: most platform decision
 * domains are judgement calls with no independently-known right answer, and writing
 * "the TypeSafe answer" into the ground-truth column would launder an opinion into
 * a fact.
 */
export const LABEL_AUTHORITIES = [
  "GROUND_TRUTH",
  "DETERMINISTIC_POLICY",
  "TYPESAFE",
] as const;
export type LabelAuthority = (typeof LABEL_AUTHORITIES)[number];

/** Structural difficulty tiers. Never derived from any model's confidence. */
export const DIFFICULTY_TIERS = [
  "easy",
  "medium",
  "hard",
  "ambiguous",
  "unlabeled",
] as const;
export type DifficultyTier = (typeof DIFFICULTY_TIERS)[number];

/**
 * Ground-truth status of a case, as the charter's schema requires.
 *
 * `verified` — a label exists with an authority that does not derive from a
 * model's own output. `ambiguous` — the bounded state genuinely underdetermines
 * the answer (more than one answer equally defensible); carried unlabeled and
 * excluded from accuracy. `unavailable` — no defensible label was authored.
 */
export const GROUND_TRUTH_STATUSES = [
  "verified",
  "unavailable",
  "ambiguous",
] as const;
export type GroundTruthStatus = (typeof GROUND_TRUTH_STATUSES)[number];

export function groundTruthStatusOf(
  c: DecisionBenchmarkCase,
): GroundTruthStatus {
  if (c.evaluationLabel.kind === "labeled") {
    return "verified";
  }
  return c.difficulty === "ambiguous" ? "ambiguous" : "unavailable";
}

/** What the deterministic gate would answer, and whether it can. */
export type DeterministicState =
  | { readonly kind: "clear"; readonly optionId: string; readonly reasonCode: string }
  | { readonly kind: "no-applicable-rule" };

/** The label: what the case should be scored against, and who says so. */
export type EvaluationLabel =
  | {
      readonly kind: "labeled";
      readonly optionId: string;
      readonly authority: LabelAuthority;
      /** Why the label holds. Authored, never a model output. */
      readonly note?: string;
    }
  | { readonly kind: "unlabeled" };

/** Minimum state to reproduce one bounded decision. */
export interface DecisionBenchmarkCase {
  readonly caseId: string;
  readonly domain: DecisionDomain;
  /** Bounded question state, identical in shape to the production spec's. */
  readonly state: {
    readonly question: string;
    readonly context: readonly string[];
    readonly ranked: boolean;
  };
  readonly options: readonly DecisionOption[];
  readonly reasonCodes: readonly string[];
  /** What the production deterministic gate answers for this state. */
  readonly deterministicExpectation: DeterministicState;
  readonly evaluationLabel: EvaluationLabel;
  readonly source: CaseSource;
  readonly difficulty: DifficultyTier;
  /** Why the label holds, when one exists. Never a model output. */
  readonly labelNote?: string;
  readonly metadata: {
    /** Structural difficulty evidence (option count, conflicting signals, ...). */
    readonly signals: readonly string[];
  };
}

/** Model answers, stored separately from cases and never inside them. */
export interface ModelVerdict {
  readonly outcome: "selected" | "abstained" | "failed";
  readonly selectedOptionId?: string;
  readonly ranking?: readonly string[];
  readonly confidence?: number;
  /** Distribution over the case's option ids, when the model supplied one. */
  readonly distribution?: Readonly<Record<string, number>>;
  readonly latencyMs?: number;
  readonly providerId?: string;
  /** Flattened provenance (`live-sdk` | `test-double`). */
  readonly executionSource?: string;
  /** Coarse failure category only; never a provider's own message. */
  readonly failureKind?: string;
}

/** Per-domain accounting for the dataset, computed by `benchmarkDatasetAccounting`. */
export interface DomainAccounting {
  readonly domain: DecisionDomain;
  readonly total: number;
  readonly labeled: number;
  readonly unlabeled: number;
  /** option id -> count, so class imbalance is visible without reading state. */
  readonly classDistribution: Readonly<Record<string, number>>;
  readonly sourceDistribution: Readonly<Record<CaseSource, number>>;
  readonly difficultyDistribution: Readonly<Record<DifficultyTier, number>>;
}

/** Whole-dataset accounting: counts and the duplicate report, no case content. */
export interface DatasetAccounting {
  readonly schemaVersion: number;
  readonly datasetVersion: string;
  readonly totalCases: number;
  readonly labeledCases: number;
  readonly unlabeledCases: number;
  readonly domains: readonly DomainAccounting[];
  /** caseIds seen more than once (a stable-id collision would be a bug). */
  readonly duplicateCaseIds: readonly string[];
  /** Question+context fingerprints shared by more than one case. */
  readonly duplicateStateFingerprints: readonly string[];
}

/**
 * Field names that must never appear on any serializable benchmark surface.
 *
 * The guard is runtime-enforced on every artifact this phase writes: if a future
 * edit adds one of these names to the emitted JSON, the benchmark command fails
 * instead of writing the file. Keys are matched exactly; nested objects recurse.
 */
export const FORBIDDEN_ARTIFACT_FIELDS = [
  "apiKey",
  "api_key",
  "authorization",
  "credential",
  "token",
  "prompt",
  "rawResponse",
  "raw_response",
  "reasoning",
  "secret",
  "password",
] as const;

/**
 * True when a JSON-ready value carries a forbidden field name anywhere in its
 * structure. Arrays recurse; primitives are safe. This is the last-line guard
 * before a benchmark artifact reaches disk.
 */
export function containsForbiddenField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenField);
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if ((FORBIDDEN_ARTIFACT_FIELDS as readonly string[]).includes(key)) {
        return true;
      }
      if (containsForbiddenField(child)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Structural accounting over the dataset: counts, class balance, source split and
 * duplicate detection. Pure and content-free — the output is safe to print.
 */
export function benchmarkDatasetAccounting(
  cases: readonly DecisionBenchmarkCase[],
): DatasetAccounting {
  const byDomain = new Map<DecisionDomain, DecisionBenchmarkCase[]>();
  for (const c of cases) {
    const bucket = byDomain.get(c.domain) ?? [];
    bucket.push(c);
    byDomain.set(c.domain, bucket);
  }
  const domains: DomainAccounting[] = [...byDomain.entries()].map(
    ([domain, bucket]) => {
      const classDistribution: Record<string, number> = {};
      const sourceDistribution: Record<CaseSource, number> = {
        "derived-production-spec": 0,
        "test-derived": 0,
        "synthetic-authored": 0,
      };
      const difficultyDistribution: Record<DifficultyTier, number> = {
        easy: 0,
        medium: 0,
        hard: 0,
        ambiguous: 0,
        unlabeled: 0,
      };
      let labeled = 0;
      for (const c of bucket) {
        if (c.evaluationLabel.kind === "labeled") {
          labeled += 1;
          classDistribution[c.evaluationLabel.optionId] =
            (classDistribution[c.evaluationLabel.optionId] ?? 0) + 1;
        }
        sourceDistribution[c.source] += 1;
        difficultyDistribution[c.difficulty] += 1;
      }
      return {
        domain,
        total: bucket.length,
        labeled,
        unlabeled: bucket.length - labeled,
        classDistribution,
        sourceDistribution,
        difficultyDistribution,
      };
    },
  );
  const idCounts = new Map<string, number>();
  const stateCounts = new Map<string, number>();
  for (const c of cases) {
    idCounts.set(c.caseId, (idCounts.get(c.caseId) ?? 0) + 1);
    const fingerprint = stateFingerprintOf(c);
    stateCounts.set(fingerprint, (stateCounts.get(fingerprint) ?? 0) + 1);
  }
  const duplicates = (counts: Map<string, number>): string[] =>
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([key]) => key);
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    datasetVersion: BENCHMARK_DATASET_VERSION,
    totalCases: cases.length,
    labeledCases: cases.filter(
      (c) => c.evaluationLabel.kind === "labeled",
    ).length,
    unlabeledCases: cases.filter(
      (c) => c.evaluationLabel.kind === "unlabeled",
    ).length,
    domains,
    duplicateCaseIds: duplicates(idCounts),
    duplicateStateFingerprints: duplicates(stateCounts),
  };
}

/**
 * The state fingerprint used for duplicate detection: domain + question +
 * context, joined with control characters so no field boundary can collide.
 * Exported because the research corpus reports duplicate-state case ids, and
 * the two computations must never drift apart.
 */
export function stateFingerprintOf(c: DecisionBenchmarkCase): string {
  return `${c.domain}\u0000${c.state.question}\u0000${c.state.context.join("\u0001")}`;
}

/**
 * Case ids whose state fingerprint appears more than once in the dataset — the
 * pre-split leakage risk the error taxonomy counts as `data-error`. Ids only:
 * the fingerprints themselves (and all case content) stay out of artifacts.
 */
export function duplicateStateCaseIdsOf(
  cases: readonly DecisionBenchmarkCase[],
): readonly string[] {
  const byFingerprint = new Map<string, string[]>();
  for (const c of cases) {
    const key = stateFingerprintOf(c);
    const bucket = byFingerprint.get(key) ?? [];
    bucket.push(c.caseId);
    byFingerprint.set(key, bucket);
  }
  return [...byFingerprint.values()]
    .filter((ids) => ids.length > 1)
    .flat();
}

import { createHash } from "node:crypto";

/** Stable case id: domain + index + short content hash, so ids survive reorders. */
export function stableCaseId(
  domain: DecisionDomain,
  index: number,
  question: string,
  context: readonly string[],
): string {
  const hash = createHash("sha256")
    .update(`${domain}\u0000${question}\u0000${context.join("\u0001")}`)
    .digest("hex")
    .slice(0, 8);
  return `case-${domain}-${String(index).padStart(3, "0")}-${hash}`;
}

/**
 * The deterministic gate the production engine runs (ADR-051), re-expressed over
 * the recorded `deterministicExpectation`. This is *not* a reimplementation used for
 * scoring: the value was captured from the production builders at dataset build
 * time, and this helper only distinguishes "the gate has an answer" from "it does
 * not" for the value-over-deterministic analysis.
 */
export function deterministicAnswerOf(
  c: DecisionBenchmarkCase,
): DeterministicState {
  return c.deterministicExpectation;
}
