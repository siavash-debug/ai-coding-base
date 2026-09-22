import { describe, expect, it } from "vitest";

import { NetworkBoundaryError } from "../../src/adapters/sandbox/guarded-network.js";
import {
  DEFAULT_TYPESAFE_BASE_URL,
  createTypeSafeProvider,
} from "../../src/adapters/decision/typesafe-provider.js";
import { createFixedClock } from "../../src/core/clock.js";
import { HttpTransportError } from "../../src/ports/http-transport.js";
import type { Environment } from "../../src/ports/environment.js";
import type { DecisionRequest } from "../../src/decisions/provider.js";
import {
  DecisionProviderError,
  isDecisionProviderError,
} from "../../src/decisions/provider.js";
import { createFakeTransport, jsonResponse } from "../support/llm.js";

/**
 * The TypeSafe adapter, driven against a scripted transport.
 *
 * The SDK's only outside dependency is the `fetch` it is handed, and this adapter
 * hands it a bridge onto the platform's `HttpTransport`. So scripting the transport
 * exercises the real SDK — request building, response parsing, error classes — with no
 * network and no credential, exactly as the Phase D adapter tests do for Chat
 * Completions.
 */

const CLOCK = createFixedClock("2026-09-20T10:00:00.000Z");
const FAKE_KEY = "typesafe-fixture-key-000000000000000000";

function environmentWith(
  values: Readonly<Record<string, string>>,
): Environment {
  return {
    id: "test-environment",
    get: (name) => values[name],
  };
}

function systemOneBody(input: {
  readonly answers: Readonly<Record<string, unknown>>;
  readonly usage?: unknown;
}): string {
  return JSON.stringify({
    model: "jev-latest",
    answers: input.answers,
    usage:
      input.usage === undefined
        ? { input_tokens: 120, output_tokens: 8 }
        : input.usage,
  });
}

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    kind: "ranking",
    question: "Which model should run this step?",
    ranked: true,
    options: [
      { id: "vendor/a", label: "Model A" },
      { id: "vendor/b", label: "Model B" },
    ],
    context: ["risk:low"],
    reasonCodes: ["ordered-by-cost", "ordered-by-safety"],
    correlationId: "task:corr-1",
    ...overrides,
  };
}

function provider(
  steps: Parameters<typeof createFakeTransport>[0],
  options: {
    readonly credentialEnvVar?: string;
    readonly environment?: Environment;
    readonly baseUrl?: string;
    readonly defaultModel?: string;
  } = {},
) {
  const transport = createFakeTransport(steps);
  return {
    transport,
    provider: createTypeSafeProvider({
      environment:
        options.environment ?? environmentWith({ TYPESAFE_API_KEY: FAKE_KEY }),
      transport,
      clock: CLOCK,
      ...(options.credentialEnvVar === undefined
        ? {}
        : { credentialEnvVar: options.credentialEnvVar }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.defaultModel === undefined
        ? {}
        : { defaultModel: options.defaultModel }),
    }),
  };
}

async function failureOf(
  run: () => Promise<unknown>,
): Promise<DecisionProviderError> {
  try {
    await run();
    throw new Error("expected the provider to fail");
  } catch (error) {
    if (isDecisionProviderError(error)) {
      return error;
    }
    throw error;
  }
}

describe("the TypeSafe adapter as a decision provider", () => {
  it("sends one bounded request through the injected transport", async () => {
    const { provider: subject, transport } = provider([
      jsonResponse(
        systemOneBody({
          answers: {
            rank_0: {
              type: "score",
              score: 3.2,
              confidence: 0.7,
              legend: {},
              probabilities: {},
            },
            rank_1: {
              type: "score",
              score: 1.1,
              confidence: 0.6,
              legend: {},
              probabilities: {},
            },
            reason: {
              type: "choice",
              choice: "ordered-by-cost",
              confidence: 0.8,
              probabilities: {},
            },
          },
        }),
        200,
        { "x-typesafe-request-id": "req-9" },
      ),
    ]);

    const result = await subject.decideWithMetadata(request());

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.method).toBe("POST");
    expect(transport.requests[0]?.url).toBe(
      `${DEFAULT_TYPESAFE_BASE_URL}/v1/systemone`,
    );
    // The credential is carried in the header and nowhere else.
    expect(transport.requests[0]?.headers["authorization"]).toBe(
      `Bearer ${FAKE_KEY}`,
    );
    expect(result.requestId).toBe("req-9");
    expect(result.modelId).toBe("jev-latest");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("orders a ranked answer by score and keeps the caller's order on a tie", async () => {
    const { provider: subject } = provider([
      jsonResponse(
        systemOneBody({
          answers: {
            rank_0: { type: "score", score: 1.5 },
            rank_1: { type: "score", score: 3.9 },
          },
        }),
      ),
    ]);
    const result = await subject.decideWithMetadata(request());
    expect(result.response.outcome).toBe("selected");
    expect(
      result.response.outcome === "selected" && result.response.rankedOptionIds,
    ).toEqual(["vendor/b", "vendor/a"]);

    const tied = provider([
      jsonResponse(
        systemOneBody({
          answers: {
            rank_0: { type: "score", score: 2 },
            rank_1: { type: "score", score: 2 },
          },
        }),
      ),
    ]);
    const tiedResult = await tied.provider.decideWithMetadata(request());
    expect(
      tiedResult.response.outcome === "selected" &&
        tiedResult.response.rankedOptionIds,
    ).toEqual(["vendor/a", "vendor/b"]);
  });

  it("maps a choice answer back to the candidate id it was offered", async () => {
    const { provider: subject } = provider([
      jsonResponse(
        systemOneBody({
          answers: {
            decision: { type: "choice", choice: "vendor/b", confidence: 0.66 },
            reason: { type: "choice", choice: "ordered-by-safety" },
          },
        }),
      ),
    ]);
    const result = await subject.decideWithMetadata(
      request({
        ranked: false,
        options: [
          { id: "vendor/a", label: "Model A" },
          { id: "vendor/b", label: "Model B" },
        ],
      }),
    );
    expect(result.response).toMatchObject({
      outcome: "selected",
      optionId: "vendor/b",
      reasonCode: "ordered-by-safety",
      confidence: 0.66,
    });
  });

  it("drops a reason code that was not offered, and keeps the decision", async () => {
    const { provider: subject } = provider([
      jsonResponse(
        systemOneBody({
          answers: {
            decision: { type: "choice", choice: "vendor/a", confidence: 0.5 },
            reason: { type: "choice", choice: "not-a-real-code" },
          },
        }),
      ),
    ]);
    const result = await subject.decideWithMetadata(request({ ranked: false }));
    expect(result.response).toMatchObject({
      outcome: "selected",
      optionId: "vendor/a",
    });
    expect(
      result.response.outcome === "selected" ? result.response.reasonCode : "x",
    ).toBeUndefined();
  });

  it("reports usage as reported, and cached tokens as the zero it was told", async () => {
    const { provider: subject } = provider([
      jsonResponse(
        systemOneBody({
          answers: {
            rank_0: { type: "score", score: 2 },
            rank_1: { type: "score", score: 1 },
          },
          usage: { input_tokens: 900, output_tokens: 40 },
        }),
      ),
    ]);
    const result = await subject.decideWithMetadata(request());
    expect(result.usage).toEqual({
      inputTokens: 900,
      outputTokens: 40,
      cachedInputTokens: 0,
    });
  });

  it("reports missing usage as unavailable rather than as zero", async () => {
    const { provider: subject } = provider([
      jsonResponse(
        systemOneBody({
          answers: {
            rank_0: { type: "score", score: 1 },
            rank_1: { type: "score", score: 1 },
          },
          usage: null,
        }),
      ),
    ]);
    const result = await subject.decideWithMetadata(request());
    expect(result.usage).toBeUndefined();
    expect(result.response.outcome).toBe("selected");
  });

  it("declares the same bounded decision kinds as the JEV contract", () => {
    const { provider: subject } = provider([]);
    expect(subject.family).toBe("jev");
    expect(subject.capabilities().deterministic).toBe(false);
    expect(subject.capabilities().kinds).not.toContain("policy");
    expect(subject.capabilities().maxOptions).toBe(8);
  });
});

describe("credentials", () => {
  it("fails before any network activity when the credential is missing", async () => {
    const { provider: subject, transport } = provider([jsonResponse("{}")], {
      environment: environmentWith({}),
    });
    const error = await failureOf(() => subject.decideWithMetadata(request()));
    expect(error.failureKind).toBe("auth");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("TYPESAFE_API_KEY");
    expect(transport.requests).toHaveLength(0);
  });

  it("reads the key through the environment port, never from process.env", async () => {
    const previous = process.env["TYPESAFE_API_KEY"];
    process.env["TYPESAFE_API_KEY"] = "leaked-from-process-env";
    try {
      const { provider: subject, transport } = provider([
        jsonResponse(
          systemOneBody({
            answers: {
              rank_0: { type: "score", score: 1 },
              rank_1: { type: "score", score: 0 },
            },
          }),
        ),
      ]);
      await subject.decideWithMetadata(request());
      expect(transport.requests[0]?.headers["authorization"]).toBe(
        `Bearer ${FAKE_KEY}`,
      );
      expect(JSON.stringify(transport.requests[0])).not.toContain(
        "leaked-from-process-env",
      );
    } finally {
      if (previous === undefined) {
        delete process.env["TYPESAFE_API_KEY"];
      } else {
        process.env["TYPESAFE_API_KEY"] = previous;
      }
    }
  });

  it("honours a configured credential variable name", async () => {
    const { provider: subject, transport } = provider(
      [
        jsonResponse(
          systemOneBody({
            answers: {
              rank_0: { type: "score", score: 1 },
              rank_1: { type: "score", score: 0 },
            },
          }),
        ),
      ],
      {
        credentialEnvVar: "CUSTOM_KEV",
        environment: environmentWith({ CUSTOM_KEV: "custom-value" }),
      },
    );
    await subject.decideWithMetadata(request());
    expect(transport.requests[0]?.headers["authorization"]).toBe(
      "Bearer custom-value",
    );
  });
});

describe("failures", () => {
  it("classifies a policy refusal as a refusal, never as a connection error", async () => {
    const { provider: subject } = provider([
      {
        error: new NetworkBoundaryError(
          "TARGET_NOT_ALLOWED",
          "https://api.typesafe.ai",
        ),
      },
    ]);
    const error = await failureOf(() => subject.decideWithMetadata(request()));
    expect(error.failureKind).toBe("refused");
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain(FAKE_KEY);
  });

  it("classifies a transport timeout", async () => {
    const { provider: subject } = provider([
      { error: new HttpTransportError("timeout", "no response in 1000ms") },
    ]);
    const error = await failureOf(() => subject.decideWithMetadata(request()));
    expect(error.failureKind).toBe("timeout");
    expect(error.retryable).toBe(true);
  });

  it("classifies rate limits, server errors and authentication failures", async () => {
    const cases: readonly (readonly [number, string])[] = [
      [429, "rate-limit"],
      [500, "server"],
      [401, "auth"],
      [403, "auth"],
      [404, "unavailable"],
    ];
    for (const [status, expected] of cases) {
      const { provider: subject } = provider([
        jsonResponse(JSON.stringify({ error: "fixture" }), status),
      ]);
      const error = await failureOf(() =>
        subject.decideWithMetadata(request()),
      );
      expect(error.failureKind, `status ${status}`).toBe(expected);
      expect(error.statusCode).toBe(status);
    }
  });

  it("refuses an oversized request locally instead of sending it", async () => {
    const { provider: subject, transport } = provider([jsonResponse("{}")]);
    const error = await failureOf(() =>
      subject.decideWithMetadata(
        request({ context: ["x".repeat(5_000)], ranked: false }),
      ),
    );
    expect(error.failureKind).toBe("refused");
    expect(transport.requests).toHaveLength(0);
  });

  it("treats a choice that was not offered as a malformed response", async () => {
    const { provider: subject } = provider([
      jsonResponse(
        systemOneBody({
          answers: { decision: { type: "choice", choice: "vendor/ghost" } },
        }),
      ),
    ]);
    const error = await failureOf(() =>
      subject.decideWithMetadata(request({ ranked: false })),
    );
    expect(error.failureKind).toBe("malformed-response");
    expect(error.retryable).toBe(false);
  });

  it("treats a confidence outside [0, 1] as a malformed response", async () => {
    const { provider: subject } = provider([
      jsonResponse(
        systemOneBody({
          answers: {
            decision: { type: "choice", choice: "vendor/a", confidence: 4 },
          },
        }),
      ),
    ]);
    const error = await failureOf(() =>
      subject.decideWithMetadata(request({ ranked: false })),
    );
    expect(error.failureKind).toBe("malformed-response");
  });

  it("treats a ranked answer without scores as a malformed response", async () => {
    const { provider: subject } = provider([
      jsonResponse(systemOneBody({ answers: { rank_0: { type: "score" } } })),
    ]);
    const error = await failureOf(() => subject.decideWithMetadata(request()));
    expect(error.failureKind).toBe("malformed-response");
  });

  it("never puts the provider's own words, headers or the key into an error", async () => {
    const { provider: subject } = provider([
      jsonResponse(
        JSON.stringify({
          error: `key ${FAKE_KEY} is invalid`,
          detail: "server said so",
        }),
        500,
      ),
    ]);
    const error = await failureOf(() => subject.decideWithMetadata(request()));
    expect(error.message).not.toContain(FAKE_KEY);
    expect(error.message).not.toContain("server said so");
    expect(error.message).toContain("server");
  });
});
