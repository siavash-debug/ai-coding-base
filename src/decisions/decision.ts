import { type Clock, toIsoString } from "../core/clock.js";
import { DomainError } from "../core/errors.js";
import type {
  DecisionId,
  ProjectId,
  SessionId,
  TaskId,
  WorkspaceId,
} from "../core/ids.js";
import {
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertOneOf,
  assertUnitInterval,
} from "../core/validation.js";
import { type AIUsage, assertValidUsage } from "../observability/usage.js";
import {
  DECISION_ANSWER_SOURCES,
  DECISION_FALLBACK_REASONS,
  DECISION_PROVIDER_EXECUTION_SOURCES,
  type DecisionAnswerSource,
  type DecisionFallbackReason,
  type DecisionProviderExecutionSourceValue,
} from "./domains.js";

/**
 * Decision: a recorded answer to a bounded question.
 *
 * A decision is created `pending` when the question is asked and resolved exactly
 * once. `decidedBy` records which layer answered, which is what makes the
 * cheapest-sufficient-layer ladder auditable.
 * See docs/architecture/V2-ARCHITECTURE.md §8 and DECISIONS.md ADR-003.
 */
/**
 * The decision kind vocabulary.
 *
 * The first group is the Phase B vocabulary: generic concerns that were enough to
 * record "which layer answered this". The second group is the Phase G decision
 * domains (`src/decisions/domains.ts`), added because a bounded question about a
 * retry is not the same question as one about relevance, and the log has to say
 * which was asked. Entries are only ever *added*: a kind is part of the persisted
 * event vocabulary, so removing or renaming one would make recorded history
 * unreadable (ADR-051).
 */
export const DECISION_KINDS = [
  "routing",
  "classification",
  "selection",
  "policy",
  "escalation",
  "approval",
  "other",
  "tool-selection",
  "risk-assessment",
  "retry",
  "completion",
  "ranking",
  "relevance",
  "human-escalation",
  "execution-strategy",
  "context-selection",
  "skill-selection",
] as const;

export type DecisionKind = (typeof DECISION_KINDS)[number];

export const DECISION_OUTCOMES = [
  "pending",
  "selected",
  "abstained",
  "escalated",
  "failed",
] as const;

export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export type ResolvedDecisionOutcome = Exclude<DecisionOutcome, "pending">;

export const RESOLVED_DECISION_OUTCOMES = [
  "selected",
  "abstained",
  "escalated",
  "failed",
] as const satisfies readonly ResolvedDecisionOutcome[];

export const DECIDED_BY = [
  "code",
  "policy",
  "decision-provider",
  "llm",
  "human",
] as const;

export type DecidedBy = (typeof DECIDED_BY)[number];

export type DecisionOptionMetadata = Readonly<
  Record<string, string | number | boolean>
>;

export interface DecisionOption {
  readonly id: string;
  readonly label: string;
  readonly metadata?: DecisionOptionMetadata;
}

/**
 * How a decision was answered, and why a deterministic answer was used.
 *
 * Recorded because "the decision layer was unavailable" and "the decision layer
 * answered" must never be confused after the fact, and because a provider that
 * failed must stay visible (ADR-052).
 */
export interface DecisionFallback {
  readonly reason: DecisionFallbackReason;
  /** The provider that was consulted, when one was. */
  readonly providerId?: string;
  /** The provider failure category, when the fallback followed a failure. */
  readonly failureKind?: string;
}

export interface Decision {
  readonly id: DecisionId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly taskId?: TaskId;
  readonly sessionId?: SessionId;
  readonly kind: DecisionKind;
  readonly question: string;
  readonly options: readonly DecisionOption[];
  readonly outcome: DecisionOutcome;
  readonly selectedOptionId?: string;
  /** Complete ordering of every option, for questions that ask for one. */
  readonly ranking?: readonly string[];
  /** Absent while `outcome` is `pending`. */
  readonly decidedBy?: DecidedBy;
  /**
   * Which layer answered: the deterministic gate, a provider, or the fallback.
   *
   * Stored explicitly rather than derived from `decidedBy`, because "a provider was
   * consulted and failed" and "no provider was consulted" both produce a
   * code-decided record and must stay distinguishable in the log (ADR-052).
   */
  readonly answeredBy?: DecisionAnswerSource;
  /** The explanation code the answer carried, from the offered vocabulary. */
  readonly reasonCode?: string;
  /** The provider-side model or version, when the provider named one. */
  readonly modelId?: string;
  readonly rationale?: string;
  readonly confidence?: number;
  readonly alternativesConsidered: readonly string[];
  /** References (paths, ids), never payloads and never secret values. */
  readonly evidence: readonly string[];
  readonly providerId?: string;
  readonly latencyMs?: number;
  readonly costMicros?: number;
  /** Reported usage, when the decision provider reported any. */
  readonly usage?: AIUsage;
  /** False when the provider reported no usage. Never means "free". */
  readonly usageReported?: boolean;
  /**
   * How the provider that answered produced its answer, when it attested it.
   *
   * `live-sdk` means the TypeSafe adapter's real SDK boundary executed; a test
   * double can only ever carry `test-double`, and absence means the provider did
   * not attest its path. Never present on a code-answered or fallback decision.
   */
  readonly executionSource?: DecisionProviderExecutionSourceValue;
  readonly fallback?: DecisionFallback;
  readonly createdAt: string;
  readonly decidedAt?: string;
}

/**
 * Which layer produced the answer.
 *
 * Derived rather than stored: a decision answered by the deterministic fallback is
 * `decidedBy: "code"`, because code produced it — the fallback field is what records
 * that a provider was consulted first and failed.
 */
export function decisionAnswerSource(
  decision: Decision,
): DecisionAnswerSource | undefined {
  if (decision.decidedBy === undefined) {
    return undefined;
  }
  if (decision.fallback !== undefined) {
    return "fallback";
  }
  return decision.decidedBy === "decision-provider"
    ? "provider"
    : "deterministic";
}

export interface CreateDecisionInput {
  readonly kind: DecisionKind;
  readonly question: string;
  readonly options: readonly DecisionOption[];
  readonly taskId?: TaskId;
  readonly sessionId?: SessionId;
  /**
   * The closed explanation vocabulary the question may be answered with.
   *
   * Recorded with the question, so "what could it have said?" is answerable from the
   * log rather than from the code that happened to be running.
   */
  readonly reasonCodes?: readonly string[];
}

export interface DecisionResolution {
  readonly outcome: ResolvedDecisionOutcome;
  readonly decidedBy: DecidedBy;
  readonly selectedOptionId?: string;
  readonly ranking?: readonly string[];
  readonly rationale?: string;
  readonly confidence?: number;
  readonly providerId?: string;
  readonly latencyMs?: number;
  readonly costMicros?: number;
  readonly evidence?: readonly string[];
  readonly usage?: AIUsage;
  readonly usageReported?: boolean;
  /**
   * The provider's own execution-path attestation, flattened to the closed
   * vocabulary. Only meaningful when `decidedBy` is `decision-provider`.
   */
  readonly executionSource?: DecisionProviderExecutionSourceValue;
  readonly fallback?: DecisionFallback;
  readonly answeredBy?: DecisionAnswerSource;
  readonly reasonCode?: string;
  readonly modelId?: string;
}

function validateOptions(
  options: readonly DecisionOption[],
): readonly DecisionOption[] {
  if (!Array.isArray(options) || options.length === 0) {
    throw new DomainError(
      "VALIDATION",
      "a decision requires at least one enumerated option",
      { field: "options" },
    );
  }
  const seen = new Set<string>();
  return options.map((option, index) => {
    const field = `options[${index}]`;
    const id = assertNonEmptyString(option.id, `${field}.id`);
    if (seen.has(id)) {
      throw new DomainError(
        "INVARIANT",
        `duplicate decision option id "${id}"`,
        {
          field: `${field}.id`,
        },
      );
    }
    seen.add(id);
    return {
      id,
      label: assertNonEmptyString(option.label, `${field}.label`),
      ...(option.metadata === undefined ? {} : { metadata: option.metadata }),
    };
  });
}

export function createDecision(
  input: CreateDecisionInput,
  options: {
    readonly id: DecisionId;
    readonly projectId: ProjectId;
    readonly workspaceId: WorkspaceId;
    readonly clock: Clock;
  },
): Decision {
  const kind = assertOneOf(input.kind, DECISION_KINDS, "kind");
  const question = assertNonEmptyString(input.question, "question");
  const decisionOptions = validateOptions(input.options);

  return {
    id: options.id,
    projectId: options.projectId,
    workspaceId: options.workspaceId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    kind,
    question,
    options: decisionOptions,
    outcome: "pending",
    alternativesConsidered: [],
    evidence: [],
    createdAt: toIsoString(options.clock.now()),
  };
}

export function isPendingDecision(decision: Decision): boolean {
  return decision.outcome === "pending";
}

/**
 * Resolves a pending decision exactly once. A resolved decision is immutable, so
 * re-resolving throws rather than silently rewriting history.
 */
export function resolveDecision(
  decision: Decision,
  resolution: DecisionResolution,
  clock: Clock,
): Decision {
  if (!isPendingDecision(decision)) {
    throw new DomainError(
      "INVARIANT",
      `decision "${decision.id}" is already resolved as "${decision.outcome}"`,
      { field: "decision.outcome" },
    );
  }
  const outcome = assertOneOf(
    resolution.outcome,
    RESOLVED_DECISION_OUTCOMES,
    "outcome",
  );
  const decidedBy = assertOneOf(resolution.decidedBy, DECIDED_BY, "decidedBy");

  let selectedOptionId: string | undefined;
  if (outcome === "selected") {
    selectedOptionId = assertNonEmptyString(
      resolution.selectedOptionId,
      "selectedOptionId",
    );
    if (!decision.options.some((option) => option.id === selectedOptionId)) {
      throw new DomainError(
        "VALIDATION",
        `selectedOptionId "${selectedOptionId}" is not one of the decision options`,
        { field: "selectedOptionId" },
      );
    }
  } else if (resolution.selectedOptionId !== undefined) {
    throw new DomainError(
      "VALIDATION",
      `outcome "${outcome}" must not carry a selectedOptionId`,
      { field: "selectedOptionId" },
    );
  }

  if (decidedBy === "decision-provider") {
    assertNonEmptyString(resolution.providerId, "providerId");
  } else if (resolution.providerId !== undefined) {
    throw new DomainError(
      "VALIDATION",
      `providerId is only valid when decidedBy is "decision-provider"`,
      { field: "providerId" },
    );
  }

  let ranking: readonly string[] | undefined;
  if (resolution.ranking !== undefined) {
    if (outcome !== "selected") {
      throw new DomainError(
        "VALIDATION",
        `outcome "${outcome}" must not carry a ranking`,
        { field: "ranking" },
      );
    }
    if (!Array.isArray(resolution.ranking)) {
      throw new DomainError("VALIDATION", "ranking must be an array", {
        field: "ranking",
      });
    }
    const optionIds = decision.options.map((option) => option.id);
    if (resolution.ranking.length !== optionIds.length) {
      throw new DomainError(
        "VALIDATION",
        "a ranking must list every enumerated option exactly once",
        { field: "ranking" },
      );
    }
    const seen = new Set<string>();
    for (const id of resolution.ranking) {
      const optionId = assertNonEmptyString(id, "ranking[]");
      if (!optionIds.includes(optionId)) {
        throw new DomainError(
          "VALIDATION",
          `ranking names option "${optionId}", which was not enumerated`,
          { field: "ranking" },
        );
      }
      if (seen.has(optionId)) {
        throw new DomainError(
          "INVARIANT",
          "a ranking must not repeat an option",
          {
            field: "ranking",
          },
        );
      }
      seen.add(optionId);
    }
    if (
      selectedOptionId !== undefined &&
      resolution.ranking[0] !== selectedOptionId
    ) {
      throw new DomainError(
        "INVARIANT",
        "a ranking must begin with the selected option",
        { field: "ranking" },
      );
    }
    ranking = [...resolution.ranking];
  }

  const usage =
    resolution.usage === undefined
      ? undefined
      : assertValidUsage(resolution.usage, "usage");
  if (
    resolution.usageReported !== undefined &&
    typeof resolution.usageReported !== "boolean"
  ) {
    throw new DomainError("VALIDATION", "usageReported must be a boolean", {
      field: "usageReported",
    });
  }
  // Provenance is a provider-answer fact: a decision code answered cannot have a
  // provider execution source, and a provider-attested one must use the closed
  // vocabulary rather than a free-form string.
  const executionSource =
    resolution.executionSource === undefined
      ? undefined
      : assertOneOf(
          resolution.executionSource,
          DECISION_PROVIDER_EXECUTION_SOURCES,
          "executionSource",
        );
  if (executionSource !== undefined && decidedBy !== "decision-provider") {
    throw new DomainError(
      "VALIDATION",
      `executionSource is only valid when decidedBy is "decision-provider"`,
      { field: "executionSource" },
    );
  }
  if (resolution.fallback !== undefined) {
    assertOneOf(
      resolution.fallback.reason,
      DECISION_FALLBACK_REASONS,
      "fallback.reason",
    );
  }
  const answeredBy =
    resolution.answeredBy === undefined
      ? undefined
      : assertOneOf(
          resolution.answeredBy,
          DECISION_ANSWER_SOURCES,
          "answeredBy",
        );
  const reasonCode =
    resolution.reasonCode === undefined
      ? undefined
      : assertNonEmptyString(resolution.reasonCode, "reasonCode");
  const modelId =
    resolution.modelId === undefined
      ? undefined
      : assertNonEmptyString(resolution.modelId, "modelId");

  const confidence =
    resolution.confidence === undefined
      ? undefined
      : assertUnitInterval(resolution.confidence, "confidence");
  const latencyMs =
    resolution.latencyMs === undefined
      ? undefined
      : assertNonNegativeInteger(resolution.latencyMs, "latencyMs");
  const costMicros =
    resolution.costMicros === undefined
      ? undefined
      : assertNonNegativeInteger(resolution.costMicros, "costMicros");

  const order = ranking ?? decision.options.map((option) => option.id);

  return {
    ...decision,
    outcome,
    ...(selectedOptionId === undefined ? {} : { selectedOptionId }),
    ...(ranking === undefined ? {} : { ranking }),
    decidedBy,
    ...(resolution.rationale === undefined
      ? {}
      : { rationale: resolution.rationale }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(resolution.providerId === undefined
      ? {}
      : { providerId: resolution.providerId }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(costMicros === undefined ? {} : { costMicros }),
    ...(usage === undefined ? {} : { usage }),
    ...(resolution.usageReported === undefined
      ? {}
      : { usageReported: resolution.usageReported }),
    ...(executionSource === undefined ? {} : { executionSource }),
    ...(resolution.fallback === undefined
      ? {}
      : { fallback: resolution.fallback }),
    ...(answeredBy === undefined ? {} : { answeredBy }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(modelId === undefined ? {} : { modelId }),
    alternativesConsidered: order.filter((id) => id !== selectedOptionId),
    evidence: resolution.evidence ?? [],
    decidedAt: toIsoString(clock.now()),
  };
}
