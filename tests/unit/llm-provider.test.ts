import { describe, expect, it } from "vitest";

import {
  classifyFinishReason,
  classifyProviderStatus,
  createOpenAiCompatibleProvider,
  parseRetryAfterMs,
} from "../../src/adapters/llm/openai-compatible-provider.js";
import {
  backoffDelayMs,
  createRetryingProvider,
} from "../../src/adapters/llm/retrying-provider.js";
import { createFixedClock } from "../../src/core/clock.js";
import { hasDomainErrorCode } from "../../src/core/errors.js";
import { createFixedEnvironment } from "../../src/ports/environment.js";
import { HttpTransportError } from "../../src/ports/http-transport.js";
import { LlmProviderError } from "../../src/ports/llm-provider.js";
import { createImmediateSleep } from "../../src/ports/sleep.js";
import {
  chatCompletionBody,
  createFakeProvider,
  createFakeTransport,
  jsonResponse,
  providerFailure,
} from "../support/llm.js";
import { createTickingClock } from "../support/project.js";

/**
 * The real provider adapter, tested entirely offline.
 *
 * The adapter's only outside dependency is the `HttpTransport` port, so scripting
 * that transport tests request building, every response shape and every failure
 * category for real. The credential in these tests is obviously fake, and one test
 * asserts directly that it never appears in an error, a message or a detail object.
 */
const FIXTURE_KEY = "sk-test-fixture-abcdefghijklmnop";
const BASE_URL = "https://fixture.invalid/v1";

/**
 * Runs a call that is expected to fail and returns the categorised error.
 *
 * Written as an explicit two-branch settle rather than `.catch()` so a test that
 * *should* have failed cannot pass vacuously when nothing is thrown.
 */
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

function providerWith(steps: Parameters<typeof createFakeTransport>[0]) {
  const transport = createFakeTransport(steps);
  const provider = createOpenAiCompatibleProvider({
    baseUrl: BASE_URL,
    modelId: "fixture-model",
    credentialEnvVar: "FIXTURE_API_KEY",
    environment: createFixedEnvironment({ FIXTURE_API_KEY: FIXTURE_KEY }),
    transport,
    clock: createTickingClock(),
  });
  return { transport, provider };
}

const REQUEST = {
  modelId: "fixture-model",
  messages: [
    { role: "system" as const, content: "be brief" },
    { role: "user" as const, content: "summarise the task" },
  ],
  correlationId: "corr-1",
};

describe("openai-compatible provider: request building", () => {
  it("posts a chat completion with the configured model and credential header", async () => {
    const { transport, provider } = providerWith([
      jsonResponse(chatCompletionBody()),
    ]);
    await provider.complete(REQUEST);

    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0];
    expect(request.url).toBe(`${BASE_URL}/chat/completions`);
    expect(request.method).toBe("POST");
    // The credential must reach the provider; it is the *reporting* path that must
    // never contain it.
    expect(request.headers["authorization"]).toBe(`Bearer ${FIXTURE_KEY}`);
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("fixture-model");
    expect(body["messages"]).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "summarise the task" },
    ]);
    expect(request.correlationId).toBe("corr-1");
  });

  it("tolerates a trailing slash on the base URL and passes optional knobs through", async () => {
    const transport = createFakeTransport([jsonResponse(chatCompletionBody())]);
    const provider = createOpenAiCompatibleProvider({
      baseUrl: `${BASE_URL}/`,
      modelId: "fixture-model",
      credentialEnvVar: "FIXTURE_API_KEY",
      environment: createFixedEnvironment({ FIXTURE_API_KEY: FIXTURE_KEY }),
      transport,
      clock: createFixedClock("2026-09-20T10:00:00.000Z"),
      timeoutMs: 1234,
    });
    await provider.complete({
      ...REQUEST,
      maxOutputTokens: 256,
      temperature: 0,
      stopSequences: ["###"],
    });

    expect(transport.requests[0].url).toBe(`${BASE_URL}/chat/completions`);
    expect(transport.requests[0].timeoutMs).toBe(1234);
    const body = JSON.parse(String(transport.requests[0].body)) as Record<
      string,
      unknown
    >;
    expect(body["max_tokens"]).toBe(256);
    expect(body["temperature"]).toBe(0);
    expect(body["stop"]).toEqual(["###"]);
  });

  it("rejects an empty message list before any request is sent", async () => {
    const { transport, provider } = providerWith([
      jsonResponse(chatCompletionBody()),
    ]);
    await expect(
      provider.complete({ ...REQUEST, messages: [] }),
    ).rejects.toSatisfy((error: unknown) =>
      hasDomainErrorCode(error, "VALIDATION"),
    );
    expect(transport.requests).toHaveLength(0);
  });

  it("fails with auth and sends nothing when the credential variable is unset", async () => {
    const transport = createFakeTransport([jsonResponse(chatCompletionBody())]);
    const provider = createOpenAiCompatibleProvider({
      baseUrl: BASE_URL,
      modelId: "fixture-model",
      credentialEnvVar: "MISSING_API_KEY",
      environment: createFixedEnvironment({}),
      transport,
      clock: createFixedClock("2026-09-20T10:00:00.000Z"),
    });

    const error = await failureOf(() => provider.complete(REQUEST));
    expect(error.failureKind).toBe("auth");
    expect(error.retryable).toBe(false);
    expect(transport.requests).toHaveLength(0);
    // The operator is told which variable is missing, and nothing about its value.
    expect(error.message).toContain("MISSING_API_KEY");
    expect(error.details["credential"]).toBeUndefined();
  });
});

describe("openai-compatible provider: response normalisation", () => {
  it("normalises usage, cached tokens, request id, finish reason and latency", async () => {
    const { provider } = providerWith([
      jsonResponse(
        chatCompletionBody({
          promptTokens: 1200,
          completionTokens: 300,
          cachedTokens: 512,
          requestId: "req-abc",
          model: "fixture-model-2026",
          finishReason: "length",
        }),
      ),
    ]);
    const response = await provider.complete(REQUEST);

    expect(response.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      cachedInputTokens: 512,
    });
    expect(response.requestId).toBe("req-abc");
    expect(response.modelId).toBe("fixture-model-2026");
    expect(response.finishReason).toBe("length");
    expect(response.latencyMs).toBe(250);
    expect(response.attempts).toBe(1);
  });

  it("reports absent usage as unavailable, never as zero", async () => {
    const { provider } = providerWith([
      jsonResponse(chatCompletionBody({ omitUsage: true })),
    ]);
    const response = await provider.complete(REQUEST);
    expect(response.usage).toBeUndefined();
    expect(response.content).toBe("ok");
  });

  it("treats a partial usage object as unavailable rather than as zeroes", async () => {
    const { provider } = providerWith([
      jsonResponse(chatCompletionBody({ partialUsage: true })),
    ]);
    const response = await provider.complete(REQUEST);
    expect(response.usage).toBeUndefined();
  });

  it("classifies a self-contradictory usage report as a malformed response", async () => {
    const { provider } = providerWith([
      jsonResponse(
        chatCompletionBody({ promptTokens: 100, cachedTokens: 500 }),
      ),
    ]);
    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      failureKind: "malformed-response",
      retryable: false,
    });
  });

  it("rejects a response body that is not JSON, without echoing it", async () => {
    const { provider } = providerWith([jsonResponse("<html>gateway</html>")]);
    const error = await failureOf(() => provider.complete(REQUEST));
    expect(error.failureKind).toBe("malformed-response");
    expect(error.message).not.toContain("html");
    expect(error.details["body"]).toBeUndefined();
  });

  it("rejects a JSON response with no choices", async () => {
    const { provider } = providerWith([
      jsonResponse(JSON.stringify({ id: "x" })),
    ]);
    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      failureKind: "malformed-response",
    });
  });
});

/**
 * The distinction a live free-tier run made concrete: a successful *request* is not a
 * usable *completion*.
 *
 * These are regression tests, and they assert the strict behaviour on purpose — the
 * adapter must keep refusing a response that carries no answer text, so that a 200
 * whose content was consumed by the model's reasoning is reported as a failed step
 * rather than handed upward as an answer. Relaxing this to make a free model "pass"
 * would turn a visible dead end into a silent one.
 */
describe("openai-compatible provider: content-less responses", () => {
  it("classifies HTTP 200 with null content as a malformed response", async () => {
    const { provider } = providerWith([
      jsonResponse(
        chatCompletionBody({
          nullContent: true,
          finishReason: "length",
          reasoning: "private chain of thought that is not an answer",
          reasoningTokens: 96,
        }),
      ),
    ]);
    const error = await failureOf(() => provider.complete(REQUEST));
    expect(error.failureKind).toBe("malformed-response");
    // A status code is carried for an operator; the body and the reasoning are not.
    expect(error.details["statusCode"]).toBe(200);
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain("chain of thought");
    expect(error.details["body"]).toBeUndefined();
    expect(error.details["reasoning"]).toBeUndefined();
  });

  it("uses answer text when a response carries reasoning alongside it", async () => {
    const { provider } = providerWith([
      jsonResponse(
        chatCompletionBody({
          content: "the answer",
          reasoning: "private chain of thought",
          reasoningTokens: 12,
        }),
      ),
    ]);
    const response = await provider.complete(REQUEST);
    expect(response.content).toBe("the answer");
    // Reasoning tokens are counted for accounting and still never surface as content.
    expect(response.usage?.reasoningTokens).toBe(12);
  });
});

describe("openai-compatible provider: failure categorisation", () => {
  it("maps status codes to categories", () => {
    expect(classifyProviderStatus(401)).toBe("auth");
    expect(classifyProviderStatus(403)).toBe("auth");
    expect(classifyProviderStatus(408)).toBe("timeout");
    expect(classifyProviderStatus(429)).toBe("rate-limit");
    expect(classifyProviderStatus(503)).toBe("server");
    expect(classifyProviderStatus(400)).toBe("unknown");
  });

  it("maps finish reasons, and does not invent one it does not know", () => {
    expect(classifyFinishReason("stop")).toBe("stop");
    expect(classifyFinishReason("length")).toBe("length");
    expect(classifyFinishReason("tool_calls")).toBe("tool-call");
    expect(classifyFinishReason("content_filter")).toBe("content-filter");
    expect(classifyFinishReason("something_new")).toBe("error");
  });

  it("reads retry-after in seconds and as an HTTP date", () => {
    const now = Date.parse("2026-09-20T10:00:00.000Z");
    expect(parseRetryAfterMs({ "retry-after": "5" }, now)).toBe(5000);
    expect(
      parseRetryAfterMs(
        { "retry-after": "Sun, 20 Sep 2026 10:00:07 GMT" },
        now,
      ),
    ).toBe(7000);
    expect(parseRetryAfterMs({}, now)).toBeUndefined();
  });

  it("categorises a rate limit, keeping the status and the provider's delay", async () => {
    const { provider } = providerWith([
      jsonResponse(JSON.stringify({ error: { message: "slow down" } }), 429, {
        "retry-after": "2",
      }),
    ]);
    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      failureKind: "rate-limit",
      retryable: true,
      statusCode: 429,
      retryAfterMs: 2000,
    });
  });

  it("classifies transport timeouts and socket failures as retryable categories", async () => {
    for (const [kind, expected] of [
      ["timeout", "timeout"],
      ["network", "network"],
    ] as const) {
      const { provider } = providerWith([
        { error: new HttpTransportError(kind, `scripted ${kind}`) },
      ]);
      await expect(provider.complete(REQUEST)).rejects.toMatchObject({
        failureKind: expected,
        retryable: true,
      });
    }
  });

  it("does not treat an unknown transport error as retryable", async () => {
    const { provider } = providerWith([{ error: new Error("boom") }]);
    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      failureKind: "unknown",
      retryable: false,
    });
  });

  it("never puts the credential or an authorization header into a failure", async () => {
    for (const status of [401, 429, 500]) {
      const { provider } = providerWith([
        jsonResponse(`unauthorized: bearer ${FIXTURE_KEY}`, status, {
          authorization: `Bearer ${FIXTURE_KEY}`,
        }),
      ]);
      const error = await failureOf(() => provider.complete(REQUEST));
      const serialized = `${error.message} ${JSON.stringify(error.details)}`;
      expect(serialized).not.toContain(FIXTURE_KEY);
      expect(serialized.toLowerCase()).not.toContain("bearer");
      expect(serialized).not.toContain("unauthorized");
    }
  });
});

describe("retrying provider", () => {
  it("retries a retryable failure up to the attempt cap, then reports the count", async () => {
    const inner = createFakeProvider([
      {
        error: providerFailure({ failureKind: "rate-limit", retryable: true }),
      },
      {
        error: providerFailure({ failureKind: "rate-limit", retryable: true }),
      },
      {
        error: providerFailure({ failureKind: "rate-limit", retryable: true }),
      },
    ]);
    const sleep = createImmediateSleep();
    const provider = createRetryingProvider({
      provider: inner,
      sleep,
      maxAttempts: 3,
      baseDelayMs: 100,
    });

    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      failureKind: "rate-limit",
      attempts: 3,
    });
    expect(inner.requests).toHaveLength(3);
  });

  it("records exponential backoff and honours a provider-requested delay within the cap", async () => {
    const delays: number[] = [];
    const inner = createFakeProvider([
      { error: providerFailure({ failureKind: "server", retryable: true }) },
      {
        error: providerFailure({
          failureKind: "rate-limit",
          retryable: true,
          retryAfterMs: 60_000,
        }),
      },
      { attempts: 1 },
    ]);
    const provider = createRetryingProvider({
      provider: inner,
      sleep: {
        id: "recording",
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 2_000,
    });

    const response = await provider.complete(REQUEST);
    // 100ms exponential, then the requested 60s clamped to the 2s cap.
    expect(delays).toEqual([100, 2_000]);
    expect(response.attempts).toBe(3);
  });

  it("does not retry a non-retryable category", async () => {
    const inner = createFakeProvider([
      { error: providerFailure({ failureKind: "auth" }) },
    ]);
    const provider = createRetryingProvider({
      provider: inner,
      sleep: createImmediateSleep(),
      maxAttempts: 5,
    });
    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      failureKind: "auth",
      attempts: 1,
    });
    expect(inner.requests).toHaveLength(1);
  });

  it("propagates a non-provider error untouched instead of retrying it", async () => {
    let calls = 0;
    const provider = createRetryingProvider({
      provider: {
        id: "exploding",
        models: ["m"],
        complete: async () => {
          calls += 1;
          throw new RangeError("programming error");
        },
      },
      sleep: createImmediateSleep(),
      maxAttempts: 4,
    });
    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(RangeError);
    expect(calls).toBe(1);
  });

  it("computes capped exponential backoff", () => {
    expect(
      backoffDelayMs({ attempt: 1, baseDelayMs: 100, maxDelayMs: 5_000 }),
    ).toBe(100);
    expect(
      backoffDelayMs({ attempt: 3, baseDelayMs: 100, maxDelayMs: 5_000 }),
    ).toBe(400);
    expect(
      backoffDelayMs({ attempt: 8, baseDelayMs: 100, maxDelayMs: 5_000 }),
    ).toBe(5_000);
    expect(
      backoffDelayMs({
        attempt: 1,
        baseDelayMs: 100,
        maxDelayMs: 5_000,
        retryAfterMs: 1_000,
      }),
    ).toBe(1_000);
  });
});
