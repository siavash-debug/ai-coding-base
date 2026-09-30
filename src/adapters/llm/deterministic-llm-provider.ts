import { type Clock, durationMsFrom, toIsoString } from "../../core/clock.js";
import { DomainError } from "../../core/errors.js";
import { assertNonEmptyString } from "../../core/validation.js";
import type { ModelRate } from "../../observability/cost.js";
import { createModelRate } from "../../observability/cost.js";
import { type AIUsage, assertValidUsage } from "../../observability/usage.js";
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
} from "../../ports/llm-provider.js";

/**
 * A deterministic, offline `LlmProvider`.
 *
 * This is **not** a vendor adapter and makes no network calls. It exists so the
 * event flow can be demonstrated and tested without a provider, and so Phase D
 * has a working seam to replace. It is registered as the offline provider and
 * `ai doctor` reports it as such.
 *
 * Latency is measured against the injected clock rather than an ambient timer, so
 * the value is a real measurement of this call and still deterministic under a
 * test clock (which does not advance on its own).
 */
export const OFFLINE_PROVIDER_ID = "deterministic";
export const OFFLINE_MODEL_ID = "deterministic-1";

/**
 * Canned usage per call, cycled. Values are plausible shapes for a planning turn
 * and a follow-up turn with a cache hit. Cached tokens stay a subset of input
 * tokens (ADR-008).
 */
export const DEFAULT_OFFLINE_USAGE: readonly AIUsage[] = [
  { inputTokens: 1240, outputTokens: 320, cachedInputTokens: 0 },
  {
    inputTokens: 2180,
    outputTokens: 460,
    cachedInputTokens: 1024,
  },
];

/**
 * Illustrative rates for the offline stand-in.
 *
 * These are placeholder numbers chosen to be plausible for a mid-size model. They
 * are a demonstration of the pricing pipeline, not a claim about any real
 * vendor's pricing, which is why the provider and model are both literally named
 * `deterministic`. Real rates belong in a project's own configuration, from a
 * source the project trusts.
 */
export const OFFLINE_RATE_EFFECTIVE_FROM = "2026-01-01T00:00:00.000Z";

export function offlineModelRates(): readonly ModelRate[] {
  return [
    createModelRate({
      providerId: OFFLINE_PROVIDER_ID,
      modelId: OFFLINE_MODEL_ID,
      effectiveFrom: OFFLINE_RATE_EFFECTIVE_FROM,
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
      cachedInputUsdPerMillionTokens: 0.3,
    }),
  ];
}

export interface DeterministicLlmProviderOptions {
  readonly clock: Clock;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly usagePlan?: readonly AIUsage[];
}

export function createDeterministicLlmProvider(
  options: DeterministicLlmProviderOptions,
): LlmProvider {
  const providerId = options.providerId ?? OFFLINE_PROVIDER_ID;
  const modelId = options.modelId ?? OFFLINE_MODEL_ID;
  const usagePlan = (options.usagePlan ?? DEFAULT_OFFLINE_USAGE).map(
    (usage, index) => assertValidUsage(usage, `usagePlan[${index}]`),
  );
  if (usagePlan.length === 0) {
    throw new DomainError("VALIDATION", "usagePlan must not be empty", {
      field: "usagePlan",
    });
  }
  let calls = 0;

  return {
    id: providerId,
    models: [modelId],

    async complete(request: LlmRequest): Promise<LlmResponse> {
      const requestedModel = assertNonEmptyString(
        request.modelId,
        "request.modelId",
      );
      if (requestedModel !== modelId) {
        throw new DomainError(
          "NOT_FOUND",
          `provider "${providerId}" does not serve model "${requestedModel}"`,
          { field: "request.modelId" },
        );
      }
      if (request.messages.length === 0) {
        throw new DomainError(
          "VALIDATION",
          "a request must carry at least one message",
          { field: "request.messages" },
        );
      }

      const startedAt = options.clock.now();
      const usage = usagePlan[calls % usagePlan.length];
      const completion = `simulated completion for ${request.correlationId}`;
      calls += 1;

      return {
        modelId: requestedModel,
        providerId,
        content: completion,
        finishReason: "stop",
        usage,
        latencyMs: durationMsFrom(
          toIsoString(startedAt),
          toIsoString(options.clock.now()),
        ),
      };
    },
  };
}
