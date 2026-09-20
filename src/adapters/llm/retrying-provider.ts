import { assertPositiveInteger } from "../../core/validation.js";
import type { Sleep } from "../../ports/sleep.js";
import {
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  LlmProviderError,
} from "../../ports/llm-provider.js";

/**
 * Bounded retry, as a decorator over any `LlmProvider`.
 *
 * Retry is a *policy*, not a property of a vendor, so it lives here rather than
 * inside the provider adapter: the adapter reports a categorised failure and this
 * layer decides whether spending another attempt is worth it, under an explicit
 * cap. See ADR-034.
 *
 * The rules, stated so they can be checked:
 *
 * - Only categories the taxonomy calls retryable are retried (rate limit,
 *   timeout, network, server). `auth`, `malformed-response`, `refused` and
 *   `unknown` are not: retrying a rejected credential just burns money.
 * - Attempts are **bounded** (`maxAttempts`, default 3). There is no unbounded
 *   loop anywhere in the platform.
 * - Backoff is exponential and **capped**, and a provider-requested
 *   `retry-after` is honoured within that cap. Waiting is injected
 *   (`Sleep`), so tests are instant and deterministic.
 * - The final failure carries the total attempt count, so the trace records how
 *   hard the platform tried rather than only that it gave up.
 *
 * A non-`LlmProviderError` escaping the inner provider is a programming error, not
 * a provider failure, and is never retried or wrapped.
 */
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 250;
export const DEFAULT_MAX_DELAY_MS = 5_000;

export interface RetryingProviderOptions {
  readonly provider: LlmProvider;
  readonly sleep: Sleep;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly id?: string;
}

/** Exponential backoff, capped. Attempt 1 waits `baseDelayMs`. */
export function backoffDelayMs(input: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryAfterMs?: number;
}): number {
  const exponential = input.baseDelayMs * 2 ** (input.attempt - 1);
  const requested =
    input.retryAfterMs === undefined ? exponential : input.retryAfterMs;
  return Math.min(Math.max(requested, 0), input.maxDelayMs);
}

export function createRetryingProvider(
  options: RetryingProviderOptions,
): LlmProvider {
  const maxAttempts = assertPositiveInteger(
    options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    "maxAttempts",
  );
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const inner = options.provider;

  return {
    id: options.id ?? inner.id,
    models: inner.models,

    async complete(request: LlmRequest): Promise<LlmResponse> {
      let attempt = 1;
      for (;;) {
        try {
          const response = await inner.complete(request);
          return {
            ...response,
            // Transport attempts spent in total, including attempts this layer
            // spent before the successful one.
            attempts: (response.attempts ?? 1) + (attempt - 1),
          };
        } catch (error) {
          if (!(error instanceof LlmProviderError)) {
            throw error;
          }
          if (!error.retryable || attempt >= maxAttempts) {
            throw new LlmProviderError(
              {
                failureKind: error.failureKind,
                providerId: error.providerId,
                modelId: error.modelId,
                attempts: attempt,
                retryable: error.retryable,
                ...(error.statusCode === undefined
                  ? {}
                  : { statusCode: error.statusCode }),
                ...(error.retryAfterMs === undefined
                  ? {}
                  : { retryAfterMs: error.retryAfterMs }),
              },
              `provider "${error.providerId}" failed for model "${error.modelId}" ` +
                `with ${error.failureKind} after ${attempt} attempt(s)`,
            );
          }

          await options.sleep.sleep(
            backoffDelayMs({
              attempt,
              baseDelayMs,
              maxDelayMs,
              ...(error.retryAfterMs === undefined
                ? {}
                : { retryAfterMs: error.retryAfterMs }),
            }),
          );
          attempt += 1;
        }
      }
    },
  };
}
