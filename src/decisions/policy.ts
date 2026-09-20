import { DomainError } from "../core/errors.js";
import {
  assertNonEmptyString,
  assertOneOf,
  assertPositiveInteger,
  assertStringArray,
} from "../core/validation.js";
import {
  ALL_OPERATIONS,
  type OperationKind,
  OPERATION_KINDS,
  type RiskLevel,
  RISK_LEVELS,
  effectiveRiskLevel,
  riskRank,
} from "./risk.js";

/**
 * Policy engine: maps (operation, risk) -> effect, deterministically.
 *
 * Evaluation is a pure function. When several rules match, the most restrictive
 * effect wins; the default effect (when nothing matches) is `verify`, never
 * `allow`. See docs/architecture/V2-ARCHITECTURE.md §12 and DECISIONS.md ADR-011.
 */
export const POLICY_EFFECTS = [
  "allow",
  "verify",
  "require-approval",
  "deny",
] as const;

export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

/** `deny > require-approval > verify > allow`. */
export const EFFECT_RESTRICTIVENESS: Readonly<Record<PolicyEffect, number>> = {
  allow: 0,
  verify: 1,
  "require-approval": 2,
  deny: 3,
};

export interface PolicyRule {
  readonly id: string;
  readonly description: string;
  readonly operations: readonly OperationKind[];
  /** Applies when the effective risk is at least this level. */
  readonly minRisk: RiskLevel;
  readonly effect: PolicyEffect;
}

export interface Policy {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly rules: readonly PolicyRule[];
  readonly defaultEffect: PolicyEffect;
}

export interface PolicyRequest {
  readonly operation: OperationKind;
  readonly riskLevel: RiskLevel;
  readonly targets?: readonly string[];
}

export interface PolicyDecision {
  readonly effect: PolicyEffect;
  readonly matchedRuleId?: string;
  readonly reason: string;
  readonly requiresHumanApproval: boolean;
  readonly requiresVerification: boolean;
  /** `max(declared, baseline)` risk that policy actually saw. */
  readonly effectiveRisk: RiskLevel;
}

export function mostRestrictiveEffect(
  effects: readonly PolicyEffect[],
): PolicyEffect {
  if (effects.length === 0) {
    throw new DomainError(
      "VALIDATION",
      "at least one policy effect is required",
      { field: "effects" },
    );
  }
  let winner: PolicyEffect = effects[0];
  for (const effect of effects) {
    if (EFFECT_RESTRICTIVENESS[effect] > EFFECT_RESTRICTIVENESS[winner]) {
      winner = effect;
    }
  }
  return winner;
}

export function validatePolicy(policy: Policy): void {
  assertNonEmptyString(policy.id, "policy.id");
  assertNonEmptyString(policy.name, "policy.name");
  assertPositiveInteger(policy.version, "policy.version");
  assertOneOf(policy.defaultEffect, POLICY_EFFECTS, "policy.defaultEffect");
  if (!Array.isArray(policy.rules)) {
    throw new DomainError("VALIDATION", "policy.rules must be an array", {
      field: "policy.rules",
    });
  }
  const seen = new Set<string>();
  policy.rules.forEach((rule, index) => {
    const field = `policy.rules[${index}]`;
    const id = assertNonEmptyString(rule.id, `${field}.id`);
    if (seen.has(id)) {
      throw new DomainError("INVARIANT", `duplicate policy rule id "${id}"`, {
        field: `${field}.id`,
      });
    }
    seen.add(id);
    assertNonEmptyString(rule.description, `${field}.description`);
    const operations = assertStringArray(
      rule.operations,
      `${field}.operations`,
    );
    if (operations.length === 0) {
      throw new DomainError(
        "VALIDATION",
        `${field}.operations must not be empty`,
        { field: `${field}.operations` },
      );
    }
    operations.forEach((operation, at) => {
      assertOneOf(operation, OPERATION_KINDS, `${field}.operations[${at}]`);
    });
    assertOneOf(rule.minRisk, RISK_LEVELS, `${field}.minRisk`);
    assertOneOf(rule.effect, POLICY_EFFECTS, `${field}.effect`);
  });
}

/**
 * Deterministic evaluation. Pure: no clock, no I/O, no provider.
 */
export function evaluatePolicy(
  policy: Policy,
  request: PolicyRequest,
): PolicyDecision {
  validatePolicy(policy);
  assertOneOf(request.operation, OPERATION_KINDS, "operation");
  assertOneOf(request.riskLevel, RISK_LEVELS, "riskLevel");
  if (request.targets !== undefined) {
    assertStringArray(request.targets, "targets");
  }

  const effectiveRisk = effectiveRiskLevel(
    request.riskLevel,
    request.operation,
  );
  const matched = policy.rules.filter(
    (rule) =>
      rule.operations.includes(request.operation) &&
      riskRank(effectiveRisk) >= riskRank(rule.minRisk),
  );

  if (matched.length === 0) {
    return {
      effect: policy.defaultEffect,
      reason:
        `no policy rule matched operation "${request.operation}" at ` +
        `${effectiveRisk} risk; default effect "${policy.defaultEffect}" applied`,
      requiresHumanApproval: policy.defaultEffect === "require-approval",
      requiresVerification: policy.defaultEffect === "verify",
      effectiveRisk,
    };
  }

  // Deterministic precedence: most restrictive effect first. Among equally
  // restrictive rules the more specific one (fewer operations) explains the
  // decision better than a broad safety net, so it wins; remaining ties fall
  // back to rule id ascending.
  const ranked = [...matched].sort(
    (a, b) =>
      EFFECT_RESTRICTIVENESS[b.effect] - EFFECT_RESTRICTIVENESS[a.effect] ||
      a.operations.length - b.operations.length ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const winner = ranked[0];
  const raised =
    effectiveRisk === request.riskLevel
      ? ""
      : ` (effective risk raised from declared "${request.riskLevel}" by the ` +
        `"${request.operation}" baseline)`;

  return {
    effect: winner.effect,
    matchedRuleId: winner.id,
    reason: `rule "${winner.id}": ${winner.description}${raised}`,
    requiresHumanApproval: winner.effect === "require-approval",
    requiresVerification: winner.effect === "verify",
    effectiveRisk,
  };
}

/**
 * Built-in default policy.
 *
 * The `P-000` safety net means any high or critical risk operation requires
 * human approval regardless of operation, so a specific rule can never make a
 * risky operation automatic. `deny` is available but unused by default: it is a
 * project-specific escalation, not a built-in opinion.
 *
 * Operations whose baseline risk is already `high` or `critical` (see
 * `baselineRiskForOperation`) always reach `P-000`, so the only effect a policy
 * can meaningfully declare for them is approval or denial. `P-001`..`P-006`
 * therefore restate that requirement per operation, which is redundant for
 * safety but valuable for audit: the recorded reason names the actual risk
 * instead of the generic net.
 */
export function defaultPolicy(): Policy {
  return {
    id: "policy-default",
    name: "Default policy",
    version: 1,
    defaultEffect: "verify",
    rules: [
      {
        id: "P-000",
        description: "High and critical risk operations require human approval",
        operations: ALL_OPERATIONS,
        minRisk: "high",
        effect: "require-approval",
      },
      {
        id: "P-001",
        description: "Destructive database operations require human approval",
        operations: ["db-destructive"],
        minRisk: "low",
        effect: "require-approval",
      },
      {
        id: "P-002",
        description: "Production changes require human approval",
        operations: ["deploy"],
        minRisk: "low",
        effect: "require-approval",
      },
      {
        id: "P-003",
        description:
          "Authentication and security changes require human approval",
        operations: ["auth-change"],
        minRisk: "low",
        effect: "require-approval",
      },
      {
        id: "P-004",
        description: "Secret writes require human approval",
        operations: ["secrets-write"],
        minRisk: "low",
        effect: "require-approval",
      },
      {
        id: "P-005",
        description: "Destructive filesystem operations require human approval",
        operations: ["delete"],
        minRisk: "low",
        effect: "require-approval",
      },
      {
        id: "P-006",
        description: "Secret reads require human approval",
        operations: ["secrets-read"],
        minRisk: "low",
        effect: "require-approval",
      },
      {
        id: "P-007",
        description: "Reads are allowed",
        operations: ["read", "db-read"],
        minRisk: "low",
        effect: "allow",
      },
      {
        id: "P-008",
        description: "Writes, execution and network access are verified",
        operations: ["write", "execute", "network"],
        minRisk: "low",
        effect: "verify",
      },
    ],
  };
}
