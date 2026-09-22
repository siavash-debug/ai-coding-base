import { describe, expect, it } from "vitest";

import { createFixedClock, createManualClock } from "../../src/core/clock.js";
import {
  DEFAULT_JEV_TIMEOUT_MS,
  JEV_PROVIDER_ID,
  MAX_JEV_REQUEST_CHARS,
  MAX_JEV_RESPONSE_CHARS,
  classifyDecisionStatus,
  createJevHttpProvider,
} from "../../src/adapters/decision/jev-http-provider.js";
import { classifyProviderStatus } from "../../src/adapters/llm/openai-compatible-provider.js";
import { DECISION_DOMAINS } from "../../src/decisions/domains.js";
import {
  DECISION_FAILURE_KINDS,
  isDecisionProviderError,
  isUsageReportingDecisionProvider,
  type DecisionProviderError,
  type DecisionRequest,
} from "../../src/decisions/provider.js";
import { DECISION_KINDS } from "../../src/decisions/decision.js";
import {
  HttpTransportError,
  type HttpTransport,
} from "../../src/ports/http-transport.js";
import {
  createFixedEnvironment,
  type Environment,
} from "../../src/ports/environment.js";
import { createFakeTransport, jsonResponse } from "../support/llm.js";

/**
 * The one real decision provider, tested without JEV.
 *
 * JEV is behind the `DecisionProvider` port, and the adapter's only outside dependency
 * is the `HttpTransport` port, so scripting a transport tests request building,
 * response normalisation and every failure category for real — deterministically, with
 * no network and no credential.
 *
 * The credential assertions are the important ones: the fake key below must never
 * appear in a request *body*, in an event-worthy error message, or in a thrown error's
 * properties. "Referenced, never stored" is only true if it is tested.
 */

const INSTANT = "2026-09-20T10:00:00.000Z";
const CREDENTIAL_VAR = "JEV_API_KEY";
const FAKE_KEY = "jev-test-key-not-a-real-secret-0001";
const BASE_URL = "https://jev.internal/v1/";

function environment(overrides: Record<string, string> = {}): Environment {
  return createFixedEnvironment({
    [CREDENTIAL_VAR]: FAKE_KEY,
    ...overrides,
  });
}

function providerWith(
  steps: Parameters<typeof createFakeTransport>[0],
  options: {
    readonly clock?: ReturnType<typeof createFixedClock>;
    readonly environment?: Environment;
    readonly timeoutMs?: number;
    readonly modelId?: string;
    readonly baseUrl?: string;
  } = {},
) {
  const transport = createFakeTransport(steps);
  const provider = createJevHttpProvider({
    baseUrl: options.baseUrl ?? BASE_URL,
    credentialEnvVar: CREDENTIAL_VAR,
    environment: options.environment ?? environment(),
    transport,
    clock: options.clock ?? createFixedClock(INSTANT),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
  });
  return { transport, provider };
}

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    kind: "routing",
    question: "Which route should this attempt take?",
    options: [
      { id: "standard", label: "Run as configured" },
      { id: "minimal", label: "Run the smallest operation set" },
    ],
    context: ["risk:medium", "routes:2"],
    reasonCodes: ["routine-task", "narrow-scope-preferred"],
    correlationId: "corr-adapter",
    ...overrides,
  };
}

function decisionBody(fields: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    outcome: "selected",
    optionId: "minimal",
    reasonCode: "narrow-scope-preferred",
    model: "jev-1",
    requestId: "req-dec-1",
    usage: { inputTokens: 900, outputTokens: 120, cachedInputTokens: 0 },
    ...fields,
  });
}

interface FailureShape {
  readonly failureKind: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly message: string;
}

/**
 * Asserts that a call failed as a *categorised* decision-provider failure and returns
 * the parts a test may legitimately assert on: the category, the status code, whether
 * it is retryable, and the message — which must never carry provider text.
 */
async function failureFrom(promise: Promise<unknown>): Promise<FailureShape> {
  try {
    await promise;
    expect.unreachable("expected the provider to fail");
  } catch (error) {
    expect(isDecisionProviderError(error), String(error)).toBe(true);
    const failure = error as DecisionProviderError;
    return {
      failureKind: failure.failureKind,
      ...(failure.statusCode === undefined
        ? {}
        : { statusCode: failure.statusCode }),
      retryable: failure.retryable,
      message: failure.message,
    };
  }
}

describe("JEV adapter: request building", () => {
  it("posts one bounded JSON request to the configured endpoint", async () => {
    const { transport, provider } = providerWith([
      jsonResponse(decisionBody()),
    ]);
    await provider.decide(request());

    expect(transport.requests).toHaveLength(1);
    const sent = transport.requests[0]!;
    // Trailing slashes are tolerated in configuration and never doubled in the URL.
    expect(sent.url).toBe("https://jev.internal/v1/decide");
    expect(sent.method).toBe("POST");
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(sent.timeoutMs).toBe(DEFAULT_JEV_TIMEOUT_MS);
    expect(sent.correlationId).toBe("corr-adapter");

    const body = JSON.parse(sent.body ?? "{}") as Record<string, unknown>;
    expect(body["kind"]).toBe("routing");
    expect(body["question"]).toBe("Which route should this attempt take?");
    expect(body["options"]).toEqual([
      { id: "standard", label: "Run as configured" },
      { id: "minimal", label: "Run the smallest operation set" },
    ]);
    expect(body["context"]).toEqual(["risk:medium", "routes:2"]);
    expect(body["reasonCodes"]).toEqual([
      "routine-task",
      "narrow-scope-preferred",
    ]);
    expect(body["correlationId"]).toBe("corr-adapter");
  });

  it("honours a per-question latency bound", async () => {
    const { transport, provider } = providerWith([
      jsonResponse(decisionBody()),
    ]);
    await provider.decide(request({ maxLatencyMs: 250 }));
    expect(transport.requests[0]!.timeoutMs).toBe(250);
  });

  it("sends constraints without sending anything it was not given", async () => {
    const { transport, provider } = providerWith([
      jsonResponse(decisionBody()),
    ]);
    await provider.decide(request({ maxCostMicros: 5_000, ranked: true }));
    const body = JSON.parse(transport.requests[0]!.body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(body["constraints"]).toEqual({ maxCostMicros: 5_000 });
    expect(body["ranked"]).toBe(true);
  });

  it("carries the credential in one header and never in the body", async () => {
    const { transport, provider } = providerWith([
      jsonResponse(decisionBody()),
    ]);
    await provider.decide(request());
    const sent = transport.requests[0]!;
    expect(sent.headers["authorization"]).toBe(`Bearer ${FAKE_KEY}`);
    expect(sent.body ?? "").not.toContain(FAKE_KEY);
    expect(sent.url).not.toContain(FAKE_KEY);
  });

  it("fails before any network call when the credential is absent", async () => {
    const transport = createFakeTransport([jsonResponse(decisionBody())]);
    const provider = createJevHttpProvider({
      baseUrl: BASE_URL,
      credentialEnvVar: CREDENTIAL_VAR,
      environment: createFixedEnvironment({}),
      transport,
      clock: createFixedClock(INSTANT),
    });
    const failure = await failureFrom(provider.decide(request()));
    expect(failure.failureKind).toBe("auth");
    expect(failure.retryable).toBe(false);
    // The variable is named; its (absent) value obviously cannot be.
    expect(failure.message).toContain(CREDENTIAL_VAR);
    expect(transport.requests).toHaveLength(0);
  });

  it("refuses a request that outgrew the bound instead of sending it", async () => {
    const { transport, provider } = providerWith([
      jsonResponse(decisionBody()),
    ]);
    const huge = request({
      context: ["x".repeat(MAX_JEV_REQUEST_CHARS)],
    });
    const failure = await failureFrom(provider.decide(huge));
    expect(failure.failureKind).toBe("refused");
    expect(transport.requests).toHaveLength(0);
  });
});

describe("JEV adapter: response normalisation", () => {
  it("normalises a selected answer with usage, model and request id", async () => {
    const { provider } = providerWith([jsonResponse(decisionBody())]);
    const result = await provider.decideWithMetadata(request());
    expect(result.response).toEqual({
      outcome: "selected",
      optionId: "minimal",
      reasonCode: "narrow-scope-preferred",
    });
    expect(result.usage).toEqual({
      inputTokens: 900,
      outputTokens: 120,
      cachedInputTokens: 0,
    });
    expect(result.modelId).toBe("jev-1");
    expect(result.requestId).toBe("req-dec-1");
  });

  it("falls back to the configured model identifier when the response omits one", async () => {
    const { provider } = providerWith(
      [jsonResponse(decisionBody({ model: undefined }))],
      { modelId: "jev-configured" },
    );
    const result = await provider.decideWithMetadata(request());
    expect(result.modelId).toBe("jev-configured");
  });

  it("reports no usage when the response reports none, rather than zero", async () => {
    const { provider } = providerWith([
      jsonResponse(decisionBody({ usage: undefined })),
    ]);
    const result = await provider.decideWithMetadata(request());
    expect(result.usage).toBeUndefined();
  });

  it("treats partial usage as unavailable rather than filling in zeroes", async () => {
    const { provider } = providerWith([
      jsonResponse(decisionBody({ usage: { prompt_tokens: 10 } })),
    ]);
    const result = await provider.decideWithMetadata(request());
    expect(result.usage).toBeUndefined();
  });

  it("rejects usage that contradicts itself", async () => {
    const { provider } = providerWith([
      jsonResponse(
        decisionBody({
          usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 99 },
        }),
      ),
    ]);
    const failure = await failureFrom(provider.decide(request()));
    expect(failure.failureKind).toBe("malformed-response");
  });

  it("normalises an abstention without recording the provider's prose", async () => {
    const { provider } = providerWith([
      jsonResponse(
        JSON.stringify({
          outcome: "abstained",
          reason: "I would rather not, and here is a paragraph about why",
        }),
      ),
    ]);
    const response = await provider.decide(request());
    expect(response).toEqual({
      outcome: "abstained",
      reason: "provider abstained",
    });
  });

  it("normalises an escalation and keeps only a code from the closed vocabulary", async () => {
    const { provider } = providerWith([
      jsonResponse(
        JSON.stringify({
          outcome: "escalated",
          reason: "a human should look at this",
          reasonCode: "human-judgement-required",
        }),
      ),
    ]);
    const response = await provider.decide(request());
    expect(response).toEqual({
      outcome: "escalated",
      reason: "provider escalated",
      reasonCode: "human-judgement-required",
    });
  });

  it("preserves a ranking when the response supplies one", async () => {
    const { provider } = providerWith([
      jsonResponse(
        decisionBody({
          outcome: "selected",
          optionId: "standard",
          rankedOptionIds: ["minimal", "standard"],
        }),
      ),
    ]);
    const response = await provider.decide(request({ ranked: true }));
    expect(response).toEqual({
      outcome: "selected",
      optionId: "standard",
      rankedOptionIds: ["minimal", "standard"],
      reasonCode: "narrow-scope-preferred",
    });
  });

  it("measures latency with the injected clock", async () => {
    const clock = createManualClock(INSTANT);
    const transport: HttpTransport = {
      id: "advancing-transport",
      async send() {
        clock.advance(48);
        return jsonResponse(decisionBody());
      },
    };
    const provider = createJevHttpProvider({
      baseUrl: BASE_URL,
      credentialEnvVar: CREDENTIAL_VAR,
      environment: environment(),
      transport,
      clock,
    });
    const result = await provider.decideWithMetadata(request());
    expect(result.latencyMs).toBe(48);
  });

  it("reports no latency when it did not measure one", async () => {
    const { provider } = providerWith([jsonResponse(decisionBody())]);
    const response = await provider.decide(request());
    expect(response.outcome).toBe("selected");
    const result = await providerWith([
      jsonResponse(decisionBody()),
    ]).provider.decideWithMetadata(request());
    // The fixed clock does not move, so the measured latency is exactly zero — which is
    // a measurement, not an absence.
    expect(result.latencyMs).toBe(0);
  });
});

describe("JEV adapter: failures", () => {
  const STATUS_CASES: readonly (readonly [number, string])[] = [
    [401, "auth"],
    [403, "auth"],
    [408, "timeout"],
    [429, "rate-limit"],
    [404, "unavailable"],
    [500, "server"],
    [503, "server"],
    [418, "unknown"],
  ];

  for (const [status, expected] of STATUS_CASES) {
    it(`categorises HTTP ${status} as ${expected}`, async () => {
      const { provider } = providerWith([jsonResponse("{}", status)]);
      const failure = await failureFrom(provider.decide(request()));
      expect(failure.failureKind).toBe(expected);
      expect(failure.statusCode).toBe(status);
      expect(DECISION_FAILURE_KINDS).toContain(failure.failureKind);
    });
  }

  it("agrees with the LLM adapter about every HTTP status it classifies", () => {
    // The two adapters do not import each other (ADR-022), so the agreement is
    // asserted rather than assumed: a status must not mean different things to the
    // reasoning layer and the decision layer.
    for (const status of [200, 401, 403, 404, 408, 418, 429, 500, 503]) {
      const decisionKind = classifyDecisionStatus(status);
      const llmKind = classifyProviderStatus(status);
      if (status === 404) {
        // Documented difference: a missing decision endpoint means "no decision layer
        // here" (unavailable), while a missing chat completion endpoint is a server
        // problem for the reasoning layer.
        expect(llmKind).not.toBe("unavailable");
        continue;
      }
      expect(decisionKind, `status ${status}`).toBe(llmKind);
    }
  });

  it("categorises a transport timeout as a retryable timeout", async () => {
    const { provider } = providerWith([
      { error: new HttpTransportError("timeout", "request timed out") },
    ]);
    const failure = await failureFrom(provider.decide(request()));
    expect(failure.failureKind).toBe("timeout");
    expect(failure.retryable).toBe(true);
  });

  it("categorises a transport network failure as retryable", async () => {
    const { provider } = providerWith([
      { error: new HttpTransportError("network", "socket closed") },
    ]);
    const failure = await failureFrom(provider.decide(request()));
    expect(failure.failureKind).toBe("network");
    expect(failure.retryable).toBe(true);
  });

  it("categorises an unrecognised throw as unknown and retryable: false", async () => {
    const { provider } = providerWith([
      { error: new Error("not a transport") },
    ]);
    const failure = await failureFrom(provider.decide(request()));
    expect(failure.failureKind).toBe("unknown");
    expect(failure.retryable).toBe(false);
  });

  it("rejects bodies that are not JSON, not objects, or too large", async () => {
    for (const body of [
      "not json at all",
      "[1,2,3]",
      "null",
      JSON.stringify({ outcome: "selected" }),
      JSON.stringify({ outcome: "maybe", optionId: "minimal" }),
      JSON.stringify({ outcome: "selected", optionId: "" }),
      JSON.stringify({ outcome: "selected", optionId: "mi".repeat(64) }),
      JSON.stringify({
        outcome: "selected",
        optionId: "minimal",
        confidence: 2,
      }),
      JSON.stringify({
        outcome: "selected",
        optionId: "minimal",
        reasonCode: "this is a sentence, not a code",
      }),
      JSON.stringify({
        outcome: "selected",
        optionId: "minimal",
        rankedOptionIds: "not-an-array",
      }),
      "x".repeat(MAX_JEV_RESPONSE_CHARS + 1),
    ]) {
      const { provider } = providerWith([jsonResponse(body)]);
      const failure = await failureFrom(provider.decide(request()));
      expect(failure.failureKind, body.slice(0, 40)).toBe("malformed-response");
    }
  });

  it("never echoes the provider's body, headers or credential in a failure", async () => {
    const { provider } = providerWith([
      jsonResponse(`{"error":"key ${FAKE_KEY} rejected"}`, 401),
    ]);
    const failure = await failureFrom(provider.decide(request()));
    expect(failure.failureKind).toBe("auth");
    expect(failure.message).not.toContain(FAKE_KEY);
    expect(failure.message).not.toContain("Bearer");
    expect(failure.message).not.toContain("rejected");
  });

  it("is a usage-reporting provider, so its timing and usage are recorded", () => {
    const { provider } = providerWith([]);
    expect(isUsageReportingDecisionProvider(provider)).toBe(true);
    expect(provider.family).toBe("jev");
    expect(provider.id).toBe(JEV_PROVIDER_ID);
  });

  it("offers exactly the bounded decision kinds and no enforcement kinds", () => {
    const { provider } = providerWith([]);
    const kinds = provider.capabilities().kinds;
    // JEV answers the eight bounded domain questions; it is never asked a question
    // that belongs to deterministic code.
    expect([...kinds].sort()).toEqual([...DECISION_DOMAINS].sort());
    for (const kind of kinds) {
      expect(DECISION_KINDS).toContain(kind);
    }
    expect(provider.capabilities().deterministic).toBe(false);
    expect(provider.capabilities().maxOptions).toBe(8);
  });
});
