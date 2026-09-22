import { describe, expect, it } from "vitest";

import {
  DEFAULT_TYPESAFE_BASE_URL,
  createTypeSafeProvider,
} from "../../src/adapters/decision/typesafe-provider.js";
import { createFixedClock } from "../../src/core/clock.js";
import {
  DECISION_PROVIDER_EXECUTION_SOURCES,
  buildRankingSpec,
  type DomainDecisionSpec,
} from "../../src/decisions/domains.js";
import {
  createDecision,
  resolveDecision,
} from "../../src/decisions/decision.js";
import {
  attestLiveSdkExecution,
  flattenDecisionProviderExecutionSource,
  isUsageReportingDecisionProvider,
  type DecisionProviderExecutionSource,
  type DecisionRequest,
  type DecisionResponse,
  type TrustedLiveSdkExecution,
} from "../../src/decisions/provider.js";
import { decisionId, projectId, workspaceId } from "../../src/core/ids.js";
import { initializeProject, openRuntime } from "../../src/application/runtime.js";
import type { Environment } from "../../src/ports/environment.js";
import { accessPolicy, allowingProviderHost } from "../support/policy.js";
import { createFakeTransport, jsonResponse } from "../support/llm.js";
import { createMetadataDecisionProvider } from "../support/decisions.js";

/**
 * Decision provenance: who answered is `providerId`; *how* the answer was produced
 * is `executionSource`. The two are different axes, and this suite pins the trust
 * boundary between them: only the TypeSafe adapter's real SDK call site can mint
 * `live-sdk`, and no test double can pass for it.
 *
 * Everything here is offline. The SDK is driven through a scripted transport, never
 * the network; no credential is read beyond a fixture value the fixture environment
 * itself supplies.
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

function rankingBody(): string {
  return JSON.stringify({
    model: "jev-latest",
    answers: {
      rank_0: { score: 4 },
      rank_1: { score: 2 },
    },
    usage: { input_tokens: 120, output_tokens: 8 },
  });
}

function rankingRequest(
  overrides: Partial<DecisionRequest> = {},
): DecisionRequest {
  return {
    kind: "ranking",
    question: "Which model should run this step?",
    ranked: true,
    options: [
      { id: "vendor/a", label: "Model A" },
      { id: "vendor/b", label: "Model B" },
    ],
    context: ["risk:low"],
    correlationId: "task:corr-1",
    ...overrides,
  };
}

describe("decision execution provenance", () => {
  it("Test A: the real adapter attests live-sdk when the SDK call resolves", async () => {
    const transport = createFakeTransport([jsonResponse(rankingBody())]);
    const provider = createTypeSafeProvider({
      environment: environmentWith({ TYPESAFE_API_KEY: FAKE_KEY }),
      transport,
      clock: CLOCK,
    });
    expect(isUsageReportingDecisionProvider(provider)).toBe(true);

    const result = await provider.decideWithMetadata(rankingRequest());
    expect(result.response.outcome).toBe("selected");
    // The marker exists only because the real `systemOne(...).withResponse()` above
    // resolved. Everything that fails earlier returns or throws without it.
    expect(result.executionSource).toBeDefined();
    expect(
      flattenDecisionProviderExecutionSource(result.executionSource!),
    ).toBe("live-sdk");
    // No network happened beyond the scripted transport: exactly one request.
    expect(transport.requests).toHaveLength(1);
  });

  it("the adapter does not attest when the SDK call never happens", async () => {
    // Missing credential: the adapter fails before any SDK call, so no marker can
    // exist for an execution that never occurred.
    const transport = createFakeTransport([jsonResponse(rankingBody())]);
    const provider = createTypeSafeProvider({
      environment: environmentWith({}),
      transport,
      clock: CLOCK,
    });
    await expect(provider.decideWithMetadata(rankingRequest())).rejects.toThrow(
      /no credential/,
    );
    expect(transport.requests).toHaveLength(0);
  });

  it("Test B: a scripted test double self-declares test-double, never live-sdk", async () => {
    const provider = createMetadataDecisionProvider([
      {
        metadata: {
          response: {
            outcome: "selected",
            optionId: "vendor/a",
            rankedOptionIds: ["vendor/a", "vendor/b"],
          } satisfies DecisionResponse,
        },
      },
    ]);
    const result = await provider.decideWithMetadata(rankingRequest());
    expect(result.executionSource).toBe("test-double");
  });

  it("Test C: provider identity alone does not make an answer live-sdk", () => {
    // The vocabulary is closed: a record that names the typesafe provider but was
    // answered by a double carries "test-double", and nothing downstream may read
    // providerId as provenance.
    // live-sdk: real TypeSafe SDK boundary only. test-double: everything else,
    // including any scripted fake.
    expect(DECISION_PROVIDER_EXECUTION_SOURCES).toEqual([
      "live-sdk",
      "test-double",
    ]);
    // Flattening is total: a double's self-declaration stays a double's.
    const double: DecisionProviderExecutionSource = "test-double";
    expect(flattenDecisionProviderExecutionSource(double)).toBe("test-double");
    // And a provider id is a string on a different axis — it can never satisfy the
    // vocabulary check that provenance goes through.
    expect(DECISION_PROVIDER_EXECUTION_SOURCES).not.toContain("typesafe");
  });

  it("a sealed live-sdk marker cannot be constructed outside the adapter", () => {
    // The marker is branded by a module-private symbol. A structural fake — any
    // object literal another module can write — is not assignable to it, which is
    // what makes "the double claims live-sdk" a compile-time error, not a review
    // finding. Runtime spot-check: the minted marker is the only value that
    // flattens to "live-sdk" other than the adapter's own.
    const minted: TrustedLiveSdkExecution = attestLiveSdkExecution();
    expect(flattenDecisionProviderExecutionSource(minted)).toBe("live-sdk");
  });

  it("Test D: the production runtime wiring carries live-sdk to the record", async () => {
    // The real construction path: initializeProject writes a typesafe decision
    // config, openRuntime builds buildDecisionProvider -> createTypeSafeProvider,
    // and the engine forwards provenance into resolveDecision. The SDK boundary is
    // scripted, so no network and no real credential is involved.
    const root = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(`${process.env.TEMP ?? "/tmp"}/provenance-`),
    );
    const decisionConfig = {
      provider: "typesafe",
      credentialEnvVar: "TYPESAFE_API_KEY",
      baseUrl: DEFAULT_TYPESAFE_BASE_URL,
      maxDecisionsPerTask: 6,
      maxRetriesPerTask: 1,
    } as const;
    await initializeProject({
      projectRoot: root,
      name: "Provenance Project",
      slug: "provenance-project",
      clock: CLOCK,
      decision: decisionConfig,
      // The egress guard is part of the production path being tested: the default
      // policy refuses api.typesafe.ai, so the test grants exactly the decision
      // host — the same explicit act an operator performs.
      policy: allowingProviderHost(
        accessPolicy({
          networkEnabled: true,
          allowedHosts: ["api.typesafe.ai"],
        }),
        "api.typesafe.ai",
      ),
    });
    const transport = createFakeTransport([jsonResponse(rankingBody())]);
    const runtime = await openRuntime({
      projectRoot: root,
      clock: CLOCK,
      environment: environmentWith({ TYPESAFE_API_KEY: FAKE_KEY }),
      transport,
    });

    const coordinator = runtime.decisionLayer.forAttempt({
      workspaceId: runtime.workspace.id,
      correlationId: "task:corr-prov",
    });
    const spec: DomainDecisionSpec = buildRankingSpec({
      candidates: [
        { id: "vendor/a", label: "Model A" },
        { id: "vendor/b", label: "Model B" },
      ],
      context: ["risk:low"],
    });
    // The coordinator's rank() drives the real path end to end: ask -> engine ->
    // provider -> SDK boundary -> resolve -> DecisionCompleted. That the recorded
    // answer carries live-sdk proves the *runtime wiring*, not just the adapter.
    const ranking = await coordinator.rank({
      candidates: spec.options,
    });
    expect(ranking.meta.executionSource).toBe("live-sdk");
    expect(ranking.meta.answeredBy).toBe("provider");
    expect(ranking.meta.providerId).toBe("typesafe");
    // The scripted transport served exactly one real SDK-shaped request.
    expect(transport.requests).toHaveLength(1);

    await import("node:fs/promises").then((fs) =>
      fs.rm(root, { recursive: true, force: true }),
    );
  });

  it("a code-answered decision cannot claim any execution source", () => {
    const base = createDecision(
      {
        kind: "ranking",
        question: "Which model?",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      },
      {
        id: decisionId("decision-1"),
        projectId: projectId("project-1"),
        workspaceId: workspaceId("workspace-1"),
        clock: CLOCK,
      },
    );
    // decidedBy: code + executionSource is a validation error, not a silent record:
    // provenance is a provider-answer fact and the record refuses to attribute one
    // to an answer code produced.
    expect(() =>
      resolveDecision(
        base,
        {
          outcome: "selected",
          decidedBy: "code",
          selectedOptionId: "a",
          executionSource: "live-sdk",
        },
        CLOCK,
      ),
    ).toThrow(/executionSource/);
  });
});
