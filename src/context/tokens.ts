import { assertNonNegativeInteger } from "../core/validation.js";
import { DomainError } from "../core/errors.js";

/**
 * Deterministic token estimation.
 *
 * The real measurement of tokens is what a provider reports in `LLMRequestCompleted`
 * — this module exists so a *selection* can be budgeted before anything is spent, and
 * it is deliberately simple and auditable rather than clever:
 *
 * - `size` basis: bytes on disk divided by `bytesPerToken`. Used before a file is
 *   read, so a candidate can be ranked and budgeted without loading it.
 * - `content` basis: characters actually read, divided by the same divisor. Used for
 *   the final budget check, because a size estimate can be wrong (line endings,
 *   UTF-8 multi-byte characters, generated files).
 *
 * It never claims precision. Every place that reports a token count from this module
 * labels it an estimate, and `ContextSelection` records which basis was used, so a
 * later comparison against provider-reported usage is possible instead of implied.
 *
 * See docs/architecture/V2-ARCHITECTURE.md §36.4 and DECISIONS.md ADR-040.
 */
export const DEFAULT_BYTES_PER_TOKEN = 4;

export function assertBytesPerToken(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 1 ||
    value > 16
  ) {
    throw new DomainError(
      "VALIDATION",
      "bytesPerToken must be a finite number between 1 and 16",
      { field: "bytesPerToken" },
    );
  }
  return value;
}

/** Estimate from a byte count. Always at least 1 for non-empty input. */
export function estimateTokensFromBytes(
  bytes: number,
  bytesPerToken: number = DEFAULT_BYTES_PER_TOKEN,
): number {
  const size = assertNonNegativeInteger(bytes, "bytes");
  const divisor = assertBytesPerToken(bytesPerToken);
  if (size === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(size / divisor));
}

/**
 * Estimate from text. UTF-8 aware: the byte length is used, not the character count,
 * so a file of multi-byte characters is not under-counted.
 */
export function estimateTokensFromText(
  text: string,
  bytesPerToken: number = DEFAULT_BYTES_PER_TOKEN,
): number {
  if (typeof text !== "string") {
    throw new DomainError("VALIDATION", "text must be a string", {
      field: "text",
    });
  }
  const bytes = Buffer.byteLength(text, "utf8");
  return estimateTokensFromBytes(bytes, bytesPerToken);
}
