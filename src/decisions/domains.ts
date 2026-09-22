import type { DecisionId } from "../core/ids.js";
import { DomainError } from "../core/errors.js";
import {
  assertNoSecretLikeValue,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertOneOf,
  assertStringArray,
  assertUnitInterval,
  containsSecretLikeValue,
} from "../core/validation.js";
import type { Capability } from "../policy/capability.js";
import { RISK_LEVELS, type RiskLevel, maxRisk, riskRank } from "./risk.js";
import type { OperationKind } from "./risk.js";
import type { DecisionKind, DecisionOption } from "./decision.js";

/**
 * Decision domains: the bounded questions a decision engine may answer.
 *
 * This module exists to make the *scope* of the decision layer explicit. A decision
 * domain is not a place to be clever: it is a small, closed question with an
 * enumerated answer set, a closed explanation vocabulary and a deterministic gate
 * that answers in code whenever certainty exists (ADR-051).
 *
 * Three rules are encoded here rather than documented:
 *
 * - **Candidates are supplied, never invented.** Every domain that chooses from a
 *   set receives that set from deterministic code (`ToolCandidate`, route ids,
 *   ranking candidates). A provider answer naming anything outside the set fails
 *   validation in `./validate.ts` — it cannot execute, be routed to, or be logged
 *   as an answer.
 * - **Certainty is answered by code.** `deterministicAnswerFor*` returns an answer
 *   when the question has only one defensible answer (a hard limit reached, a single
 *   candidate, a security failure). The engine then never consults a provider, which
 *   is both a correctness rule and the cost rule of ADR-052.
 * - **A default is always declared.** Each spec carries `defaultOptionId`, the option
 *   assumed when no provider answer exists. That is what makes fallback deterministic
 *   and auditable rather than improvised at the call site.
 *
 * Nothing here performs I/O, reads a clock, or knows what a provider is.
 */

export const DECISION_DOMAINS = [
  "routing",
  "tool-selection",
  "risk-assessment",
  "retry",
  "completion",
  "ranking",
  "relevance",
  "human-escalation",
  "execution-strategy",
  "skill-selection",
  "context-selection",
] as const;

export type DecisionDomain = (typeof DECISION_DOMAINS)[number];

/**
 * Every decision domain is recorded under its own decision kind. The mapping is
 * typed as `Record<DecisionDomain, DecisionKind>` on purpose: adding a domain
 * without adding its kind is a compile error, so the log vocabulary and the domain
 * vocabulary cannot drift apart.
 */
export const DECISION_DOMAIN_KINDS: Readonly<
  Record<DecisionDomain, DecisionKind>
> = {
  routing: "routing",
  "tool-selection": "tool-selection",
  "risk-assessment": "risk-assessment",
  retry: "retry",
  completion: "completion",
  ranking: "ranking",
  relevance: "relevance",
  "human-escalation": "human-escalation",
  "execution-strategy": "execution-strategy",
  "skill-selection": "tool-selection",
  "context-selection": "classification",
};

/**
 * Hard input bounds.
 *
 * A decision request is a *summary*, not a context dump: the Context Engine decides
 * what a task may read, and this layer decides what a decision may consider. These
 * numbers are the maximum a single decision may carry, whatever a caller asks for.
 */
export const MAX_DECISION_OPTIONS = 8;
export const MAX_DECISION_REASON_CODES = 8;
export const MAX_DECISION_CONTEXT_ENTRIES = 16;
export const MAX_DECISION_QUESTION_CHARS = 240;
export const MAX_DECISION_CONTEXT_ENTRY_CHARS = 200;
export const MAX_DECISION_INPUT_CHARS = 4_000;
/** Bounds a provider's free-form strings that are echoed into the record. */
export const MAX_DECISION_TOKEN_CHARS = 64;

/**
 * Explanation codes are a closed, machine-readable vocabulary: lowercase tokens.
 *
 * A provider answers with a *code*, not with prose, and the code must be one the
 * caller offered. Untrusted text therefore cannot enter the event log through the
 * decision path, which keeps the log queryable and removes a whole class of
 * injection and accidental-leak problems (ADR-053).
 */
export const REASON_CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function isReasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_PATTERN.test(value);
} /** How a bounded question was answered. Recorded on every decision. */
export const DECISION_ANSWER_SOURCES = [
  "deterministic",
  "provider",
  "fallback",
] as const;
export type DecisionAnswerSource = (typeof DECISION_ANSWER_SOURCES)[number];

/**
 * Which path actually produced a provider answer.
 *
 * This is distinct from `DecisionAnswerSource` on purpose. The answer source says
 * whether the *decision engine* consulted a provider; this says how that provider's
 * answer was *produced*.
 *
 * A test double is free to set its own id and return an answer, but it is not free
 * to claim the real SDK executed. Only the TypeSafe adapter's `decideDetailed`
 * boundary may construct the "live-sdk" value.
 */
export const DECISION_PROVIDER_EXECUTION_SOURCES = [
  "live-sdk",
  "test-double",
] as const;
/**
 * The closed vocabulary a *recorded* answer may carry for `executionSource`.
 *
 * Provider-side, the `live-sdk` half is a branded marker only the TypeSafe adapter
 * can mint (see `src/decisions/provider.ts`); this flat union is what the engine's
 * flattening and the record/event validators accept.
 */
export type DecisionProviderExecutionSourceValue =
  (typeof DECISION_PROVIDER_EXECUTION_SOURCES)[number];

/**
 * Why a deterministic fallback answered instead of a provider.
 *
 * A closed vocabulary, because these end up in the trace and in `ai task decisions`
 * and an operator must be able to count them. `provider-refused` is a provider
 * saying no; `invalid-answer` is a provider answering something that failed
 * validation. They are different problems and are never merged.
 */
export const DECISION_FALLBACK_REASONS = [
  "provider-disabled",
  "provider-unavailable",
  "provider-timeout",
  "provider-auth",
  "provider-rate-limit",
  "provider-error",
  "provider-malformed-response",
  "provider-refused",
  "provider-abstained",
  "invalid-answer",
  "budget-exhausted",
] as const;

export type DecisionFallbackReason = (typeof DECISION_FALLBACK_REASONS)[number];

/**
 * The reason code recorded when no decision layer is installed at all.
 *
 * Deliberately *not* one of the codes a provider may answer with: it describes the
 * absence of a provider, so offering it as an answer would let the layer claim it had
 * not been configured. "Nothing is installed" and "the layer could not answer" are
 * different states and are recorded differently (ADR-052).
 */
export const DECISION_LAYER_DISABLED_REASON = "decision-layer-disabled";

/** Runtime metadata attached to a domain answer by the coordinator. */
export interface DecisionOutcomeMeta {
  readonly decisionId: DecisionId;
  readonly answeredBy: DecisionAnswerSource;
  readonly providerId?: string;
  readonly fallbackReason?: DecisionFallbackReason;
  /** Total tokens the decision cost, when the provider reported usage. */
  readonly usageTokens?: number;
  readonly latencyMs?: number;
  /**
   * How the provider that answered this question produced its answer, when attested.
   *
   * Present only when the engine forwarded a provider's own provenance attestation.
   * The only trusted value is `live-sdk`, and only the TypeSafe adapter's SDK boundary
   * can mint it (see `src/decisions/provider.ts`). A test double carries
   * `test-double`, and absence means the provider did not attest its path.
   */
  readonly executionSource?: DecisionProviderExecutionSourceValue;
}

/** The deterministic answer, when code can answer the question on its own. */
export interface DomainDeterministicAnswer {
  readonly optionId: string;
  readonly reasonCode: string;
  readonly rationale: string;
}

/**
 * One bounded question, ready to be asked.
 *
 * `options` and `reasonCodes` come from deterministic code; `context` is a list of
 * stable references (never content) and is validated to be free of secret-shaped
 * values. `defaultOptionId` must be one of the options: a fallback that named an
 * unknown option would be a fabricated answer.
 */
export interface DomainDecisionSpec {
  readonly domain: DecisionDomain;
  readonly question: string;
  readonly options: readonly DecisionOption[];
  readonly reasonCodes: readonly string[];
  readonly context: readonly string[];
  readonly defaultOptionId: string;
  /** Whether a provider may answer `escalated` for this question. */
  readonly allowEscalated: boolean;
  /** Whether a provider may abstain (abstention always falls back deterministically). */
  readonly allowAbstained: boolean;
  /** True when the answer is an ordering of every option, not a single choice. */
  readonly ranked: boolean;
  readonly deterministic?: DomainDeterministicAnswer;
  readonly maxLatencyMs?: number;
  readonly maxCostMicros?: number;
}

/** What the engine produced for one bounded question. */
export interface DomainDecisionOutcome {
  readonly domain: DecisionDomain;
  readonly kind: DecisionKind;
  readonly answeredBy: DecisionAnswerSource;
  readonly outcome: "selected" | "abstained" | "escalated" | "failed";
  readonly selectedOptionId?: string;
  readonly ranking?: readonly string[];
  readonly reasonCode?: string;
  readonly confidence?: number;
  readonly rationale?: string;
  readonly providerId?: string;
  /** The provider-side model or version, when it named one. Used for pricing. */
  readonly modelId?: string;
  readonly providerFailure?: string;
  readonly fallbackReason?: DecisionFallbackReason;
  readonly latencyMs: number;
  readonly usageReported: boolean;
  /**
   * How the provider that answered this question produced its answer.
   *
   * Present only when the provider itself attested it. The only trusted value is
   * `live-sdk`, and that value can only come from the TypeSafe adapter's SDK call
   * site; a test double can only ever carry `test-double`.
   */
  readonly executionSource?: DecisionProviderExecutionSourceValue;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
  };
  readonly requestId?: string;
  /** Provider invocations spent on this question: 0 or 1. */
  readonly providerCalls: number;
}

/**
 * Validates a spec that was assembled by application code.
 *
 * Fails loudly rather than repairing: a spec with no options, a duplicate option, a
 * default that is not an option, or a secret-shaped context entry means the caller
 * is wrong, and silently choosing something else would hide that.
 */
export function assertDomainDecisionSpec(spec: DomainDecisionSpec): void {
  assertOneOf(spec.domain, DECISION_DOMAINS, "spec.domain");
  const question = assertNonEmptyString(spec.question, "spec.question");
  if (question.length > MAX_DECISION_QUESTION_CHARS) {
    throw new DomainError(
      "VALIDATION",
      `spec.question must be at most ${MAX_DECISION_QUESTION_CHARS} characters`,
      { field: "spec.question" },
    );
  }
  assertNoSecretLikeValue(question, "spec.question");

  if (!Array.isArray(spec.options) || spec.options.length === 0) {
    throw new DomainError(
      "VALIDATION",
      "a decision requires at least one candidate option",
      { field: "spec.options" },
    );
  }
  if (spec.options.length > MAX_DECISION_OPTIONS) {
    throw new DomainError(
      "VALIDATION",
      `a decision may carry at most ${MAX_DECISION_OPTIONS} options`,
      { field: "spec.options" },
    );
  }
  const seen = new Set<string>();
  for (const [index, option] of spec.options.entries()) {
    const field = `spec.options[${index}]`;
    const id = assertNonEmptyString(option.id, `${field}.id`);
    assertNoSecretLikeValue(id, `${field}.id`);
    if (seen.has(id)) {
      throw new DomainError(
        "INVARIANT",
        `duplicate decision option id "${id}"`,
        { field: `${field}.id` },
      );
    }
    seen.add(id);
    assertNoSecretLikeValue(
      assertNonEmptyString(option.label, `${field}.label`),
      `${field}.label`,
    );
  }

  const reasonCodes = assertStringArray(spec.reasonCodes, "spec.reasonCodes");
  if (reasonCodes.length > MAX_DECISION_REASON_CODES) {
    throw new DomainError(
      "VALIDATION",
      `a decision may offer at most ${MAX_DECISION_REASON_CODES} reason codes`,
      { field: "spec.reasonCodes" },
    );
  }
  for (const [index, code] of reasonCodes.entries()) {
    if (!isReasonCode(code)) {
      throw new DomainError(
        "VALIDATION",
        `spec.reasonCodes[${index}] must match ${String(REASON_CODE_PATTERN)}`,
        { field: `spec.reasonCodes[${index}]` },
      );
    }
  }

  if (spec.context.length > MAX_DECISION_CONTEXT_ENTRIES) {
    throw new DomainError(
      "VALIDATION",
      `a decision may carry at most ${MAX_DECISION_CONTEXT_ENTRIES} context entries`,
      { field: "spec.context" },
    );
  }
  let inputChars = question.length;
  for (const [index, entry] of spec.context.entries()) {
    const field = `spec.context[${index}]`;
    const text = assertNonEmptyString(entry, field);
    if (text.length > MAX_DECISION_CONTEXT_ENTRY_CHARS) {
      throw new DomainError(
        "VALIDATION",
        `${field} must be at most ${MAX_DECISION_CONTEXT_ENTRY_CHARS} characters`,
        { field },
      );
    }
    if (containsSecretLikeValue(text)) {
      throw new DomainError(
        "VALIDATION",
        `${field} appears to contain secret material; decisions carry references, not secrets`,
        { field },
      );
    }
    inputChars += text.length;
  }
  if (inputChars > MAX_DECISION_INPUT_CHARS) {
    throw new DomainError(
      "VALIDATION",
      `a decision request must carry at most ${MAX_DECISION_INPUT_CHARS} characters of input`,
      { field: "spec" },
    );
  }

  if (!seen.has(spec.defaultOptionId)) {
    throw new DomainError(
      "VALIDATION",
      `spec.defaultOptionId "${spec.defaultOptionId}" is not one of the options`,
      { field: "spec.defaultOptionId" },
    );
  }
  if (spec.deterministic !== undefined) {
    if (!seen.has(spec.deterministic.optionId)) {
      throw new DomainError(
        "VALIDATION",
        `a deterministic answer must name one of the options (got "${spec.deterministic.optionId}")`,
        { field: "spec.deterministic.optionId" },
      );
    }
    if (
      reasonCodes.length > 0 &&
      !reasonCodes.includes(spec.deterministic.reasonCode)
    ) {
      throw new DomainError(
        "VALIDATION",
        `deterministic reason code "${spec.deterministic.reasonCode}" is not in spec.reasonCodes`,
        { field: "spec.deterministic.reasonCode" },
      );
    }
  }
  if (spec.maxLatencyMs !== undefined) {
    assertNonNegativeInteger(spec.maxLatencyMs, "spec.maxLatencyMs");
  }
  if (spec.maxCostMicros !== undefined) {
    assertNonNegativeInteger(spec.maxCostMicros, "spec.maxCostMicros");
  }
}

/* ------------------------------------------------------------------ routing */

/**
 * Execution routes: what an attempt is allowed to *do*, from narrowest to widest.
 *
 * Ordering matters and is part of the contract: a route may only narrow the work a
 * standard attempt would perform. A decision layer can therefore choose a smaller
 * route, never a larger one — it cannot widen scope because wider scope is not in
 * the candidate set unless deterministic code put it there.
 */
export type AttemptRouteId = "standard" | "minimal" | "defer-to-human";

export const ATTEMPT_ROUTE_IDS: readonly AttemptRouteId[] = [
  "standard",
  "minimal",
  "defer-to-human",
];

export const ATTEMPT_ROUTE_OPTIONS: readonly DecisionOption[] = [
  { id: "standard", label: "Run the attempt as configured" },
  { id: "minimal", label: "Run the attempt with the smallest operation set" },
  { id: "defer-to-human", label: "Perform no operation and defer to a human" },
];

export const ROUTING_REASON_CODES = [
  "single-registered-route",
  "routine-task",
  "narrow-scope-preferred",
  "human-judgement-required",
] as const;

export interface RoutingDecisionInput {
  readonly taskRiskLevel: RiskLevel;
  readonly routes: readonly string[];
  readonly context: readonly string[];
}

export function buildRoutingSpec(
  input: RoutingDecisionInput,
): DomainDecisionSpec {
  const routes = input.routes.filter((route): route is AttemptRouteId =>
    (ATTEMPT_ROUTE_IDS as readonly string[]).includes(route),
  );
  const candidates = ATTEMPT_ROUTE_OPTIONS.filter((option) =>
    routes.includes(option.id as AttemptRouteId),
  );
  if (candidates.length === 0) {
    throw new DomainError(
      "VALIDATION",
      "routing requires at least one registered route",
      { field: "routes" },
    );
  }
  const only = candidates.length === 1 ? candidates[0] : undefined;
  return {
    domain: "routing",
    question: `Which execution route should task work at risk level "${input.taskRiskLevel}" take?`,
    options: candidates,
    reasonCodes: ROUTING_REASON_CODES,
    context: input.context,
    defaultOptionId: "standard",
    allowEscalated: routes.includes("defer-to-human"),
    allowAbstained: true,
    ranked: false,
    ...(only === undefined
      ? {}
      : {
          deterministic: {
            optionId: only.id,
            reasonCode: "single-registered-route",
            rationale: `only route "${only.id}" is registered`,
          },
        }),
  };
}

export interface RouteDecision {
  readonly routeId: AttemptRouteId;
  readonly deferToHuman: boolean;
  readonly reasonCode?: string;
  readonly meta: DecisionOutcomeMeta;
}

export function interpretRoute(
  outcome: DomainDecisionOutcome,
  meta: DecisionOutcomeMeta,
): RouteDecision {
  const routeId = (outcome.selectedOptionId ?? "standard") as AttemptRouteId;
  return {
    routeId,
    deferToHuman: routeId === "defer-to-human",
    ...(outcome.reasonCode === undefined
      ? {}
      : { reasonCode: outcome.reasonCode }),
    meta,
  };
}

/* ---------------------------------------------------------- tool-selection */

/**
 * A tool the runtime may ask for, with the operation it would perform.
 *
 * The list is produced by deterministic code (the agent runner's registry, filtered
 * by the capability envelope the attempt was given) and is passed *in*. A decision
 * layer selects from it; it cannot add to it. `ref` is a workspace-relative
 * reference and is validated as one by the enforcement layer when the operation is
 * actually requested.
 */
export interface ToolCandidate {
  readonly toolId: string;
  readonly label: string;
  readonly operation: OperationKind;
  readonly capability?: Capability;
  /** Workspace-relative reference the tool would act on, when it acts on one. */
  readonly ref?: string;
}

export const TOOL_SELECTION_REASON_CODES = [
  "single-allowed-tool",
  "cheapest-sufficient-tool",
  "least-privilege-tool",
  "most-informative-tool",
] as const;

export interface ToolSelectionInput {
  readonly candidates: readonly ToolCandidate[];
  /** The option assumed when no provider answer is available. */
  readonly defaultToolId: string;
  readonly context: readonly string[];
}

export function toolCandidateOptions(
  candidates: readonly ToolCandidate[],
): readonly DecisionOption[] {
  return candidates.map((candidate) => ({
    id: candidate.toolId,
    label: candidate.label,
    metadata: {
      operation: candidate.operation,
      ...(candidate.capability === undefined
        ? {}
        : { capability: candidate.capability }),
    },
  }));
}

export function buildToolSelectionSpec(
  input: ToolSelectionInput,
): DomainDecisionSpec {
  if (input.candidates.length === 0) {
    throw new DomainError(
      "VALIDATION",
      "tool selection requires at least one allowed candidate",
      { field: "candidates" },
    );
  }
  const options = toolCandidateOptions(input.candidates);
  if (!options.some((option) => option.id === input.defaultToolId)) {
    throw new DomainError(
      "VALIDATION",
      `defaultToolId "${input.defaultToolId}" is not one of the candidates`,
      { field: "defaultToolId" },
    );
  }
  const only = options.length === 1 ? options[0] : undefined;
  return {
    domain: "tool-selection",
    question: "Which allowed tool should the runtime use for this task?",
    options,
    reasonCodes: TOOL_SELECTION_REASON_CODES,
    context: [...input.context, `candidates:${input.candidates.length}`],
    defaultOptionId: input.defaultToolId,
    allowEscalated: false,
    allowAbstained: true,
    ranked: false,
    ...(only === undefined
      ? {}
      : {
          deterministic: {
            optionId: only.id,
            reasonCode: "single-allowed-tool",
            rationale: `only "${only.id}" is permitted by the capability envelope`,
          },
        }),
  };
}

export interface ToolSelectionDecision {
  readonly toolId: string;
  readonly reasonCode?: string;
  readonly meta: DecisionOutcomeMeta;
}

export function interpretToolSelection(
  outcome: DomainDecisionOutcome,
  meta: DecisionOutcomeMeta,
  fallbackToolId: string,
): ToolSelectionDecision {
  return {
    toolId: outcome.selectedOptionId ?? fallbackToolId,
    ...(outcome.reasonCode === undefined
      ? {}
      : { reasonCode: outcome.reasonCode }),
    meta,
  };
}

/* --------------------------------------------------------- risk-assessment */

export const RISK_ASSESSMENT_REASON_CODES = [
  "baseline-risk",
  "declared-risk",
  "destructive-operation",
  "external-effect",
  "credential-adjacent",
  "irreversible-change",
  "routine-change",
] as const;

export const RISK_OPTIONS: readonly DecisionOption[] = RISK_LEVELS.map(
  (level) => ({ id: level, label: `${level} risk` }),
);

export interface RiskAssessmentInput {
  readonly operation: OperationKind;
  /** Deterministic floor: the operation baseline raised by the declared level. */
  readonly baselineRisk: RiskLevel;
  readonly context: readonly string[];
}

export function buildRiskAssessmentSpec(
  input: RiskAssessmentInput,
): DomainDecisionSpec {
  // Deterministic gate: nothing can raise a critical risk further, so asking is
  // pure cost. The answer is the baseline, recorded as decided by code.
  const deterministic =
    riskRank(input.baselineRisk) >= riskRank("critical")
      ? {
          optionId: "critical",
          reasonCode: "baseline-risk",
          rationale:
            "the operation baseline is already critical; no contextual assessment can raise it",
        }
      : undefined;
  return {
    domain: "risk-assessment",
    question:
      `What contextual risk does operation "${input.operation}" carry, beyond its ` +
      `"${input.baselineRisk}" baseline?`,
    options: RISK_OPTIONS,
    reasonCodes: RISK_ASSESSMENT_REASON_CODES,
    context: input.context,
    defaultOptionId: input.baselineRisk,
    allowEscalated: false,
    allowAbstained: true,
    ranked: false,
    ...(deterministic === undefined ? {} : { deterministic }),
  };
}

export interface RiskAssessmentDecision {
  /**
   * The risk to *use*: never below the deterministic baseline, and never above
   * `critical`. A provider answer can raise scrutiny, never lower it.
   */
  readonly effectiveRisk: RiskLevel;
  readonly assessedRisk: RiskLevel;
  readonly raised: boolean;
  readonly reasonCode?: string;
  readonly meta: DecisionOutcomeMeta;
}

export function interpretRiskAssessment(
  outcome: DomainDecisionOutcome,
  meta: DecisionOutcomeMeta,
  baselineRisk: RiskLevel,
): RiskAssessmentDecision {
  const assessed = RISK_LEVELS.find(
    (level) => level === outcome.selectedOptionId,
  );
  // `maxRisk` is the whole guarantee: a provider that answers "low" for a critical
  // operation has its answer recorded, and no effect on enforcement.
  const effectiveRisk =
    assessed === undefined ? baselineRisk : maxRisk([baselineRisk, assessed]);
  return {
    effectiveRisk,
    assessedRisk: assessed ?? baselineRisk,
    raised: riskRank(effectiveRisk) > riskRank(baselineRisk),
    ...(outcome.reasonCode === undefined
      ? {}
      : { reasonCode: outcome.reasonCode }),
    meta,
  };
}

/* -------------------------------------------------------------------- retry */

export const RETRY_REASON_CODES = [
  "transient-failure",
  "retryable-failure",
  "quality-below-threshold",
  "retry-limit-reached",
  "failure-not-retryable",
  "budget-exhausted",
  "deterministic-failure",
] as const;

export const RETRY_OPTIONS: readonly DecisionOption[] = [
  { id: "retry", label: "Retry within the deterministic limits" },
  { id: "stop", label: "Stop and report the failure" },
  { id: "escalate", label: "Escalate to a human" },
];

export type RetryAction = "retry" | "stop" | "escalate";

export interface RetryDecisionInput {
  /** What failed, in the platform's own vocabulary: an LLM failure kind. */
  readonly failureKind: string;
  readonly retryable: boolean;
  readonly attemptsSpent: number;
  /** Hard deterministic cap on attempt-level retries. */
  readonly maxRetries: number;
  /** Retries the task budget still allows. */
  readonly retriesRemaining: number;
  readonly context: readonly string[];
}

export function buildRetrySpec(input: RetryDecisionInput): DomainDecisionSpec {
  const limit = (() => {
    if (!input.retryable) {
      return {
        optionId: "stop",
        reasonCode: "failure-not-retryable",
        rationale: `failure "${input.failureKind}" is not retryable by policy`,
      };
    }
    if (input.attemptsSpent >= input.maxRetries) {
      return {
        optionId: "stop",
        reasonCode: "retry-limit-reached",
        rationale: `${input.attemptsSpent} of ${input.maxRetries} attempt-level retr(ies) spent`,
      };
    }
    if (input.retriesRemaining <= 0) {
      return {
        optionId: "stop",
        reasonCode: "budget-exhausted",
        rationale: "the task budget allows no further retries",
      };
    }
    return undefined;
  })();
  return {
    domain: "retry",
    question: `Should the attempt be retried after a "${input.failureKind}" failure?`,
    options: RETRY_OPTIONS,
    reasonCodes: RETRY_REASON_CODES,
    context: [
      ...input.context,
      `attempts-spent:${input.attemptsSpent}`,
      `retries-remaining:${input.retriesRemaining}`,
    ],
    defaultOptionId: "stop",
    allowEscalated: true,
    allowAbstained: true,
    ranked: false,
    ...(limit === undefined ? {} : { deterministic: limit }),
  };
}

export interface RetryDecisionResult {
  readonly action: RetryAction;
  readonly reasonCode?: string;
  readonly meta: DecisionOutcomeMeta;
}

export function interpretRetry(
  outcome: DomainDecisionOutcome,
  meta: DecisionOutcomeMeta,
): RetryDecisionResult {
  const action: RetryAction =
    outcome.outcome === "escalated"
      ? "escalate"
      : outcome.selectedOptionId === "retry"
        ? "retry"
        : "stop";
  return {
    action,
    ...(outcome.reasonCode === undefined
      ? {}
      : { reasonCode: outcome.reasonCode }),
    meta,
  };
}

/* -------------------------------------------------------- execution-strategy */

/**
 * Whether this task should be executed by a model at all — and if not, by what.
 *
 * This is the question that precedes every other one: a task that code can finish
 * must not spend a model call, and a task that needs a model this project cannot
 * reach is not a task to attempt quietly. It is deliberately *not* a model-selection
 * question (that is `ranking`) and not a capability question (deterministic code
 * answers which capabilities the words require): it is the judgement of whether the
 * work should be done deterministically, by a model, or by a human.
 *
 * Three of the four cases are answered by code, because they have one defensible
 * answer each and asking would be pure cost (ADR-051/ADR-052):
 *
 * - a model is required and candidates exist → `model`;
 * - a model is required and no registered model matches → `human` (a capability
 *   nobody supplies is a human's problem, not something to attempt anyway);
 * - no model capability is required and risk is below high → `deterministic`.
 *
 * The fourth is the interesting one and goes to the provider: **no model capability
 * is required, but the task is high-risk**. Code could finish it, and code finishing
 * it silently is exactly what nobody asked for on a high-risk change. Whether the
 * deterministic path is safe here is a judgement call, so it is the JEV's.
 */
export const EXECUTION_STRATEGY_REASON_CODES = [
  "no-model-capability-required",
  "model-capability-required",
  "eligible-model-available",
  "no-eligible-model",
  "routine-change",
  "high-risk-deterministic-work",
  "human-judgement-required",
] as const;

export const EXECUTION_STRATEGY_OPTIONS: readonly DecisionOption[] = [
  {
    id: "deterministic",
    label: "Complete it deterministically, with no model call",
  },
  { id: "model", label: "Execute it with a model through Frontier" },
  { id: "human", label: "Hand it to a human before spending anything" },
];

export type ExecutionStrategyId = "deterministic" | "model" | "human";

export interface ExecutionStrategyInput {
  /** True when the task's own words require a capability only a model supplies. */
  readonly modelRequired: boolean;
  /** How many registered models satisfy the requirement set. Metadata, not a choice. */
  readonly eligibleCandidates: number;
  readonly riskLevel: RiskLevel;
  /** Required capabilities, as codes. References only, never task text. */
  readonly requiredCapabilities: readonly string[];
  readonly context: readonly string[];
}

export function buildExecutionStrategySpec(
  input: ExecutionStrategyInput,
): DomainDecisionSpec {
  const deterministic = ((): DomainDeterministicAnswer | undefined => {
    if (input.modelRequired && input.eligibleCandidates > 0) {
      return {
        optionId: "model",
        reasonCode: "eligible-model-available",
        rationale: `${input.eligibleCandidates} registered model(s) satisfy the required capabilities`,
      };
    }
    if (input.modelRequired) {
      return {
        optionId: "human",
        reasonCode: "no-eligible-model",
        rationale:
          "a model is required but no registered model satisfies the requirement set",
      };
    }
    if (riskRank(input.riskLevel) < riskRank("high")) {
      return {
        optionId: "deterministic",
        reasonCode: "no-model-capability-required",
        rationale:
          "the task requests no capability only a model supplies, at risk below high",
      };
    }
    return undefined;
  })();
  return {
    domain: "execution-strategy",
    question:
      `Should this ${input.riskLevel}-risk task be completed deterministically, ` +
      `executed with a model, or handed to a human?`,
    options: EXECUTION_STRATEGY_OPTIONS,
    reasonCodes: EXECUTION_STRATEGY_REASON_CODES,
    context: [
      ...input.context,
      `risk:${input.riskLevel}`,
      `model-required:${input.modelRequired}`,
      `eligible-models:${input.eligibleCandidates}`,
      `capabilities:${input.requiredCapabilities.join("+") || "none"}`,
    ],
    // The conservative default: a high-risk task that code *could* finish is not
    // auto-completed on the strength of an absent opinion.
    defaultOptionId: "human",
    allowEscalated: true,
    allowAbstained: true,
    ranked: false,
    ...(deterministic === undefined ? {} : { deterministic }),
  };
}

export interface ExecutionStrategyDecision {
  readonly strategy: ExecutionStrategyId;
  readonly reasonCode?: string;
  readonly meta: DecisionOutcomeMeta;
}

export function interpretExecutionStrategy(
  outcome: DomainDecisionOutcome,
  meta: DecisionOutcomeMeta,
  fallbackStrategy: ExecutionStrategyId,
): ExecutionStrategyDecision {
  // `escalated` is an answer to this question: it means "a human, now", and is
  // recorded as the human strategy rather than as a missing answer.
  const strategy =
    outcome.outcome === "escalated"
      ? "human"
      : EXECUTION_STRATEGY_OPTIONS.some(
            (option) => option.id === outcome.selectedOptionId,
          )
        ? (outcome.selectedOptionId as ExecutionStrategyId)
        : fallbackStrategy;
  return {
    strategy,
    ...(outcome.reasonCode === undefined
      ? {}
      : { reasonCode: outcome.reasonCode }),
    meta,
  };
}

/* --------------------------------------------------------------- completion */

export const COMPLETION_REASON_CODES = [
  "criteria-met",
  "verification-passed",
  "evidence-insufficient",
  "verification-failed",
  "criteria-unclear",
  "no-verification-evidence",
] as const;

export const COMPLETION_OPTIONS: readonly DecisionOption[] = [
  { id: "complete", label: "Evidence suggests the task is complete" },
  { id: "incomplete", label: "Evidence suggests the task is not complete" },
  { id: "uncertain", label: "Evidence is insufficient to say" },
];

export type CompletionAssessmentId = "complete" | "incomplete" | "uncertain";

export interface CompletionDecisionInput {
  readonly acceptanceCriteriaTotal: number;
  /**
   * Absent when no criterion-level verification exists yet.
   *
   * Optional rather than defaulted to zero: "we did not measure criterion progress"
   * and "none of the criteria are met" are different facts, and a decision layer must
   * not be handed the second in place of the first.
   */
  readonly acceptanceCriteriaMet?: number;
  readonly verificationChecks: number;
  readonly verificationFailures: number;
  readonly context: readonly string[];
}

export function buildCompletionSpec(
  input: CompletionDecisionInput,
): DomainDecisionSpec {
  const deterministic = (() => {
    if (input.verificationFailures > 0) {
      return {
        optionId: "incomplete",
        reasonCode: "verification-failed",
        rationale: `${input.verificationFailures} verification check(s) failed`,
      };
    }
    if (input.verificationChecks === 0) {
      return {
        optionId: "uncertain",
        reasonCode: "no-verification-evidence",
        rationale: "no verification result was produced for this attempt",
      };
    }
    return undefined;
  })();
  return {
    domain: "completion",
    question: "Does the recorded evidence suggest this task is complete?",
    options: COMPLETION_OPTIONS,
    reasonCodes: COMPLETION_REASON_CODES,
    context: [
      ...input.context,
      `criteria:${input.acceptanceCriteriaMet ?? "unmeasured"}/${input.acceptanceCriteriaTotal}`,
      `verification-checks:${input.verificationChecks}`,
    ],
    defaultOptionId: "uncertain",
    allowEscalated: false,
    allowAbstained: true,
    ranked: false,
    ...(deterministic === undefined ? {} : { deterministic }),
  };
}

export interface CompletionDecisionResult {
  /** An assessment only. The task state machine remains deterministic (ADR-054). */
  readonly assessment: CompletionAssessmentId;
  readonly reasonCode?: string;
  readonly meta: DecisionOutcomeMeta;
}

export function interpretCompletion(
  outcome: DomainDecisionOutcome,
  meta: DecisionOutcomeMeta,
): CompletionDecisionResult {
  const assessment = COMPLETION_OPTIONS.some(
    (option) => option.id === outcome.selectedOptionId,
  )
    ? (outcome.selectedOptionId as CompletionAssessmentId)
    : "uncertain";
  return {
    assessment,
    ...(outcome.reasonCode === undefined
      ? {}
      : { reasonCode: outcome.reasonCode }),
    meta,
  };
}

/* -------------------------------------------------------- human-escalation */

export const ESCALATION_REASON_CODES = [
  "security-refusal",
  "policy-denial",
  "repeated-failure",
  "insufficient-evidence",
  "resource-boundary",
  "routine-outcome",
] as const;

export const ESCALATION_OPTIONS: readonly DecisionOption[] = [
  { id: "review", label: "Recommend human review" },
  { id: "no-review", label: "Recommend no human review" },
];

export type EscalationRecommendationId = "review" | "no-review";

export interface EscalationDecisionInput {
  /** Deterministic facts the recommendation is based on. References only. */
  readonly facts: readonly string[];
  /** True when a deterministic security or policy refusal stopped the work. */
  readonly securityRefusal: boolean;
  readonly context: readonly string[];
}

export function buildEscalationSpec(
  input: EscalationDecisionInput,
): DomainDecisionSpec {
  // A security or policy refusal is never delegated to a decision layer: a human
  // must see it. This is the one place where the escalation question has a single
  // defensible answer, and it is answered in code (ADR-053).
  const deterministic = input.securityRefusal
    ? {
        optionId: "review",
        reasonCode: "security-refusal",
        rationale:
          "a deterministic security or policy refusal stopped the work; a human must review it",
      }
    : undefined;
  return {
    domain: "human-escalation",
    question: "Should a human review this outcome before the task is closed?",
    options: ESCALATION_OPTIONS,
    reasonCodes: ESCALATION_REASON_CODES,
    context: [...input.context, ...input.facts.map((fact) => `fact:${fact}`)],
    defaultOptionId: "review",
    allowEscalated: true,
    allowAbstained: true,
    ranked: false,
    ...(deterministic === undefined ? {} : { deterministic }),
  };
}

export interface EscalationDecisionResult {
  /**
   * A recommendation, never an approval and never a suspension. It cannot create an
   * approval request, change task state, or grant anything (ADR-055).
   */
  readonly recommendation: EscalationRecommendationId;
  readonly reasonCode?: string;
  readonly meta: DecisionOutcomeMeta;
}

export function interpretEscalation(
  outcome: DomainDecisionOutcome,
  meta: DecisionOutcomeMeta,
): EscalationDecisionResult {
  const recommendation: EscalationRecommendationId =
    outcome.outcome === "escalated" ? "review" : "no-review";
  if (outcome.outcome !== "escalated") {
    // Only an explicit `review` selection recommends review; `no-review` and every
    // other shape are reported conservatively below by the caller when relevant.
    const selected = outcome.selectedOptionId;
    return {
      recommendation: selected === "review" ? "review" : "no-review",
      ...(outcome.reasonCode === undefined
        ? {}
        : { reasonCode: outcome.reasonCode }),
      meta,
    };
  }
  return {
    recommendation,
    ...(outcome.reasonCode === undefined
      ? {}
      : { reasonCode: outcome.reasonCode }),
    meta,
  };
}

/* ------------------------------------------------------------------ ranking */

export const RANKING_REASON_CODES = [
  "single-candidate",
  "ordered-by-relevance",
  "ordered-by-cost",
  "ordered-by-safety",
] as const;

export interface RankingDecisionInput {
  readonly candidates: readonly DecisionOption[];
  readonly context: readonly string[];
}

export function buildRankingSpec(
  input: RankingDecisionInput,
): DomainDecisionSpec {
  if (input.candidates.length === 0) {
    throw new DomainError("VALIDATION", "ranking requires candidates", {
      field: "candidates",
    });
  }
  const deterministic =
    input.candidates.length === 1
      ? {
          optionId: input.candidates[0].id,
          reasonCode: "single-candidate",
          rationale: "only one candidate was supplied",
        }
      : undefined;
  return {
    domain: "ranking",
    question: "In what order should these candidates be considered?",
    options: input.candidates,
    reasonCodes: RANKING_REASON_CODES,
    context: input.context,
    defaultOptionId: input.candidates[0].id,
    allowEscalated: false,
    allowAbstained: true,
    ranked: true,
    ...(deterministic === undefined ? {} : { deterministic }),
  };
}

export interface RankingDecisionResult {
  /** Candidate ids in rank order. Always a permutation of the supplied candidates. */
  readonly ranking: readonly string[];
  readonly reasonCode?: string;
  readonly meta: DecisionOutcomeMeta;
}

export function interpretRanking(
  outcome: DomainDecisionOutcome,
  meta: DecisionOutcomeMeta,
  candidates: readonly DecisionOption[],
): RankingDecisionResult {
  const supplied = candidates.map((option) => option.id);
  const ranking =
    outcome.ranking !== undefined && outcome.ranking.length === supplied.length
      ? outcome.ranking
      : supplied;
  return {
    ranking,
    ...(outcome.reasonCode === undefined
      ? {}
      : { reasonCode: outcome.reasonCode }),
    meta,
  };
}

/* ---------------------------------------------------------------- relevance */

export const RELEVANCE_REASON_CODES = [
  "explicitly-referenced",
  "related-by-path",
  "unrelated",
  "insufficient-evidence",
] as const;

export const RELEVANCE_OPTIONS: readonly DecisionOption[] = [
  { id: "relevant", label: "The candidate is relevant to the task" },
  { id: "not-relevant", label: "The candidate is not relevant to the task" },
];

export type RelevanceVerdict = "relevant" | "not-relevant";

export interface RelevanceDecisionInput {
  readonly candidateRefs: readonly string[];
  readonly context: readonly string[];
}

export function buildRelevanceSpec(
  input: RelevanceDecisionInput,
): DomainDecisionSpec {
  if (input.candidateRefs.length === 0) {
    throw new DomainError("VALIDATION", "relevance requires candidates", {
      field: "candidateRefs",
    });
  }
  return {
    domain: "relevance",
    question: "Is the bounded candidate set relevant to this task?",
    options: RELEVANCE_OPTIONS,
    reasonCodes: RELEVANCE_REASON_CODES,
    context: [...input.context, ...input.candidateRefs],
    // Conservative default: an unavailable decision layer never asserts relevance
    // it cannot establish.
    defaultOptionId: "not-relevant",
    allowEscalated: false,
    allowAbstained: true,
    ranked: false,
  };
}

export interface RelevanceDecisionResult {
  readonly verdict: RelevanceVerdict;
  readonly reasonCode?: string;
  readonly meta: DecisionOutcomeMeta;
}

export function interpretRelevance(
  outcome: DomainDecisionOutcome,
  meta: DecisionOutcomeMeta,
): RelevanceDecisionResult {
  return {
    verdict:
      outcome.selectedOptionId === "relevant" ? "relevant" : "not-relevant",
    ...(outcome.reasonCode === undefined
      ? {}
      : { reasonCode: outcome.reasonCode }),
    meta,
  };
}

/* ---------------------------------------------------------- skill-selection */

export const SKILL_SELECTION_REASON_CODES = [
  "explicit-skill-match",
  "declared-capability-match",
  "ambiguous-skill-match",
  "no-skill-available",
  "insufficient-evidence",
] as const;

export const SKILL_SELECTION_NO_SKILL = "no-skill";

export type SkillSelectionVerdict = "select-skill" | "no-skill";

export interface SkillSelectionInput {
  /** Registered skill ids only. A provider cannot invent one of these. */
  readonly skillIds: readonly string[];
  readonly context: readonly string[];
}

/**
 * Builds the skill-selection question: "which available skill, if any, applies?".
 *
 * The option set is the registered skills plus one non-skill answer. Validation
 * rejects any answer naming something outside it, so a decision can select a skill
 * that exists or select none — it can never invent one.
 */
export function buildSkillSelectionSpec(
  input: SkillSelectionInput,
): DomainDecisionSpec {
  if (input.skillIds.length === 0) {
    throw new DomainError(
      "VALIDATION",
      "skill selection requires at least one registered skill",
      { field: "skillIds" },
    );
  }
  if (input.skillIds.length > MAX_DECISION_OPTIONS - 1) {
    throw new DomainError(
      "VALIDATION",
      `skill selection supports at most ${MAX_DECISION_OPTIONS - 1} skills per question`,
      { field: "skillIds" },
    );
  }
  return {
    domain: "skill-selection",
    question: "Which available skill, if any, is relevant to the current state?",
    options: [
      ...input.skillIds.map(
        (id): DecisionOption => ({ id, label: `registered skill: ${id}` }),
      ),
      {
        id: SKILL_SELECTION_NO_SKILL,
        label: "No registered skill matches; proceed without one",
      },
    ],
    reasonCodes: SKILL_SELECTION_REASON_CODES,
    context: input.context,
    defaultOptionId: SKILL_SELECTION_NO_SKILL,
    allowEscalated: false,
    allowAbstained: true,
    ranked: false,
  };
}

export interface SkillSelectionResult {
  readonly verdict: SkillSelectionVerdict;
  /** Present only when the verdict is `select-skill`; a registered skill id. */
  readonly skillId?: string;
  readonly reasonCode?: string;
  readonly meta: DecisionOutcomeMeta;
}

export function interpretSkillSelection(
  outcome: DomainDecisionOutcome,
  meta: DecisionOutcomeMeta,
): SkillSelectionResult {
  const selected = outcome.selectedOptionId;
  if (selected === undefined || selected === SKILL_SELECTION_NO_SKILL) {
    return {
      verdict: "no-skill",
      ...(outcome.reasonCode === undefined ? {} : { reasonCode: outcome.reasonCode }),
      meta,
    };
  }
  // Validation has already proven the answer named an offered option, and every
  // offered option except `no-skill` is a registered skill id.
  return {
    verdict: "select-skill",
    skillId: selected,
    ...(outcome.reasonCode === undefined ? {} : { reasonCode: outcome.reasonCode }),
    meta,
  };
}

/* ------------------------------------------------------- context-selection */

export const CONTEXT_SELECTION_REASON_CODES = [
  "explicitly-referenced",
  "related-by-path",
  "duplicate-of-kept",
  "stale-or-superseded",
  "unrelated",
  "insufficient-evidence",
] as const;

export const CONTEXT_SELECTION_OPTIONS: readonly DecisionOption[] = [
  { id: "keep", label: "Keep the candidate in context" },
  { id: "drop", label: "Drop the candidate from context" },
  { id: "compress", label: "Keep a compressed form of the candidate" },
];

export type ContextSelectionVerdict = "keep" | "drop" | "compress";

export interface ContextSelectionInput {
  /** Candidate references (paths, ids) — never the candidate content itself. */
  readonly candidateRefs: readonly string[];
  readonly context: readonly string[];
}

/**
 * Builds one context-candidate question: keep, drop, or compress.
 *
 * The default is `drop`: an unavailable decision layer never grows the context.
 * Compression itself, when chosen, is performed by the context engine's own
 * mechanisms — this decision only classifies the candidate.
 */
export function buildContextSelectionSpec(
  input: ContextSelectionInput,
): DomainDecisionSpec {
  if (input.candidateRefs.length === 0) {
    throw new DomainError(
      "VALIDATION",
      "context selection requires at least one candidate",
      { field: "candidateRefs" },
    );
  }
  return {
    domain: "context-selection",
    question: "Should this context candidate be kept, dropped, or compressed?",
    options: CONTEXT_SELECTION_OPTIONS,
    reasonCodes: CONTEXT_SELECTION_REASON_CODES,
    context: [...input.context, ...input.candidateRefs],
    defaultOptionId: "drop",
    allowEscalated: false,
    allowAbstained: true,
    ranked: false,
  };
}

export interface ContextSelectionResult {
  readonly verdict: ContextSelectionVerdict;
  readonly reasonCode?: string;
  /** The provider's confidence in this classification, when it reported one. */
  readonly confidence?: number;
  readonly meta: DecisionOutcomeMeta;
}

export function interpretContextSelection(
  outcome: DomainDecisionOutcome,
  meta: DecisionOutcomeMeta,
): ContextSelectionResult {
  return {
    verdict:
      outcome.selectedOptionId === "keep"
        ? "keep"
        : outcome.selectedOptionId === "compress"
          ? "compress"
          : "drop",
    ...(outcome.reasonCode === undefined ? {} : { reasonCode: outcome.reasonCode }),
    ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
    meta,
  };
}

/* ------------------------------------------------------------------ helpers */

/**
 * Confidence, when a provider supplies one.
 *
 * Absent is not 0.5 and not 1: an assessment without confidence is recorded as
 * having none, the same honesty rule `usage` follows (ADR-035).
 */
export function assertConfidence(
  value: unknown,
  field = "confidence",
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertUnitInterval(value, field);
}
