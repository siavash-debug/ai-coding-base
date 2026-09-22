import { describe, expect, it } from "vitest";

import { hasDomainErrorCode } from "../../src/core/errors.js";
import {
  ATTEMPT_ROUTE_OPTIONS,
  DECISION_DOMAINS,
  DECISION_DOMAIN_KINDS,
  DECISION_LAYER_DISABLED_REASON,
  MAX_DECISION_CONTEXT_ENTRIES,
  MAX_DECISION_CONTEXT_ENTRY_CHARS,
  MAX_DECISION_OPTIONS,
  MAX_DECISION_QUESTION_CHARS,
  REASON_CODE_PATTERN,
  ROUTING_REASON_CODES,
  buildCompletionSpec,
  buildContextSelectionSpec,
  buildEscalationSpec,
  buildExecutionStrategySpec,
  buildRankingSpec,
  buildRelevanceSpec,
  buildSkillSelectionSpec,
  buildRetrySpec,
  buildRiskAssessmentSpec,
  buildRoutingSpec,
  buildToolSelectionSpec,
  assertDomainDecisionSpec,
  interpretCompletion,
  interpretEscalation,
  interpretRanking,
  interpretRelevance,
  interpretRetry,
  interpretRiskAssessment,
  interpretRoute,
  interpretToolSelection,
  isReasonCode,
  type DecisionOutcomeMeta,
  type DomainDecisionOutcome,
  type DomainDecisionSpec,
  type ToolCandidate,
} from "../../src/decisions/domains.js";
import { DECISION_KINDS } from "../../src/decisions/decision.js";
import { decisionId } from "../../src/core/ids.js";

/**
 * Decision domains: the shape of every bounded question.
 *
 * Two properties are load-bearing and are asserted here rather than assumed:
 *
 * - **a question is closed** — its candidates, its explanation vocabulary and its
 *   bounds are all supplied by deterministic code, so no answer can widen it;
 * - **certainty is answered by code** — where an option is the only defensible
 *   answer, the spec carries a deterministic gate, and the engine never consults a
 *   provider at all.
 *
 * The interpretation tests are the second half of the same argument: whatever a
 * decision layer answers, the value that reaches the application is derived here, and
 * it can only ever be *more* conservative than the deterministic baseline.
 */

const META: DecisionOutcomeMeta = {
  decisionId: decisionId("dec-fixture"),
  answeredBy: "deterministic",
  latencyMs: 0,
};

function outcome(
  spec: DomainDecisionSpec,
  overrides: Partial<DomainDecisionOutcome> = {},
): DomainDecisionOutcome {
  return {
    domain: spec.domain,
    kind: DECISION_DOMAIN_KINDS[spec.domain],
    answeredBy: "provider",
    outcome: "selected",
    latencyMs: 12,
    usageReported: false,
    providerCalls: 1,
    ...overrides,
  };
}

const TOOLS: readonly ToolCandidate[] = [
  {
    toolId: "list-workspace-files",
    label: "List workspace files",
    operation: "read",
    capability: "filesystem.read",
  },
  {
    toolId: "read-selected-file",
    label: "Read the selected context file",
    operation: "read",
    capability: "filesystem.read",
    ref: "src/a.ts",
  },
];

describe("decision domains", () => {
  it("maps every domain to a kind in the closed decision vocabulary", () => {
    for (const domain of DECISION_DOMAINS) {
      expect(DECISION_KINDS).toContain(DECISION_DOMAIN_KINDS[domain]);
    }
  });

  it("does not offer the absence of a provider as an answer", () => {
    // `decision-layer-disabled` describes the missing layer, so offering it to a
    // layer would let a provider claim it had not been configured.
    for (const domain of DECISION_DOMAINS) {
      const spec = specFor(domain);
      expect(spec.reasonCodes).not.toContain(DECISION_LAYER_DISABLED_REASON);
    }
  });

  it("validates every domain spec it builds", () => {
    for (const domain of DECISION_DOMAINS) {
      expect(() => assertDomainDecisionSpec(specFor(domain))).not.toThrow();
    }
  });

  it("accepts only codes from the closed explanation vocabulary", () => {
    expect(isReasonCode("retry-limit-reached")).toBe(true);
    expect(isReasonCode("Retry")).toBe(false);
    expect(isReasonCode("-leading")).toBe(false);
    expect(isReasonCode("has space")).toBe(false);
    expect(isReasonCode("a".repeat(65))).toBe(false);
    expect(String(REASON_CODE_PATTERN)).toContain("[a-z]");
  });

  describe("bounds", () => {
    it("refuses a question with no candidates", () => {
      expect(() =>
        buildRoutingSpec({ taskRiskLevel: "low", routes: [], context: [] }),
      ).toThrow();
    });

    it("refuses more candidates than a decision may carry", () => {
      const candidates: ToolCandidate[] = Array.from(
        { length: MAX_DECISION_OPTIONS + 1 },
        (_unused, index) => ({
          toolId: `tool-${index}`,
          label: `Tool ${index}`,
          operation: "read" as const,
        }),
      );
      // The bound is asserted by `assertDomainDecisionSpec`, which the engine runs
      // before anything is recorded or sent, so there is one choke point rather than
      // a check per builder.
      expect(() =>
        assertDomainDecisionSpec(
          buildToolSelectionSpec({
            candidates,
            defaultToolId: "tool-0",
            context: [],
          }),
        ),
      ).toThrow();
    });

    it("refuses a default that is not one of the candidates", () => {
      expect(() =>
        buildToolSelectionSpec({
          candidates: TOOLS,
          defaultToolId: "tool-that-does-not-exist",
          context: [],
        }),
      ).toThrow();
    });

    it("refuses a question longer than the input bound", () => {
      const spec = buildRoutingSpec({
        taskRiskLevel: "low",
        routes: ["standard"],
        context: [],
      });
      expect(() =>
        assertDomainDecisionSpec({
          ...spec,
          question: "x".repeat(MAX_DECISION_QUESTION_CHARS + 1),
        }),
      ).toThrow();
    });

    it("refuses a context entry longer than the bound", () => {
      const spec = buildRoutingSpec({
        taskRiskLevel: "low",
        routes: ["standard"],
        context: [],
      });
      expect(() =>
        assertDomainDecisionSpec({
          ...spec,
          context: ["y".repeat(MAX_DECISION_CONTEXT_ENTRY_CHARS + 1)],
        }),
      ).toThrow();
    });

    it("refuses more context entries than the bound", () => {
      const spec = buildRoutingSpec({
        taskRiskLevel: "low",
        routes: ["standard"],
        context: [],
      });
      expect(() =>
        assertDomainDecisionSpec({
          ...spec,
          context: Array.from(
            { length: MAX_DECISION_CONTEXT_ENTRIES + 1 },
            (_unused, index) => `ref:${index}`,
          ),
        }),
      ).toThrow();
    });

    it("refuses duplicate candidates", () => {
      const spec = buildToolSelectionSpec({
        candidates: TOOLS,
        defaultToolId: TOOLS[0]!.toolId,
        context: [],
      });
      expect(() =>
        assertDomainDecisionSpec({
          ...spec,
          options: [spec.options[0]!, spec.options[0]!],
        }),
      ).toThrow();
    });

    it("refuses a deterministic answer that names no candidate", () => {
      const spec = buildRoutingSpec({
        taskRiskLevel: "low",
        routes: ["standard"],
        context: [],
      });
      expect(() =>
        assertDomainDecisionSpec({
          ...spec,
          deterministic: {
            optionId: "not-a-route",
            reasonCode: "single-registered-route",
            rationale: "invented",
          },
        }),
      ).toThrow();
    });

    it("refuses a deterministic reason code that was not offered", () => {
      const spec = buildRoutingSpec({
        taskRiskLevel: "low",
        routes: ["standard"],
        context: [],
      });
      expect(() =>
        assertDomainDecisionSpec({
          ...spec,
          deterministic: {
            optionId: "standard",
            reasonCode: "not-offered",
            rationale: "invented",
          },
        }),
      ).toThrow();
    });

    it("refuses secret-shaped material in a question or a candidate", () => {
      // A decision carries references, never secrets: the check is on the way in, so
      // a provider is never handed a key to reason about.
      const fakeKey = "sk-live-abcdefghijklmnop";
      const spec = buildRoutingSpec({
        taskRiskLevel: "low",
        routes: ["standard"],
        context: [],
      });
      expect(() =>
        assertDomainDecisionSpec({ ...spec, question: `Is ${fakeKey} fine?` }),
      ).toThrow();
      expect(() =>
        assertDomainDecisionSpec({
          ...spec,
          context: [`credential:${fakeKey}`],
        }),
      ).toThrow();
      expect(() =>
        assertDomainDecisionSpec({
          ...spec,
          options: [
            { id: fakeKey, label: "a key" },
            { id: "b", label: "b" },
          ],
        }),
      ).toThrow();
    });
  });

  describe("deterministic gates", () => {
    it("answers routing itself when one route is registered", () => {
      const spec = buildRoutingSpec({
        taskRiskLevel: "low",
        routes: ["standard"],
        context: [],
      });
      expect(spec.deterministic?.optionId).toBe("standard");
      expect(spec.deterministic?.reasonCode).toBe("single-registered-route");
      expect(ROUTING_REASON_CODES).toContain(spec.deterministic?.reasonCode);
    });

    it("leaves routing open when a decision layer could narrow the route", () => {
      const spec = buildRoutingSpec({
        taskRiskLevel: "low",
        routes: ["standard", "minimal", "defer-to-human"],
        context: [],
      });
      expect(spec.deterministic).toBeUndefined();
      // The candidate set is the registered subset of the closed route vocabulary,
      // never an invented route.
      expect(spec.options.map((option) => option.id)).toEqual([
        "standard",
        "minimal",
        "defer-to-human",
      ]);
      expect(ATTEMPT_ROUTE_OPTIONS).toHaveLength(3);
    });

    it("answers tool selection itself when one tool is permitted", () => {
      const spec = buildToolSelectionSpec({
        candidates: [TOOLS[0]!],
        defaultToolId: TOOLS[0]!.toolId,
        context: [],
      });
      expect(spec.deterministic?.optionId).toBe(TOOLS[0]!.toolId);
    });

    it("stops a retry at the deterministic limit, whatever the layer would say", () => {
      const spent = buildRetrySpec({
        failureKind: "rate-limit",
        retryable: true,
        attemptsSpent: 2,
        maxRetries: 2,
        retriesRemaining: 5,
        context: [],
      });
      expect(spent.deterministic?.optionId).toBe("stop");
      expect(spent.deterministic?.reasonCode).toBe("retry-limit-reached");

      const exhausted = buildRetrySpec({
        failureKind: "rate-limit",
        retryable: true,
        attemptsSpent: 0,
        maxRetries: 2,
        retriesRemaining: 0,
        context: [],
      });
      expect(exhausted.deterministic?.reasonCode).toBe("budget-exhausted");

      const notRetryable = buildRetrySpec({
        failureKind: "auth",
        retryable: false,
        attemptsSpent: 0,
        maxRetries: 2,
        retriesRemaining: 5,
        context: [],
      });
      expect(notRetryable.deterministic?.reasonCode).toBe(
        "failure-not-retryable",
      );

      // With room to spare there *is* a real question, and a decision layer may
      // answer it — inside the limits the gate already established.
      const open = buildRetrySpec({
        failureKind: "rate-limit",
        retryable: true,
        attemptsSpent: 0,
        maxRetries: 2,
        retriesRemaining: 2,
        context: [],
      });
      expect(open.deterministic).toBeUndefined();
      expect(open.allowEscalated).toBe(true);
    });

    it("refuses to call a task complete on failed evidence", () => {
      const failed = buildCompletionSpec({
        acceptanceCriteriaTotal: 2,
        acceptanceCriteriaMet: 1,
        verificationChecks: 3,
        verificationFailures: 1,
        context: [],
      });
      expect(failed.deterministic?.optionId).toBe("incomplete");

      const noEvidence = buildCompletionSpec({
        acceptanceCriteriaTotal: 2,
        verificationChecks: 0,
        verificationFailures: 0,
        context: [],
      });
      expect(noEvidence.deterministic?.optionId).toBe("uncertain");
      expect(noEvidence.deterministic?.reasonCode).toBe(
        "no-verification-evidence",
      );

      // Evidence exists and nothing failed: the question is genuinely open.
      const open = buildCompletionSpec({
        acceptanceCriteriaTotal: 2,
        acceptanceCriteriaMet: 2,
        verificationChecks: 2,
        verificationFailures: 0,
        context: [],
      });
      expect(open.deterministic).toBeUndefined();
      expect(open.defaultOptionId).toBe("uncertain");
    });

    it("distinguishes unmeasured criteria from zero met", () => {
      const unmeasured = buildCompletionSpec({
        acceptanceCriteriaTotal: 2,
        verificationChecks: 1,
        verificationFailures: 0,
        context: [],
      });
      expect(unmeasured.context.join(" ")).toContain("unmeasured");
    });

    it("never delegates a security refusal to a decision layer", () => {
      const spec = buildEscalationSpec({
        facts: ["refused-operation"],
        securityRefusal: true,
        context: [],
      });
      expect(spec.deterministic?.optionId).toBe("review");
      expect(spec.deterministic?.reasonCode).toBe("security-refusal");
      // A human must see it, so the default agrees with the gate.
      expect(spec.defaultOptionId).toBe("review");
    });

    it("answers ranking itself for a single candidate", () => {
      const spec = buildRankingSpec({
        candidates: [{ id: "only", label: "Only candidate" }],
        context: [],
      });
      expect(spec.deterministic?.optionId).toBe("only");
      expect(spec.ranked).toBe(true);
    });

    it("treats an already-critical baseline as unraisable", () => {
      const spec = buildRiskAssessmentSpec({
        operation: "deploy",
        baselineRisk: "critical",
        context: [],
      });
      expect(spec.deterministic?.optionId).toBe("critical");
      expect(spec.options.map((option) => option.id)).toEqual([
        "low",
        "medium",
        "high",
        "critical",
      ]);
    });
  });

  describe("interpretation", () => {
    it("maps a route answer to a bounded route id only", () => {
      const spec = buildRoutingSpec({
        taskRiskLevel: "low",
        routes: ["standard", "minimal"],
        context: [],
      });
      const chosen = interpretRoute(
        outcome(spec, { selectedOptionId: "minimal" }),
        META,
      );
      expect(chosen.routeId).toBe("minimal");
      expect(chosen.deferToHuman).toBe(false);

      const deferred = interpretRoute(
        outcome(spec, { selectedOptionId: "defer-to-human" }),
        META,
      );
      expect(deferred.deferToHuman).toBe(true);
    });

    it("keeps the baseline risk when the assessment is lower", () => {
      const spec = buildRiskAssessmentSpec({
        operation: "deploy",
        baselineRisk: "high",
        context: [],
      });
      const lowered = interpretRiskAssessment(
        outcome(spec, { selectedOptionId: "low" }),
        META,
        "high",
      );
      expect(lowered.effectiveRisk).toBe("high");
      expect(lowered.assessedRisk).toBe("low");
      expect(lowered.raised).toBe(false);
    });

    it("lets the assessment raise risk, never lower it", () => {
      const spec = buildRiskAssessmentSpec({
        operation: "read",
        baselineRisk: "low",
        context: [],
      });
      const raised = interpretRiskAssessment(
        outcome(spec, { selectedOptionId: "critical" }),
        META,
        "low",
      );
      expect(raised.effectiveRisk).toBe("critical");
      expect(raised.raised).toBe(true);
    });

    it("ignores a risk answer outside the vocabulary", () => {
      const spec = buildRiskAssessmentSpec({
        operation: "read",
        baselineRisk: "low",
        context: [],
      });
      const ignored = interpretRiskAssessment(
        outcome(spec, { selectedOptionId: "catastrophic" }),
        META,
        "low",
      );
      expect(ignored.effectiveRisk).toBe("low");
      expect(ignored.assessedRisk).toBe("low");
    });

    it("treats escalation as the action for a retry", () => {
      const spec = buildRetrySpec({
        failureKind: "server",
        retryable: true,
        attemptsSpent: 0,
        maxRetries: 2,
        retriesRemaining: 2,
        context: [],
      });
      expect(
        interpretRetry(outcome(spec, { outcome: "escalated" }), META).action,
      ).toBe("escalate");
      expect(
        interpretRetry(outcome(spec, { selectedOptionId: "retry" }), META)
          .action,
      ).toBe("retry");
      expect(
        interpretRetry(outcome(spec, { selectedOptionId: "stop" }), META)
          .action,
      ).toBe("stop");
      // Anything unrecognised stops: a retry is never assumed.
      expect(interpretRetry(outcome(spec, {}), META).action).toBe("stop");
    });

    it("reports an unrecognised completion answer as uncertain", () => {
      const spec = buildCompletionSpec({
        acceptanceCriteriaTotal: 1,
        verificationChecks: 1,
        verificationFailures: 0,
        context: [],
      });
      expect(
        interpretCompletion(outcome(spec, { selectedOptionId: "done" }), META)
          .assessment,
      ).toBe("uncertain");
      expect(
        interpretCompletion(
          outcome(spec, { selectedOptionId: "complete" }),
          META,
        ).assessment,
      ).toBe("complete");
    });

    it("keeps a ranking a permutation of the supplied candidates", () => {
      const candidates = [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ];
      const spec = buildRankingSpec({ candidates, context: [] });
      const ranked = interpretRanking(
        outcome(spec, { selectedOptionId: "b", ranking: ["b", "a"] }),
        META,
        candidates,
      );
      expect(ranked.ranking).toEqual(["b", "a"]);
      // A partial ordering is discarded in favour of the caller's own order.
      const partial = interpretRanking(
        outcome(spec, { selectedOptionId: "b", ranking: ["b"] }),
        META,
        candidates,
      );
      expect(partial.ranking).toEqual(["a", "b"]);
    });

    it("asserts relevance only when it was answered", () => {
      const spec = buildRelevanceSpec({
        candidateRefs: ["src/a.ts"],
        context: [],
      });
      expect(
        interpretRelevance(
          outcome(spec, { selectedOptionId: "relevant" }),
          META,
        ).verdict,
      ).toBe("relevant");
      expect(
        interpretRelevance(
          outcome(spec, { selectedOptionId: "not-relevant" }),
          META,
        ).verdict,
      ).toBe("not-relevant");
      expect(interpretRelevance(outcome(spec, {}), META).verdict).toBe(
        "not-relevant",
      );
    });

    it("reports an escalation recommendation distinctly from an approval", () => {
      const spec = buildEscalationSpec({
        facts: [],
        securityRefusal: false,
        context: [],
      });
      expect(
        interpretEscalation(
          outcome(spec, { selectedOptionId: "no-review" }),
          META,
        ).recommendation,
      ).toBe("no-review");
      expect(
        interpretEscalation(outcome(spec, { outcome: "escalated" }), META)
          .recommendation,
      ).toBe("review");
      // The result carries a recommendation and metadata, and has no field that could
      // be mistaken for a grant.
      const result = interpretEscalation(
        outcome(spec, { selectedOptionId: "review" }),
        META,
      );
      expect(result.recommendation).toBe("review");
      // A recommendation and its provenance, and nothing that could be read as a
      // grant: an escalation is not an approval and must not look like one.
      expect(Object.keys(result).sort()).toEqual(["meta", "recommendation"]);
      expect(JSON.stringify(result)).not.toContain("approv");
    });

    it("falls back to the declared tool when the answer names nothing", () => {
      const spec = buildToolSelectionSpec({
        candidates: TOOLS,
        defaultToolId: TOOLS[0]!.toolId,
        context: [],
      });
      const chosen = interpretToolSelection(
        outcome(spec, { selectedOptionId: TOOLS[1]!.toolId }),
        META,
        TOOLS[0]!.toolId,
      );
      expect(chosen.toolId).toBe(TOOLS[1]!.toolId);
      expect(
        interpretToolSelection(outcome(spec, {}), META, TOOLS[0]!.toolId)
          .toolId,
      ).toBe(TOOLS[0]!.toolId);
    });
  });

  it("fails loudly when a spec is malformed rather than repairing it", () => {
    try {
      assertDomainDecisionSpec({
        domain: "routing",
        question: "",
        options: [],
        reasonCodes: [],
        context: [],
        defaultOptionId: "standard",
        allowEscalated: false,
        allowAbstained: true,
        ranked: false,
      });
      expect.unreachable();
    } catch (error) {
      expect(hasDomainErrorCode(error, "VALIDATION")).toBe(true);
    }
  });
});

/** One valid, minimal spec per domain, used to assert the shared invariants. */
function specFor(
  domain: (typeof DECISION_DOMAINS)[number],
): DomainDecisionSpec {
  switch (domain) {
    case "routing":
      return buildRoutingSpec({
        taskRiskLevel: "low",
        routes: ["standard", "minimal"],
        context: [],
      });
    case "tool-selection":
      return buildToolSelectionSpec({
        candidates: TOOLS,
        defaultToolId: TOOLS[0]!.toolId,
        context: [],
      });
    case "risk-assessment":
      return buildRiskAssessmentSpec({
        operation: "read",
        baselineRisk: "low",
        context: [],
      });
    case "retry":
      return buildRetrySpec({
        failureKind: "server",
        retryable: true,
        attemptsSpent: 0,
        maxRetries: 2,
        retriesRemaining: 2,
        context: [],
      });
    case "completion":
      return buildCompletionSpec({
        acceptanceCriteriaTotal: 1,
        verificationChecks: 1,
        verificationFailures: 0,
        context: [],
      });
    case "ranking":
      return buildRankingSpec({
        candidates: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        context: [],
      });
    case "relevance":
      return buildRelevanceSpec({ candidateRefs: ["src/a.ts"], context: [] });
    case "human-escalation":
      return buildEscalationSpec({
        facts: [],
        securityRefusal: false,
        context: [],
      });
    case "execution-strategy":
      return buildExecutionStrategySpec({
        modelRequired: true,
        eligibleCandidates: 1,
        riskLevel: "low",
        requiredCapabilities: ["reasoning"],
        context: [],
      });
    case "skill-selection":
      return buildSkillSelectionSpec({
        skillIds: ["code-review"],
        context: [],
      });
    case "context-selection":
      return buildContextSelectionSpec({
        candidateRefs: ["src/a.ts"],
        context: [],
      });
  }
}
