import { DomainError } from "../core/errors.js";
import { assertNonNegativeInteger } from "../core/validation.js";

/**
 * AI budgets: limits plus the behaviour when a limit is approached or exceeded.
 *
 * Evaluation is a pure function of `(budget, consumption, thresholds)`. Budget
 * logic never lives inside a provider adapter, and no clock or I/O is involved.
 * See docs/architecture/V2-ARCHITECTURE.md §16 and DECISIONS.md ADR-009.
 */
export const BUDGET_DIMENSIONS = [
  "tokens",
  "cost",
  "duration",
  "iterations",
  "retries",
] as const;

export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

export interface Budget {
  readonly maxTokens?: number;
  readonly maxCostMicros?: number;
  readonly maxDurationMs?: number;
  readonly maxIterations?: number;
  readonly maxRetries?: number;
  /** Behaviour at 100%. Defaults to `stop`. */
  readonly onExceeded?: "stop" | "require-approval";
}

export interface BudgetThresholds {
  readonly warning: number;
  readonly critical: number;
}

export const DEFAULT_BUDGET_THRESHOLDS: BudgetThresholds = {
  warning: 0.8,
  critical: 0.9,
};

export type BudgetLevel = "ok" | "warning" | "critical" | "exceeded";

export type BudgetAction =
  "warn" | "optimize" | "escalate" | "stop" | "require-approval";

export interface BudgetConsumption {
  readonly tokens?: number;
  readonly costMicros?: number;
  readonly durationMs?: number;
  readonly iterations?: number;
  readonly retries?: number;
}

export interface BudgetDimensionStatus {
  readonly dimension: BudgetDimension;
  readonly limit: number;
  readonly consumed: number;
  readonly ratio: number;
  readonly level: BudgetLevel;
  readonly remaining: number;
}

export interface BudgetEvaluation {
  readonly level: BudgetLevel;
  readonly exceeded: boolean;
  readonly onExceeded: "stop" | "require-approval";
  readonly dimensions: readonly BudgetDimensionStatus[];
  readonly actions: readonly BudgetAction[];
  readonly reasons: readonly string[];
}

const LEVEL_RANK: Readonly<Record<BudgetLevel, number>> = {
  ok: 0,
  warning: 1,
  critical: 2,
  exceeded: 3,
};

const LIMIT_FIELD: Readonly<Record<BudgetDimension, keyof Budget>> = {
  tokens: "maxTokens",
  cost: "maxCostMicros",
  duration: "maxDurationMs",
  iterations: "maxIterations",
  retries: "maxRetries",
};

const CONSUMPTION_FIELD: Readonly<
  Record<BudgetDimension, keyof BudgetConsumption>
> = {
  tokens: "tokens",
  cost: "costMicros",
  duration: "durationMs",
  iterations: "iterations",
  retries: "retries",
};

export function validateBudget(budget: Budget): void {
  if (typeof budget !== "object" || budget === null) {
    throw new DomainError("VALIDATION", "Budget must be an object", {
      field: "budget",
    });
  }
  for (const dimension of BUDGET_DIMENSIONS) {
    const limit = budget[LIMIT_FIELD[dimension]];
    if (limit === undefined) {
      continue;
    }
    assertNonNegativeInteger(limit, LIMIT_FIELD[dimension]);
  }
  const onExceeded = budget.onExceeded;
  if (
    onExceeded !== undefined &&
    onExceeded !== "stop" &&
    onExceeded !== "require-approval"
  ) {
    throw new DomainError(
      "VALIDATION",
      'budget.onExceeded must be either "stop" or "require-approval"',
      { field: "onExceeded" },
    );
  }
}

export function validateBudgetThresholds(thresholds: BudgetThresholds): void {
  const { warning, critical } = thresholds;
  if (
    !Number.isFinite(warning) ||
    !Number.isFinite(critical) ||
    warning <= 0 ||
    critical > 1 ||
    warning >= critical
  ) {
    throw new DomainError(
      "VALIDATION",
      "Budget thresholds must satisfy 0 < warning < critical <= 1",
      { field: "thresholds" },
    );
  }
}

/** True when no dimension has a limit, i.e. the task is unbounded. */
export function isUnboundedBudget(budget: Budget): boolean {
  return BUDGET_DIMENSIONS.every(
    (dimension) => budget[LIMIT_FIELD[dimension]] === undefined,
  );
}

export function budgetLimit(
  budget: Budget,
  dimension: BudgetDimension,
): number | undefined {
  return budget[LIMIT_FIELD[dimension]] as number | undefined;
}

function levelForRatio(
  ratio: number,
  thresholds: BudgetThresholds,
): BudgetLevel {
  if (ratio >= 1) {
    return "exceeded";
  }
  if (ratio >= thresholds.critical) {
    return "critical";
  }
  if (ratio >= thresholds.warning) {
    return "warning";
  }
  return "ok";
}

function formatPercent(ratio: number): string {
  return Number.isFinite(ratio) ? `${(ratio * 100).toFixed(1)}%` : "over 100%";
}

function actionsFor(
  level: BudgetLevel,
  onExceeded: "stop" | "require-approval",
): readonly BudgetAction[] {
  switch (level) {
    case "ok":
      return [];
    case "warning":
      return ["warn"];
    case "critical":
      return ["warn", "optimize", "escalate"];
    case "exceeded":
      return onExceeded === "require-approval"
        ? ["require-approval", "escalate"]
        : ["stop"];
  }
}

/**
 * 80% -> warning, 90% -> critical (optimize/escalate), 100% -> stop or require
 * approval. An absent limit is unbounded and never contributes a level. A limit
 * of `0` is valid and means "no consumption permitted".
 */
export function evaluateBudget(
  budget: Budget,
  consumption: BudgetConsumption = {},
  thresholds: BudgetThresholds = DEFAULT_BUDGET_THRESHOLDS,
): BudgetEvaluation {
  validateBudget(budget);
  validateBudgetThresholds(thresholds);
  const onExceeded = budget.onExceeded ?? "stop";

  const dimensions: BudgetDimensionStatus[] = [];
  const reasons: string[] = [];

  for (const dimension of BUDGET_DIMENSIONS) {
    const limit = budgetLimit(budget, dimension);
    if (limit === undefined) {
      continue;
    }
    const raw = consumption[CONSUMPTION_FIELD[dimension]];
    const consumed =
      raw === undefined ? 0 : assertNonNegativeInteger(raw, dimension);
    const ratio =
      limit === 0
        ? consumed > 0
          ? Number.POSITIVE_INFINITY
          : 0
        : consumed / limit;
    const level = levelForRatio(ratio, thresholds);
    dimensions.push({
      dimension,
      limit,
      consumed,
      ratio,
      level,
      remaining: Math.max(0, limit - consumed),
    });
    if (level !== "ok") {
      reasons.push(
        `${dimension}: ${formatPercent(ratio)} of limit (${consumed}/${limit})`,
      );
    }
  }

  let level: BudgetLevel = "ok";
  for (const status of dimensions) {
    if (LEVEL_RANK[status.level] > LEVEL_RANK[level]) {
      level = status.level;
    }
  }

  if (level === "exceeded") {
    reasons.unshift(`budget exceeded (onExceeded: ${onExceeded})`);
  }

  return {
    level,
    exceeded: level === "exceeded",
    onExceeded,
    dimensions,
    actions: actionsFor(level, onExceeded),
    reasons,
  };
}
