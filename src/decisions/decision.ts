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

/**
 * Decision: a recorded answer to a bounded question.
 *
 * A decision is created `pending` when the question is asked and resolved exactly
 * once. `decidedBy` records which layer answered, which is what makes the
 * cheapest-sufficient-layer ladder auditable.
 * See docs/architecture/V2-ARCHITECTURE.md §8 and DECISIONS.md ADR-003.
 */
export const DECISION_KINDS = [
  "routing",
  "classification",
  "selection",
  "policy",
  "escalation",
  "approval",
  "other",
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
  /** Absent while `outcome` is `pending`. */
  readonly decidedBy?: DecidedBy;
  readonly rationale?: string;
  readonly confidence?: number;
  readonly alternativesConsidered: readonly string[];
  /** References (paths, ids), never payloads and never secret values. */
  readonly evidence: readonly string[];
  readonly providerId?: string;
  readonly latencyMs?: number;
  readonly costMicros?: number;
  readonly createdAt: string;
  readonly decidedAt?: string;
}

export interface CreateDecisionInput {
  readonly kind: DecisionKind;
  readonly question: string;
  readonly options: readonly DecisionOption[];
  readonly taskId?: TaskId;
  readonly sessionId?: SessionId;
}

export interface DecisionResolution {
  readonly outcome: ResolvedDecisionOutcome;
  readonly decidedBy: DecidedBy;
  readonly selectedOptionId?: string;
  readonly rationale?: string;
  readonly confidence?: number;
  readonly providerId?: string;
  readonly latencyMs?: number;
  readonly costMicros?: number;
  readonly evidence?: readonly string[];
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

  return {
    ...decision,
    outcome,
    ...(selectedOptionId === undefined ? {} : { selectedOptionId }),
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
    alternativesConsidered: decision.options
      .map((option) => option.id)
      .filter((id) => id !== selectedOptionId),
    evidence: resolution.evidence ?? [],
    decidedAt: toIsoString(clock.now()),
  };
}
