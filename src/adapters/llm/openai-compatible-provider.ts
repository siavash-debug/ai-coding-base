import type { Clock } from "../../core/clock.js";
import { durationMsFrom, toIsoString } from "../../core/clock.js";
import { DomainError, hasDomainErrorCode } from "../../core/errors.js";
import { assertNonEmptyString } from "../../core/validation.js";
import type { AIUsage } from "../../observability/usage.js";
import { assertValidUsage } from "../../observability/usage.js";
import type { Environment } from "../../ports/environment.js";
import {
  type HttpStreamResponse,
  type HttpTransport,
  type StreamingHttpTransport,
  HttpTransportError,
  isHttpTransportError,
  supportsStreaming,
} from "../../ports/http-transport.js";
import {
  type LlmContentPresence,
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
 *
 * ## Streaming
 *
 * The adapter can consume a Server-Sent Events stream instead of a buffered body,
 * and it stays one adapter: streaming is a transport choice, not a second
 * implementation, and it changes nothing above this port. `complete` still resolves a
 * single `LlmResponse` — assembled from the deltas, with the provider's usage and
 * finish reason carried through unchanged — so no decision contract, accounting rule
 * or provenance guarantee depends on which mode ran.
 *
 * Why it exists: a buffered call cannot distinguish a slow generator from a dead one,
 * so an endpoint that queues for a minute looks exactly like an outage until the
 * deadline expires. A stream reports status and headers as soon as the peer answers
 * and delivers text as it is produced, which is the difference between a deadline that
 * merely bounds a hang and one that is rarely reached.
 */

export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

/** The SSE sentinel that ends a Chat Completions stream. */
export const STREAM_DONE_SENTINEL = "[DONE]";

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
  /**
   * Ask for a Server-Sent Events response and assemble the answer from its deltas.
   *
   * A provider property, not a model one: whether an endpoint answers incrementally
   * is a fact about the endpoint. Off by default, so an existing configuration keeps
   * the buffered behaviour it was validated with.
   *
   * Streaming is *opportunistic*: when this is set but the transport that reaches
   * this provider cannot stream, the adapter falls back to the buffered path rather
   * than failing. That is a capability downgrade, never a safety one — the timeout,
   * the egress guard and the failure taxonomy are identical in both modes.
   */
  readonly streaming?: boolean;
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
    // An empty string is "no content", not "content that is empty": callers
    // distinguish absence of a completion from one with text in it.
    return content.length === 0 ? undefined : content;
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
    const joined = parts.join("");
    return joined.length === 0 ? undefined : joined;
  }
  return undefined;
}

/**
 * Reports, from shape alone, what a 2xx body carried.
 *
 * Never inspects text: the categories are structural (ADR-035), so the field is
 * safe to persist while every string in the body stays unpersisted.
 */
function classifyContentPresence(payload: {
  readonly choices?: unknown;
  readonly message?: unknown;
}): LlmContentPresence {
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
    return "no-choices";
  }
  if (
    typeof payload.message !== "object" ||
    payload.message === null
  ) {
    return "reasoning-only";
  }
  const content = (payload.message as Record<string, unknown>)["content"];
  if (extractContent(content) !== undefined) {
    return "usable-content";
  }
  // A content field that exists but holds nothing ("", or an empty parts
  // array) is an empty completion; no content field at all is the reasoning
  // model's signature. The distinction is structural, not textual.
  if (typeof content === "string" || Array.isArray(content)) {
    return "empty-content";
  }
  return "reasoning-only";
}

/**
 * Splits an SSE body into `data:` payloads.
 *
 * A deliberate simplification, stated so it can be checked: for Chat Completions,
 * each `data:` line is a complete JSON event, so the multi-line `data:` continuation
 * the SSE specification permits is not implemented. Comment lines (`:`), `event:`
 * and `id:` fields carry nothing this protocol puts to use and are skipped by not
 * matching, which is also what makes keep-alive traffic harmless.
 *
 * Exported and pure so the framing can be tested without a socket.
 */
export async function* iterateSseData(
  chunks: AsyncIterable<string>,
): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const payload = sseDataField(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (payload !== undefined) {
        yield payload;
      }
      index = buffer.indexOf("\n");
    }
  }
  // A final frame that arrived without a trailing newline is still a frame: the
  // peer stopped writing, so whatever is buffered is the last of it.
  const payload = sseDataField(buffer);
  if (payload !== undefined) {
    yield payload;
  }
}

/** The payload of a `data:` line, or `undefined` for any other line. */
function sseDataField(line: string): string | undefined {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!trimmed.startsWith("data:")) {
    return undefined;
  }
  const payload = trimmed.slice("data:".length).trim();
  return payload.length === 0 ? undefined : payload;
}

/**
 * Everything a stream has reported so far.
 *
 * The booleans exist so a stream that produced nothing can be described in the same
 * structural vocabulary a buffered response uses, and so no text has to be inspected
 * to do it.
 */
interface StreamAccumulator {
  content: string;
  finishReason?: unknown;
  usage?: unknown;
  requestId?: string;
  reportedModel?: string;
  /** At least one `data:` payload arrived. */
  sawData: boolean;
  /** At least one payload parsed as JSON. */
  sawEvent: boolean;
  /** At least one event carried a non-empty `choices` array. */
  sawChoice: boolean;
  /** A choice carried a `content` field, whether or not it held anything. */
  sawContentField: boolean;
}

/**
 * What a finished stream carried, in the buffered classifier's own vocabulary.
 *
 * Reported only when there is no usable content, so this is the shape of a failed
 * answer rather than of a successful one.
 */
function streamContentPresence(acc: StreamAccumulator): LlmContentPresence {
  if (!acc.sawData) {
    // Nothing was answered with at all. "No choices" is the honest description: the
    // stream carried no event that could have held one.
    return "no-choices";
  }
  if (!acc.sawEvent) {
    return "unparseable";
  }
  if (!acc.sawChoice) {
    return "no-choices";
  }
  if (acc.sawContentField) {
    return "empty-content";
  }
  return "reasoning-only";
}

/** Folds one SSE payload into the accumulator. Never throws on bad input. */
function accumulateStreamEvent(acc: StreamAccumulator, payload: string): void {
  acc.sawData = true;
  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    // One unreadable frame does not discard the frames around it; if none of them
    // parse, `streamContentPresence` reports it as unparseable.
    return;
  }
  acc.sawEvent = true;
  if (typeof event !== "object" || event === null) {
    return;
  }
  const record = event as Record<string, unknown>;
  // Identity is established by the first frame that carries it and never overwritten:
  // the id names *this* completion, so the frame that opened the answer is the
  // authority on which one it is. Usage is the opposite case — the trailing frame is
  // the authoritative one — which is why the two are not handled alike.
  if (
    acc.requestId === undefined &&
    typeof record["id"] === "string" &&
    record["id"].length > 0
  ) {
    acc.requestId = record["id"];
  }
  if (
    acc.reportedModel === undefined &&
    typeof record["model"] === "string" &&
    record["model"].length > 0
  ) {
    acc.reportedModel = record["model"];
  }
  // Some endpoints attach usage to the final content frame and some send it in a
  // trailing frame of its own. Taking the last one reported covers both without
  // asking for a vendor-specific `stream_options` parameter.
  if (record["usage"] !== undefined) {
    acc.usage = record["usage"];
  }
  const choices = record["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    return;
  }
  acc.sawChoice = true;
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null) {
    return;
  }
  const row = choice as Record<string, unknown>;
  if (row["finish_reason"] !== undefined && row["finish_reason"] !== null) {
    acc.finishReason = row["finish_reason"];
  }
  // `delta` is the streaming shape; `message` is accepted because a few compatible
  // endpoints send a whole message per frame, and the cost of tolerating it is
  // three tokens of branching versus a silently empty answer.
  const carrier = row["delta"] ?? row["message"];
  if (typeof carrier !== "object" || carrier === null) {
    return;
  }
  const delta = carrier as Record<string, unknown>;
  const piece = extractContent(delta["content"]);
  if (piece !== undefined) {
    acc.content += piece;
  }
  if (typeof delta["content"] === "string" || Array.isArray(delta["content"])) {
    acc.sawContentField = true;
  }
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
    details: {
      statusCode?: number;
      contentPresence?: LlmContentPresence;
      retryAfterMs?: number;
    } = {},
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
      fail("malformed-response", modelId, {
        statusCode: 200,
        contentPresence: "unparseable",
      });
    }
  }

  /**
   * The streaming entry point, when configuration asks for it *and* the transport
   * that reaches this provider can deliver it.
   *
   * Resolved once, at construction: a capability that cannot change at runtime is
   * not something to re-ask on every call.
   */
  const streamingTransport =
    options.streaming === true && supportsStreaming(options.transport)
      ? options.transport
      : undefined;

  /** One translation for every transport-level failure, from either mode. */
  function transportFailure(error: unknown, modelId: string): never {
    if (isHttpTransportError(error)) {
      // Timeouts and socket failures are categorised by the transport; this adapter
      // only attributes them to the provider and the model.
      fail(error.failureKind, modelId);
    }
    if (error instanceof LlmProviderError) {
      throw error;
    }
    if (hasDomainErrorCode(error, "FORBIDDEN")) {
      // Policy refused this call before it reached the socket (egress, capability or
      // approval gate). A refusal is not an unknown transport failure, and it is never
      // retryable: repeating it asks the same boundary the same question.
      fail("refused", modelId);
    }
    // An unrecognised transport error is not assumed to be retryable.
    fail("unknown", modelId);
  }

  /**
   * The request body. One builder, so the two modes cannot drift apart in what they
   * ask for; `stream` is the only difference.
   *
   * No `stream_options` is sent, deliberately: on the endpoints measured, usage
   * already arrives in the stream, and requesting an optional parameter an endpoint
   * does not implement converts a working call into a rejection for no gain.
   */
  function buildRequestBody(
    modelId: string,
    request: LlmRequest,
    stream: boolean,
  ): Record<string, unknown> {
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
    if (stream) {
      body["stream"] = true;
    }
    return body;
  }

  /**
   * The streamed path, resolved into the same `LlmResponse` the buffered path
   * returns.
   *
   * The ordering of the checks matches the buffered path exactly — transport
   * failure, then status, then shape, then content — because the taxonomy a caller
   * branches on must not depend on how the bytes arrived.
   */
  async function completeStreamed(input: {
    readonly request: LlmRequest;
    readonly modelId: string;
    readonly credential: string;
    readonly transport: StreamingHttpTransport;
  }): Promise<LlmResponse> {
    const { request, modelId, credential, transport } = input;
    const startedAt = toIsoString(options.clock.now());

    let stream: HttpStreamResponse;
    try {
      stream = await transport.sendStream({
        url: `${baseUrl}/chat/completions`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify(buildRequestBody(modelId, request, true)),
        timeoutMs,
        correlationId: request.correlationId,
      });
    } catch (error) {
      transportFailure(error, modelId);
    }

    if (stream.status < 200 || stream.status >= 300) {
      const retryAfterMs = parseRetryAfterMs(
        stream.headers,
        options.clock.now().getTime(),
      );
      fail(classifyProviderStatus(stream.status), modelId, {
        statusCode: stream.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }

    const accumulated: StreamAccumulator = {
      content: "",
      sawData: false,
      sawEvent: false,
      sawChoice: false,
      sawContentField: false,
    };
    try {
      for await (const payload of iterateSseData(stream.chunks)) {
        if (payload === STREAM_DONE_SENTINEL) {
          break;
        }
        accumulateStreamEvent(accumulated, payload);
      }
    } catch (error) {
      // A stream that dies after the headers reports the same categories as one that
      // never connected, so the retry policy sees a single taxonomy.
      transportFailure(error, modelId);
    }

    const latencyMs = durationMsFrom(
      startedAt,
      toIsoString(options.clock.now()),
    );
    // A partial answer is never returned. Handing back what arrived before the stream
    // broke would be indistinguishable downstream from an answer the model finished,
    // and a truncated completion is worse than a reported failure.
    const content =
      accumulated.content.length === 0 ? undefined : accumulated.content;
    if (content === undefined) {
      fail("malformed-response", modelId, {
        statusCode: stream.status,
        contentPresence: streamContentPresence(accumulated),
      });
    }

    const usage = normalizeUsage(accumulated.usage, modelId);
    return {
      providerId,
      modelId: accumulated.reportedModel ?? modelId,
      content,
      finishReason: classifyFinishReason(accumulated.finishReason),
      ...(usage === undefined ? {} : { usage }),
      latencyMs,
      attempts: 1,
      ...(accumulated.requestId === undefined
        ? {}
        : { requestId: accumulated.requestId }),
    };
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

      if (streamingTransport !== undefined) {
        return await completeStreamed({
          request,
          modelId,
          credential,
          transport: streamingTransport,
        });
      }

      const body = buildRequestBody(modelId, request, false);
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
        transportFailure(error, modelId);
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
      }      let parsed: ChatCompletionPayload;
      try {
        parsed = JSON.parse(response.body) as ChatCompletionPayload;
      } catch {
        // The response body is never echoed: it may contain anything.
        fail("malformed-response", modelId, {
          statusCode: response.status,
          contentPresence: "unparseable",
        });
      }

      const choices = parsed.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        fail("malformed-response", modelId, {
          statusCode: response.status,
          contentPresence: "no-choices",
        });
      }
      const choice = choices[0] as Record<string, unknown>;
      const message = choice["message"];
      const content =
        typeof message === "object" && message !== null
          ? extractContent((message as Record<string, unknown>)["content"])
          : undefined;
      if (content === undefined) {
        fail("malformed-response", modelId, {
          statusCode: response.status,
          contentPresence: classifyContentPresence({
            choices,
            message,
          }),
        });
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
