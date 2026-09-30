import { DomainError } from "../core/errors.js";
import {
  assertIsoTimestamp,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertNonNegativeNumber,
} from "../core/validation.js";
import type { AIUsage } from "./usage.js";
import { assertValidUsage, billableInputTokens } from "./usage.js";

/**
 * Cost accounting in integer micro-USD.
 *
 * Floating-point dollars accumulate visible error when summed over thousands of
 * calls, so money is stored as an integer count of micro-USD.
 * See docs/architecture/V2-ARCHITECTURE.md §15 and DECISIONS.md ADR-007.
 */
export const MICROS_PER_USD = 1_000_000;
export const TOKENS_PER_MILLION = 1_000_000;

export interface Cost {
  readonly currency: "USD";
  readonly micros: number;
}

export interface ModelRate {
  readonly providerId: string;
  readonly modelId: string;
  readonly currency: "USD";
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
  readonly cachedInputMicrosPerMillionTokens: number;
  /** Rates change over time; history is part of the record. */
  readonly effectiveFrom: string;
}

export interface ModelKey {
  readonly providerId: string;
  readonly modelId: string;
  /** Selects the rate effective at this instant. Defaults to the newest rate. */
  readonly at?: string;
}

export function zeroCost(): Cost {
  return { currency: "USD", micros: 0 };
}

export function addCost(a: Cost, b: Cost): Cost {
  return { currency: "USD", micros: a.micros + b.micros };
}

export function sumCosts(costs: readonly Cost[]): Cost {
  return costs.reduce(addCost, zeroCost());
}

export function microsFromDollars(usd: number): number {
  return Math.round(assertNonNegativeNumber(usd, "usd") * MICROS_PER_USD);
}

/** Shorthand for building readable rate tables. */
export function createModelRate(input: {
  providerId: string;
  modelId: string;
  effectiveFrom: string;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  cachedInputUsdPerMillionTokens: number;
}): ModelRate {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    currency: "USD",
    inputMicrosPerMillionTokens: microsFromDollars(
      input.inputUsdPerMillionTokens,
    ),
    outputMicrosPerMillionTokens: microsFromDollars(
      input.outputUsdPerMillionTokens,
    ),
    cachedInputMicrosPerMillionTokens: microsFromDollars(
      input.cachedInputUsdPerMillionTokens,
    ),
    effectiveFrom: assertIsoTimestamp(input.effectiveFrom, "effectiveFrom"),
  };
}

/**
 * Validates a rate that arrived from outside the type system (configuration
 * file, future remote catalogue). Rates are data, so they are validated at every
 * boundary they cross.
 */
export function assertValidModelRate(
  value: unknown,
  field = "rate",
): ModelRate {
  if (typeof value !== "object" || value === null) {
    throw new DomainError("VALIDATION", `${field} must be an object`, {
      field,
    });
  }
  const candidate = value as Record<string, unknown>;
  const providerId = assertNonEmptyString(
    candidate["providerId"],
    `${field}.providerId`,
  );
  const modelId = assertNonEmptyString(
    candidate["modelId"],
    `${field}.modelId`,
  );
  if (candidate["currency"] !== "USD") {
    throw new DomainError("VALIDATION", `${field}.currency must be "USD"`, {
      field: `${field}.currency`,
    });
  }
  const inputMicrosPerMillionTokens = assertNonNegativeInteger(
    candidate["inputMicrosPerMillionTokens"],
    `${field}.inputMicrosPerMillionTokens`,
  );
  const outputMicrosPerMillionTokens = assertNonNegativeInteger(
    candidate["outputMicrosPerMillionTokens"],
    `${field}.outputMicrosPerMillionTokens`,
  );
  const cachedInputMicrosPerMillionTokens = assertNonNegativeInteger(
    candidate["cachedInputMicrosPerMillionTokens"],
    `${field}.cachedInputMicrosPerMillionTokens`,
  );
  const effectiveFrom = assertIsoTimestamp(
    candidate["effectiveFrom"],
    `${field}.effectiveFrom`,
  );
  return {
    providerId,
    modelId,
    currency: "USD",
    inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens,
    cachedInputMicrosPerMillionTokens,
    effectiveFrom,
  };
}

/**
 * Cost of one call under one rate.
 *
 * Each component is rounded independently to whole micro-USD; the resulting
 * error is bounded by 1 micro-USD per component per call.
 */
export function computeCost(usage: AIUsage, rate: ModelRate): Cost {
  const valid = assertValidUsage(usage);
  const micros =
    Math.round(
      (billableInputTokens(valid) * rate.inputMicrosPerMillionTokens) /
        TOKENS_PER_MILLION,
    ) +
    Math.round(
      (valid.cachedInputTokens * rate.cachedInputMicrosPerMillionTokens) /
        TOKENS_PER_MILLION,
    ) +
    Math.round(
      (valid.outputTokens * rate.outputMicrosPerMillionTokens) /
        TOKENS_PER_MILLION,
    );
  return { currency: "USD", micros };
}

/**
 * Newest applicable rate for a model. When two rates share an `effectiveFrom`,
 * the later entry in the array wins, so lookup is deterministic for a given
 * table order.
 */
export function findModelRate(
  rates: readonly ModelRate[],
  key: ModelKey,
): ModelRate | undefined {
  const at = key.at === undefined ? undefined : Date.parse(key.at);
  let best: ModelRate | undefined;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const rate of rates) {
    if (rate.providerId !== key.providerId || rate.modelId !== key.modelId) {
      continue;
    }
    const effective = Date.parse(rate.effectiveFrom);
    if (at !== undefined && effective > at) {
      continue;
    }
    if (best === undefined || effective >= bestAt) {
      best = rate;
      bestAt = effective;
    }
  }
  return best;
}

/**
 * Cost for a call, or `undefined` when the model has no known rate.
 *
 * An unknown model MUST NOT be reported as costing zero: a fabricated $0 is a
 * correctness bug, not a rounding error.
 */
export function estimateCost(input: {
  usage: AIUsage;
  providerId: string;
  modelId: string;
  rates: readonly ModelRate[];
  at?: string;
}): Cost | undefined {
  const rate = findModelRate(input.rates, {
    providerId: input.providerId,
    modelId: input.modelId,
    ...(input.at === undefined ? {} : { at: input.at }),
  });
  if (rate === undefined) {
    return undefined;
  }
  return computeCost(input.usage, rate);
}

/** Human-readable rendering, e.g. `$0.84`. Presentation only. */
export function formatCost(cost: Cost): string {
  if (!Number.isFinite(cost.micros) || cost.micros < 0) {
    throw new DomainError("VALIDATION", "Cost must be a non-negative number", {
      field: "micros",
    });
  }
  const fixed = (cost.micros / MICROS_PER_USD).toFixed(6);
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  return `$${trimmed === "" ? "0" : trimmed}`;
}
