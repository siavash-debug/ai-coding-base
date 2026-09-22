import { DomainError } from "../core/errors.js";
import { assertOneOf } from "../core/validation.js";
import {
  ALL_OPERATIONS,
  type OperationKind,
  baselineRiskForOperation,
  type RiskLevel,
} from "../decisions/risk.js";

/**
 * Capabilities: the canonical vocabulary of *what an operation needs*.
 *
 * A capability is not a permission. It is a typed request for a class of access
 * ("I need to read a file inside the workspace"), which is then evaluated against
 * the project's access policy, the attempt's declared envelope and the approval
 * ledger. Keeping the vocabulary closed and typed is what makes enforcement
 * possible at the boundary: a caller cannot invent a capability name, and no
 * layer infers authorization from a free-text string (ADR-045).
 *
 * The set is deliberately small. Every entry below is required by an operation
 * that Phase F actually enforces; anything speculative belongs to the phase that
 * implements it.
 */
export const CAPABILITIES = [
  "filesystem.read",
  "filesystem.write",
  "process.execute",
  "network.connect",
  "environment.read",
  "git.read",
  "git.write",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: unknown): value is Capability {
  return (
    typeof value === "string" &&
    (CAPABILITIES as readonly string[]).includes(value)
  );
}

export function assertCapability(
  value: unknown,
  field = "capability",
): Capability {
  return assertOneOf(value, CAPABILITIES, field);
}

export function assertCapabilityList(
  value: unknown,
  field: string,
): readonly Capability[] {
  if (!Array.isArray(value)) {
    throw new DomainError("VALIDATION", `${field} must be an array`, { field });
  }
  return value.map((entry, index) =>
    assertCapability(entry, `${field}[${index}]`),
  );
}

/**
 * The capability each access is *bound* to, keyed by the capability itself.
 *
 * A capability maps to exactly one operation kind from the risk model, so the
 * existing risk policy and approval ledger can be reused without a second
 * authorization system: `filesystem.write` is a `write`, so its baseline risk is
 * `medium` and an approval naming `write` is what authorises it.
 *
 * The mapping is intentionally conservative: `environment.read` is a
 * `secrets-read` (baseline `high`) because reading the environment is how a
 * credential is obtained, even when the variable turns out to be mundane.
 */
const CAPABILITY_OPERATION: Readonly<Record<Capability, OperationKind>> = {
  "filesystem.read": "read",
  "filesystem.write": "write",
  "process.execute": "execute",
  "network.connect": "network",
  "environment.read": "secrets-read",
  "git.read": "read",
  "git.write": "write",
};

export function operationKindForCapability(
  capability: Capability,
): OperationKind {
  return CAPABILITY_OPERATION[capability];
}

/** Baseline risk of a capability, from the operation kind it is bound to. */
export function baselineRiskForCapability(capability: Capability): RiskLevel {
  return baselineRiskForOperation(operationKindForCapability(capability));
}

/**
 * Every capability that could satisfy an operation kind.
 *
 * Used in the opposite direction: a step reported as a `write` is checked against
 * capabilities that grant writing, so a runner's declared operation and the
 * capability the boundary enforces cannot drift apart.
 */
export function capabilitiesForOperationKind(
  kind: OperationKind,
): readonly Capability[] {
  assertOneOf(kind, ALL_OPERATIONS, "operation");
  return CAPABILITIES.filter(
    (capability) => CAPABILITY_OPERATION[capability] === kind,
  );
}

/** Stable ordering, so a rendered capability list is deterministic. */
export function sortCapabilities(
  capabilities: readonly Capability[],
): readonly Capability[] {
  return [...capabilities].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
