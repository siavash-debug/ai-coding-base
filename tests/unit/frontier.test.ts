import { describe, expect, it } from "vitest";

import { createLlmFrontier } from "../../src/adapters/frontier/llm-frontier.js";
import {
  NetworkBoundaryError,
  createGuardedNetwork,
} from "../../src/adapters/sandbox/guarded-network.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProvider,
} from "../../src/adapters/llm/openai-compatible-provider.js";
import { createFixedClock } from "../../src/core/clock.js";
import { hasDomainErrorCode } from "../../src/core/errors.js";
import {
  type LlmProvider,
  isLlmProviderError,
} from "../../src/ports/llm-provider.js";
import { createModelRegistry } from "../../src/models/registry.js";
import type { ModelProfile } from "../../src/models/model.js";
import {
  chatCompletionBody,
  createFakeTransport,
  jsonResponse,
} from "../support/llm.js";
import { allowingProviderHost, accessPolicy } from "../support/policy.js";
import {
  FIXTURE_USAGE,
  TEXT_MODEL,
  VISION_MODEL,
  createMultiModelProvider,
} from "../support/frontier.js";

/**
 * Frontier: resolution rules and the network boundary.
 *
 * Two very different failure modes live here and they must not be confused:
 *
 * - **Resolution** — the plan asked for something this project cannot do (an unknown
 *   model, a provider that is configured but serves something else). A refusal, never
 *   a silent substitution, because a substitution would make the trace lie about
 *   which model ran.
 * - **Egress** — policy does not allow the vendor's host. Enforced at the transport,
 *   so an adapter cannot forget it, and provable by watching how many requests reach
 *   the socket underneath.
 */

const CLOCK = createFixedClock("2026-09-20T10:00:00.000Z");
const FIXTURE_HOST = "fixture.invalid";

function registryFor(models: readonly ModelProfile[]) {
  return createModelRegistry({ models });
}

// Typed as the port rather than as the fake: the frontier resolves providers through
// `LlmProvider`, and the egress test hands it a real adapter, not the fake.
function frontierOver(
  models: readonly ModelProfile[],
  providers: ReadonlyMap<string, LlmProvider>,
) {
  return createLlmFrontier({
    registry: registryFor(models),
    providers,
    clock: CLOCK,
  });
}

describe("resolution", () => {
  it("refuses a model that is not registered", async () => {
    const frontier = frontierOver([TEXT_MODEL], new Map());
    try {
      await frontier.executeStep({
        stepId: "s1",
        providerId: TEXT_MODEL.providerId,
        modelId: "vendor/unknown",
        instruction: "do it",
        correlationId: "c",
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(hasDomainErrorCode(error, "NOT_FOUND")).toBe(true);
    }
  });

  it("refuses a model whose provider is not configured for this project", async () => {
    const frontier = frontierOver([TEXT_MODEL], new Map());
    try {
      await frontier.executeStep({
        stepId: "s1",
        providerId: TEXT_MODEL.providerId,
        modelId: TEXT_MODEL.modelId,
        instruction: "do it",
        correlationId: "c",
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(hasDomainErrorCode(error, "NOT_FOUND")).toBe(true);
      expect(String((error as Error).message)).toContain("not configured");
    }
  });

  it("refuses a provider that does not serve the model", async () => {
    const frontier = frontierOver(
      [TEXT_MODEL],
      new Map([
        [
          TEXT_MODEL.providerId,
          createMultiModelProvider({
            id: TEXT_MODEL.providerId,
            modelIds: ["vendor/something-else"],
          }),
        ],
      ]),
    );
    try {
      await frontier.executeStep({
        stepId: "s1",
        providerId: TEXT_MODEL.providerId,
        modelId: TEXT_MODEL.modelId,
        instruction: "do it",
        correlationId: "c",
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(hasDomainErrorCode(error, "VALIDATION")).toBe(true);
    }
  });

  it("refuses a model attributed to the wrong provider", async () => {
    const frontier = frontierOver(
      [TEXT_MODEL],
      new Map([
        [
          TEXT_MODEL.providerId,
          createMultiModelProvider({
            id: TEXT_MODEL.providerId,
            modelIds: [TEXT_MODEL.modelId],
          }),
        ],
      ]),
    );
    try {
      await frontier.executeStep({
        stepId: "s1",
        providerId: "other",
        modelId: TEXT_MODEL.modelId,
        instruction: "do it",
        correlationId: "c",
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(hasDomainErrorCode(error, "INVARIANT")).toBe(true);
    }
  });

  it("normalises a completed step and tells the model what it may not trust", async () => {
    const provider = createMultiModelProvider({
      id: TEXT_MODEL.providerId,
      modelIds: [TEXT_MODEL.modelId, VISION_MODEL.modelId],
      content: "done",
      usage: FIXTURE_USAGE,
    });
    const frontier = frontierOver(
      [TEXT_MODEL, VISION_MODEL],
      new Map([[TEXT_MODEL.providerId, provider]]),
    );

    const result = await frontier.executeStep({
      stepId: "s1",
      providerId: TEXT_MODEL.providerId,
      modelId: TEXT_MODEL.modelId,
      instruction: "Fix the parser bug",
      contextText: "file: src/parser.ts",
      correlationId: "c",
    });

    expect(result).toMatchObject({
      stepId: "s1",
      modelId: TEXT_MODEL.modelId,
      providerId: TEXT_MODEL.providerId,
      content: "done",
      usageReported: true,
    });
    expect(result.usage).toEqual(FIXTURE_USAGE);
    const messages = provider.requests[0]?.messages ?? [];
    expect(messages[0]?.content).toContain("untrusted material");
    expect(messages[1]?.content).toContain("file: src/parser.ts");
    expect(frontier.models()).toEqual([
      TEXT_MODEL.modelId,
      VISION_MODEL.modelId,
    ]);
  });

  it("reports usage the provider did not give as unavailable, not as zero", async () => {
    const provider = createMultiModelProvider({
      id: TEXT_MODEL.providerId,
      modelIds: [TEXT_MODEL.modelId],
    });
    const frontier = frontierOver(
      [TEXT_MODEL],
      new Map([[TEXT_MODEL.providerId, provider]]),
    );
    const result = await frontier.executeStep({
      stepId: "s1",
      providerId: TEXT_MODEL.providerId,
      modelId: TEXT_MODEL.modelId,
      instruction: "do it",
      correlationId: "c",
    });
    expect(result.usage).toBeUndefined();
    expect(result.usageReported).toBe(false);
  });
});

describe("provider egress", () => {
  function realAdapter(providerHosts: readonly string[]) {
    const transport = createFakeTransport([
      jsonResponse(chatCompletionBody({ content: "ok" })),
    ]);
    const network = createGuardedNetwork({
      transport,
      operationEnabled: false,
      operationHosts: [],
      providerHosts,
    });
    const provider = createOpenAiCompatibleProvider({
      id: OPENAI_COMPATIBLE_PROVIDER_ID,
      baseUrl: `https://${FIXTURE_HOST}/v1`,
      modelId: TEXT_MODEL.modelId,
      credentialEnvVar: "FIXTURE_API_KEY",
      environment: { id: "test", get: () => "fixture-key" },
      transport: network.providerTransport,
      clock: CLOCK,
    });
    const frontier = frontierOver(
      [{ ...TEXT_MODEL, providerId: OPENAI_COMPATIBLE_PROVIDER_ID }],
      new Map([[OPENAI_COMPATIBLE_PROVIDER_ID, provider]]),
    );
    return { frontier, transport };
  }

  it("refuses an unlisted host before a socket exists", async () => {
    const { frontier, transport } = realAdapter([]);
    try {
      await frontier.executeStep({
        stepId: "s1",
        providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelId: TEXT_MODEL.modelId,
        instruction: "do it",
        correlationId: "c",
      });
      throw new Error("expected the boundary to refuse");
    } catch (error) {
      // The provider port normalises the refusal instead of leaking the transport's
      // error: it arrives as a non-retryable, categorised provider failure (ADR-050).
      expect(isLlmProviderError(error)).toBe(true);
      expect(isLlmProviderError(error) && error.failureKind).toBe("refused");
      expect(isLlmProviderError(error) && error.retryable).toBe(false);
      // The refusal names no host and carries no request material.
      expect((error as Error).message).not.toContain("http");
      expect((error as Error).message).not.toContain("fixture-key");
    }
    // Nothing reached the transport underneath: the refusal happened before egress.
    expect(transport.requests).toHaveLength(0);
  });

  it("reaches the vendor once policy allows the host", async () => {
    const { frontier, transport } = realAdapter([FIXTURE_HOST]);
    const result = await frontier.executeStep({
      stepId: "s1",
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelId: TEXT_MODEL.modelId,
      instruction: "do it",
      correlationId: "c",
    });
    expect(result.content).toBe("ok");
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.url).toContain(FIXTURE_HOST);
  });

  it("keeps operation reach and provider reach as different sets", async () => {
    const network = createGuardedNetwork({
      transport: createFakeTransport([]),
      operationEnabled: true,
      operationHosts: [FIXTURE_HOST],
      providerHosts: [],
    });
    // An operation may reach it; provider egress still may not.
    expect(network.admitUrl(`https://${FIXTURE_HOST}/x`)).toBeUndefined();
    try {
      await network.providerTransport.send({
        url: `https://${FIXTURE_HOST}/v1/chat/completions`,
        method: "POST",
        headers: {},
        body: "{}",
        timeoutMs: 10,
        correlationId: "c",
      });
      throw new Error("expected the boundary to refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(NetworkBoundaryError);
    }
    expect(accessPolicy().network.providerHosts).toEqual([]);
    expect(
      allowingProviderHost(accessPolicy(), FIXTURE_HOST).network.providerHosts,
    ).toEqual([FIXTURE_HOST]);
  });
});
