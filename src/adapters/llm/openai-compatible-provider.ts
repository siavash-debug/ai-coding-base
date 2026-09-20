import type { Clock } from "../../core/clock.js";
import { durationMsFrom, toIsoString } from "../../core/clock.js";
import { DomainError } from "../../core/errors.js";
import { assertNonEmptyString } from "../../core/validation.js";
import type { AIUsage } from "../../observability/usage.js";
import { assertValidUsage } from "../../observability/usage.js";
import type { Environment } from "../../ports/environment.js";
import {
  type HttpTransport,
  HttpTransportError,
  isHttpTransportError,
} from "../../ports/http-transport.js";
import {
  type LlmFailureKind,
  type LlmFinishReason,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  LlmProviderError,
  isRetryableFailure,
} from "../../ports/llm-provider.js";

/**
 * The one real provider adapter: a Chat Completions-shaped HTTP API.
 *
 * "OpenAI-compatible" is a protocol, not a vendor. Many providers (and local
 * servers) speak it, so a single adapter — configured with a base URL, a model id
 * and the *name* of an environment variable holding a credential — covers the first
 * real slice without the platform taking a position on which vendor is correct.
 * See ADR-033.
 *
 * What this adapter does, and nothing else:
 *
 * - builds a request body from the normalised `LlmRequest`;
 * - reads the credential through the `Environment` port, at call time, and never
 *   stores it;
 * - normalises the response into provider-agnostic usage and finish reason;
 * - categorises every failure into `LlmFailureKind`.
 *
 * What it deliberately does **not** do:
 *
 * - **retry** — that is a policy decision with a budget, implemented as a
 *   decorator (`adapters/llm/retrying-provider.ts`);
 * - **price** anything — rates live in project configuration and are applied by
 *   the metrics layer (§15);
 * - **fabricate usage** — a provider that reports no usage yields `undefined`,
 *   which downstream accounting reports as `usage unavailable`, never as `0`
 *   (ADR-035);
 * - **persist or log content** — no prompt, response, header or credential value
 *   is ever included in an error message. Operator-facing messages are redacted.
 */

export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

export interface OpenAiCompatibleProviderOptions {
  /** API root, e.g. `https://api.openai.com/v1`. A trailing slash is tolerated. */
  readonly baseUrl: string;
  /** Default model. A request may name another model the provider serves. */
  readonly modelId: string;
  /** Name of the environment variable holding the key. Never the key itself. */
  readonly credentialEnvVar: string;
  readonly environment: Environment;
  readonly transport: HttpTransport;
  readonly clock: Clock;
  readonly timeoutMs?: number;
  readonly id?: string;
  /** Extra model ids this adapter is allowed to be asked for. */
  readonly additionalModels?: readonly string[];
}

/** HTTP status to failure category. Exported so the mapping is directly testable. */
export function classifyProviderStatus(status: number): LlmFailureKind {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 408) {
    return "timeout";
  }
  if (status === 429) {
    return "rate-limit";
  }
  if (status >= 500) {
    return "server";
  }
  // Other 4xx responses are the provider declining to serve *this* request. They
  // are not retryable, and the taxonomy has no better name than "unknown"; the
  // status code travels with the failure so an operator can see which one.
  return "unknown";
}

/** `finish_reason` from the wire, mapped into the platform's closed set. */
export function classifyFinishReason(reason: unknown): LlmFinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool-call";
    case "content_filter":
      return "content-filter";
    default:
      // A success with a reason we do not model is reported as such rather than
      // guessed at.
      return "error";
  }
}

/** `retry-after` in either of its two legal forms. Seconds or HTTP-date. */
export function parseRetryAfterMs(
  headers: Readonly<Record<string, string>>,
  nowMs: number,
): number | undefined {
  const raw = headers["retry-after"];
  if (raw === undefined) {
    return undefined;
  }
  const seconds = Number.parseInt(raw.trim(), 10);
  if (Number.isSafeInteger(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at)) {
    return undefined;
  }
  return Math.max(0, at - nowMs);
}

interface ChatCompletionPayload {
  readonly id?: unknown;
  readonly model?: unknown;
  readonly choices?: unknown;
  readonly usage?: unknown;
}

/** Extracts text from the two `content` shapes Chat Completions APIs return. */
function extractContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        parts.push((part as { text: string }).text);
      }
    }
    return parts.length === 0 ? undefined : parts.join("");
  }
  return undefined;
}

export function createOpenAiCompatibleProvider(
  options: OpenAiCompatibleProviderOptions,
): LlmProvider {
  const providerId = options.id ?? OPENAI_COMPATIBLE_PROVIDER_ID;
  const baseUrl = assertNonEmptyString(options.baseUrl, "baseUrl").replace(
    /\/+$/,
    "",
  );
  const defaultModel = assertNonEmptyString(options.modelId, "modelId");
  const credentialEnvVar = assertNonEmptyString(
    options.credentialEnvVar,
    "credentialEnvVar",
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

  function fail(
    failureKind: LlmFailureKind,
    modelId: string,
    details: { statusCode?: number; retryAfterMs?: number } = {},
  ): never {
    throw new LlmProviderError(
      {
        failureKind,
        providerId,
        modelId,
        attempts: 1,
        retryable: isRetryableFailure(failureKind),
        ...details,
      },
      // Never the vendor's own message: only the category and, at most, the
      // status code, which is already in `details`.
      `provider "${providerId}" failed for model "${modelId}": ${failureKind}`,
    );
  }

  function normalizeUsage(raw: unknown, modelId: string): AIUsage | undefined {
    if (typeof raw !== "object" || raw === null) {
      return undefined;
    }
    const usage = raw as Record<string, unknown>;
    const input = usage["prompt_tokens"];
    const output = usage["completion_tokens"];
    if (typeof input !== "number" || typeof output !== "number") {
      // Partial or absent usage is *unavailable*, not zero: a provider that
      // reports nothing must not look free (ADR-035).
      return undefined;
    }
    const details = usage["prompt_tokens_details"];
    const cached =
      typeof details === "object" && details !== null
        ? ((details as Record<string, unknown>)["cached_tokens"] ?? 0)
        : 0;
    const completionDetails = usage["completion_tokens_details"];
    const reasoning =
      typeof completionDetails === "object" && completionDetails !== null
        ? (completionDetails as Record<string, unknown>)["reasoning_tokens"]
        : undefined;
    try {
      return assertValidUsage(
        {
          inputTokens: input,
          outputTokens: output,
          cachedInputTokens: cached,
          ...(typeof reasoning === "number"
            ? { reasoningTokens: reasoning }
            : {}),
        },
        "usage",
      );
    } catch {
      // A provider that reports cached tokens exceeding input tokens is not a
      // rounding problem; the response does not mean what it claims.
      fail("malformed-response", modelId, { statusCode: 200 });
    }
  }

  return {
    id: providerId,
    models: [defaultModel, ...(options.additionalModels ?? [])],

    async complete(request: LlmRequest): Promise<LlmResponse> {
      const modelId = assertNonEmptyString(request.modelId, "modelId");
      if (request.messages.length === 0) {
        throw new DomainError(
          "VALIDATION",
          "an LLM request must contain at least one message",
          { field: "messages" },
        );
      }

      const credential = options.environment.get(credentialEnvVar);
      if (credential === undefined || credential.length === 0) {
        // Fails before any network call. The message names the *variable* so an
        // operator knows what to export; the value is never read into anything.
        throw new LlmProviderError(
          {
            failureKind: "auth",
            providerId,
            modelId,
            attempts: 1,
            retryable: false,
          },
          `provider "${providerId}" has no credential for model "${modelId}": ` +
            `environment variable ${credentialEnvVar} is not set`,
        );
      }

      const body: Record<string, unknown> = {
        model: modelId,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      };
      if (request.maxOutputTokens !== undefined) {
        body["max_tokens"] = request.maxOutputTokens;
      }
      if (request.temperature !== undefined) {
        body["temperature"] = request.temperature;
      }
      if (request.stopSequences !== undefined) {
        body["stop"] = [...request.stopSequences];
      }

      const startedAt = toIsoString(options.clock.now());
      let response;
      try {
        response = await options.transport.send({
          url: `${baseUrl}/chat/completions`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${credential}`,
          },
          body: JSON.stringify(body),
          timeoutMs,
          correlationId: request.correlationId,
        });
      } catch (error) {
        if (isHttpTransportError(error)) {
          // Timeouts and socket failures are categorised by the transport; this
          // adapter only attributes them to the provider and the model.
          fail(error.failureKind, modelId);
        }
        if (error instanceof LlmProviderError) {
          throw error;
        }
        // An unrecognised transport error is not assumed to be retryable.
        fail("unknown", modelId);
      }

      const latencyMs = durationMsFrom(
        startedAt,
        toIsoString(options.clock.now()),
      );

      if (response.status < 200 || response.status >= 300) {
        const retryAfterMs = parseRetryAfterMs(
          response.headers,
          options.clock.now().getTime(),
        );
        fail(classifyProviderStatus(response.status), modelId, {
          statusCode: response.status,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
      }

      let parsed: ChatCompletionPayload;
      try {
        parsed = JSON.parse(response.body) as ChatCompletionPayload;
      } catch {
        // The response body is never echoed: it may contain anything.
        fail("malformed-response", modelId, { statusCode: response.status });
      }

      const choices = parsed.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        fail("malformed-response", modelId, { statusCode: response.status });
      }
      const choice = choices[0] as Record<string, unknown>;
      const message = choice["message"];
      const content =
        typeof message === "object" && message !== null
          ? extractContent((message as Record<string, unknown>)["content"])
          : undefined;
      if (content === undefined) {
        fail("malformed-response", modelId, { statusCode: response.status });
      }

      const usage = normalizeUsage(parsed.usage, modelId);
      const reportedModel =
        typeof parsed.model === "string" && parsed.model.length > 0
          ? parsed.model
          : modelId;

      return {
        providerId,
        modelId: reportedModel,
        content,
        finishReason: classifyFinishReason(choice["finish_reason"]),
        ...(usage === undefined ? {} : { usage }),
        latencyMs,
        attempts: 1,
        ...(typeof parsed.id === "string" && parsed.id.length > 0
          ? { requestId: parsed.id }
          : {}),
      };
    },
  };
}

/** Re-exported so callers configuring the adapter can branch on transport errors. */
export { HttpTransportError };
