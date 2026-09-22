import {
  type Clock,
  durationMsFrom,
  toIsoString,
} from "../../src/core/clock.js";
import { emptyUsage } from "../../src/observability/usage.js";
import type { AIUsage } from "../../src/observability/usage.js";
import {
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from "../../src/ports/http-transport.js";
import {
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  LlmProviderError,
} from "../../src/ports/llm-provider.js";

/**
 * Offline fixtures for the real provider adapter.
 *
 * The adapter's only outside dependency is the `HttpTransport` port, so scripting a
 * transport is enough to test request building, response normalisation and every
 * failure category for real — deterministically, with no network and no credential.
 *
 * Nothing here reaches the network, and the credential values used in tests are
 * obviously fake, so a test can never accidentally exercise a real key.
 */

export type TransportStep = HttpResponse | { readonly error: Error };

export interface FakeTransport extends HttpTransport {
  readonly requests: readonly HttpRequest[];
}

/** Replays scripted responses in order and records every request it received. */
export function createFakeTransport(
  steps: readonly TransportStep[],
): FakeTransport {
  const requests: HttpRequest[] = [];
  let index = 0;
  return {
    id: "fake-transport",
    requests,
    async send(request: HttpRequest): Promise<HttpResponse> {
      requests.push(request);
      const step = steps[index];
      index += 1;
      if (step === undefined) {
        throw new Error(
          `fake transport received request #${index} with no scripted response`,
        );
      }
      if ("error" in step) {
        throw step.error;
      }
      return step;
    },
  };
}

export function jsonResponse(
  body: string,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): HttpResponse {
  return { status, headers, body };
}

export interface ChatCompletionFixture {
  readonly content?: string;
  /**
   * Emit `content: null`, as a reasoning-only response does.
   *
   * A separately named switch rather than `content: undefined` so a test that means
   * "the model produced no answer text" cannot be confused with one that simply did
   * not pass a value to the default.
   */
  readonly nullContent?: boolean;
  /** A vendor's reasoning member, sent alongside or instead of answer text. */
  readonly reasoning?: string;
  readonly model?: string;
  readonly requestId?: string;
  readonly finishReason?: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly cachedTokens?: number;
  readonly reasoningTokens?: number;
  /** Omit the whole `usage` member, as a provider may. */
  readonly omitUsage?: boolean;
  /** Emit a usage object with the fields missing rather than absent. */
  readonly partialUsage?: boolean;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** A Chat Completions response body in the shape the adapter expects. */
export function chatCompletionBody(
  fixture: ChatCompletionFixture = {},
): string {
  const usage = fixture.omitUsage
    ? {}
    : fixture.partialUsage
      ? { usage: { total_tokens: 42 } }
      : {
          usage: {
            prompt_tokens: fixture.promptTokens ?? 1200,
            completion_tokens: fixture.completionTokens ?? 300,
            total_tokens:
              (fixture.promptTokens ?? 1200) +
              (fixture.completionTokens ?? 300),
            prompt_tokens_details: {
              cached_tokens: fixture.cachedTokens ?? 0,
            },
            ...(fixture.reasoningTokens === undefined
              ? {}
              : {
                  completion_tokens_details: {
                    reasoning_tokens: fixture.reasoningTokens,
                  },
                }),
          },
        };
  return JSON.stringify({
    id: fixture.requestId ?? "req-fixture-1",
    model: fixture.model ?? "fixture-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: fixture.nullContent ? null : (fixture.content ?? "ok"),
          ...(fixture.reasoning === undefined
            ? {}
            : { reasoning: fixture.reasoning }),
        },
        finish_reason: fixture.finishReason ?? "stop",
      },
    ],
    ...usage,
    ...(fixture.extra ?? {}),
  });
}

/** A provider whose responses (or failures) are scripted, for runner-level tests. */
export interface FakeProviderStep {
  readonly usage?: AIUsage;
  readonly content?: string;
  readonly latencyMs?: number;
  readonly attempts?: number;
  readonly requestId?: string;
  readonly error?: LlmProviderError;
}

export interface FakeProvider extends LlmProvider {
  readonly requests: readonly LlmRequest[];
}

export function createFakeProvider(
  steps: readonly FakeProviderStep[],
  options: { readonly id?: string; readonly modelId?: string } = {},
): FakeProvider {
  const id = options.id ?? "fake-provider";
  const modelId = options.modelId ?? "fake-model";
  const requests: LlmRequest[] = [];
  let index = 0;
  return {
    id,
    models: [modelId],
    requests,
    async complete(request: LlmRequest): Promise<LlmResponse> {
      requests.push(request);
      const step = steps[index];
      index += 1;
      if (step === undefined) {
        throw new Error(
          `fake provider received call #${index} with no scripted step`,
        );
      }
      if (step.error !== undefined) {
        throw step.error;
      }
      return {
        providerId: id,
        modelId: request.modelId,
        content: step.content ?? "fake completion",
        finishReason: "stop",
        usage: step.usage ?? emptyUsage(),
        latencyMs: step.latencyMs ?? 10,
        ...(step.attempts === undefined ? {} : { attempts: step.attempts }),
        ...(step.requestId === undefined ? {} : { requestId: step.requestId }),
      };
    },
  };
}

/** Builds a categorised provider failure without going through a transport. */
export function providerFailure(input: {
  readonly failureKind: LlmProviderError["failureKind"];
  readonly providerId?: string;
  readonly modelId?: string;
  readonly attempts?: number;
  readonly retryable?: boolean;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
}): LlmProviderError {
  return new LlmProviderError(
    {
      failureKind: input.failureKind,
      providerId: input.providerId ?? "fake-provider",
      modelId: input.modelId ?? "fake-model",
      attempts: input.attempts ?? 1,
      retryable: input.retryable ?? false,
      ...(input.statusCode === undefined
        ? {}
        : { statusCode: input.statusCode }),
      ...(input.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: input.retryAfterMs }),
    },
    `scripted ${input.failureKind} failure`,
  );
}

/** Milliseconds the clock advanced across a call, for latency assertions. */
export function latencyOf(clock: Clock, from: Date): number {
  return durationMsFrom(toIsoString(from), toIsoString(clock.now()));
}
