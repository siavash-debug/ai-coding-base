import type {
  DecisionBenchmarkCase,
  DeterministicState,
  EvaluationLabel,
} from "./decision-benchmark.js";
import { stableCaseId } from "./decision-benchmark.js";
import type { DecisionDomain, DomainDecisionSpec } from "../../src/decisions/domains.js";
import {
  ALL_OPERATIONS,
  baselineRiskForOperation,
} from "../../src/decisions/risk.js";
import { DECISION_FAILURE_KINDS } from "../../src/decisions/provider.js";
import {
  buildCompletionSpec,
  buildEscalationSpec,
  buildExecutionStrategySpec,
  buildRetrySpec,
  buildRiskAssessmentSpec,
  assertDomainDecisionSpec,
} from "../../src/decisions/domains.js";

/**
 * Test-derived benchmark cases.
 *
 * **Provenance rule.** Every case here reproduces a state the repository's own
 * test suite builds with the *production* builders — either verbatim from
 * `tests/unit/decision-domains.test.ts` / `tests/support/decisions.ts`, or as
 * the direct parameter family those tests exercise (the full failure taxonomy,
 * the full operation table). Where a test asserts the deterministic gate's
 * answer, the case's deterministic expectation AND its label authority are
 * DETERMINISTIC_POLICY — the repo's own asserted behavior, not a model's
 * opinion. Judgment labels are GROUND_TRUTH with the reason in `labelNote`.
 *
 * None of this reuses the legacy 36-case slice's question/context text; where a
 * state coincides with an authored one, duplicate accounting reports it.
 */

const noRule: DeterministicState = { kind: "no-applicable-rule" };
const noSignals: readonly string[] = [];
const signals = (...items: readonly string[]): readonly string[] => items;

interface TestRow {
  readonly domain: DecisionDomain;
  readonly question: string;
  readonly context: readonly string[];
  readonly ranked: boolean;
  readonly options: DecisionBenchmarkCase["options"];
  readonly reasonCodes: readonly string[];
  readonly deterministic: DeterministicState;
  readonly label: EvaluationLabel;
  readonly difficulty: DecisionBenchmarkCase["difficulty"];
  readonly note?: string;
  readonly signals?: readonly string[];
}

/** Gate-asserted labels carry DETERMINISTIC_POLICY authority, per the tests. */
function gateLabel(optionId: string): EvaluationLabel {
  return {
    kind: "labeled",
    optionId,
    authority: "DETERMINISTIC_POLICY",
    note: "the repo's own decision-domains test suite asserts this gate answer",
  };
}

function truthLabel(optionId: string, note: string): EvaluationLabel {
  return { kind: "labeled", optionId, authority: "GROUND_TRUTH", note };
}

function unlabeled(): EvaluationLabel {
  return { kind: "unlabeled" };
}

/* --------------------------------------------- from tests/support/decisions.ts */

/** `specForDomain` verbatim states — the specs every engine test asks about. */
const SPEC_FOR_DOMAIN_ROWS: readonly TestRow[] = [
  {
    domain: "routing",
    question: 'Which execution route should task work at risk level "low" take?',
    context: ["risk:low"],
    ranked: false,
    options: [
      { id: "standard", label: "Run the attempt as configured" },
      { id: "minimal", label: "Run the attempt with the smallest operation set" },
    ],
    reasonCodes: [
      "single-registered-route",
      "routine-task",
      "narrow-scope-preferred",
      "human-judgement-required",
    ],
    deterministic: noRule,
    label: truthLabel("standard", "low-risk two-route question; standard serves the work"),
    difficulty: "easy",
    signals: signals("test-derived:support", "2-options"),
  },
  {
    domain: "tool-selection",
    question: "Which allowed tool should the runtime use for this task?",
    context: ["candidates:2"],
    ranked: false,
    options: [
      { id: "list-workspace-files", label: "List workspace files" },
      { id: "read-selected-file", label: "Read the selected context file" },
    ],
    reasonCodes: [
      "single-allowed-tool",
      "cheapest-sufficient-tool",
      "least-privilege-tool",
      "most-informative-tool",
    ],
    deterministic: noRule,
    label: truthLabel("list-workspace-files", "support default is enumeration; a read needs a chosen target"),
    difficulty: "medium",
    note: "neither answer is wrong a priori; the support module names the first as default",
    signals: signals("test-derived:support", "2-options"),
  },
  {
    domain: "risk-assessment",
    question: 'What contextual risk does operation "write" carry, beyond its "medium" baseline?',
    context: ["op:write"],
    ranked: false,
    options: [
      { id: "low", label: "low risk" },
      { id: "medium", label: "medium risk" },
      { id: "high", label: "high risk" },
      { id: "critical", label: "critical risk" },
    ],
    reasonCodes: [
      "baseline-risk",
      "declared-risk",
      "destructive-operation",
      "external-effect",
      "credential-adjacent",
      "irreversible-change",
      "routine-change",
    ],
    deterministic: noRule,
    label: truthLabel("medium", "bare write with no contextual signal stays at baseline"),
    difficulty: "easy",
    signals: signals("test-derived:support", "4-options"),
  },
  {
    domain: "retry",
    question: 'Should the attempt be retried after a "server" failure?',
    context: ["failure-kind:server", "attempts-spent:0", "retries-remaining:2"],
    ranked: false,
    options: [
      { id: "retry", label: "Retry within the deterministic limits" },
      { id: "stop", label: "Stop and report the failure" },
      { id: "escalate", label: "Escalate to a human" },
    ],
    reasonCodes: [
      "transient-failure",
      "retryable-failure",
      "quality-below-threshold",
      "retry-limit-reached",
      "failure-not-retryable",
      "budget-exhausted",
      "deterministic-failure",
    ],
    deterministic: noRule,
    label: truthLabel("retry", "5xx on the first attempt with full budget is the canonical retry"),
    difficulty: "easy",
    signals: signals("test-derived:support", "3-options"),
  },
  {
    domain: "completion",
    question: "Does the recorded evidence suggest this task is complete?",
    context: ["criteria:2/2", "verification-checks:2", "verification-failures:0"],
    ranked: false,
    options: [
      { id: "complete", label: "Evidence suggests the task is complete" },
      { id: "incomplete", label: "Evidence suggests the task is not complete" },
      { id: "uncertain", label: "Evidence is insufficient to say" },
    ],
    reasonCodes: [
      "criteria-met",
      "verification-passed",
      "evidence-insufficient",
      "verification-failed",
      "criteria-unclear",
      "no-verification-evidence",
    ],
    deterministic: noRule,
    label: truthLabel("complete", "the support module's 'open question' state is full-criteria full-verification"),
    difficulty: "easy",
    signals: signals("test-derived:support", "3-options"),
  },
  {
    domain: "human-escalation",
    question: "Should a human review this outcome before the task is closed?",
    context: ["fact:verification-failed"],
    ranked: false,
    options: [
      { id: "review", label: "Recommend human review" },
      { id: "no-review", label: "Recommend no human review" },
    ],
    reasonCodes: [
      "security-refusal",
      "policy-denial",
      "repeated-failure",
      "insufficient-evidence",
      "resource-boundary",
      "routine-outcome",
    ],
    deterministic: noRule,
    label: truthLabel("review", "a failed verification is not a routine outcome"),
    difficulty: "easy",
    signals: signals("test-derived:support", "2-options"),
  },
  {
    domain: "execution-strategy",
    question: "Should this medium-risk task be completed deterministically, executed with a model, or handed to a human?",
    context: ["risk:medium", "model-required:true", "eligible-models:2"],
    ranked: false,
    options: [
      { id: "deterministic", label: "Complete it deterministically, with no model call" },
      { id: "model", label: "Execute it with a model through Frontier" },
      { id: "human", label: "Hand it to a human before spending anything" },
    ],
    reasonCodes: [
      "no-model-capability-required",
      "model-capability-required",
      "eligible-model-available",
      "no-eligible-model",
      "routine-change",
      "high-risk-deterministic-work",
      "human-judgement-required",
    ],
    deterministic: {
      kind: "clear",
      optionId: "model",
      reasonCode: "eligible-model-available",
    },
    label: gateLabel("model"),
    difficulty: "easy",
    signals: signals("test-derived:support", "3-options", "gate-clear"),
  },
  {
    domain: "skill-selection",
    question: "Which available skill, if any, is relevant to the current state?",
    context: ["state:(support module: no state context supplied)"],
    ranked: false,
    options: [
      { id: "code-review", label: "registered skill: code-review" },
      { id: "no-skill", label: "No registered skill matches; proceed without one" },
    ],
    reasonCodes: [
      "explicit-skill-match",
      "declared-capability-match",
      "ambiguous-skill-match",
      "no-skill-available",
      "insufficient-evidence",
    ],
    deterministic: noRule,
    label: unlabeled(),
    difficulty: "unlabeled",
    note: "the support module supplies no state; nothing in the bounded state selects a skill",
    signals: signals("test-derived:support", "2-options"),
  },
  {
    domain: "context-selection",
    question: "Should this context candidate be kept, dropped, or compressed?",
    context: ["candidate:src/a.ts", "task:(support module: no task context supplied)"],
    ranked: false,
    options: [
      { id: "keep", label: "Keep the candidate in context" },
      { id: "drop", label: "Drop the candidate from context" },
      { id: "compress", label: "Keep a compressed form of the candidate" },
    ],
    reasonCodes: [
      "explicitly-referenced",
      "related-by-path",
      "duplicate-of-kept",
      "stale-or-superseded",
      "unrelated",
      "insufficient-evidence",
    ],
    deterministic: noRule,
    label: unlabeled(),
    difficulty: "unlabeled",
    note: "no task context; the bounded state underdetermines keep/drop",
    signals: signals("test-derived:support", "3-options"),
  },
  {
    domain: "relevance",
    question: "Is the bounded candidate set relevant to this task?",
    context: ["candidate:src/a.ts", "candidate:tests/a.test.ts", "task:(support module: no task context supplied)"],
    ranked: false,
    options: [
      { id: "relevant", label: "The candidate is relevant to the task" },
      { id: "not-relevant", label: "The candidate is not relevant to the task" },
    ],
    reasonCodes: [
      "explicitly-referenced",
      "related-by-path",
      "unrelated",
      "insufficient-evidence",
    ],
    deterministic: noRule,
    label: unlabeled(),
    difficulty: "unlabeled",
    note: "a source file and its test are plausible for any coding task, but no task is stated",
    signals: signals("test-derived:support", "2-options"),
  },
  {
    domain: "ranking",
    question: "In what order should these candidates be considered?",
    context: ["candidates:2", "task:(support module: no task context supplied)"],
    ranked: true,
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    reasonCodes: ["single-candidate", "ordered-by-relevance", "ordered-by-cost", "ordered-by-safety"],
    deterministic: noRule,
    label: unlabeled(),
    difficulty: "unlabeled",
    note: "two anonymous candidates and no task; no defensible ordering",
    signals: signals("test-derived:support", "2-options", "ranked"),
  },
];

/* --------------------------------- from tests/unit/decision-domains.test.ts */
/* The deterministic-gate suite's exact inputs. Every label below is the
   assertion that test makes — DETERMINISTIC_POLICY authority. */

const GATE_SUITE_ROWS: readonly TestRow[] = [
  {
    domain: "routing",
    question: 'Which execution route should task work at risk level "low" take?',
    context: ["test:answers routing itself when one route is registered"],
    ranked: false,
    options: [{ id: "standard", label: "Run the attempt as configured" }],
    reasonCodes: [
      "single-registered-route",
      "routine-task",
      "narrow-scope-preferred",
      "human-judgement-required",
    ],
    deterministic: { kind: "clear", optionId: "standard", reasonCode: "single-registered-route" },
    label: gateLabel("standard"),
    difficulty: "easy",
    signals: signals("test-derived:gate-suite", "1-option", "gate-clear"),
  },
  {
    domain: "tool-selection",
    question: "Which allowed tool should the runtime use for this task?",
    context: ["test:answers tool selection itself when one tool is permitted"],
    ranked: false,
    options: [{ id: "list-workspace-files", label: "List workspace files" }],
    reasonCodes: [
      "single-allowed-tool",
      "cheapest-sufficient-tool",
      "least-privilege-tool",
      "most-informative-tool",
    ],
    deterministic: {
      kind: "clear",
      optionId: "list-workspace-files",
      reasonCode: "single-allowed-tool",
    },
    label: gateLabel("list-workspace-files"),
    difficulty: "easy",
    signals: signals("test-derived:gate-suite", "1-option", "gate-clear"),
  },
  {
    domain: "retry",
    question: 'Should the attempt be retried after a "rate-limit" failure?',
    context: ["test:stops a retry at the deterministic limit", "attempts-spent:2", "max-retries:2", "retries-remaining:5"],
    ranked: false,
    options: [
      { id: "retry", label: "Retry within the deterministic limits" },
      { id: "stop", label: "Stop and report the failure" },
      { id: "escalate", label: "Escalate to a human" },
    ],
    reasonCodes: [
      "transient-failure",
      "retryable-failure",
      "quality-below-threshold",
      "retry-limit-reached",
      "failure-not-retryable",
      "budget-exhausted",
      "deterministic-failure",
    ],
    deterministic: { kind: "clear", optionId: "stop", reasonCode: "retry-limit-reached" },
    label: gateLabel("stop"),
    difficulty: "easy",
    signals: signals("test-derived:gate-suite", "3-options", "gate-clear"),
  },
  {
    domain: "retry",
    question: 'Should the attempt be retried after a "rate-limit" failure?',
    context: ["test:stops a retry at the deterministic limit", "attempts-spent:0", "max-retries:2", "retries-remaining:0"],
    ranked: false,
    options: [
      { id: "retry", label: "Retry within the deterministic limits" },
      { id: "stop", label: "Stop and report the failure" },
      { id: "escalate", label: "Escalate to a human" },
    ],
    reasonCodes: [
      "transient-failure",
      "retryable-failure",
      "quality-below-threshold",
      "retry-limit-reached",
      "failure-not-retryable",
      "budget-exhausted",
      "deterministic-failure",
    ],
    deterministic: { kind: "clear", optionId: "stop", reasonCode: "budget-exhausted" },
    label: gateLabel("stop"),
    difficulty: "easy",
    signals: signals("test-derived:gate-suite", "3-options", "gate-clear"),
  },
  {
    domain: "retry",
    question: 'Should the attempt be retried after an "auth" failure?',
    context: ["test:stops a retry at the deterministic limit", "attempts-spent:0", "max-retries:2", "retries-remaining:5"],
    ranked: false,
    options: [
      { id: "retry", label: "Retry within the deterministic limits" },
      { id: "stop", label: "Stop and report the failure" },
      { id: "escalate", label: "Escalate to a human" },
    ],
    reasonCodes: [
      "transient-failure",
      "retryable-failure",
      "quality-below-threshold",
      "retry-limit-reached",
      "failure-not-retryable",
      "budget-exhausted",
      "deterministic-failure",
    ],
    deterministic: { kind: "clear", optionId: "stop", reasonCode: "failure-not-retryable" },
    label: gateLabel("stop"),
    difficulty: "easy",
    signals: signals("test-derived:gate-suite", "3-options", "gate-clear"),
  },
  {
    domain: "retry",
    question: 'Should the attempt be retried after a "rate-limit" failure?',
    context: ["test:stops a retry at the deterministic limit (open question)", "attempts-spent:0", "max-retries:2", "retries-remaining:2"],
    ranked: false,
    options: [
      { id: "retry", label: "Retry within the deterministic limits" },
      { id: "stop", label: "Stop and report the failure" },
      { id: "escalate", label: "Escalate to a human" },
    ],
    reasonCodes: [
      "transient-failure",
      "retryable-failure",
      "quality-below-threshold",
      "retry-limit-reached",
      "failure-not-retryable",
      "budget-exhausted",
      "deterministic-failure",
    ],
    deterministic: noRule,
    label: truthLabel("retry", "the test names this the genuinely open question; rate-limit is transient"),
    difficulty: "easy",
    signals: signals("test-derived:gate-suite", "3-options"),
  },
  {
    domain: "completion",
    question: "Does the recorded evidence suggest this task is complete?",
    context: ["test:refuses to call a task complete on failed evidence", "criteria:1/2", "verification-checks:3", "verification-failures:1"],
    ranked: false,
    options: [
      { id: "complete", label: "Evidence suggests the task is complete" },
      { id: "incomplete", label: "Evidence suggests the task is not complete" },
      { id: "uncertain", label: "Evidence is insufficient to say" },
    ],
    reasonCodes: [
      "criteria-met",
      "verification-passed",
      "evidence-insufficient",
      "verification-failed",
      "criteria-unclear",
      "no-verification-evidence",
    ],
    deterministic: { kind: "clear", optionId: "incomplete", reasonCode: "verification-failed" },
    label: gateLabel("incomplete"),
    difficulty: "easy",
    signals: signals("test-derived:gate-suite", "3-options", "gate-clear"),
  },
  {
    domain: "completion",
    question: "Does the recorded evidence suggest this task is complete?",
    context: ["test:refuses to call a task complete on failed evidence", "criteria:unmeasured/2", "verification-checks:0"],
    ranked: false,
    options: [
      { id: "complete", label: "Evidence suggests the task is complete" },
      { id: "incomplete", label: "Evidence suggests the task is not complete" },
      { id: "uncertain", label: "Evidence is insufficient to say" },
    ],
    reasonCodes: [
      "criteria-met",
      "verification-passed",
      "evidence-insufficient",
      "verification-failed",
      "criteria-unclear",
      "no-verification-evidence",
    ],
    deterministic: { kind: "clear", optionId: "uncertain", reasonCode: "no-verification-evidence" },
    label: gateLabel("uncertain"),
    difficulty: "easy",
    signals: signals("test-derived:gate-suite", "3-options", "gate-clear"),
  },
  {
    domain: "human-escalation",
    question: "Should a human review this outcome before the task is closed?",
    context: ["test:never delegates a security refusal", "fact:refused-operation", "security-refusal:true"],
    ranked: false,
    options: [
      { id: "review", label: "Recommend human review" },
      { id: "no-review", label: "Recommend no human review" },
    ],
    reasonCodes: [
      "security-refusal",
      "policy-denial",
      "repeated-failure",
      "insufficient-evidence",
      "resource-boundary",
      "routine-outcome",
    ],
    deterministic: { kind: "clear", optionId: "review", reasonCode: "security-refusal" },
    label: gateLabel("review"),
    difficulty: "easy",
    signals: signals("test-derived:gate-suite", "2-options", "gate-clear"),
  },
  {
    domain: "ranking",
    question: "In what order should these candidates be considered?",
    context: ["test:answers ranking itself for a single candidate", "candidates:1"],
    ranked: true,
    options: [{ id: "only", label: "Only candidate" }],
    reasonCodes: ["single-candidate", "ordered-by-relevance", "ordered-by-cost", "ordered-by-safety"],
    deterministic: { kind: "clear", optionId: "only", reasonCode: "single-candidate" },
    label: gateLabel("only"),
    difficulty: "easy",
    signals: signals("test-derived:gate-suite", "1-option", "gate-clear"),
  },
  {
    domain: "risk-assessment",
    question: 'What contextual risk does operation "deploy" carry, beyond its "critical" baseline?',
    context: ["test:treats an already-critical baseline as unraisable"],
    ranked: false,
    options: [
      { id: "low", label: "low risk" },
      { id: "medium", label: "medium risk" },
      { id: "high", label: "high risk" },
      { id: "critical", label: "critical risk" },
    ],
    reasonCodes: [
      "baseline-risk",
      "declared-risk",
      "destructive-operation",
      "external-effect",
      "credential-adjacent",
      "irreversible-change",
      "routine-change",
    ],
    deterministic: { kind: "clear", optionId: "critical", reasonCode: "baseline-risk" },
    label: gateLabel("critical"),
    difficulty: "easy",
    signals: signals("test-derived:gate-suite", "4-options", "gate-clear"),
  },
  {
    domain: "completion",
    question: "Does the recorded evidence suggest this task is complete?",
    context: ["test:distinguishes unmeasured criteria from zero met", "criteria:unmeasured/2", "verification-checks:1"],
    ranked: false,
    options: [
      { id: "complete", label: "Evidence suggests the task is complete" },
      { id: "incomplete", label: "Evidence suggests the task is not complete" },
      { id: "uncertain", label: "Evidence is insufficient to say" },
    ],
    reasonCodes: [
      "criteria-met",
      "verification-passed",
      "evidence-insufficient",
      "verification-failed",
      "criteria-unclear",
      "no-verification-evidence",
    ],
    deterministic: noRule,
    label: truthLabel("uncertain", "criterion progress was never measured; the test exists to pin that wording"),
    difficulty: "medium",
    signals: signals("test-derived:gate-suite", "3-options"),
  },
];

/* ------------------------------------------------- test-derived grid rows */
/* The same parameter families the gate suite sweeps, extended over the FULL
   taxonomy tables the tests assert totals for (DECISION_FAILURE_KINDS,
   ALL_OPERATIONS). These are test-derived (the tests sweep these tables), and
   judgment labels are not fabricated: rows whose answer is a judgement carry
   no label; rows whose answer is the gate's own asserted behavior carry
   DETERMINISTIC_POLICY labels derived from the production builder itself. */

function isRetryableByTaxonomy(failureKind: string): boolean {
  return (
    failureKind === "rate-limit" ||
    failureKind === "timeout" ||
    failureKind === "network" ||
    failureKind === "server"
  );
}

function retryGateFor(input: {
  readonly failureKind: string;
  readonly attemptsSpent: number;
  readonly maxRetries: number;
  readonly retriesRemaining: number;
}): DeterministicState {
  const spec = buildRetrySpec({
    failureKind: input.failureKind,
    retryable: isRetryableByTaxonomy(input.failureKind),
    attemptsSpent: input.attemptsSpent,
    maxRetries: input.maxRetries,
    retriesRemaining: input.retriesRemaining,
    context: [],
  });
  return spec.deterministic === undefined
    ? noRule
    : { kind: "clear", optionId: spec.deterministic.optionId, reasonCode: spec.deterministic.reasonCode };
}

const RETRY_TAXONOMY_ROWS: readonly TestRow[] = DECISION_FAILURE_KINDS.flatMap(
  (failureKind): readonly TestRow[] => {
    const retryable = isRetryableByTaxonomy(failureKind);
    const question = `Should the attempt be retried after a "${failureKind}" failure?`;
    const options = [
      { id: "retry", label: "Retry within the deterministic limits" },
      { id: "stop", label: "Stop and report the failure" },
      { id: "escalate", label: "Escalate to a human" },
    ];
    const reasonCodes = [
      "transient-failure",
      "retryable-failure",
      "quality-below-threshold",
      "retry-limit-reached",
      "failure-not-retryable",
      "budget-exhausted",
      "deterministic-failure",
    ];
    return ([
      { attemptsSpent: 1, retriesRemaining: 3 },
      { attemptsSpent: 3, retriesRemaining: 3 },
      { attemptsSpent: 0, retriesRemaining: 0 },
    ] as const).map(({ attemptsSpent, retriesRemaining }) => {
      const deterministic = retryGateFor({
        failureKind,
        attemptsSpent,
        maxRetries: 3,
        retriesRemaining,
      });
      // Where the gate is silent the honest label for a first-spent budget
      // position on a retryable failure is "retry" (the taxonomy's own
      // retryability rule); everywhere else judgment is not fabricated.
      const label: EvaluationLabel =
        deterministic.kind === "clear"
          ? gateLabel(deterministic.optionId)
          : retryable && attemptsSpent === 1 && retriesRemaining === 3
            ? truthLabel(
                "retry",
                `the shared taxonomy classifies "${failureKind}" as retryable and budget remains`,
              )
            : unlabeled();
      return {
        domain: "retry" as const,
        question,
        context: [
          `failure-kind:${failureKind}`,
          `attempts-spent:${attemptsSpent}`,
          `retries-remaining:${retriesRemaining}`,
        ],
        ranked: false,
        options,
        reasonCodes,
        deterministic,
        label,
        difficulty:
          deterministic.kind === "clear"
            ? ("easy" as const)
            : label.kind === "labeled"
              ? ("medium" as const)
              : ("unlabeled" as const),
        signals: signals("test-derived:retry-taxonomy", "3-options"),
      };
    });
  },
);

const RISK_OPERATION_ROWS: readonly TestRow[] = ALL_OPERATIONS.map((operation) => {
  const baseline = baselineRiskForOperation(operation);
  const spec: DomainDecisionSpec = buildRiskAssessmentSpec({
    operation,
    baselineRisk: baseline,
    context: [`op:${operation}`, "test-derived:operation-table"],
  });
  assertDomainDecisionSpec(spec);
  return {
    domain: "risk-assessment" as const,
    question: spec.question,
    context: spec.context,
    ranked: false,
    options: spec.options.map((option) => ({ id: option.id, label: option.label })),
    reasonCodes: [...spec.reasonCodes],
    deterministic:
      spec.deterministic === undefined
        ? noRule
        : {
            kind: "clear" as const,
            optionId: spec.deterministic.optionId,
            reasonCode: spec.deterministic.reasonCode,
          },      label:
        spec.deterministic === undefined
          ? unlabeled()
          : gateLabel(spec.deterministic.optionId),
      difficulty:
        spec.deterministic === undefined ? ("unlabeled" as const) : ("easy" as const),
      signals: signals("test-derived:operation-table", "4-options"),
  };
});

const STRATEGY_MATRIX_ROWS: readonly TestRow[] = (
  [
    [false, 0],
    [false, 2],
    [true, 0],
    [true, 2],
  ] as const
).flatMap(([modelRequired, eligible]): readonly TestRow[] =>
  (["low", "high", "critical"] as const).map((risk) => {
    const spec: DomainDecisionSpec = buildExecutionStrategySpec({
      modelRequired,
      eligibleCandidates: eligible,
      riskLevel: risk,
      requiredCapabilities: modelRequired ? ["reasoning", "coding"] : [],
      context: [
        "test-derived:strategy-matrix",
        `risk:${risk}`,
        `model-required:${modelRequired}`,
        `eligible-models:${eligible}`,
      ],
    });
    assertDomainDecisionSpec(spec);
    return {
      domain: "execution-strategy" as const,
      question: spec.question,
      context: spec.context,
      ranked: false,
      options: spec.options.map((option) => ({ id: option.id, label: option.label })),
      reasonCodes: [...spec.reasonCodes],
      deterministic:
        spec.deterministic === undefined
          ? noRule
          : {
              kind: "clear" as const,
              optionId: spec.deterministic.optionId,
              reasonCode: spec.deterministic.reasonCode,
            },
      label:
        spec.deterministic === undefined
          ? unlabeled()
          : gateLabel(spec.deterministic.optionId),
      difficulty:
        spec.deterministic === undefined
          ? ("unlabeled" as const)
          : ("easy" as const),
      signals: signals("test-derived:strategy-matrix", "3-options"),
    };
  }),
);

const COMPLETION_MATRIX_ROWS: readonly TestRow[] = (
  [
    [0, 2, 1, 0],
    [1, 2, 1, 0],
    [2, 2, 1, 0],
    [2, 2, 2, 0],
    [1, 4, 3, 1],
    [3, 4, 2, 0],
    [0, 3, 0, 0],
    [2, 3, 4, 2],
  ] as const
).map(([met, total, checks, failures]) => {
  const spec: DomainDecisionSpec = buildCompletionSpec({
    acceptanceCriteriaTotal: total,
    acceptanceCriteriaMet: met,
    verificationChecks: checks,
    verificationFailures: failures,
    context: [
      `criteria:${met}/${total}`,
      `verification-checks:${checks}`,
      `verification-failures:${failures}`,
      "test-derived:completion-matrix",
    ],
  });
  assertDomainDecisionSpec(spec);
  const deterministic: DeterministicState =
    spec.deterministic === undefined
      ? noRule
      : {
          kind: "clear",
          optionId: spec.deterministic.optionId,
          reasonCode: spec.deterministic.reasonCode,
        };
  // Judgment labels only where the bounded evidence is one-sided (all criteria
  // met and nothing failed, or a majority outstanding); ties stay unlabeled.
  const label: EvaluationLabel =
    deterministic.kind === "clear"
      ? gateLabel(deterministic.optionId)
      : failures === 0 && met === total
        ? truthLabel("complete", "all criteria met with passing checks")
        : failures === 0 && total > 0 && met === 0
          ? truthLabel("incomplete", "no criteria met and checks pass only over finished work")
          : unlabeled();
  return {
    domain: "completion" as const,
    question: spec.question,
    context: spec.context,
    ranked: false,
    options: spec.options.map((option) => ({ id: option.id, label: option.label })),
    reasonCodes: [...spec.reasonCodes],
    deterministic,
    label,
    difficulty:
      deterministic.kind === "clear"
        ? ("easy" as const)
        : label.kind === "labeled"
          ? ("medium" as const)
          : ("unlabeled" as const),
    signals: signals("test-derived:completion-matrix", "3-options"),
  };
});

const ESCALATION_FACT_ROWS: readonly TestRow[] = (
  [
    [["verification-failed"], false],
    [["repeated-failure", "attempt-count:3"], false],
    [["resource-boundary", "token-budget:exhausted"], false],
    [["verification-passed", "criteria:3/3"], false],
    [["attempt-failed", "attempt-count:1", "failure-kind:timeout"], false],
  ] as const
).map(([facts, securityRefusal]) => {
  const spec: DomainDecisionSpec = buildEscalationSpec({
    facts: [...facts],
    securityRefusal,
    context: [...facts.map((fact) => `fact:${fact}`), "test-derived:escalation-facts"],
  });
  assertDomainDecisionSpec(spec);
  return {
    domain: "human-escalation" as const,
    question: spec.question,
    context: spec.context,
    ranked: false,
    options: spec.options.map((option) => ({ id: option.id, label: option.label })),
    reasonCodes: [...spec.reasonCodes],
    deterministic:
      spec.deterministic === undefined
        ? noRule
        : {
            kind: "clear" as const,
            optionId: spec.deterministic.optionId,
            reasonCode: spec.deterministic.reasonCode,
          },
    label:
      spec.deterministic === undefined
        ? truthLabel(
            facts[0].startsWith("verification-passed") ? "no-review" : "review",
            facts[0].startsWith("verification-passed")
              ? "verified success is the routine-outcome case"
              : "boundary facts belong in front of a human",
          )
        : gateLabel(spec.deterministic.optionId),
    difficulty: "easy" as const,
    signals: signals("test-derived:escalation-facts", "2-options"),
  };
});

/* ------------------------------------------------------------------ assemble */

const TEST_ROWS: readonly TestRow[] = [
  ...SPEC_FOR_DOMAIN_ROWS,
  ...GATE_SUITE_ROWS,
  ...RETRY_TAXONOMY_ROWS,
  ...RISK_OPERATION_ROWS,
  ...STRATEGY_MATRIX_ROWS,
  ...COMPLETION_MATRIX_ROWS,
  ...ESCALATION_FACT_ROWS,
];

const TEST_DERIVED_COUNTER = new Map<string, number>();

function nextTestIndex(domain: string): number {
  const next = (TEST_DERIVED_COUNTER.get(domain) ?? 0) + 1;
  TEST_DERIVED_COUNTER.set(domain, next);
  return next;
}

export const TEST_DERIVED_CASES: readonly DecisionBenchmarkCase[] =
  TEST_ROWS.map((row) => {
    const domain = row.domain;
    const index = nextTestIndex(domain);
    return {
      caseId: stableCaseId(domain, 100 + index, row.question, row.context),
      domain,
      state: {
        question: row.question,
        context: row.context,
        ranked: row.ranked,
      },
      options: row.options,
      reasonCodes: row.reasonCodes,
      deterministicExpectation: row.deterministic,
      evaluationLabel: row.label,
      source: "test-derived" as const,
      difficulty: row.difficulty,
      ...(row.note === undefined ? {} : { labelNote: row.note }),
      metadata: {
        signals: row.signals ?? noSignals,
      },
    };
  });
