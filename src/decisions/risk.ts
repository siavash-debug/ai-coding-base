/**
 * Risk levels and operation baseline risk.
 *
 * Risk is the input to the policy engine (see `./policy.ts`). These functions are
 * pure and have no dependency on any provider, planner or model.
 * See docs/architecture/V2-ARCHITECTURE.md §12 and DECISIONS.md ADR-011.
 */
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

const RISK_RANK: Readonly<Record<RiskLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function riskRank(level: RiskLevel): number {
  return RISK_RANK[level];
}

/** Negative when `a` is safer than `b`, positive when it is riskier. */
export function compareRisk(a: RiskLevel, b: RiskLevel): number {
  return riskRank(a) - riskRank(b);
}

export function maxRisk(levels: readonly RiskLevel[]): RiskLevel {
  let highest: RiskLevel = "low";
  for (const level of levels) {
    if (riskRank(level) > riskRank(highest)) {
      highest = level;
    }
  }
  return highest;
}

/** `high` and `critical` operations require an explicit human approval record. */
export function requiresHumanApproval(level: RiskLevel): boolean {
  return riskRank(level) >= riskRank("high");
}

/** Everything above `low` must be verified before the task may complete. */
export function requiresVerification(level: RiskLevel): boolean {
  return riskRank(level) > riskRank("low");
}

export const OPERATION_KINDS = [
  "read",
  "write",
  "execute",
  "delete",
  "network",
  "dependency-install",
  "db-read",
  "db-write",
  "db-destructive",
  "deploy",
  "auth-change",
  "secrets-read",
  "secrets-write",
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

export const ALL_OPERATIONS: readonly OperationKind[] = OPERATION_KINDS;

/**
 * Inherent risk of an operation, independent of how it was declared.
 *
 * A destructive operation can never be presented as low risk: the effective risk
 * of a request is `max(declared, baseline)`, so declaring a low risk cannot lower
 * the baseline. See `effectiveRiskLevel`.
 */
const BASELINE_RISK: Readonly<Record<OperationKind, RiskLevel>> = {
  read: "low",
  "db-read": "low",
  write: "medium",
  execute: "medium",
  network: "medium",
  "dependency-install": "high",
  "secrets-read": "high",
  "db-write": "high",
  delete: "critical",
  "db-destructive": "critical",
  deploy: "critical",
  "auth-change": "critical",
  "secrets-write": "critical",
};

export function baselineRiskForOperation(operation: OperationKind): RiskLevel {
  return BASELINE_RISK[operation];
}

/**
 * The risk level that policy actually sees: never lower than the operation's
 * inherent baseline.
 */
export function effectiveRiskLevel(
  declared: RiskLevel,
  operation: OperationKind,
): RiskLevel {
  return maxRisk([declared, baselineRiskForOperation(operation)]);
}
