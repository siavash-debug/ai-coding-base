import { assertOneOf } from "../core/validation.js";

/**
 * The closed set of reasons an access decision can give.
 *
 * Denials are structured rather than prose because a denial is a security
 * artefact: it is recorded in the log, projected into a trace, and (later) counted
 * by an evaluation harness. A stable code is the part a machine can act on; the
 * human sentence is the part an operator reads, and neither is allowed to carry a
 * secret value or an absolute host path (ADR-046).
 *
 * `ALLOWED` is the only non-denial. Everything else fails closed.
 */
export const POLICY_REASON_CODES = [
  /** The capability was granted to the project and to this attempt. */
  "ALLOWED",
  /** The project's policy forbids this capability outright. */
  "CAPABILITY_DENIED",
  /** The capability is not part of this attempt's declared envelope. */
  "CAPABILITY_NOT_DECLARED",
  /** Policy is configured but the target is not covered by any rule allowing it. */
  "POLICY_DENIED",
  /** The resolved target is outside the configured readable/writable boundary. */
  "RESOURCE_OUTSIDE_BOUNDARY",
  /** The reference contained `..`, an absolute path, or a NUL. */
  "TARGET_REFUSED",
  /** The target is not on the project's explicit allowlist. */
  "TARGET_NOT_ALLOWED",
  /** The path looks like a credential (`.env`, a private key, a token file). */
  "SECRET_PATH_DENIED",
  /** The path is the platform's own runtime state (`.git/`, `.ai/`). */
  "RUNTIME_STATE_DENIED",
  /** A symlink or reparse point made the real target ambiguous or external. */
  "SYMLINK_ESCAPE",
  /** The target could not be resolved well enough to judge it. */
  "UNRESOLVED_TARGET",
  /** Policy requires a human approval for this capability. */
  "APPROVAL_REQUIRED",
  /** An approval is required and none was found for this scope and capability. */
  "APPROVAL_MISSING",
  /** The grant that was found has expired. */
  "APPROVAL_EXPIRED",
  /** The grant that was found was already spent. */
  "APPROVAL_CONSUMED",
  /** The grant belongs to another project, workspace, task or capability. */
  "APPROVAL_SCOPE_MISMATCH",
  /** The request, scope or envelope was malformed; nothing was evaluated. */
  "MALFORMED_REQUEST",
  /** The caller's scope is not the scope this boundary is bound to. */
  "INVALID_SCOPE",
  /** The operation itself failed after it was authorised. */
  "OPERATION_FAILED",
] as const;

export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];

/**
 * One short explanation per code, for CLI and trace rendering.
 *
 * Kept beside the codes so a new code cannot be added without a description —
 * an unexplained denial is indistinguishable from a bug.
 */
export const REASON_DESCRIPTIONS: Readonly<Record<PolicyReasonCode, string>> = {
  ALLOWED: "allowed",
  CAPABILITY_DENIED: "capability is denied by policy",
  CAPABILITY_NOT_DECLARED: "capability is not declared for this attempt",
  POLICY_DENIED: "policy does not allow this target",
  RESOURCE_OUTSIDE_BOUNDARY: "target is outside the permitted boundary",
  TARGET_REFUSED: "target reference was refused",
  TARGET_NOT_ALLOWED: "target is not on the allowlist",
  SECRET_PATH_DENIED: "target looks like credential material",
  RUNTIME_STATE_DENIED: "target is platform runtime state",
  SYMLINK_ESCAPE: "target resolves outside the boundary through a link",
  UNRESOLVED_TARGET: "target could not be resolved",
  APPROVAL_REQUIRED: "human approval is required",
  APPROVAL_MISSING: "no approval covers this operation",
  APPROVAL_EXPIRED: "the approval has expired",
  APPROVAL_CONSUMED: "the approval was already consumed",
  APPROVAL_SCOPE_MISMATCH: "the approval belongs to another scope",
  MALFORMED_REQUEST: "the request was malformed",
  INVALID_SCOPE: "the request is outside this boundary's scope",
  OPERATION_FAILED: "the operation failed after being authorized",
};

export function assertPolicyReasonCode(
  value: unknown,
  field = "reasonCode",
): PolicyReasonCode {
  return assertOneOf(value, POLICY_REASON_CODES, field);
}

/** True for every code that is not `ALLOWED`. Fail-closed by construction. */
export function isDenial(code: PolicyReasonCode): boolean {
  return code !== "ALLOWED";
}
