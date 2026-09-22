import { describe, expect, it } from "vitest";

import {
  createOpenAiCompatibleProvider,
  iterateSseData,
} from "../../src/adapters/llm/openai-compatible-provider.js";
import { createFixedEnvironment } from "../../src/ports/environment.js";
import { HttpTransportError } from "../../src/ports/http-transport.js";
import { LlmProviderError } from "../../src/ports/llm-provider.js";
import {
  chatCompletionBody,
  createFakeStreamingTransport,
  createFakeTransport,
  doneFrame,
  jsonResponse,
  sseFrame,
  streamChunk,
} from "../support/llm.js";
import { createTickingClock } from "../support/project.js";

/**
 * The provider adapter's streaming path, tested entirely offline.
 *
 * Streaming changes how bytes arrive and nothing else, so these tests assert the two
 * things that must hold: the assembled response is the *same contract* the buffered
 * path returns, and every failure category is reached identically in both modes. A
 * stream that quietly produced a different shape, or a different failure kind, would
 * move a decision without moving a test — which is why both are asserted directly.
 */
const FIXTURE_KEY = "sk-test-fixture-abcdefghijklmnop";
const BASE_URL = "https://fixture.invalid/v1";

async function failureOf(
  call: () => Promise<unknown>,
): Promise<LlmProviderError> {
  const outcome = await call().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(outcome instanceof LlmProviderError)) {
    throw new Error(
      `expected an LlmProviderError, got: ${String(outcome ?? "a successful call")}`,
    );
  }
  return outcome;
}

function streamingProvider(
  input: Parameters<typeof createFakeStreamingTransport>[0],
): {
  readonly transport: ReturnType<typeof createFakeStreamingTransport>;
  readonly provider: ReturnType<typeof createOpenAiCompatibleProvider>;
} {
  const transport = createFakeStreamingTransport(input);
  const provider = createOpenAiCompatibleProvider({
    baseUrl: BASE_URL,
    modelId: "fixture-model",
    credentialEnvVar: "FIXTURE_API_KEY",
    environment: createFixedEnvironment({ FIXTURE_API_KEY: FIXTURE_KEY }),
    transport,
    clock: createTickingClock(),
    streaming: true,
  });
  return { transport, provider };
}

const REQUEST = {
  modelId: "fixture-model",
  messages: [{ role: "user" as const, content: "summarise the task" }],
  correlationId: "corr-stream-1",
};

/** Presents an array as the async iterable the framing helper consumes. */
async function* fromArray(items: readonly string[]): AsyncGenerator<string> {
  for (const item of items) {
    yield item;
  }
}

async function collect(chunks: readonly string[]): Promise<readonly string[]> {
  const out: string[] = [];
  for await (const payload of iterateSseData(fromArray(chunks))) {
    out.push(payload);
  }
  return out;
}

describe("sse framing", () => {
  it("yields one payload per data line, however the bytes are split", async () => {
    const body = sseFrame({ a: 1 }) + sseFrame({ b: 2 }) + doneFrame();
    // The same body, delivered three ways: whole, split mid-frame, and one byte at a
    // time. Framing must not depend on how the network happened to chunk it.
    const whole = await collect([body]);
    const halved = await collect([
      body.slice(0, 7),
      body.slice(7, 23),
      body.slice(23),
    ]);
    const bytewise = await collect(body.split(""));

    expect(whole).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
    expect(halved).toEqual(whole);
    expect(bytewise).toEqual(whole);
  });

  it("skips comments, keep-alives and other SSE fields", async () => {
    const chunks = [
      ": keep-alive\n\n",
      "event: message\n",
      "id: 42\n",
      "retry: 100\n",
      sseFrame({ real: true }),
      "\n",
    ];
    expect(await collect(chunks)).toEqual(['{"real":true}']);
  });

  it("accepts CRLF line endings and a final frame with no trailing newline", async () => {
    const crlf = `data: {"a":1}\r\n\r\ndata: {"b":2}`;
    expect(await collect([crlf])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("ignores an empty data field rather than yielding an unparseable frame", async () => {
    expect(await collect(["data:\n\n", "data:   \n\n"])).toEqual([]);
  });
});

describe("openai-compatible provider: streaming", () => {
  it("asks for a stream and never for a vendor-specific stream option", async () => {
    const { transport, provider } = streamingProvider({
      stream: [{ kind: "stream", frames: [streamChunk({ content: "hi" })] }],
    });
    await provider.complete(REQUEST);

    expect(transport.streamRequests).toHaveLength(1);
    const request = transport.streamRequests[0];
    expect(request?.url).toBe(`${BASE_URL}/chat/completions`);
    expect(request?.headers["accept"]).toBe("text/event-stream");
    expect(request?.headers["authorization"]).toBe(`Bearer ${FIXTURE_KEY}`);
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body["stream"]).toBe(true);
    // Measured: usage arrives without it, and asking for a parameter an endpoint does
    // not implement converts a working call into a rejection.
    expect(body["stream_options"]).toBeUndefined();
  });

  it("assembles the answer from deltas and carries usage, finish reason and ids", async () => {
    const { provider } = streamingProvider({
      stream: [
        {
          kind: "stream",
          frames: [
            streamChunk({ id: "chatcmpl-9", model: "qwen-fixture", content: "Hel" }),
            streamChunk({ content: "lo " }),
            streamChunk({ content: "world", finishReason: "stop" }),
            streamChunk({ noChoices: true, usage: {} }),
            doneFrame(),
          ],
        },
      ],
    });

    const response = await provider.complete(REQUEST);
    expect(response.content).toBe("Hello world");
    expect(response.finishReason).toBe("stop");
    expect(response.modelId).toBe("qwen-fixture");
    expect(response.requestId).toBe("chatcmpl-9");
    expect(response.attempts).toBe(1);
    expect(response.usage?.outputTokens).toBe(300);
  });

  it("takes usage from a trailing frame that carries no choices", async () => {
    const { provider } = streamingProvider({
      stream: [
        {
          kind: "stream",
          frames: [
            streamChunk({ content: "answer", finishReason: "length" }),
            streamChunk({
              noChoices: true,
              usage: { prompt: 40, completion: 7, cached: 3 },
            }),
            doneFrame(),
          ],
        },
      ],
    });

    const response = await provider.complete(REQUEST);
    expect(response.finishReason).toBe("length");
    // No `reasoningTokens` key: the endpoint did not report one, and an absent
    // measurement must not be invented as zero.
    expect(response.usage).toEqual({
      inputTokens: 40,
      outputTokens: 7,
      cachedInputTokens: 3,
    });
  });

  it("stops reading at the done sentinel and ignores frames after it", async () => {
    const { provider } = streamingProvider({
      stream: [
        {
          kind: "stream",
          frames: [
            streamChunk({ content: "kept" }),
            doneFrame(),
            streamChunk({ content: "discarded" }),
          ],
        },
      ],
    });

    expect((await provider.complete(REQUEST)).content).toBe("kept");
  });

  it("returns the same response contract as the buffered path", async () => {
    const { provider: streamed } = streamingProvider({
      stream: [
        {
          kind: "stream",
          frames: [
            streamChunk({ content: "ok", finishReason: "stop" }),
            streamChunk({ noChoices: true, usage: {} }),
            doneFrame(),
          ],
        },
      ],
    });
    const bufferedProvider = createOpenAiCompatibleProvider({
      baseUrl: BASE_URL,
      modelId: "fixture-model",
      credentialEnvVar: "FIXTURE_API_KEY",
      environment: createFixedEnvironment({ FIXTURE_API_KEY: FIXTURE_KEY }),
      transport: createFakeTransport([jsonResponse(chatCompletionBody())]),
      clock: createTickingClock(),
    });

    const fromStream = await streamed.complete(REQUEST);
    const fromBuffer = await bufferedProvider.complete(REQUEST);
    // The keys are asserted, not the values: which fields exist is the contract every
    // caller and every event shape depends on.
    expect(Object.keys(fromStream).sort()).toEqual(
      Object.keys(fromBuffer).sort(),
    );
  });

  it("tolerates one unreadable frame without discarding the rest", async () => {
    const { provider } = streamingProvider({
      stream: [
        {
          kind: "stream",
          frames: [
            streamChunk({ content: "before" }),
            "data: {not json\n\n",
            streamChunk({ content: "after" }),
            doneFrame(),
          ],
        },
      ],
    });

    expect((await provider.complete(REQUEST)).content).toBe("beforeafter");
  });
});

describe("openai-compatible provider: streaming failures", () => {
  it("reports a stream with no frames as a malformed response", async () => {
    const { provider } = streamingProvider({
      stream: [{ kind: "stream", frames: [] }],
    });

    const failure = await failureOf(() => provider.complete(REQUEST));
    expect(failure.failureKind).toBe("malformed-response");
    expect(failure.contentPresence).toBe("no-choices");
    expect(failure.retryable).toBe(false);
  });

  it("reports a usage-only stream as having no choices", async () => {
    const { provider } = streamingProvider({
      stream: [
        {
          kind: "stream",
          frames: [sseFrame({ usage: { prompt_tokens: 1, completion_tokens: 0 } })],
        },
      ],
    });

    const failure = await failureOf(() => provider.complete(REQUEST));
    expect(failure.contentPresence).toBe("no-choices");
  });

  it("reports an unparseable stream as unparseable", async () => {
    const { provider } = streamingProvider({
      stream: [{ kind: "stream", frames: ["data: <<garbage>>\n\n"] }],
    });

    const failure = await failureOf(() => provider.complete(REQUEST));
    expect(failure.contentPresence).toBe("unparseable");
  });

  it("distinguishes an empty completion from a reasoning-only one", async () => {
    const empty = streamingProvider({
      stream: [{ kind: "stream", frames: [streamChunk({ content: "" })] }],
    });
    const reasoning = streamingProvider({
      stream: [
        {
          kind: "stream",
          frames: [streamChunk({ nullContent: true, reasoning: "thinking" })],
        },
      ],
    });

    expect(
      (await failureOf(() => empty.provider.complete(REQUEST))).contentPresence,
    ).toBe("empty-content");
    expect(
      (await failureOf(() => reasoning.provider.complete(REQUEST)))
        .contentPresence,
    ).toBe("reasoning-only");
  });

  it("classifies a refusal status exactly as the buffered path does", async () => {
    const { provider } = streamingProvider({
      stream: [
        {
          kind: "stream",
          status: 429,
          headers: { "retry-after": "7" },
          frames: [],
        },
      ],
    });

    const failure = await failureOf(() => provider.complete(REQUEST));
    expect(failure.failureKind).toBe("rate-limit");
    expect(failure.statusCode).toBe(429);
    expect(failure.retryAfterMs).toBe(7000);
    expect(failure.retryable).toBe(true);
  });

  it("classifies a connection failure before the headers", async () => {
    const { provider } = streamingProvider({
      stream: [
        {
          kind: "throw",
          error: new HttpTransportError("network", "socket refused"),
        },
      ],
    });

    expect((await failureOf(() => provider.complete(REQUEST))).failureKind).toBe(
      "network",
    );
  });

  it("returns no partial answer when the stream dies after delivering text", async () => {
    const { provider } = streamingProvider({
      stream: [
        {
          kind: "stream",
          frames: [streamChunk({ content: "half an ans" })],
          failAfter: 1,
          error: new HttpTransportError("network", "terminated"),
        },
      ],
    });

    // The honest outcome: a truncated completion is indistinguishable downstream from
    // a finished one, so it is reported as a failure rather than passed off as an answer.
    const failure = await failureOf(() => provider.complete(REQUEST));
    expect(failure.failureKind).toBe("network");
    expect(failure.retryable).toBe(true);
  });

  it("classifies an aborted stream as a timeout", async () => {
    const { provider } = streamingProvider({
      stream: [
        {
          kind: "stream",
          frames: [],
          failAfter: 0,
          error: new HttpTransportError("timeout", "deadline reached"),
        },
      ],
    });

    expect((await failureOf(() => provider.complete(REQUEST))).failureKind).toBe(
      "timeout",
    );
  });

  it("does not assume an untranslated stream error is retryable", async () => {
    const { provider } = streamingProvider({
      stream: [
        { kind: "stream", frames: [], failAfter: 0, error: new TypeError("boom") },
      ],
    });

    const failure = await failureOf(() => provider.complete(REQUEST));
    expect(failure.failureKind).toBe("unknown");
    expect(failure.retryable).toBe(false);
  });

  it("keeps the credential out of a streaming failure", async () => {
    const { provider } = streamingProvider({
      stream: [
        { kind: "stream", frames: [], failAfter: 0, error: new TypeError("boom") },
      ],
    });

    const failure = await failureOf(() => provider.complete(REQUEST));
    const serialised = `${failure.message} ${JSON.stringify(failure.details)}`;
    expect(serialised).not.toContain(FIXTURE_KEY);
    expect(serialised).not.toContain("Bearer");
  });
});

describe("openai-compatible provider: streaming mode selection", () => {
  it("does not stream when the provider is not configured to", async () => {
    const transport = createFakeStreamingTransport({
      buffered: [jsonResponse(chatCompletionBody())],
      stream: [{ kind: "stream", frames: [streamChunk({ content: "nope" })] }],
    });
    const provider = createOpenAiCompatibleProvider({
      baseUrl: BASE_URL,
      modelId: "fixture-model",
      credentialEnvVar: "FIXTURE_API_KEY",
      environment: createFixedEnvironment({ FIXTURE_API_KEY: FIXTURE_KEY }),
      transport,
      clock: createTickingClock(),
    });

    const response = await provider.complete(REQUEST);
    expect(response.content).toBe("ok");
    expect(transport.streamRequests).toHaveLength(0);
    const body = JSON.parse(String(transport.requests[0]?.body)) as Record<
      string,
      unknown
    >;
    expect(body["stream"]).toBeUndefined();
  });

  it("falls back to the buffered path when the transport cannot stream", async () => {
    // `createFakeTransport` has no `sendStream`, which is the situation of every
    // transport stacked behind a decorator that did not forward the capability.
    const transport = createFakeTransport([jsonResponse(chatCompletionBody())]);
    const provider = createOpenAiCompatibleProvider({
      baseUrl: BASE_URL,
      modelId: "fixture-model",
      credentialEnvVar: "FIXTURE_API_KEY",
      environment: createFixedEnvironment({ FIXTURE_API_KEY: FIXTURE_KEY }),
      transport,
      clock: createTickingClock(),
      streaming: true,
    });

    // A capability downgrade, not a failure: the call still happens, with the same
    // timeout, egress guard and failure taxonomy.
    const response = await provider.complete(REQUEST);
    expect(response.content).toBe("ok");
    expect(transport.requests).toHaveLength(1);
  });
});
