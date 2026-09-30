import { isAbsolute } from "node:path";

import { isValidIsoTimestamp } from "./clock.js";
import { DomainError } from "./errors.js";

/**
 * Assertion helpers for the trust boundary.
 *
 * Domain factories validate their inputs with these functions so that invalid
 * data fails at construction, never at read time.
 */

export function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("VALIDATION", `${field} must be a non-empty string`, {
      field,
    });
  }
  return value;
}

export function assertOptionalNonEmptyString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertNonEmptyString(value, field);
}

export function assertNonNegativeInteger(
  value: unknown,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      "VALIDATION",
      `${field} must be a non-negative integer`,
      { field },
    );
  }
  return value;
}

export function assertPositiveInteger(value: unknown, field: string): number {
  const parsed = assertNonNegativeInteger(value, field);
  if (parsed === 0) {
    throw new DomainError("VALIDATION", `${field} must be greater than zero`, {
      field,
    });
  }
  return parsed;
}

export function assertNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new DomainError(
      "VALIDATION",
      `${field} must be a finite, non-negative number`,
      { field },
    );
  }
  return value;
}

/** A fraction in the closed interval [0, 1]. */
export function assertUnitInterval(value: unknown, field: string): number {
  const parsed = assertNonNegativeNumber(value, field);
  if (parsed > 1) {
    throw new DomainError("VALIDATION", `${field} must be at most 1`, {
      field,
    });
  }
  return parsed;
}

export function assertIsoTimestamp(value: unknown, field: string): string {
  if (!isValidIsoTimestamp(value)) {
    throw new DomainError(
      "VALIDATION",
      `${field} must be an ISO-8601 UTC timestamp`,
      { field },
    );
  }
  return value;
}

export function assertOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new DomainError(
      "VALIDATION",
      `${field} must be one of: ${allowed.join(", ")}`,
      { field },
    );
  }
  return value as T;
}

export function assertStringArray(
  value: unknown,
  field: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new DomainError("VALIDATION", `${field} must be an array`, { field });
  }
  return value.map((entry, index) =>
    assertNonEmptyString(entry, `${field}[${index}]`),
  );
}

/**
 * Filesystem roots must be absolute and must not traverse upwards. Secrets and
 * outside-project access are separate concerns handled by policy + grants.
 */
export function assertSafeAbsolutePath(value: unknown, field: string): string {
  const text = assertNonEmptyString(value, field);
  if (text.includes("\0")) {
    throw new DomainError("VALIDATION", `${field} must not contain NUL`, {
      field,
    });
  }
  if (!isAbsolute(text)) {
    throw new DomainError("VALIDATION", `${field} must be an absolute path`, {
      field,
    });
  }
  const segments = text.split(/[\\/]+/);
  if (segments.includes("..")) {
    throw new DomainError(
      "VALIDATION",
      `${field} must not contain parent-directory traversal`,
      { field },
    );
  }
  return text;
}

/** Rejects secret-shaped values from ever reaching an event or log payload. */
export const SECRET_VALUE_PATTERN =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{12,})/;

export function containsSecretLikeValue(value: string): boolean {
  return SECRET_VALUE_PATTERN.test(value);
}

export function assertNoSecretLikeValue(value: string, field: string): void {
  if (containsSecretLikeValue(value)) {
    throw new DomainError(
      "VALIDATION",
      `${field} appears to contain secret material; reference secrets instead of embedding them`,
      { field },
    );
  }
}

/**
 * Makes third-party text safe to show an operator.
 *
 * Redaction is pattern-based and therefore best-effort, so it is never the only
 * defence: `assertNoSecretLikeValue` still guards anything that reaches an event.
 * This exists because operator-facing text (a vendor error message, for example)
 * is exactly the kind of string that echoes a key back at you.
 */
export function redactSecretLikeValues(text: string, maxLength = 200): string {
  const redacted = text
    .replace(new RegExp(SECRET_VALUE_PATTERN.source, "g"), "[redacted]")
    // Authorization material echoed in any of its common shapes.
    .replace(/(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(
      /"?(api[-_]?key|authorization|x-api-key)"?\s*[:=]\s*"?[^\s",}]{8,}/gi,
      "$1: [redacted]",
    );
  return redacted.length > maxLength
    ? `${redacted.slice(0, maxLength)}…`
    : redacted;
}
