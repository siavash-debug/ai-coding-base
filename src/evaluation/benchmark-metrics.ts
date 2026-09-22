import type { DecisionDomain } from "../../src/decisions/domains.js";
import {
  containsForbiddenField,
  type DecisionBenchmarkCase,
  type EvaluationLabel,
  type ModelVerdict,
} from "./decision-benchmark.js";

/**
 * Benchmark metrics: accuracy, agreement, calibration, selective prediction,
 * risk-asymmetric errors, and value over deterministic policy.
 *
 * **Pure and content-free.** Every function here is a fold over already-recorded
 * verdicts (see `ModelVerdict`) plus the case's label/deterministic state. Nothing
 * reads a model, a clock, the network or a secret, so the whole module is unit-
 * testable offline and its outputs are safe to print.
 *
 * **Label honesty.** Accuracy is computed only over labeled cases whose authority
 * is `GROUND_TRUTH` — the one authority that says what is right rather than what
 * some decision source said. Agreement with TypeSafe or with the deterministic
 * gate is reported separately and never called accuracy.
 */

/* ------------------------------------------------------------------ helpers */

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

function round(value: number | undefined, digits = 4): number | undefined {
  return value === undefined
    ? undefined
    : Math.round(value * 10 ** digits) / 10 ** digits;
}

function selectedId(verdict: ModelVerdict | undefined): string | undefined {
  return verdict !== undefined && verdict.outcome === "selected"
    ? verdict.selectedOptionId
    : undefined;
}

/** The top-1 answer for ranked questions: ranking[0] when present. */
function topId(verdict: ModelVerdict | undefined): string | undefined {
  if (verdict === undefined || verdict.outcome !== "selected") {
    return undefined;
  }
  return verdict.selectedOptionId ?? verdict.ranking?.[0];
}

export function isLabeledGroundTruth(label: EvaluationLabel): boolean {
  return (
    label.kind === "labeled" &&
    (label.authority === "GROUND_TRUTH" ||
      label.authority === "DETERMINISTIC_POLICY")
  );
}

/* ------------------------------------------------------------------- inputs */

/**
 * One scored case: the benchmark case's *structural* fields plus the recorded
 * model verdicts. Rebuilt (rather than importing `DecisionBenchmarkCase`) so the
 * metrics module never needs case state to do its work — evaluation consumes
 * ids, labels and verdicts only.
 */
export interface BenchmarkCaseRef {
  readonly caseId: string;
  readonly domain: DecisionDomain;
  readonly label: EvaluationLabel;
  readonly deterministicExpectation:
    | { readonly kind: "clear"; readonly optionId: string; readonly reasonCode: string }
    | { readonly kind: "no-applicable-rule" };
  readonly subject: ModelVerdict;
  readonly typesafe?: ModelVerdict;
}

/* ----------------------------------------------------------------- accuracy */

export interface AccuracyMetrics {
  readonly labeledCount: number;
  readonly correctCount?: number;
  readonly accuracy?: number;
  /** Confusion matrix over the label vocabulary of the evaluated slice. */
  readonly confusion?: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/**
 * Accuracy over ground-truth-labeled cases. Ranked questions are scored top-1 —
 * the label records the first pick and never a full ordering.
 */
export function accuracyOver(
  refs: readonly BenchmarkCaseRef[],
): AccuracyMetrics {
  const labeled = refs.filter(
    (ref) =>
      ref.subject.outcome !== "failed" &&
      isLabeledGroundTruth(ref.label) &&
      topId(ref.subject) !== undefined,
  );
  if (labeled.length === 0) {
    return { labeledCount: 0 };
  }
  let correct = 0;
  const confusion: Record<string, Record<string, number>> = {};
  for (const ref of labeled) {
    const expected = ref.label.kind === "labeled" ? ref.label.optionId : "";
    const actual = topId(ref.subject) ?? "";
    confusion[expected] ??= {};
    confusion[expected][actual] = (confusion[expected][actual] ?? 0) + 1;
    if (expected === actual) {
      correct += 1;
    }
  }
  return {
    labeledCount: labeled.length,
    correctCount: correct,
    accuracy: round(correct / labeled.length),
    confusion,
  };
}

/* ---------------------------------------------------------------- agreement */

export interface AgreementMetrics {
  readonly comparableCount: number;
  readonly agreeCount?: number;
  readonly agreement?: number;
}

/**
 * Agreement between two answer sources over cases where BOTH selected an option.
 * Deliberately never called accuracy: without a ground-truth column, agreement is
 * just overlap between two opinions.
 */
export function agreementOver(
  refs: readonly BenchmarkCaseRef[],
  pickLeft: (ref: BenchmarkCaseRef) => string | undefined,
  pickRight: (ref: BenchmarkCaseRef) => string | undefined,
): AgreementMetrics {
  const comparable = refs.filter(
    (ref) => pickLeft(ref) !== undefined && pickRight(ref) !== undefined,
  );
  if (comparable.length === 0) {
    return { comparableCount: 0 };
  }
  const agreeCount = comparable.filter(
    (ref) => pickLeft(ref) === pickRight(ref),
  ).length;
  return {
    comparableCount: comparable.length,
    agreeCount,
    agreement: round(agreeCount / comparable.length),
  };
}

export function modelVsDeterministic(
  refs: readonly BenchmarkCaseRef[],
): AgreementMetrics {
  return agreementOver(
    refs,
    (ref) => topId(ref.subject),
    (ref) =>
      ref.deterministicExpectation.kind === "clear"
        ? ref.deterministicExpectation.optionId
        : undefined,
  );
}

export function modelVsTypesafe(refs: readonly BenchmarkCaseRef[]): AgreementMetrics {
  return agreementOver(refs, (ref) => topId(ref.subject), (ref) =>
    selectedId(ref.typesafe),
  );
}

export function typesafeVsDeterministic(
  refs: readonly BenchmarkCaseRef[],
): AgreementMetrics {
  return agreementOver(
    refs,
    (ref) => selectedId(ref.typesafe),
    (ref) =>
      ref.deterministicExpectation.kind === "clear"
        ? ref.deterministicExpectation.optionId
        : undefined,
  );
}

/**
 * The benchmark slice live TypeSafe is consulted on: only cases where the
 * production decision architecture would actually consult it — the labeled,
 * gate-unavailable rows. Deterministic-gate-covered and unlabeled cases stay
 * out; a benchmark never manufactures traffic to inflate the dataset.
 */
export function typeSafeEligibleCases(
  cases: readonly DecisionBenchmarkCase[],
): readonly DecisionBenchmarkCase[] {
  return cases.filter(
    (c) =>
      isLabeledGroundTruth(c.evaluationLabel) &&
      c.deterministicExpectation.kind === "no-applicable-rule",
  );
}

/* -------------------------------------------------------------- calibration */

/** A reliability bucket: confidence range, share of cases, observed accuracy. */
export interface ReliabilityBucket {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly meanConfidence: number;
  readonly accuracy: number;
}

export interface CalibrationMetrics {
  readonly scoredCount: number;
  readonly brier?: number;
  readonly ece?: number;
  readonly reliability: readonly ReliabilityBucket[];
  readonly meanConfidence?: number;
}

/**
 * Confidence that the top-1 pick is correct, when the verdict carries a
 * distribution; falls back to the verdict's own `confidence` when it does not.
 */
function topConfidence(verdict: ModelVerdict): number | undefined {
  if (verdict.outcome !== "selected") {
    return undefined;
  }
  const top = topId(verdict);
  if (top === undefined) {
    return undefined;
  }
  const fromDistribution = verdict.distribution?.[top];
  return fromDistribution ?? verdict.confidence;
}

/**
 * Brier and ECE over ground-truth-labeled cases, using P(top-1 correct) as the
 * confidence. Binning is 10 equal-width buckets over [0,1], lower-exclusive,
 * upper-inclusive except the first, which also catches exactly 0 — the standard
 * convention that keeps every probability in exactly one bucket.
 */
export function calibrationOver(
  refs: readonly BenchmarkCaseRef[],
  bins = 10,
): CalibrationMetrics {
  const scored: { confidence: number; correct: 0 | 1 }[] = refs.flatMap(
    (ref) => {
      const confidence = topConfidence(ref.subject);
      const top = topId(ref.subject);
      if (
        ref.subject.outcome === "failed" ||
        confidence === undefined ||
        top === undefined ||
        !isLabeledGroundTruth(ref.label)
      ) {
        return [];
      }
      const correct: 0 | 1 =
        ref.label.kind === "labeled" && ref.label.optionId === top ? 1 : 0;
      return [{ confidence, correct }];
    },
  );
  if (scored.length === 0) {
    return { scoredCount: 0, reliability: [] };
  }
  const brier = mean(scored.map(({ confidence, correct }) => (confidence - correct) ** 2));
  const reliability: ReliabilityBucket[] = [];
  let ece = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    const lower = bin / bins;
    const upper = (bin + 1) / bins;
    const inBin = scored.filter(
      ({ confidence }, index) =>
        index >= 0 &&
        (bin === 0
          ? confidence >= lower && confidence <= upper
          : confidence > lower && confidence <= upper),
    );
    if (inBin.length === 0) {
      continue;
    }
    const meanConfidence = mean(inBin.map(({ confidence }) => confidence)) ?? 0;
    const accuracy = mean(inBin.map(({ correct }) => correct)) ?? 0;
    reliability.push({
      lower,
      upper,
      count: inBin.length,
      meanConfidence: round(meanConfidence) ?? 0,
      accuracy: round(accuracy) ?? 0,
    });
    ece += (inBin.length / scored.length) * Math.abs(meanConfidence - accuracy);
  }
  return {
    scoredCount: scored.length,
    ...(brier === undefined ? {} : { brier: round(brier) }),
    ece: round(ece),
    reliability,
    meanConfidence: round(mean(scored.map(({ confidence }) => confidence))),
  };
}

/* --------------------------------------------------- selective prediction */

export const SELECTIVE_PREDICTION_THRESHOLDS = [
  0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95,
] as const;

export interface ThresholdSimulation {
  readonly threshold: number;
  /** Cases the evaluated model would handle (confidence ≥ threshold). */
  readonly handled: number;
  /** Cases the evaluated model would abstain on — the simulated TypeSafe fallbacks. */
  readonly fallbackToTypesafe: number;
  readonly abstentionRate?: number;
  /** Accuracy on accepted cases where ground truth exists. */
  readonly accuracyOnAccepted?: number;
  /** Accepted AND wrong, over ground-truth-labeled accepted cases. */
  readonly falseAcceptRate?: number;
  /** Ground-truth-correct cases the gate would have rejected. */
  readonly falseAbstainCount?: number;
  readonly typeSafeFallbacks: number;
}

/**
 * Simulated abstention ONLY — a production confidence gate is not built, not
 * wired, and not recommended by this function's mere existence. The gate is
 * evaluated on P(top-1 correct), computed from the recorded distribution, and
 * false-accept/false-abstain are reported only where ground truth exists.
 */
export function simulateSelectivePrediction(
  refs: readonly BenchmarkCaseRef[],
  thresholds: readonly number[] = SELECTIVE_PREDICTION_THRESHOLDS,
): ThresholdSimulation[] {
  return thresholds.map((threshold) => {
    const accepted = refs.filter((ref) => {
      const confidence = topConfidence(ref.subject);
      return (
        ref.subject.outcome === "selected" &&
        confidence !== undefined &&
        confidence >= threshold
      );
    });
    const acceptedWithTruth = accepted.filter(
      (ref) => isLabeledGroundTruth(ref.label) && topId(ref.subject) !== undefined,
    );
    const acceptedCorrect = acceptedWithTruth.filter(
      (ref) =>
        ref.label.kind === "labeled" && ref.label.optionId === topId(ref.subject),
    );
    const correctButAbstained = refs.filter((ref) => {
      const confidence = topConfidence(ref.subject);
      return (
        ref.label.kind === "labeled" &&
        isLabeledGroundTruth(ref.label) &&
        ref.subject.outcome === "selected" &&
        ref.label.optionId === topId(ref.subject) &&
        (confidence === undefined || confidence < threshold)
      );
    });
    return {
      threshold,
      handled: accepted.length,
      fallbackToTypesafe: refs.length - accepted.length,
      abstentionRate: round((refs.length - accepted.length) / Math.max(1, refs.length)),
      ...(acceptedWithTruth.length > 0
        ? {
            accuracyOnAccepted: round(
              acceptedCorrect.length / acceptedWithTruth.length,
            ),
            falseAcceptRate: round(
              (acceptedWithTruth.length - acceptedCorrect.length) /
                acceptedWithTruth.length,
            ),
          }
        : {}),
      ...(correctButAbstained.length > 0 || acceptedWithTruth.length > 0
        ? { falseAbstainCount: correctButAbstained.length }
        : {}),
      typeSafeFallbacks: refs.length - accepted.length,
      estimatedLocalDecisions: accepted.length,
    };
  });
}

/* ------------------------------------------------------ risk-asymmetric */

export interface RiskErrorBreakdown {
  /** Labeled cases evaluated in the risk-sensitive domains. */
  readonly evaluated: number;
  /** Predicted safe when truth says risky (escalate/review/stop/high+). */
  readonly falseSafe?: number;
  /** Predicted risky when truth says safe. */
  readonly falseEscalation?: number;
  /** Predicted retry when truth says stop/escalate. */
  readonly falseRetry?: number;
  /** Predicted stop when truth says retry. */
  readonly falseStop?: number;
}

/**
 * Risk-asymmetric error counts for the three risk-sensitive domains. The two
 * error directions are NOT collapsed: a false "safe" on a critical operation and
 * a false "escalate" on a routine one are different failures with different
 * costs, and the report shows them separately.
 */
export function riskErrorBreakdown(
  refs: readonly BenchmarkCaseRef[],
): RiskErrorBreakdown {
  const riskyDomains = new Set(["risk-assessment", "human-escalation", "retry"]);
  const evaluated = refs.filter(
    (ref) =>
      riskyDomains.has(ref.domain) &&
      isLabeledGroundTruth(ref.label) &&
      ref.subject.outcome !== "failed" &&
      topId(ref.subject) !== undefined,
  );
  const counts = { falseSafe: 0, falseEscalation: 0, falseRetry: 0, falseStop: 0 };
  for (const ref of evaluated) {
    if (ref.label.kind !== "labeled") {
      continue;
    }
    const expected = ref.label.optionId;
    const actual = topId(ref.subject) ?? "";
    const RISKY = new Set(["high", "critical", "review", "escalate"]);
    const SAFE = new Set(["low", "medium", "no-review"]);
    if (expected === actual) {
      continue;
    }
    if (ref.domain === "retry") {
      if (expected === "retry" && (actual === "stop" || actual === "escalate")) {
        counts.falseStop += 1;
      } else if (expected !== "retry" && actual === "retry") {
        counts.falseRetry += 1;
      }
      continue;
    }
    if (RISKY.has(expected) && SAFE.has(actual)) {
      counts.falseSafe += 1;
    } else if (SAFE.has(expected) && RISKY.has(actual)) {
      counts.falseEscalation += 1;
    }
  }
  const hasRisk = evaluated.length > 0;
  return {
    evaluated: evaluated.length,
    ...(hasRisk ? counts : {}),
  };
}

/* --------------------------------------------- value over deterministic */

export interface ValueOverDeterministic {
  /** Ground-truth-labeled cases where the gate had no rule (the interesting slice). */
  readonly gateUnavailable: number;
  /** Correct among cases where the gate had no answer. */
  readonly correctWhenGateUnavailable?: number;
  /** Correct among cases where the gate answered — overlap, not value. */
  readonly correctWhenGateClear?: number;
  /** Wrong on cases the gate answered correctly. */
  readonly wrongWhenGateClear?: number;
  readonly agreesWithGate?: number;
  readonly disagreesWithGate?: number;
}

/**
 * Does the evaluated model add information beyond the deterministic policy?
 * Measured only where a ground-truth label exists — everywhere else "correct"
 * would be an opinion.
 */
export function valueOverDeterministic(
  refs: readonly BenchmarkCaseRef[],
): ValueOverDeterministic {
  const labeled = refs.filter(
    (ref) => isLabeledGroundTruth(ref.label) && topId(ref.subject) !== undefined,
  );
  const gateUnavailable = labeled.filter(
    (ref) => ref.deterministicExpectation.kind === "no-applicable-rule",
  );
  const gateClear = labeled.filter(
    (ref) => ref.deterministicExpectation.kind === "clear",
  );
  const correctOn = (slice: readonly BenchmarkCaseRef[]): number =>
    slice.filter(
      (ref) =>
        ref.label.kind === "labeled" && ref.label.optionId === topId(ref.subject),
    ).length;
  return {
    gateUnavailable: gateUnavailable.length,
    ...(gateUnavailable.length > 0
      ? {
          correctWhenGateUnavailable: correctOn(gateUnavailable),
        }
      : {}),
    ...(gateClear.length > 0
      ? {
          correctWhenGateClear: correctOn(gateClear),
          wrongWhenGateClear: gateClear.length - correctOn(gateClear),
        }
      : {}),
    ...(labeled.length > 0
      ? {
          agreesWithGate: labeled.filter(
            (ref) =>
              ref.deterministicExpectation.kind === "clear" &&
              ref.deterministicExpectation.optionId === topId(ref.subject),
          ).length,
          disagreesWithGate: labeled.filter(
            (ref) =>
              ref.deterministicExpectation.kind === "clear" &&
              ref.deterministicExpectation.optionId !== topId(ref.subject),
          ).length,
        }
      : {}),
  };
}

/* ------------------------------------------------------ domain aggregation */

export interface DomainReport {
  readonly domain: DecisionDomain;
  readonly sampleCount: number;
  readonly labeledCount: number;
  readonly accuracy?: number;
  readonly brier?: number;
  readonly ece?: number;
  readonly agreementWithDeterministic?: number;
  readonly agreementWithTypeSafe?: number;
  readonly warmP50Ms?: number;
  readonly warmP95Ms?: number;
  readonly failureRate: number;
  readonly coverageAt07?: number;
  readonly coverageAt08?: number;
  readonly coverageAt09?: number;
  /** Evidence state, not a production recommendation. */
  readonly evidence: "sufficient" | "promising" | "insufficient" | "poor";
}

/**
 * Evidence classification per domain. The thresholds are deliberately
 * conservative and are printed with the report: "sufficient" demands enough
 * labeled cases for a meaningful rate AND acceptable calibration; "poor" means
 * measured performance is genuinely low on adequate data. Nothing here feeds a
 * production decision.
 */
function classifyEvidence(
  domain: Omit<DomainReport, "evidence">,
): DomainReport["evidence"] {
  const n = domain.labeledCount;
  if (domain.accuracy === undefined || n < 15) {
    return "insufficient";
  }
  if (domain.accuracy < 0.5) {
    return "poor";
  }
  if (n >= 30 && domain.accuracy >= 0.7 && (domain.ece ?? 1) <= 0.25) {
    return "sufficient";
  }
  return "promising";
}

export function buildDomainReports(
  refs: readonly BenchmarkCaseRef[],
  thresholds: readonly number[] = SELECTIVE_PREDICTION_THRESHOLDS,
): readonly DomainReport[] {
  const domains = [...new Set(refs.map((ref) => ref.domain))];
  const at = (t: number): number =>
    thresholds.includes(t) ? t : Math.min(...thresholds.filter((x) => x >= t));
  const [t07, t08, t09] = [at(0.7), at(0.8), at(0.9)];
  return domains.map((domain) => {
    const slice = refs.filter((ref) => ref.domain === domain);
    const acc = accuracyOver(slice);
    const cal = calibrationOver(slice);
    const vsGate = modelVsDeterministic(slice);
    const vsTypesafe = modelVsTypesafe(slice);
    const latencies = slice
      .map((ref) => ref.subject.latencyMs)
      .filter((value): value is number => value !== undefined);
    const failureRate =
      slice.filter((ref) => ref.subject.outcome === "failed").length /
      Math.max(1, slice.length);
    const simulation = simulateSelectivePrediction(slice, [t07, t08, t09]);
    const coverage = (threshold: number): number | undefined => {
      const row = simulation.find((entry) => entry.threshold === threshold);
      return row === undefined
        ? undefined
        : round(row.handled / Math.max(1, slice.length));
    };
    const report: DomainReport = {
      domain,
      sampleCount: slice.length,
      labeledCount: acc.labeledCount,
      failureRate: round(failureRate) ?? 0,
      ...(acc.accuracy === undefined ? {} : { accuracy: acc.accuracy }),
      ...(cal.brier === undefined ? {} : { brier: cal.brier }),
      ...(cal.ece === undefined ? {} : { ece: cal.ece }),
      ...(vsGate.agreement === undefined
        ? {}
        : { agreementWithDeterministic: vsGate.agreement }),
      ...(vsTypesafe.agreement === undefined
        ? {}
        : { agreementWithTypeSafe: vsTypesafe.agreement }),
      ...(latencies.length > 0
        ? {
            warmP50Ms: percentile(latencies, 50),
            warmP95Ms: percentile(latencies, 95),
          }
        : {}),
      ...(coverage(t07) === undefined ? {} : { coverageAt07: coverage(t07) }),
      ...(coverage(t08) === undefined ? {} : { coverageAt08: coverage(t08) }),
      ...(coverage(t09) === undefined ? {} : { coverageAt09: coverage(t09) }),
      evidence: classifyEvidence({
        domain,
        sampleCount: slice.length,
        labeledCount: acc.labeledCount,
        failureRate: round(failureRate) ?? 0,
        ...(acc.accuracy === undefined ? {} : { accuracy: acc.accuracy }),
        ...(cal.ece === undefined ? {} : { ece: cal.ece }),
      }),
    };
    return report;
  });
}

/* ------------------------------------------------------ artifact sanitizer */

/**
 * The last-line guard before any benchmark artifact is written: refuse a
 * document that carries a forbidden field name anywhere in its structure.
 * Returns the document unchanged when clean.
 */
export function assertArtifactClean<T>(document: T): T {
  if (containsForbiddenField(document)) {
    throw new Error(
      "benchmark artifact would carry a forbidden field; refusing to write it",
    );
  }
  return document;
}
