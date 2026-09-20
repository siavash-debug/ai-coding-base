import { DomainError } from "../core/errors.js";
import { assertNonNegativeInteger } from "../core/validation.js";

/**
 * Token accounting.
 *
 * `cachedInputTokens` is a SUBSET of `inputTokens`, never an additional
 * dimension, so `totalTokens` cannot double-count cached tokens.
 * See docs/architecture/V2-ARCHITECTURE.md §14 and DECISIONS.md ADR-008.
 */
export interface AIUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  /** Present only when the provider reports it. */
  readonly reasoningTokens?: number;
}

export function emptyUsage(): AIUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

export function assertValidUsage(value: unknown, field = "usage"): AIUsage {
  if (typeof value !== "object" || value === null) {
    throw new DomainError("VALIDATION", `${field} must be an object`, {
      field,
    });
  }
  const candidate = value as Record<string, unknown>;
  const inputTokens = assertNonNegativeInteger(
    candidate["inputTokens"],
    `${field}.inputTokens`,
  );
  const outputTokens = assertNonNegativeInteger(
    candidate["outputTokens"],
    `${field}.outputTokens`,
  );
  const cachedInputTokens = assertNonNegativeInteger(
    candidate["cachedInputTokens"],
    `${field}.cachedInputTokens`,
  );
  if (cachedInputTokens > inputTokens) {
    throw new DomainError(
      "VALIDATION",
      `${field}.cachedInputTokens must not exceed ${field}.inputTokens`,
      { field },
    );
  }
  const reasoning = candidate["reasoningTokens"];
  if (reasoning === undefined) {
    return { inputTokens, outputTokens, cachedInputTokens };
  }
  const reasoningTokens = assertNonNegativeInteger(
    reasoning,
    `${field}.reasoningTokens`,
  );
  if (reasoningTokens > outputTokens) {
    throw new DomainError(
      "VALIDATION",
      `${field}.reasoningTokens must not exceed ${field}.outputTokens`,
      { field },
    );
  }
  return { inputTokens, outputTokens, cachedInputTokens, reasoningTokens };
}

export function isValidUsage(value: unknown): boolean {
  try {
    assertValidUsage(value);
    return true;
  } catch {
    return false;
  }
}

/** Tokens counted for context/total purposes. Cached tokens are not re-added. */
export function totalTokens(usage: AIUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/** Input tokens that are billed at the full input rate. */
export function billableInputTokens(usage: AIUsage): number {
  return usage.inputTokens - usage.cachedInputTokens;
}

/**
 * Aggregation. Associative and commutative, so usage may be summed in any order
 * and produce identical totals (asserted by tests).
 */
export function addUsage(a: AIUsage, b: AIUsage): AIUsage {
  const left = assertValidUsage(a, "a");
  const right = assertValidUsage(b, "b");
  const summed: AIUsage = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
  };
  if (
    left.reasoningTokens === undefined &&
    right.reasoningTokens === undefined
  ) {
    return summed;
  }
  return {
    ...summed,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
  };
}

export function sumUsage(usages: readonly AIUsage[]): AIUsage {
  return usages.reduce(addUsage, emptyUsage());
}
