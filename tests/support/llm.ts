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
  type HttpStreamResponse,
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

/*
 * Streaming fixtures.
 *
 * The streaming path is tested the same way the buffered path is: by scripting the
 * port. Nothing here needs a socket, a clock or a real credential, and every failure
 * shape — a refused connection, a refusal status, a stream that dies half-way — is
 * something a test can produce on purpose rather than hope for.
 */

/** One Server-Sent Events frame. A string payload is sent as-is. */
export function sseFrame(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

/** The sentinel that ends a Chat Completions stream. */
export function doneFrame(): string {
  return sseFrame("[DONE]");
}

export interface StreamChunkFixture {
  readonly id?: string;
  readonly model?: string;
  /** Absent means the frame carries no `content` member at all. */
  readonly content?: string;
  /** `content: null`, as a reasoning-only delta has. */
  readonly nullContent?: boolean;
  readonly reasoning?: string;
  readonly finishReason?: string;
  readonly usage?: {
    readonly prompt?: number;
    readonly completion?: number;
    readonly cached?: number;
  };
  /** Emit a `choices` array that is empty, as a trailing usage frame has. */
  readonly noChoices?: boolean;
  readonly extra?: Readonly<Record<string, unknown>>;
}

function usageBody(fixture: {
  readonly prompt?: number;
  readonly completion?: number;
  readonly cached?: number;
}): Record<string, unknown> {
  return {
    prompt_tokens: fixture.prompt ?? 1200,
    completion_tokens: fixture.completion ?? 300,
    total_tokens: (fixture.prompt ?? 1200) + (fixture.completion ?? 300),
    prompt_tokens_details: { cached_tokens: fixture.cached ?? 0 },
  };
}

/** One Chat Completions chunk, in the streaming shape the adapter consumes. */
export function streamChunk(fixture: StreamChunkFixture = {}): string {
  const base = {
    id: fixture.id ?? "chatcmpl-fixture-1",
    model: fixture.model ?? "fixture-model",
    object: "chat.completion.chunk",
  };
  const choices = fixture.noChoices
    ? []
    : [
        {
          index: 0,
          delta: {
            role: "assistant",
            ...(fixture.content === undefined && fixture.nullContent !== true
              ? {}
              : {
                  content: fixture.nullContent ? null : fixture.content,
                }),
            ...(fixture.reasoning === undefined
              ? {}
              : { reasoning_content: fixture.reasoning }),
          },
          finish_reason: fixture.finishReason ?? null,
        },
      ];
  return sseFrame({
    ...base,
    choices,
    ...(fixture.usage === undefined ? {} : { usage: usageBody(fixture.usage) }),
    ...(fixture.extra ?? {}),
  });
}

/** A transport script entry for one streamed call. */
export type FakeStreamStep =
  | {
      readonly kind: "stream";
      readonly status?: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly frames: readonly string[];
      /** Deliver this many frames, then fail mid-stream. */
      readonly failAfter?: number;
      readonly error?: Error;
    }
  | { readonly kind: "throw"; readonly error: Error };

export interface FakeStreamingTransport extends HttpTransport {
  /** Every buffered request the transport received. */
  readonly requests: readonly HttpRequest[];
  /** Every streamed request the transport received, tracked separately. */
  readonly streamRequests: readonly HttpRequest[];
  sendStream(request: HttpRequest): Promise<HttpStreamResponse>;
}

/**
 * A transport that can stream, with both entry points scripted independently.
 *
 * Two scripts rather than one, deliberately: a test that asserts streaming was *not*
 * used needs the buffered path to be scripted and the streamed path to stay empty, and
 * vice versa. Sharing one queue would make "which entry point was called?" unassertable.
 */
export function createFakeStreamingTransport(input: {
  readonly stream?: readonly FakeStreamStep[];
  readonly buffered?: readonly TransportStep[];
}): FakeStreamingTransport {
  const requests: HttpRequest[] = [];
  const streamRequests: HttpRequest[] = [];
  let bufferedIndex = 0;
  let streamIndex = 0;

  async function* serve(
    step: Extract<FakeStreamStep, { kind: "stream" }>,
  ): AsyncGenerator<string> {
    const limit = step.failAfter ?? step.frames.length;
    for (let index = 0; index < limit; index += 1) {
      const frame = step.frames[index];
      if (frame !== undefined) {
        yield frame;
      }
    }
    if (step.failAfter !== undefined) {
      throw step.error ?? new TypeError("terminated");
    }
  }

  return {
    id: "fake-streaming-transport",
    requests,
    streamRequests,

    async send(request: HttpRequest): Promise<HttpResponse> {
      requests.push(request);
      const step = (input.buffered ?? [])[bufferedIndex];
      bufferedIndex += 1;
      if (step === undefined) {
        throw new Error(
          `fake streaming transport received buffered request #${bufferedIndex} with no scripted response`,
        );
      }
      if ("error" in step) {
        throw step.error;
      }
      return step;
    },

    async sendStream(request: HttpRequest): Promise<HttpStreamResponse> {
      streamRequests.push(request);
      const step = (input.stream ?? [])[streamIndex];
      streamIndex += 1;
      if (step === undefined) {
        throw new Error(
          `fake streaming transport received streamed request #${streamIndex} with no scripted step`,
        );
      }
      if (step.kind === "throw") {
        throw step.error;
      }
      return {
        status: step.status ?? 200,
        headers: step.headers ?? {},
        chunks: serve(step),
      };
    },
  };
}
