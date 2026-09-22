import {
  DECISION_DOMAIN_KINDS,
  type DecisionDomain,
} from "../decisions/domains.js";
import type { DecisionKind } from "../decisions/decision.js";
import type {
  OrchestrationResult,
  OrchestrationStepReport,
} from "../orchestration/orchestrator.js";
import type { TaskTrace, TraceDecision } from "./trace.js";

/**
 * What the decision layer actually decided, in one structured answer.
 *
 * This module exists because "did the brain decide anything, or did the platform
 * decide for it?" is the question an efficiency review asks first, and answering it by
 * reading a raw event log by eye is how a platform ends up claiming judgement it never
 * exercised. The report is a *projection*: every field is copied from the orchestration
 * result or the task trace, nothing is re-derived, and nothing is scored. There is no
 * quality number here on purpose — a self-assigned score would be exactly the kind of
 * invented metric this codebase refuses (ADR-035).
 *
 * Three rules:
 *
 * - **Metadata only.** Model ids, requirement codes, option ids, reason codes, counts
 *   and durations. Prompts, model output, reasoning and context text never enter the
 *   trace, so they cannot enter this report either (ADR-039).
 * - **Absent is a state, not a zero.** A question that was never asked is reported as
 *   `not-asked`; a cost that is unknown is absent; a call the provider did not price is
 *   counted as unpriced rather than priced at zero.
 * - **The report cannot change anything.** It is a read-only view, so a caller cannot
 *   mark a task complete or grant a capability by building one.
 */

/** How a run ended, from the recorded outcome and not from a re-derivation. */
export const DECISION_QUALITY_FINAL_STATUSES = [
  /** The plan ran, the completion decision agreed, no review was recommended. */
  "completed",
  /** Something was done, but the recorded outcome asks for a human. */
  "needs-review",
  /** The brain chose the human strategy: nothing was attempted at all. */
  "not-attempted",
  /** A step failed and the run stopped on it. */
  "failed",
] as const;

export type DecisionQualityFinalStatus =
  (typeof DECISION_QUALITY_FINAL_STATUSES)[number];

/**
 * Which layer answered one bounded question.
 *
 * `not-asked` is deliberately distinct from `deterministic`: "code knew the answer so
 * the question was never put to anyone" and "no layer was asked this question" are
 * different facts, and a report that merged them would make an unasked question look
 * like a decision.
 */
export const DECISION_QUALITY_ANSWERED_BY = [
  "code",
  "provider",
  "fallback",
  "not-asked",
] as const;

export type DecisionQualityAnsweredBy =
  (typeof DECISION_QUALITY_ANSWERED_BY)[number];

export interface DecisionQualityDecision {
  readonly domain: DecisionDomain;
  readonly kind: DecisionKind;
  readonly outcome: string;
  readonly answeredBy: DecisionQualityAnsweredBy;
  readonly selectedOptionId?: string;
  readonly reasonCode?: string;
  readonly ranking?: readonly string[];
  readonly fallbackReason?: string;
  readonly providerFailureKind?: string;
  /** Provider invocations this question spent. 0 for anything code answered. */
  readonly providerCalls: number;
  readonly latencyMs?: number;
  readonly usageReported: boolean;
  /**
   * The provider's execution-path attestation, when recorded.
   *
   * `"live-sdk"` means the real TypeSafe SDK boundary executed; `"test-double"`
   * means a scripted provider answered. Absent for code-answered decisions.
   */
  readonly executionSource?: string;
}

/**
 * One step Frontier actually executed (or skipped).
 *
 * Sizes, not text: `contentChars` is what the step produced in bytes, which is the
 * only thing about its output that belongs in a report (ADR-039).
 */
export interface DecisionQualityStep {
  readonly stepId: string;
  readonly purpose: string;
  readonly status: string;
  readonly modelId: string;
  readonly attempts: number;
  readonly retry: number;
  readonly contentChars?: number;
  readonly failureKind?: string;
  readonly selectionReasonCode?: string;
  readonly rankedCandidates?: readonly string[];
  readonly answeredBy?: string;
}

export interface DecisionQualityCandidate {
  readonly modelId: string;
  readonly eligible: boolean;
  /** Why it was rejected, when it was. A closed code, never a model's opinion. */
  readonly reasonCode?: string;
  readonly missing?: readonly string[];
  /** True for the model the plan committed to for its first step. */
  readonly selected: boolean;
  /** True when a real call to this model is recorded. */
  readonly invoked: boolean;
}

export interface DecisionQualityReport {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly requirements: {
    readonly classifications: readonly string[];
    readonly capabilities: readonly string[];
    readonly inputModalities: readonly string[];
    readonly outputModalities: readonly string[];
    readonly complexity: string;
  };
  readonly risk: string;
  readonly modelRequired: boolean;
  readonly planId: string;
  readonly candidates: readonly DecisionQualityCandidate[];
  readonly candidateCount: number;
  readonly eligibleCount: number;
  /** The model the selected plan's first step runs. Absent when no step ran. */
  readonly selectedModelId?: string;
  /**
   * Models a real provider call is recorded against, in log order and deduplicated.
   *
   * Failures count: a call that reached a provider and was rejected is still a call
   * that model was asked to serve, and a report that listed only successes would hide
   * the fallback switch after a failure.
   */
  readonly invokedModelIds: readonly string[];
  readonly steps: readonly DecisionQualityStep[];
  readonly executionStrategy: DecisionQualityDecision;
  readonly routing?: DecisionQualityDecision;
  readonly ranking?: DecisionQualityDecision;
  readonly completion: DecisionQualityDecision;
  readonly escalation: DecisionQualityDecision;
  /** Every retry question the run asked, in order. Empty when none was needed. */
  readonly retries: readonly DecisionQualityDecision[];
  /** Every bounded question the run asked, in log order. */
  readonly decisions: readonly DecisionQualityDecision[];
  readonly decisionCount: number;
  readonly decisionsAnsweredByProvider: number;
  readonly decisionsAnsweredByCode: number;
  readonly context: {
    readonly selectionCount: number;
    readonly selectedItems: number;
    readonly excludedItems: number;
    readonly selectedTokens?: number;
    readonly budgetTokens?: number;
    readonly selectedRefs: readonly string[];
    readonly excludedRefs: readonly string[];
  };
  /**
   * Provider calls the trace records, successful or failed.
   *
   * Counted from the log rather than from the run's step accounting, because the two
   * differ exactly when a retry happened — and a report about call efficiency that
   * undercounts retried calls would understate the cost it exists to expose.
   */
  readonly modelCalls: number;
  /** Steps that reached a terminal state, which is what the run's own bound counts. */
  readonly stepsSpent: number;
  readonly retryCount: number;
  readonly unpricedCalls: number;
  readonly costMicros?: number;
  readonly failureKinds: readonly string[];
  readonly finalStatus: DecisionQualityFinalStatus;
  readonly stopReason?: string;
  readonly completionAssessment: string;
  readonly escalationRecommendation: string;
  readonly needsHumanReview: boolean;
}

export interface DecisionQualityInput {
  readonly result: OrchestrationResult;
  readonly trace: TaskTrace;
}

/**
 * The reported answer for a question, or an explicit `not-asked`.
 *
 * A domain can legitimately be asked more than once (retry, after each failure). This
 * returns the *last* answer for that domain, which is the one that shaped the final
 * outcome; the full ordered list is available through `decisions` and `retries`.
 */
function answeredByOf(
  decision: TraceDecision | undefined,
): DecisionQualityAnsweredBy {
  if (decision === undefined) {
    return "not-asked";
  }
  if (decision.answeredBy === "provider") {
    return "provider";
  }
  if (decision.answeredBy === "fallback") {
    return "fallback";
  }
  // `deterministic` — and anything recorded without a source at all — is an answer
  // code produced: either the engine's certainty gate or its declared default. It is
  // not reported as a provider answer, because no provider was consulted.
  return "code";
}

function providerCallsOf(decision: TraceDecision | undefined): number {
  if (decision === undefined) {
    return 0;
  }
  return decision.answeredBy === "provider" ? 1 : 0;
}

function summarize(
  domain: DecisionDomain,
  decision: TraceDecision | undefined,
): DecisionQualityDecision {
  return {
    domain,
    kind: DECISION_DOMAIN_KINDS[domain],
    outcome: decision?.outcome ?? "not-asked",
    answeredBy: answeredByOf(decision),
    ...(decision?.executionSource === undefined
      ? {}
      : { executionSource: decision.executionSource }),
    ...(decision?.selectedOptionId === undefined
      ? {}
      : { selectedOptionId: decision.selectedOptionId }),
    ...(decision?.reasonCode === undefined
      ? {}
      : { reasonCode: decision.reasonCode }),
    ...(decision?.ranking === undefined ? {} : { ranking: decision.ranking }),
    ...(decision?.fallbackReason === undefined
      ? {}
      : { fallbackReason: decision.fallbackReason }),
    ...(decision?.providerFailureKind === undefined
      ? {}
      : { providerFailureKind: decision.providerFailureKind }),
    providerCalls: providerCallsOf(decision),
    ...(decision?.latencyMs === undefined
      ? {}
      : { latencyMs: decision.latencyMs }),
    usageReported: decision?.usageReported === true,
  };
}

function lastOf(
  decisions: readonly TraceDecision[],
  kind: DecisionKind,
): TraceDecision | undefined {
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    if (decisions[index]?.kind === kind) {
      return decisions[index];
    }
  }
  return undefined;
}

function failedStep(
  steps: readonly OrchestrationStepReport[],
): OrchestrationStepReport | undefined {
  return steps.find((step) => step.status === "failed");
}

/**
 * How the run ended, read from the recorded outcome.
 *
 * The order matters and encodes the priority the platform uses everywhere else: an
 * attempt that never started is reported as such before anything else, a security or
 * step failure outranks a partial success, and only a run whose completion decision
 * agreed *and* that asked for no review is reported as completed.
 *
 * The completion decision — the evidence question — is what gates `completed`, not the
 * escalation recommendation: a run whose completion assessment is `uncertain` is
 * reported as needing review even where the escalation question happened to recommend
 * no review, because "we did not verify it" and "a human should look" are different
 * questions and the first one is the one that describes the outcome.
 */
function finalStatusOf(
  input: DecisionQualityInput,
): DecisionQualityFinalStatus {
  const { result } = input;
  if (result.stopReason === "strategy-human" || result.planId === "plan:none") {
    return "not-attempted";
  }
  if (
    failedStep(result.steps) !== undefined ||
    result.stopReason === "step-failed" ||
    result.stopReason === "retry-exhausted"
  ) {
    return "failed";
  }
  if (result.needsHumanReview || result.completionAssessment !== "complete") {
    return "needs-review";
  }
  return "completed";
}

/**
 * Builds the report.
 *
 * Pure: it reads two already-recorded projections and cannot fail on them. Every
 * optional field stays absent when the platform does not know the value, so a caller
 * can distinguish "not priced" from "free" and "no context selection ran" from
 * "a selection ran that kept nothing".
 */
export function buildDecisionQualityReport(
  input: DecisionQualityInput,
): DecisionQualityReport {
  const { result, trace } = input;
  const decisions = trace.decisions;

  const invoked = [
    ...new Set(
      [
        ...trace.llmCalls.map((call) => ({
          sequence: call.sequence,
          modelId: call.modelId,
        })),
        ...trace.llmFailures.map((failure) => ({
          sequence: failure.sequence,
          modelId: failure.modelId,
        })),
      ]
        .sort((a, b) => a.sequence - b.sequence)
        .map((entry) => entry.modelId),
    ),
  ];
  const invokedIds = new Set(invoked);
  const selectedModelId = result.steps[0]?.modelId;
  const candidates: readonly DecisionQualityCandidate[] = [
    ...result.eligibleModelIds.map((modelId) => ({
      modelId,
      eligible: true,
      selected: modelId === selectedModelId,
      invoked: invokedIds.has(modelId),
    })),
    ...result.rejectedModels.map((entry) => ({
      modelId: entry.modelId,
      eligible: false,
      reasonCode: entry.reasonCode,
      missing: entry.missing,
      selected: false,
      invoked: invokedIds.has(entry.modelId),
    })),
  ];

  const retries = decisions
    .filter((decision) => decision.kind === "retry")
    .map((decision) => summarize("retry", decision));
  const selections = trace.contextSelections;
  const lastSelection = selections[selections.length - 1];

  const failureKinds = [
    ...new Set([
      ...trace.llmFailures.map((failure) => failure.failureKind),
      ...result.steps
        .map((step) => step.failureKind)
        .filter((kind): kind is NonNullable<typeof kind> => kind !== undefined),
    ]),
  ];

  return {
    taskId: String(result.taskId),
    workspaceId: String(result.workspaceId),
    ...(trace.title === undefined ? {} : { title: trace.title }),
    requirements: {
      classifications: [...result.requirements.classifications],
      capabilities: [
        ...result.requirements.modelRequirements.requiredCapabilities,
      ],
      inputModalities: [
        ...result.requirements.modelRequirements.inputModalities,
      ],
      outputModalities: [
        ...result.requirements.modelRequirements.outputModalities,
      ],
      complexity: result.requirements.complexity,
    },
    risk: result.requirements.risk,
    modelRequired: result.requirements.modelRequired,
    planId: result.planId,
    candidates,
    candidateCount: candidates.length,
    eligibleCount: result.eligibleModelIds.length,
    ...(selectedModelId === undefined ? {} : { selectedModelId }),
    invokedModelIds: invoked,
    steps: result.steps.map((step) => ({
      stepId: step.stepId,
      purpose: step.purpose,
      status: step.status,
      modelId: step.modelId,
      attempts: step.attempts,
      retry: step.retry,
      ...(step.contentChars === undefined
        ? {}
        : { contentChars: step.contentChars }),
      ...(step.failureKind === undefined
        ? {}
        : { failureKind: step.failureKind }),
      ...(step.selectionReasonCode === undefined
        ? {}
        : { selectionReasonCode: step.selectionReasonCode }),
      ...(step.rankedCandidates === undefined
        ? {}
        : { rankedCandidates: step.rankedCandidates }),
      ...(step.answeredBy === undefined ? {} : { answeredBy: step.answeredBy }),
    })),
    executionStrategy: summarize(
      "execution-strategy",
      lastOf(decisions, "execution-strategy"),
    ),
    ...(lastOf(decisions, "routing") === undefined
      ? {}
      : { routing: summarize("routing", lastOf(decisions, "routing")) }),
    ...(lastOf(decisions, "ranking") === undefined
      ? {}
      : { ranking: summarize("ranking", lastOf(decisions, "ranking")) }),
    completion: summarize("completion", lastOf(decisions, "completion")),
    escalation: summarize(
      "human-escalation",
      lastOf(decisions, "human-escalation"),
    ),
    retries,
    decisions: decisions.map((decision) =>
      summarize(decision.kind as DecisionDomain, decision),
    ),
    decisionCount: decisions.length,
    decisionsAnsweredByProvider: decisions.filter(
      (decision) => decision.answeredBy === "provider",
    ).length,
    decisionsAnsweredByCode: decisions.filter(
      (decision) => decision.answeredBy !== "provider",
    ).length,
    context: {
      selectionCount: selections.length,
      selectedItems: lastSelection?.selected.length ?? 0,
      excludedItems: lastSelection?.excluded.length ?? 0,
      ...(lastSelection?.selectedTokens === undefined
        ? {}
        : { selectedTokens: lastSelection.selectedTokens }),
      ...(lastSelection?.budgetTokens === undefined
        ? {}
        : { budgetTokens: lastSelection.budgetTokens }),
      selectedRefs: lastSelection?.selected.map((ref) => ref.ref) ?? [],
      excludedRefs: lastSelection?.excluded.map((ref) => ref.ref) ?? [],
    },
    modelCalls: trace.llmCalls.length + trace.llmFailures.length,
    stepsSpent: result.callsSpent,
    retryCount: result.retriesSpent,
    unpricedCalls: result.unpricedCalls,
    ...(result.costMicros === undefined
      ? {}
      : { costMicros: result.costMicros }),
    failureKinds,
    finalStatus: finalStatusOf(input),
    ...(result.stopReason === undefined
      ? {}
      : { stopReason: result.stopReason }),
    completionAssessment: result.completionAssessment,
    escalationRecommendation: result.escalationRecommendation,
    needsHumanReview: result.needsHumanReview,
  };
}

/**
 * Whether the report shows the brain doing anything a deterministic path could not.
 *
 * Exists for tests and reviews, and is deliberately narrow: it asserts that at least
 * one bounded question was answered by a provider, which is the only claim an offline
 * report can honestly make about judgement being exercised.
 */
export function wasDecisionLayerConsulted(
  report: DecisionQualityReport,
): boolean {
  return report.decisionsAnsweredByProvider > 0;
}
