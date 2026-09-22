import { describe, expect, it } from "vitest";

import { createFixedClock } from "../../src/core/clock.js";
import {
  DECISION_DOMAINS,
  DECISION_FALLBACK_REASONS,
  DECISION_LAYER_DISABLED_REASON,
  buildRoutingSpec,
  buildToolSelectionSpec,
  type DomainDecisionSpec,
} from "../../src/decisions/domains.js";
import {
  DOMAIN_FALLBACKS,
  deterministicFallbackFor,
  describeFallbacks,
} from "../../src/decisions/fallback.js";
import { createDecisionEngine } from "../../src/decisions/engine.js";
import {
  DECISION_FAILURE_KINDS,
  fallbackReasonForFailure,
  providerCanHandle,
  type DecisionProvider,
} from "../../src/decisions/provider.js";
import {
  createMetadataDecisionProvider,
  createScriptedDecisionProvider,
  decisionProviderFailure,
  DECISION_USAGE,
  specForDomain,
} from "../support/decisions.js";
import { createTickingClock } from "../support/project.js";

/**
 * The decision engine: how one bounded question gets answered.
 *
 * The order of its steps is the architecture, and each step is asserted here:
 * certainty first (code answers, the layer is never asked), then an absent layer
 * (answered and recorded as absent, *not* as a failure), then a capability gate, then
 * one provider call, then validation, then the deterministic fallback. A provider
 * answer that fails validation never becomes an answer, and a provider failure is
 * always replaced by a fallback whose reason is recorded.
 */

const INSTANT = "2026-09-20T10:00:00.000Z";
const CORRELATION = "corr-fixture";

function engineWith(provider?: DecisionProvider) {
  return createDecisionEngine({
    clock: createFixedClock(INSTANT),
    ...(provider === undefined ? {} : { provider }),
  });
}

function routingSpec(): DomainDecisionSpec {
  return buildRoutingSpec({
    taskRiskLevel: "low",
    routes: ["standard", "minimal"],
    context: ["risk:low"],
  });
}

const EVALUATE = { correlationId: CORRELATION } as const;

describe("decision engine", () => {
  it("reports that it is unconfigured when no provider is installed", () => {
    const info = engineWith().info;
    expect(info.configured).toBe(false);
    expect(info.providerId).toBeUndefined();
  });

  it("never asks a provider when code can answer", async () => {
    const provider = createScriptedDecisionProvider([]);
    const engine = engineWith(provider);
    const single = buildRoutingSpec({
      taskRiskLevel: "low",
      routes: ["standard"],
      context: [],
    });
    const outcome = await engine.evaluate(single, EVALUATE);
    expect(outcome.answeredBy).toBe("deterministic");
    expect(outcome.selectedOptionId).toBe("standard");
    expect(outcome.providerCalls).toBe(0);
    // The provider was never reached: not one request.
    expect(provider.requests).toHaveLength(0);
  });

  it("records an absent decision layer as an absent layer, not a failure", async () => {
    const outcome = await engineWith().evaluate(routingSpec(), EVALUATE);
    expect(outcome.answeredBy).toBe("deterministic");
    expect(outcome.fallbackReason).toBeUndefined();
    expect(outcome.providerFailure).toBeUndefined();
    expect(outcome.reasonCode).toBe(DECISION_LAYER_DISABLED_REASON);
    expect(outcome.selectedOptionId).toBe("standard");
    expect(outcome.providerCalls).toBe(0);
  });

  it("takes a validated provider answer as the answer", async () => {
    const provider = createScriptedDecisionProvider([
      {
        response: {
          outcome: "selected",
          optionId: "minimal",
          reasonCode: "narrow-scope-preferred",
          confidence: 0.8,
        },
      },
    ]);
    const outcome = await engineWith(provider).evaluate(
      routingSpec(),
      EVALUATE,
    );
    expect(outcome.answeredBy).toBe("provider");
    expect(outcome.selectedOptionId).toBe("minimal");
    expect(outcome.reasonCode).toBe("narrow-scope-preferred");
    expect(outcome.confidence).toBe(0.8);
    expect(outcome.providerId).toBe(provider.id);
    expect(outcome.providerCalls).toBe(1);
    // The provider's own prose is dropped, never recorded.
    expect(outcome.rationale).toBeDefined();
  });

  it("reports usage only when the provider reports usage", async () => {
    const reporting = createMetadataDecisionProvider([
      {
        metadata: {
          response: { outcome: "selected", optionId: "minimal" },
          usage: DECISION_USAGE,
        },
      },
    ]);
    const withUsage = await engineWith(reporting).evaluate(
      routingSpec(),
      EVALUATE,
    );
    expect(withUsage.usageReported).toBe(true);
    expect(withUsage.usage).toEqual(DECISION_USAGE);

    const silent = createMetadataDecisionProvider([
      { response: { outcome: "selected", optionId: "minimal" } },
    ]);
    const withoutUsage = await engineWith(silent).evaluate(
      routingSpec(),
      EVALUATE,
    );
    expect(withoutUsage.usageReported).toBe(false);
    expect(withoutUsage.usage).toBeUndefined();
  });

  it("does not consult a provider that cannot handle the question", async () => {
    const provider = createScriptedDecisionProvider([], { kinds: ["ranking"] });
    expect(
      providerCanHandle(provider, {
        kind: "routing",
        question: "q",
        options: [{ id: "a", label: "A" }],
        context: [],
        correlationId: CORRELATION,
      }),
    ).toBe(false);

    const outcome = await engineWith(provider).evaluate(
      routingSpec(),
      EVALUATE,
    );
    expect(outcome.answeredBy).toBe("fallback");
    expect(outcome.fallbackReason).toBe("provider-unavailable");
    expect(provider.requests).toHaveLength(0);
  });

  it("refuses to send a question with more candidates than the provider accepts", () => {
    const provider = createScriptedDecisionProvider([], { maxOptions: 1 });
    expect(
      providerCanHandle(provider, {
        kind: "tool-selection",
        question: "q",
        options: [{ id: "a", label: "A" }],
        context: [],
        correlationId: CORRELATION,
      }),
    ).toBe(true);
    expect(
      providerCanHandle(provider, {
        kind: "tool-selection",
        question: "q",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        context: [],
        correlationId: CORRELATION,
      }),
    ).toBe(false);
  });

  it("honours a caller that knows the layer must not be consulted", async () => {
    // An exhausted budget: the point of a hard budget is that the provider is not
    // called at all, and the degradation is recorded rather than hidden.
    const provider = createScriptedDecisionProvider([]);
    const outcome = await engineWith(provider).evaluate(routingSpec(), {
      ...EVALUATE,
      skipProviderWith: "budget-exhausted",
    });
    expect(outcome.answeredBy).toBe("fallback");
    expect(outcome.fallbackReason).toBe("budget-exhausted");
    expect(provider.requests).toHaveLength(0);
  });

  it("maps every provider failure category onto a recorded fallback reason", async () => {
    for (const failureKind of DECISION_FAILURE_KINDS) {
      const provider = createScriptedDecisionProvider([
        { error: decisionProviderFailure({ failureKind }) },
      ]);
      const outcome = await engineWith(provider).evaluate(
        routingSpec(),
        EVALUATE,
      );
      const expected = fallbackReasonForFailure(failureKind);
      expect(outcome.answeredBy, failureKind).toBe("fallback");
      expect(outcome.fallbackReason, failureKind).toBe(expected);
      expect(outcome.providerFailure, failureKind).toBe(failureKind);
      expect(DECISION_FALLBACK_REASONS, failureKind).toContain(expected);
      expect(outcome.providerCalls, failureKind).toBe(1);
      // The fallback answer is a candidate the caller supplied, never a new one.
      expect(
        routingSpec().options.map((option) => option.id),
        failureKind,
      ).toContain(outcome.selectedOptionId);
    }
  });

  it("attributes an unrecognised throw to the provider layer", async () => {
    const provider = createScriptedDecisionProvider([
      { error: new Error("something the taxonomy does not cover") },
    ]);
    const outcome = await engineWith(provider).evaluate(
      routingSpec(),
      EVALUATE,
    );
    expect(outcome.answeredBy).toBe("fallback");
    expect(outcome.fallbackReason).toBe("provider-error");
    expect(outcome.providerFailure).toBe("unknown");
  });

  it("treats a provider that reports its own failure as a failure, not an answer", async () => {
    const provider = createScriptedDecisionProvider([
      { response: { outcome: "failed", error: "internal" } },
    ]);
    const outcome = await engineWith(provider).evaluate(
      routingSpec(),
      EVALUATE,
    );
    expect(outcome.answeredBy).toBe("fallback");
    expect(outcome.fallbackReason).toBe("provider-error");
  });

  it("treats an abstention as a fallback with the provider's involvement recorded", async () => {
    const provider = createScriptedDecisionProvider([
      { response: { outcome: "abstained", reason: "not enough to go on" } },
    ]);
    const outcome = await engineWith(provider).evaluate(
      routingSpec(),
      EVALUATE,
    );
    expect(outcome.answeredBy).toBe("fallback");
    expect(outcome.fallbackReason).toBe("provider-abstained");
    expect(outcome.providerCalls).toBe(1);
  });

  it("rejects an answer that names a candidate that was not offered", async () => {
    const provider = createScriptedDecisionProvider([
      {
        response: {
          outcome: "selected",
          optionId: "route-that-does-not-exist",
        },
      },
    ]);
    const outcome = await engineWith(provider).evaluate(
      routingSpec(),
      EVALUATE,
    );
    expect(outcome.answeredBy).toBe("fallback");
    expect(outcome.fallbackReason).toBe("invalid-answer");
    expect(outcome.providerFailure).toBe("malformed-response");
    expect(outcome.selectedOptionId).toBe("standard");
  });

  it("rejects prose where an explanation code is required", async () => {
    const provider = createScriptedDecisionProvider([
      {
        response: {
          outcome: "selected",
          optionId: "minimal",
          reasonCode: "I think this is the safer route because it touches less",
        },
      },
    ]);
    const outcome = await engineWith(provider).evaluate(
      routingSpec(),
      EVALUATE,
    );
    expect(outcome.answeredBy).toBe("fallback");
    expect(outcome.fallbackReason).toBe("invalid-answer");
    expect(outcome.reasonCode).toBe("invalid-answer");
  });

  it("rejects a reason code that was not offered for the question", async () => {
    const provider = createScriptedDecisionProvider([
      {
        response: {
          outcome: "selected",
          optionId: "minimal",
          reasonCode: "credential-adjacent",
        },
      },
    ]);
    const outcome = await engineWith(provider).evaluate(
      routingSpec(),
      EVALUATE,
    );
    expect(outcome.fallbackReason).toBe("invalid-answer");
  });

  it("rejects a confidence outside the unit interval", async () => {
    const provider = createScriptedDecisionProvider([
      {
        response: { outcome: "selected", optionId: "minimal", confidence: 1.5 },
      },
    ]);
    const outcome = await engineWith(provider).evaluate(
      routingSpec(),
      EVALUATE,
    );
    expect(outcome.fallbackReason).toBe("invalid-answer");
    expect(outcome.confidence).toBeUndefined();
  });

  it("rejects an escalation answer for a question that does not allow one", async () => {
    const provider = createScriptedDecisionProvider([
      { response: { outcome: "escalated", reason: "you decide" } },
    ]);
    // Routing with a defer route allows escalation; tool selection never does.
    const spec = buildToolSelectionSpec({
      candidates: [
        { toolId: "a", label: "A", operation: "read" },
        { toolId: "b", label: "B", operation: "read" },
      ],
      defaultToolId: "a",
      context: [],
    });
    expect(spec.allowEscalated).toBe(false);
    const outcome = await engineWith(provider).evaluate(spec, EVALUATE);
    expect(outcome.fallbackReason).toBe("invalid-answer");
    expect(outcome.selectedOptionId).toBe("a");
  });

  it("carries an allowed escalation through as an escalation", async () => {
    const provider = createScriptedDecisionProvider([
      {
        response: {
          outcome: "escalated",
          reason: "needs a human",
          reasonCode: "human-judgement-required",
        },
      },
    ]);
    const outcome = await engineWith(provider).evaluate(
      buildRoutingSpec({
        taskRiskLevel: "high",
        routes: ["standard", "minimal", "defer-to-human"],
        context: [],
      }),
      EVALUATE,
    );
    expect(outcome.answeredBy).toBe("provider");
    expect(outcome.outcome).toBe("escalated");
    expect(outcome.reasonCode).toBe("human-judgement-required");
  });

  it("rejects an ordering for a question that does not ask for one", async () => {
    const provider = createScriptedDecisionProvider([
      {
        response: {
          outcome: "selected",
          optionId: "minimal",
          rankedOptionIds: ["minimal", "standard"],
        },
      },
    ]);
    const outcome = await engineWith(provider).evaluate(
      routingSpec(),
      EVALUATE,
    );
    expect(outcome.fallbackReason).toBe("invalid-answer");
    expect(outcome.ranking).toBeUndefined();
  });

  it("rejects a partial or repeated ranking", async () => {
    const spec = {
      ...buildToolSelectionSpec({
        candidates: [
          { toolId: "a", label: "A", operation: "read" },
          { toolId: "b", label: "B", operation: "read" },
        ],
        defaultToolId: "a",
        context: [],
      }),
      ranked: true,
      deterministic: undefined,
    };
    for (const rankedOptionIds of [["a"], ["a", "a"], ["a", "c"]]) {
      const provider = createScriptedDecisionProvider([
        { response: { outcome: "selected", optionId: "a", rankedOptionIds } },
      ]);
      const outcome = await engineWith(provider).evaluate(spec, EVALUATE);
      expect(outcome.fallbackReason, JSON.stringify(rankedOptionIds)).toBe(
        "invalid-answer",
      );
    }
  });

  it("measures latency with the injected clock", async () => {
    // A ticking clock advances a fixed step per read, so a measured latency is
    // non-zero without ever consulting the wall clock.
    const clock = createTickingClock(INSTANT, 37);
    const provider = createScriptedDecisionProvider([
      { response: { outcome: "selected", optionId: "minimal" } },
    ]);
    const outcome = await createDecisionEngine({ clock, provider }).evaluate(
      routingSpec(),
      EVALUATE,
    );
    expect(outcome.latencyMs).toBe(37);
  });

  it("refuses a malformed question before a provider could see it", async () => {
    const provider = createScriptedDecisionProvider([]);
    await expect(
      engineWith(provider).evaluate(
        { ...routingSpec(), options: [] },
        EVALUATE,
      ),
    ).rejects.toThrow();
    expect(provider.requests).toHaveLength(0);
  });
});

describe("deterministic fallbacks", () => {
  it("registers exactly one strategy per domain", () => {
    const registered = describeFallbacks();
    expect(registered.map((entry) => entry.domain).sort()).toEqual(
      [...DECISION_DOMAINS].sort(),
    );
    for (const entry of registered) {
      expect(DOMAIN_FALLBACKS[entry.domain]).toBe(entry);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("answers with the question's own declared default, whatever the reason", () => {
    for (const domain of DECISION_DOMAINS) {
      const spec = specForDomain(domain);
      for (const reason of DECISION_FALLBACK_REASONS) {
        const answer = deterministicFallbackFor(spec, reason);
        // The spec's validation already proved the default is one of the options, so
        // a fallback can never name a candidate that does not exist.
        expect(
          spec.options.map((option) => option.id),
          `${domain}/${reason}`,
        ).toContain(answer.optionId);
        expect(answer.rationale, `${domain}/${reason}`).toContain(reason);
      }
    }
  });

  it("keeps a ranked fallback a permutation of the supplied candidates", () => {
    const spec = specForDomain("ranking");
    const answer = deterministicFallbackFor(spec, "provider-timeout");
    expect(answer.ranking).toEqual(spec.options.map((option) => option.id));
  });

  it("never asserts a judgement it cannot make", () => {
    // The conservative direction is part of the contract: completion is never
    // assumed, relevance is never asserted, escalation is conservative.
    expect(DOMAIN_FALLBACKS.completion.strategy).toBe("conservative-negative");
    expect(DOMAIN_FALLBACKS.relevance.strategy).toBe("conservative-negative");
    expect(DOMAIN_FALLBACKS["human-escalation"].strategy).toBe(
      "conservative-review",
    );
    expect(DOMAIN_FALLBACKS.retry.strategy).toBe("stop");
    expect(DOMAIN_FALLBACKS["risk-assessment"].strategy).toBe(
      "deterministic-floor",
    );
  });
});
