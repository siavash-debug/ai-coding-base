/**
 * Typed, stable domain errors.
 *
 * Every failure that callers may need to branch on carries a machine-readable
 * `code`; messages are for humans and are not a contract.
 */
export type DomainErrorCode =
  | "VALIDATION"
  | "INVARIANT"
  | "TRANSITION"
  | "BUDGET_EXCEEDED"
  | "POLICY_DENIED"
  | "APPROVAL_REQUIRED"
  | "NOT_FOUND"
  | "CONFLICT"
  /** A project/workspace boundary was crossed. See V2-ARCHITECTURE §19. */
  | "FORBIDDEN"
  /**
   * An external provider failed in a categorised way. The category, status code
   * and attempt count live in `details`; the human-readable message is never
   * persisted, because vendor messages are not a trusted place for secrets.
   */
  | "PROVIDER_FAILURE"
  /**
   * The network itself failed (timeout, DNS, TLS, socket) before a provider could
   * answer. Separated from `PROVIDER_FAILURE` so a provider adapter can attribute
   * a failure honestly instead of guessing which vendor was at fault.
   */
  | "TRANSPORT_FAILURE"
  /** A stream's write lock could not be acquired within its budget. */
  | "LOCK_TIMEOUT";

export type DomainErrorDetails = Readonly<Record<string, unknown>>;

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: DomainErrorDetails;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: DomainErrorDetails = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
    // Keep prototypes correct when the class is transpiled below ES2015 targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError && typeof value.code === "string";
}

export function hasDomainErrorCode(
  value: unknown,
  code: DomainErrorCode,
): boolean {
  return isDomainError(value) && value.code === code;
}
