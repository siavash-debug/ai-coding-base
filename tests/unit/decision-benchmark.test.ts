import { describe, expect, it } from "vitest";

import {
  BENCHMARK_CASES,
  BENCHMARK_DOMAINS,
} from "../../src/evaluation/decision-benchmark-cases.js";
import {
  benchmarkDatasetAccounting,
  containsForbiddenField,
  groundTruthStatusOf,
  isLegacyDataset,
  LEGACY_CASE_COUNT,
  BENCHMARK_DATASET_NAME,
  BENCHMARK_DATASET_VERSION,
  type DecisionBenchmarkCase,
  type ModelVerdict,
} from "../../src/evaluation/decision-benchmark.js";
import { DECISION_DOMAINS as ALL_DOMAINS } from "../../src/decisions/domains.js";
import { ALL_OPERATIONS } from "../../src/decisions/risk.js";
import {
  accuracyOver,
  assertArtifactClean,
  buildDomainReports,
  calibrationOver,
  isLabeledGroundTruth,
  modelVsDeterministic,
  modelVsTypesafe,
  riskErrorBreakdown,
  simulateSelectivePrediction,
  typeSafeEligibleCases,
  valueOverDeterministic,
  type BenchmarkCaseRef,
} from "../../src/evaluation/benchmark-metrics.js";
import { DECISION_DOMAIN_KINDS } from "../../src/decisions/domains.js";

/**
 * Offline benchmark regression tests: dataset structure, label honesty,
 * duplicate detection, metric correctness, threshold simulation and the
 * sensitive-field guard. No GPU, no live TypeSafe, no network.
 */

function labeledRef(overrides: {
  readonly caseId?: string;
  readonly domain?: BenchmarkCaseRef["domain"];
  readonly labelOption?: string;
  readonly subjectOption?: string;
  readonly confidence?: number;
  readonly distribution?: Readonly<Record<string, number>>;
  readonly gate?: "clear" | "none";
  readonly gateOption?: string;
  readonly typesafeOption?: string;
  readonly outcome?: ModelVerdict["outcome"];
}): BenchmarkCaseRef {
  const gate =
    overrides.gate === "none"
      ? ({ kind: "no-applicable-rule" } as const)
      : ({
          kind: "clear",
          optionId: overrides.gateOption ?? "a",
          reasonCode: "test-reason",
        } as const);
  return {
    caseId: overrides.caseId ?? "case-test",
    domain: overrides.domain ?? "relevance",
    label:
      overrides.labelOption === undefined
        ? { kind: "unlabeled" }
        : {
            kind: "labeled",
            optionId: overrides.labelOption,
            authority: "GROUND_TRUTH",
          },
    deterministicExpectation: gate,
    subject: {
      outcome: overrides.outcome ?? "selected",
      ...(overrides.outcome === "failed"
        ? {}
        : { selectedOptionId: overrides.subjectOption ?? "a" }),
      ...(overrides.confidence === undefined && overrides.distribution === undefined
        ? {}
        : {
            confidence:
              overrides.confidence ??
              Object.values(overrides.distribution ?? { a: 1 })[0],
          }),
      ...(overrides.distribution === undefined ? {} : { distribution: overrides.distribution }),
      latencyMs: 10,
    },
    ...(overrides.typesafeOption === undefined
      ? {}
      : {
          typesafe: {
            outcome: "selected" as const,
            selectedOptionId: overrides.typesafeOption,
            latencyMs: 100,
          },
        }),
  };
}

describe("benchmark dataset structure", () => {
  it("covers every production decision domain through the real builders", () => {
    expect([...BENCHMARK_DOMAINS].sort()).toEqual([...ALL_DOMAINS].sort());
  });

  it("every case maps to a declared production decision kind", () => {
    for (const c of BENCHMARK_CASES) {
      expect(DECISION_DOMAIN_KINDS[c.domain]).toBeDefined();
    }
  });

  it("case ids are unique and stable-shaped", () => {
    const ids = new Set(BENCHMARK_CASES.map((c) => c.caseId));
    expect(ids.size).toBe(BENCHMARK_CASES.length);
    for (const id of BENCHMARK_CASES.map((c) => c.caseId)) {
      expect(id).toMatch(/^case-[a-z-]+-\d{3}-[0-9a-f]{8}$/);
    }
  });

  it("no option named in a label falls outside the case's offered options", () => {
    for (const c of BENCHMARK_CASES) {
      const label = c.evaluationLabel;
      if (label.kind === "labeled") {
        expect(
          c.options.some((option) => option.id === label.optionId),
          `${c.caseId} labels an unoffered option`,
        ).toBe(true);
      }
    }
  });

  it("deterministic-expectation options are always offered options", () => {
    for (const c of BENCHMARK_CASES) {
      const expectation = c.deterministicExpectation;
      if (expectation.kind === "clear") {
        expect(
          c.options.some((option) => option.id === expectation.optionId),
          `${c.caseId} expects an unoffered deterministic answer`,
        ).toBe(true);
      }
    }
  });

  it("unlabeled rows never claim a difficulty tier reserved for labeled work", () => {
    for (const c of BENCHMARK_CASES) {
      if (c.evaluationLabel.kind === "unlabeled") {
        expect(c.difficulty).toBe("unlabeled");
      } else {
        expect(c.difficulty).not.toBe("unlabeled");
      }
    }
  });

  it("state stays within the production decision bounds", () => {
    for (const c of BENCHMARK_CASES) {
      expect(c.state.question.length).toBeLessThanOrEqual(240);
      expect(c.options.length).toBeGreaterThan(0);
      expect(c.options.length).toBeLessThanOrEqual(8);
      expect(c.state.context.length).toBeLessThanOrEqual(16);
    }
  });
});

describe("label separation", () => {
  it("dataset is v2 with the expected name, not the legacy 36-case slice", () => {
    expect(BENCHMARK_DATASET_NAME).toBe("decision-brain-benchmark");
    expect(BENCHMARK_DATASET_VERSION).toBe("2.0.0");
    expect(isLegacyDataset(BENCHMARK_CASES)).toBe(false);
    expect(BENCHMARK_CASES.length).toBeGreaterThan(LEGACY_CASE_COUNT);
  });

  it("includes the test-derived slice with honest provenance", () => {
    const testDerived = BENCHMARK_CASES.filter((c) => c.source === "test-derived");
    expect(testDerived.length).toBeGreaterThanOrEqual(80);
    for (const c of testDerived) {
      // Test-derived gate labels carry DETERMINISTIC_POLICY authority with the
      // provenance note; judgment labels stay GROUND_TRUTH.
      if (c.evaluationLabel.kind === "labeled") {
        expect(["DETERMINISTIC_POLICY", "GROUND_TRUTH"]).toContain(
          c.evaluationLabel.authority,
        );
      }
    }
  });

  it("groundTruthStatusOf separates verified from unavailable", () => {
    const labeled = BENCHMARK_CASES.find((c) => c.evaluationLabel.kind === "labeled");
    const unlabeled = BENCHMARK_CASES.find((c) => c.evaluationLabel.kind === "unlabeled");
    expect(labeled && groundTruthStatusOf(labeled)).toBe("verified");
    expect(unlabeled && groundTruthStatusOf(unlabeled)).toBe("unavailable");
  });

  it("labeled rows always declare an authority; grids are unlabeled", () => {
    for (const c of BENCHMARK_CASES) {
      if (c.evaluationLabel.kind === "labeled") {
        expect([
          "GROUND_TRUTH",
          "DETERMINISTIC_POLICY",
          "TYPESAFE",
        ]).toContain(c.evaluationLabel.authority);
      }
    }
  });

  it("no label is authored with TYPESAFE authority in this dataset", () => {
    // The charter forbids laundering an authoritative source's opinion into a
    // label; if a future edit adds one, this test makes it visible.
    const modelAuthored = BENCHMARK_CASES.filter(
      (c) =>
        c.evaluationLabel.kind === "labeled" &&
        c.evaluationLabel.authority === "TYPESAFE",
    );
    expect(modelAuthored).toEqual([]);
  });

  it("isLabeledGroundTruth accepts ground truth and rejects unlabeled", () => {
    expect(
      isLabeledGroundTruth({
        kind: "labeled",
        optionId: "a",
        authority: "GROUND_TRUTH",
      }),
    ).toBe(true);
    expect(isLabeledGroundTruth({ kind: "unlabeled" })).toBe(false);
  });

  it("accuracy counts only labeled cases even when unlabeled verdicts exist", () => {
    const refs = [
      labeledRef({ labelOption: "a", subjectOption: "a" }),
      labeledRef({ labelOption: "b", subjectOption: "b" }),
      labeledRef({ subjectOption: "a" }), // unlabeled: excluded from accuracy
    ];
    const metrics = accuracyOver(refs);
    expect(metrics.labeledCount).toBe(2);
    expect(metrics.accuracy).toBe(1);
  });
});

describe("dataset accounting", () => {
  const accounting = benchmarkDatasetAccounting(BENCHMARK_CASES);

  it("accounts every case exactly once across domains", () => {
    const total = accounting.domains.reduce((sum, d) => sum + d.total, 0);
    expect(total).toBe(accounting.totalCases);
    expect(accounting.totalCases).toBe(BENCHMARK_CASES.length);
  });

  it("labeled plus unlabeled equals total", () => {
    expect(accounting.labeledCases + accounting.unlabeledCases).toBe(
      accounting.totalCases,
    );
  });

  it("class distributions sum to the labeled count per domain", () => {
    for (const domain of accounting.domains) {
      const sum = Object.values(domain.classDistribution).reduce(
        (sum, count) => sum + count,
        0,
      );
      expect(sum).toBe(domain.labeled);
    }
  });

  it("detects duplicated case ids as empty and reports state overlap honestly", () => {
    expect(accounting.duplicateCaseIds).toEqual([]);
    // The relevance grid intentionally reproduces authored states; the
    // accounting must see that overlap, not hide it.
    expect(accounting.duplicateStateFingerprints.length).toBeGreaterThan(0);
  });

  it("meets the charter scale without fabricated labels", () => {
    expect(accounting.totalCases).toBeGreaterThanOrEqual(300);
    expect(accounting.labeledCases).toBeGreaterThanOrEqual(150);
    // All three sources present and accounted for.
    const sources = new Set(accounting.domains.flatMap((d) => Object.entries(d.sourceDistribution).filter(([, n]) => n > 0).map(([k]) => k)));
    expect(sources.has("derived-production-spec")).toBe(true);
    expect(sources.has("test-derived")).toBe(true);
  });
});

describe("metric correctness", () => {
  it("accuracy is exact on a hand-checked slice", () => {
    const refs = [
      labeledRef({ labelOption: "a", subjectOption: "a" }),
      labeledRef({ labelOption: "a", subjectOption: "b" }),
      labeledRef({ labelOption: "a", subjectOption: "a", outcome: "failed" }),
    ];
    const metrics = accuracyOver(refs);
    expect(metrics.labeledCount).toBe(2);
    expect(metrics.correctCount).toBe(1);
    expect(metrics.accuracy).toBe(0.5);
    expect(metrics.confusion?.a?.a).toBe(1);
    expect(metrics.confusion?.a?.b).toBe(1);
  });

  it("agreement with TypeSafe is computed only over comparable cases", () => {
    const refs = [
      labeledRef({ labelOption: "a", subjectOption: "a", typesafeOption: "a" }),
      labeledRef({ labelOption: "a", subjectOption: "b", typesafeOption: "a" }),
      labeledRef({ labelOption: "a", subjectOption: "a" }), // no typesafe verdict
    ];
    const vsTypesafe = modelVsTypesafe(refs);
    expect(vsTypesafe.comparableCount).toBe(2);
    expect(vsTypesafe.agreement).toBe(0.5);
  });

  it("agreement with the deterministic gate treats gate-unavailable as non-comparable", () => {
    const refs = [
      labeledRef({ labelOption: "a", subjectOption: "a", gate: "clear", gateOption: "a" }),
      labeledRef({ labelOption: "a", subjectOption: "a", gate: "none" }),
    ];
    const vsGate = modelVsDeterministic(refs);
    expect(vsGate.comparableCount).toBe(1);
    expect(vsGate.agreement).toBe(1);
  });

  it("brier is exact on a hand-checked slice", () => {
    const refs = [
      labeledRef({
        labelOption: "a",
        subjectOption: "a",
        distribution: { a: 0.8, b: 0.2 },
      }),
      labeledRef({
        labelOption: "b",
        subjectOption: "a",
        distribution: { a: 0.6, b: 0.4 },
      }),
    ];
    const calibration = calibrationOver(refs);
    // (0.8 - 1)^2 + (0.6 - 0)^2 = 0.04 + 0.36 = 0.4 -> mean 0.2
    expect(calibration.brier).toBeCloseTo(0.2, 3);
    expect(calibration.scoredCount).toBe(2);
  });

  it("ece uses lower-exclusive upper-inclusive bins", () => {
    const at = (confidence: number): BenchmarkCaseRef =>
      labeledRef({
        labelOption: "a",
        subjectOption: "a",
        distribution: { a: confidence, b: 1 - confidence },
      });
    const calibration = calibrationOver([at(0.5), at(1.0)]);
    // Confidence 1.0 must land in the last bin, 0.5 in the fifth.
    const bins = calibration.reliability.map((b) => [b.lower, b.upper]);
    expect(bins).toContainEqual([0.4, 0.5]);
    expect(bins).toContainEqual([0.9, 1]);
  });
});

describe("selective prediction simulation", () => {
  it("thresholds are exactly the charter's set", () => {
    const rows = simulateSelectivePrediction([
      labeledRef({ labelOption: "a", subjectOption: "a", confidence: 0.9 }),
    ]);
    expect(rows.map((r) => r.threshold)).toEqual([
      0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95,
    ]);
  });

  it("coverage and fallback counts move monotonically with the threshold", () => {
    const refs = [0.55, 0.65, 0.72, 0.78, 0.83, 0.88, 0.93, 0.97].map(
      (confidence, index) =>
        labeledRef({
          caseId: `case-${index}`,
          labelOption: "a",
          subjectOption: "a",
          confidence,
        }),
    );
    const rows = simulateSelectivePrediction(refs);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].handled).toBeLessThanOrEqual(rows[i - 1].handled);
      expect(rows[i].fallbackToTypesafe).toBeGreaterThanOrEqual(
        rows[i - 1].fallbackToTypesafe,
      );
    }
    expect(rows[0].handled).toBe(refs.length);
    expect(rows[rows.length - 1].handled).toBe(1);
  });

  it("false-accept rate is computed only where ground truth exists", () => {
    const labeled = labeledRef({
      labelOption: "a",
      subjectOption: "b", // wrong, confidently
      confidence: 0.9,
    });
    const unlabeled = labeledRef({ subjectOption: "a", confidence: 0.9 });
    const rows = simulateSelectivePrediction([labeled, unlabeled], [0.5]);
    expect(rows[0].handled).toBe(2);
    expect(rows[0].accuracyOnAccepted).toBe(0);
    expect(rows[0].falseAcceptRate).toBe(1);
  });

  it("failed verdicts are never accepted by any threshold", () => {
    const failed = labeledRef({
      labelOption: "a",
      subjectOption: "a",
      outcome: "failed",
      confidence: 0.99,
    });
    const rows = simulateSelectivePrediction([failed], [0.5]);
    expect(rows[0].handled).toBe(0);
  });
});

describe("risk-sensitive and value analysis", () => {
  it("risk errors separate false-safe from false-escalation", () => {
    const refs = [
      labeledRef({
        domain: "risk-assessment",
        labelOption: "critical",
        subjectOption: "low", // false safe
        confidence: 0.9,
      }),
      labeledRef({
        domain: "risk-assessment",
        labelOption: "medium",
        subjectOption: "critical", // false escalation
        confidence: 0.9,
      }),
      labeledRef({
        domain: "retry",
        labelOption: "retry",
        subjectOption: "stop", // false stop
        confidence: 0.9,
      }),
      labeledRef({
        domain: "relevance",
        labelOption: "relevant",
        subjectOption: "not-relevant", // not a risk domain
        confidence: 0.9,
      }),
    ];
    const breakdown = riskErrorBreakdown(refs);
    expect(breakdown.evaluated).toBe(3);
    expect(breakdown.falseSafe).toBe(1);
    expect(breakdown.falseEscalation).toBe(1);
    expect(breakdown.falseStop).toBe(1);
    expect(breakdown.falseRetry).toBe(0);
  });

  it("value over deterministic separates the gate-unavailable slice", () => {
    const refs = [
      labeledRef({
        labelOption: "a",
        subjectOption: "a",
        gate: "none", // correct where the gate is silent
      }),
      labeledRef({
        labelOption: "a",
        subjectOption: "b",
        gate: "none", // wrong where the gate is silent
      }),
      labeledRef({
        labelOption: "a",
        subjectOption: "a",
        gate: "clear",
        gateOption: "a", // overlap: both right
      }),
    ];
    const value = valueOverDeterministic(refs);
    expect(value.gateUnavailable).toBe(2);
    expect(value.correctWhenGateUnavailable).toBe(1);
    expect(value.correctWhenGateClear).toBe(1);
    expect(value.wrongWhenGateClear).toBe(0);
  });

  it("domain reports classify evidence without a single best-domain ranking", () => {
    const refs = [
      labeledRef({
        domain: "relevance",
        labelOption: "a",
        subjectOption: "a",
        confidence: 0.9,
      }),
      labeledRef({
        domain: "relevance",
        labelOption: "a",
        subjectOption: "b",
        confidence: 0.9,
      }),
    ];
    const reports = buildDomainReports(refs);
    expect(reports).toHaveLength(1);
    expect(reports[0].evidence).toBe("insufficient"); // 2 labeled cases
  });
});

describe("typeSafe eligibility and artifact guard", () => {
  it("live TypeSafe is bounded to labeled, gate-unavailable cases only", () => {
    const eligible = typeSafeEligibleCases(BENCHMARK_CASES);
    for (const c of eligible) {
      expect(c.evaluationLabel.kind).toBe("labeled");
      expect(c.deterministicExpectation.kind).toBe("no-applicable-rule");
    }
    // And the slice is a strict subset: gate-covered and unlabeled stay out.
    expect(eligible.length).toBeLessThan(BENCHMARK_CASES.length);
    expect(eligible.length).toBeGreaterThan(0);
  });

  it("containsForbiddenField catches forbidden keys at any depth", () => {
    expect(containsForbiddenField({ ok: true })).toBe(false);
    expect(containsForbiddenField({ nested: { apiKey: "x" } })).toBe(true);
    expect(containsForbiddenField([{ deep: [{ token: "x" }] }])).toBe(true);
    expect(containsForbiddenField({ rawResponse: {} })).toBe(true);
  });

  it("assertArtifactClean passes a full result document and rejects seeded ones", () => {
    expect(() =>
      assertArtifactClean({ schemaVersion: 1, ok: { nested: [1, 2] } }),
    ).not.toThrow();
    expect(() => assertArtifactClean({ prompt: "leak" })).toThrow();
    expect(() => assertArtifactClean({ a: { authorization: "Bearer x" } })).toThrow();
  });

  it("no benchmark case embeds credential-shaped strings", () => {
    // `secrets-read`/`secrets-write` are the policy's own OperationKind names,
    // not credentials; everything else matching this pattern is a leak.
    const SECRET_PATTERN =
      /(api[_-]?key|authorization|bearer\s|secret(?!s-(read|write))|password|sk-[a-z0-9]{8})/i;
    for (const c of BENCHMARK_CASES) {
      const text = [
        c.state.question,
        ...c.state.context,
        ...c.options.map((option) => option.label),
      ].join("\n");
      expect(SECRET_PATTERN.test(text), `${c.caseId} looks credential-shaped`).toBe(
        false,
      );
    }
  });
});

describe("dataset fidelity to production builders", () => {
  it("question text is exactly what the production builders emit", () => {
    // Spot-check the domain questions the builders own.
    const byDomain = new Map<string, DecisionBenchmarkCase[]>();
    for (const c of BENCHMARK_CASES) {
      const bucket = byDomain.get(c.domain) ?? [];
      bucket.push(c);
      byDomain.set(c.domain, bucket);
    }
    expect(
      byDomain.get("completion")?.every(
        (c) => c.state.question === "Does the recorded evidence suggest this task is complete?",
      ),
    ).toBe(true);
    expect(
      byDomain.get("tool-selection")?.every(
        (c) => c.state.question === "Which allowed tool should the runtime use for this task?",
      ),
    ).toBe(true);
    expect(
      byDomain.get("relevance")?.every(
        (c) => c.state.question === "Is the bounded candidate set relevant to this task?",
      ),
    ).toBe(true);
  });

  it("risk baselines in cases match the policy's own table", () => {
    const riskCases = BENCHMARK_CASES.filter((c) => c.domain === "risk-assessment");
    expect(riskCases.length).toBeGreaterThan(0);
    for (const c of riskCases) {
      // The question always carries the baseline the builder derived from policy.
      expect(c.state.question).toMatch(/beyond its "(low|medium|high|critical)" baseline\?$/);
    }
    // Every operation named in an op: context entry is a real policy operation.
    for (const c of riskCases) {
      const op = c.state.context.find((entry) => entry.startsWith("op:"));
      if (op !== undefined) {
        expect(ALL_OPERATIONS).toContain(op.slice("op:".length));
      }
    }
  });
});
