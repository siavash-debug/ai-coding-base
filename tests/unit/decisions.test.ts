import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../src/core/clock.js";
import {
  decisionId,
  projectId,
  taskId,
  workspaceId,
} from "../../src/core/ids.js";
import {
  DECISION_KINDS,
  type Decision,
  type DecisionKind,
  createDecision,
  isPendingDecision,
  resolveDecision,
} from "../../src/decisions/decision.js";
import {
  EFFECT_RESTRICTIVENESS,
  type Policy,
  type PolicyEffect,
  defaultPolicy,
  evaluatePolicy,
  mostRestrictiveEffect,
  validatePolicy,
} from "../../src/decisions/policy.js";
import {
  type DecisionCapabilities,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResponse,
  createAbstainingDecisionProvider,
  providerCanHandle,
  resolveDecisionFromProviderResponse,
} from "../../src/decisions/provider.js";
import {
  type DecisionProviderRegistration,
  candidateRegistrations,
  routeDecision,
  selectDecisionProvider,
} from "../../src/decisions/routing.js";
import {
  ALL_OPERATIONS,
  OPERATION_KINDS,
  RISK_LEVELS,
  baselineRiskForOperation,
  compareRisk,
  effectiveRiskLevel,
  maxRisk,
  requiresHumanApproval,
  requiresVerification,
  riskRank,
} from "../../src/decisions/risk.js";
import { expectDomainError } from "../support/errors.js";

const INSTANT = "2026-09-20T10:00:00.000Z";
const clock = createFixedClock(INSTANT);

function makeDecision(kind: DecisionKind = "routing"): Decision {
  return createDecision(
    {
      kind,
      question: "Which provider should handle this request?",
      options: [
        { id: "a", label: "Provider A" },
        { id: "b", label: "Provider B" },
      ],
      taskId: taskId("tsk-1"),
    },
    {
      id: decisionId("dec-1"),
      projectId: projectId("prj-1"),
      workspaceId: workspaceId("wsp-1"),
      clock,
    },
  );
}

describe("risk", () => {
  it("orders risk levels", () => {
    expect(RISK_LEVELS.map(riskRank)).toEqual([0, 1, 2, 3]);
    expect(compareRisk("low", "critical")).toBeLessThan(0);
    expect(compareRisk("critical", "low")).toBeGreaterThan(0);
    expect(compareRisk("high", "high")).toBe(0);
  });

  it("takes the highest level and defaults to low for an empty set", () => {
    expect(maxRisk(["low", "critical", "medium"])).toBe("critical");
    expect(maxRisk([])).toBe("low");
  });

  it("gates approval on high and critical only", () => {
    expect(requiresHumanApproval("low")).toBe(false);
    expect(requiresHumanApproval("medium")).toBe(false);
    expect(requiresHumanApproval("high")).toBe(true);
    expect(requiresHumanApproval("critical")).toBe(true);
  });

  it("requires verification for everything above low", () => {
    expect(requiresVerification("low")).toBe(false);
    expect(requiresVerification("medium")).toBe(true);
    expect(requiresVerification("critical")).toBe(true);
  });

  it("declares a baseline risk for every operation", () => {
    for (const operation of OPERATION_KINDS) {
      expect(RISK_LEVELS).toContain(baselineRiskForOperation(operation));
    }
    expect(baselineRiskForOperation("read")).toBe("low");
    expect(baselineRiskForOperation("execute")).toBe("medium");
    expect(baselineRiskForOperation("secrets-read")).toBe("high");
    expect(baselineRiskForOperation("db-destructive")).toBe("critical");
    expect(baselineRiskForOperation("deploy")).toBe("critical");
  });

  it("raises a declared risk to the operation baseline but never lowers it", () => {
    expect(effectiveRiskLevel("low", "secrets-read")).toBe("high");
    expect(effectiveRiskLevel("low", "db-destructive")).toBe("critical");
    expect(effectiveRiskLevel("critical", "read")).toBe("critical");
    expect(effectiveRiskLevel("medium", "write")).toBe("medium");
  });
});

describe("policy engine", () => {
  const policy = defaultPolicy();

  it("allows low-risk reads", () => {
    const decision = evaluatePolicy(policy, {
      operation: "read",
      riskLevel: "low",
    });
    expect(decision.effect).toBe("allow");
    expect(decision.matchedRuleId).toBe("P-007");
    expect(decision.requiresHumanApproval).toBe(false);
    expect(decision.requiresVerification).toBe(false);
  });

  it("verifies writes, execution and network access", () => {
    for (const operation of ["write", "execute", "network"] as const) {
      const decision = evaluatePolicy(policy, { operation, riskLevel: "low" });
      expect(decision.effect).toBe("verify");
      expect(decision.requiresVerification).toBe(true);
      expect(decision.matchedRuleId).toBe("P-008");
    }
  });

  it("requires approval for the dangerous operations by name", () => {
    const expectations = {
      "db-destructive": "P-001",
      deploy: "P-002",
      "auth-change": "P-003",
      "secrets-write": "P-004",
      delete: "P-005",
      "secrets-read": "P-006",
    } as const;
    for (const [operation, ruleId] of Object.entries(expectations)) {
      const decision = evaluatePolicy(policy, {
        operation: operation as keyof typeof expectations,
        riskLevel: "low",
      });
      expect(decision.effect).toBe("require-approval");
      expect(decision.matchedRuleId).toBe(ruleId);
      expect(decision.requiresHumanApproval).toBe(true);
    }
  });

  it("cannot be talked down by declaring a low risk", () => {
    const decision = evaluatePolicy(policy, {
      operation: "db-destructive",
      riskLevel: "low",
    });
    expect(decision.effectiveRisk).toBe("critical");
    expect(decision.effect).toBe("require-approval");
    expect(decision.reason).toContain("effective risk raised");
  });

  it("escalates through the safety net when nothing specific applies", () => {
    const raised = evaluatePolicy(policy, {
      operation: "read",
      riskLevel: "high",
    });
    expect(raised.matchedRuleId).toBe("P-000");
    expect(raised.effect).toBe("require-approval");

    const dbWrite = evaluatePolicy(policy, {
      operation: "db-write",
      riskLevel: "low",
    });
    expect(dbWrite.matchedRuleId).toBe("P-000");
    expect(dbWrite.effect).toBe("require-approval");

    const install = evaluatePolicy(policy, {
      operation: "dependency-install",
      riskLevel: "low",
    });
    expect(install.effect).toBe("require-approval");
  });

  it("never defaults to allow", () => {
    expect(policy.defaultEffect).toBe("verify");
    const noMatch: Policy = {
      id: "policy-narrow",
      name: "Narrow",
      version: 1,
      defaultEffect: "verify",
      rules: [
        {
          id: "N-1",
          description: "only deletions",
          operations: ["delete"],
          minRisk: "critical",
          effect: "deny",
        },
      ],
    };
    const decision = evaluatePolicy(noMatch, {
      operation: "read",
      riskLevel: "low",
    });
    expect(decision.effect).toBe("verify");
    expect(decision.matchedRuleId).toBeUndefined();
    expect(decision.reason).toContain("no policy rule matched");
  });

  it("honours a require-approval default effect", () => {
    const strict: Policy = {
      id: "policy-strict",
      name: "Strict",
      version: 1,
      defaultEffect: "require-approval",
      rules: [],
    };
    const decision = evaluatePolicy(strict, {
      operation: "read",
      riskLevel: "low",
    });
    expect(decision.requiresHumanApproval).toBe(true);
  });

  it("prefers the most restrictive effect", () => {
    expect(mostRestrictiveEffect(["allow", "verify"])).toBe("verify");
    expect(mostRestrictiveEffect(["verify", "deny", "allow"])).toBe("deny");
    expect(mostRestrictiveEffect(["require-approval", "deny"])).toBe("deny");
    expect(EFFECT_RESTRICTIVENESS.deny).toBeGreaterThan(
      EFFECT_RESTRICTIVENESS["require-approval"],
    );
    expectDomainError(() => mostRestrictiveEffect([]), "VALIDATION");
  });

  it("breaks ties by specificity, then by rule id", () => {
    const specificity: Policy = {
      id: "policy-specificity",
      name: "Specificity",
      version: 1,
      defaultEffect: "verify",
      rules: [
        {
          id: "R-2",
          description: "broad denial",
          operations: ALL_OPERATIONS,
          minRisk: "low",
          effect: "deny",
        },
        {
          id: "R-1",
          description: "targeted denial",
          operations: ["write"],
          minRisk: "low",
          effect: "deny",
        },
      ],
    };
    expect(
      evaluatePolicy(specificity, { operation: "write", riskLevel: "low" })
        .matchedRuleId,
    ).toBe("R-1");

    const ids: Policy = {
      id: "policy-ids",
      name: "Ids",
      version: 1,
      defaultEffect: "allow",
      rules: [
        {
          id: "T-9",
          description: "second",
          operations: ["write"],
          minRisk: "low",
          effect: "verify",
        },
        {
          id: "T-1",
          description: "first",
          operations: ["write"],
          minRisk: "low",
          effect: "verify",
        },
      ],
    };
    expect(
      evaluatePolicy(ids, { operation: "write", riskLevel: "low" })
        .matchedRuleId,
    ).toBe("T-1");
  });

  it("validates the policy itself", () => {
    const bad = (overrides: Partial<Policy>) =>
      validatePolicy({ ...defaultPolicy(), ...overrides });
    expectDomainError(
      () =>
        bad({
          rules: [
            {
              id: "D-1",
              description: "one",
              operations: ["read"],
              minRisk: "low",
              effect: "allow",
            },
            {
              id: "D-1",
              description: "two",
              operations: ["read"],
              minRisk: "low",
              effect: "allow",
            },
          ],
        }),
      "INVARIANT",
    );
    expectDomainError(
      () => bad({ defaultEffect: "permit" as unknown as PolicyEffect }),
      "VALIDATION",
    );
    expectDomainError(() => bad({ version: 0 }), "VALIDATION");
  });

  it("rejects an invalid request", () => {
    expectDomainError(
      () =>
        evaluatePolicy(policy, {
          operation: "teleport" as unknown as "read",
          riskLevel: "low",
        }),
      "VALIDATION",
    );
    expectDomainError(
      () =>
        evaluatePolicy(policy, {
          operation: "read",
          riskLevel: "extreme" as unknown as "low",
        }),
      "VALIDATION",
    );
  });
});

describe("decision record", () => {
  it("is pending when the question is asked", () => {
    const decision = makeDecision();
    expect(decision.outcome).toBe("pending");
    expect(decision.decidedBy).toBeUndefined();
    expect(decision.decidedAt).toBeUndefined();
    expect(decision.createdAt).toBe(INSTANT);
    expect(decision.alternativesConsidered).toEqual([]);
    expect(isPendingDecision(decision)).toBe(true);
  });

  it("requires an enumerated option set", () => {
    expectDomainError(
      () =>
        createDecision(
          { kind: "routing", question: "q", options: [] },
          {
            id: decisionId("dec-2"),
            projectId: projectId("prj-1"),
            workspaceId: workspaceId("wsp-1"),
            clock,
          },
        ),
      "VALIDATION",
    );
  });

  it("resolves a selection and derives the alternatives", () => {
    const resolved = resolveDecision(
      makeDecision(),
      { outcome: "selected", decidedBy: "code", selectedOptionId: "a" },
      clock,
    );
    expect(resolved.outcome).toBe("selected");
    expect(resolved.selectedOptionId).toBe("a");
    expect(resolved.decidedBy).toBe("code");
    expect(resolved.decidedAt).toBe(INSTANT);
    expect(resolved.alternativesConsidered).toEqual(["b"]);
  });

  it("records abstention, escalation and failure", () => {
    const abstained = resolveDecision(
      makeDecision(),
      {
        outcome: "abstained",
        decidedBy: "decision-provider",
        providerId: "jev",
      },
      clock,
    );
    expect(abstained.outcome).toBe("abstained");
    expect(abstained.selectedOptionId).toBeUndefined();
    expect(abstained.alternativesConsidered).toEqual(["a", "b"]);

    const escalated = resolveDecision(
      makeDecision(),
      { outcome: "escalated", decidedBy: "human" },
      clock,
    );
    expect(escalated.decidedBy).toBe("human");

    const failed = resolveDecision(
      makeDecision(),
      { outcome: "failed", decidedBy: "llm", rationale: "timeout" },
      clock,
    );
    expect(failed.rationale).toBe("timeout");
  });

  it("refuses a selection that is not one of the options", () => {
    expectDomainError(
      () =>
        resolveDecision(
          makeDecision(),
          { outcome: "selected", decidedBy: "llm", selectedOptionId: "z" },
          clock,
        ),
      "VALIDATION",
    );
  });

  it("refuses a selectedOptionId on a non-selected outcome", () => {
    expectDomainError(
      () =>
        resolveDecision(
          makeDecision(),
          {
            outcome: "abstained",
            decidedBy: "code",
            selectedOptionId: "a",
          },
          clock,
        ),
      "VALIDATION",
    );
  });

  it("requires a provider id only for provider decisions", () => {
    expectDomainError(
      () =>
        resolveDecision(
          makeDecision(),
          { outcome: "abstained", decidedBy: "decision-provider" },
          clock,
        ),
      "VALIDATION",
    );
    expectDomainError(
      () =>
        resolveDecision(
          makeDecision(),
          { outcome: "abstained", decidedBy: "code", providerId: "jev" },
          clock,
        ),
      "VALIDATION",
    );
  });

  it("validates confidence and cost fields", () => {
    expectDomainError(
      () =>
        resolveDecision(
          makeDecision(),
          {
            outcome: "selected",
            decidedBy: "llm",
            selectedOptionId: "a",
            confidence: 1.5,
          },
          clock,
        ),
      "VALIDATION",
    );
    expectDomainError(
      () =>
        resolveDecision(
          makeDecision(),
          {
            outcome: "selected",
            decidedBy: "llm",
            selectedOptionId: "a",
            costMicros: -1,
          },
          clock,
        ),
      "VALIDATION",
    );
  });

  it("resolves exactly once", () => {
    const resolved = resolveDecision(
      makeDecision(),
      { outcome: "selected", decidedBy: "code", selectedOptionId: "a" },
      clock,
    );
    expectDomainError(
      () =>
        resolveDecision(
          resolved,
          { outcome: "selected", decidedBy: "code", selectedOptionId: "b" },
          clock,
        ),
      "INVARIANT",
    );
  });
});

describe("decision provider port", () => {
  const request: DecisionRequest = {
    kind: "routing",
    question: "Which provider?",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    context: [],
    correlationId: "prj-1:wsp-1:tsk-1",
  };

  function stubProvider(
    id: string,
    response: DecisionResponse,
    capabilities: DecisionCapabilities = {
      kinds: DECISION_KINDS,
      deterministic: true,
    },
  ): DecisionProvider {
    return {
      id,
      family: "rules",
      capabilities: () => capabilities,
      decide: async () => response,
    };
  }

  it("abstains without a decision engine", async () => {
    const provider = createAbstainingDecisionProvider();
    expect(provider.family).toBe("rules");
    expect(provider.capabilities().deterministic).toBe(true);
    await expect(provider.decide(request)).resolves.toEqual({
      outcome: "abstained",
      reason: "no decision engine is configured for this installation",
    });
  });

  it("checks capability without any I/O", () => {
    const narrow = stubProvider(
      "narrow",
      { outcome: "abstained", reason: "x" },
      {
        kinds: ["selection"],
        deterministic: true,
      },
    );
    expect(providerCanHandle(narrow, request)).toBe(false);
    expect(providerCanHandle(narrow, { ...request, kind: "selection" })).toBe(
      true,
    );

    const single = stubProvider(
      "single",
      { outcome: "abstained", reason: "x" },
      {
        kinds: DECISION_KINDS,
        deterministic: true,
        maxOptions: 1,
      },
    );
    expect(providerCanHandle(single, request)).toBe(false);
  });

  it("bridges every provider response into a decision record", () => {
    const selected = resolveDecisionFromProviderResponse(
      makeDecision(),
      {
        outcome: "selected",
        optionId: "b",
        rationale: "cheapest capable engine",
        confidence: 0.75,
      },
      { providerId: "jev", clock, latencyMs: 12, costMicros: 4 },
    );
    expect(selected.decidedBy).toBe("decision-provider");
    expect(selected.providerId).toBe("jev");
    expect(selected.selectedOptionId).toBe("b");
    expect(selected.confidence).toBe(0.75);
    expect(selected.latencyMs).toBe(12);
    expect(selected.costMicros).toBe(4);
    expect(selected.alternativesConsidered).toEqual(["a"]);

    const abstained = resolveDecisionFromProviderResponse(
      makeDecision(),
      { outcome: "abstained", reason: "out of scope" },
      { providerId: "jev", clock },
    );
    expect(abstained.outcome).toBe("abstained");
    expect(abstained.rationale).toBe("out of scope");

    const escalated = resolveDecisionFromProviderResponse(
      makeDecision(),
      { outcome: "escalated", reason: "needs a human" },
      { providerId: "jev", clock },
    );
    expect(escalated.outcome).toBe("escalated");

    const failed = resolveDecisionFromProviderResponse(
      makeDecision(),
      { outcome: "failed", error: "timeout" },
      { providerId: "jev", clock },
    );
    expect(failed.outcome).toBe("failed");
    expect(failed.rationale).toBe("timeout");
  });

  it("rejects a provider selection outside the option set", () => {
    expectDomainError(
      () =>
        resolveDecisionFromProviderResponse(
          makeDecision(),
          { outcome: "selected", optionId: "nope" },
          { providerId: "jev", clock },
        ),
      "VALIDATION",
    );
  });

  it("requires an identified provider", () => {
    expectDomainError(
      () =>
        resolveDecisionFromProviderResponse(
          makeDecision(),
          { outcome: "abstained", reason: "x" },
          { providerId: "", clock },
        ),
      "VALIDATION",
    );
  });
});

describe("provider routing", () => {
  const registrations: DecisionProviderRegistration[] = [
    { providerId: "slow-jev", kinds: ["routing"], priority: 20, enabled: true },
    {
      providerId: "fast-rules",
      kinds: ["routing", "selection"],
      priority: 10,
      enabled: true,
    },
    { providerId: "disabled", kinds: ["routing"], priority: 1, enabled: false },
    {
      providerId: "classifier",
      kinds: ["classification"],
      priority: 5,
      enabled: true,
    },
  ];

  it("selects the lowest-priority enabled provider for the kind", () => {
    expect(selectDecisionProvider(registrations, "routing")?.providerId).toBe(
      "fast-rules",
    );
    expect(
      selectDecisionProvider(registrations, "classification")?.providerId,
    ).toBe("classifier");
    expect(selectDecisionProvider(registrations, "approval")).toBeUndefined();
  });

  it("breaks priority ties by provider id", () => {
    const tied: DecisionProviderRegistration[] = [
      { providerId: "b", kinds: ["routing"], priority: 1, enabled: true },
      { providerId: "a", kinds: ["routing"], priority: 1, enabled: true },
    ];
    expect(selectDecisionProvider(tied, "routing")?.providerId).toBe("a");
  });

  it("returns a sorted candidate list without mutating the input", () => {
    const input = [...registrations];
    expect(
      candidateRegistrations(input, "routing").map((entry) => entry.providerId),
    ).toEqual(["fast-rules", "slow-jev"]);
    expect(input).toEqual(registrations);
  });

  it("skips providers that cannot handle the request", () => {
    const request: DecisionRequest = {
      kind: "routing",
      question: "Which provider?",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      context: [],
      correlationId: "c",
    };
    const narrow: DecisionProvider = {
      id: "narrow",
      family: "rules",
      capabilities: () => ({
        kinds: DECISION_KINDS,
        deterministic: true,
        maxOptions: 1,
      }),
      decide: async () => ({ outcome: "abstained", reason: "x" }),
    };
    const wide: DecisionProvider = {
      id: "wide",
      family: "rules",
      capabilities: () => ({ kinds: DECISION_KINDS, deterministic: true }),
      decide: async () => ({ outcome: "abstained", reason: "x" }),
    };
    const ordering: DecisionProviderRegistration[] = [
      { providerId: "narrow", kinds: ["routing"], priority: 1, enabled: true },
      { providerId: "wide", kinds: ["routing"], priority: 2, enabled: true },
    ];
    expect(routeDecision([narrow, wide], ordering, request)?.id).toBe("wide");
    expect(
      routeDecision(
        [narrow, wide],
        ordering.map((entry) => ({ ...entry, enabled: false })),
        request,
      ),
    ).toBeUndefined();
  });
});
