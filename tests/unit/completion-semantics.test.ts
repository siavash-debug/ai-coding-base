import { afterEach, describe, expect, it } from "vitest";

import { createFixedClock } from "../../src/core/clock.js";
import { DECISION_KINDS } from "../../src/decisions/decision.js";
import {
  COMPLETION_EVIDENCE_SHAPES,
  COMPLETION_REASON_CODES,
  buildCompletionSpec,
  classifyCompletionEvidence,
  completionReasonCodesFor,
  interpretCompletion,
  type CompletionDecisionInput,
  type CompletionEvidenceShape,
  type DecisionOutcomeMeta,
} from "../../src/decisions/domains.js";
import { createDecisionEngine } from "../../src/decisions/engine.js";
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
} from "../../src/decisions/provider.js";
import type { AgentRunner } from "../../src/ports/agent-runner.js";
import {
  FIXTURE_INSTANT,
  createEnforcementFixture,
  readWritePolicy,
  type EnforcementFixture,
} from "../support/policy.js";
import { createScriptedDecisionProvider } from "../support/decisions.js";
import { decisionId, type TaskId } from "../../src/core/ids.js";

/**
 * What the completion question means.
 *
 * Completion is the one assessment whose answer *withholds* a human, so the semantics
 * have to be exact rather than approximately right. Three properties are under test,
 * and each is a property of the question the platform builds rather than of a wording:
 *
 * - the evidence is classified into one shape, so "2 of 2 criteria established" is not
 *   confusable with "1 of 3", with "nothing measured", or with no verification at all;
 * - the facts carry explicit counts, so a missing value is never read as zero;
 * - the reason codes a layer may answer with are bounded by the evidence, so a claim
 *   the platform did not measure cannot be made — it is rejected, not recorded.
 *
 * Nothing here gives the layer authority: every assertion below is about interpretation
 * and about what may reach the record.
 */

const META: DecisionOutcomeMeta = {
  decisionId: decisionId("dec-fixture"),
  answeredBy: "provider",
  latencyMs: 0,
};

function evidence(
  overrides: Partial<CompletionDecisionInput> = {},
): CompletionDecisionInput {
  return {
    acceptanceCriteriaTotal: 2,
    acceptanceCriteriaMet: 2,
    verificationChecks: 2,
    verificationFailures: 0,
    context: [],
    ...overrides,
  };
}

function engineWith(provider?: DecisionProvider) {
  return createDecisionEngine({
    clock: createFixedClock(FIXTURE_INSTANT),
    ...(provider === undefined ? {} : { provider }),
  });
}

function evaluate(input: CompletionDecisionInput, provider?: DecisionProvider) {
  const engine = engineWith(provider);
  return engine.evaluate(buildCompletionSpec(input), {
    correlationId: "corr-1",
  });
}

describe("completion evidence: one shape per recorded fact", () => {
  it("classifies a failed verification ahead of everything else", () => {
    expect(
      classifyCompletionEvidence(
        evidence({ verificationChecks: 3, verificationFailures: 1 }),
      ),
    ).toBe("failed");
  });

  it("classifies an attempt with no verification as having no evidence", () => {
    expect(
      classifyCompletionEvidence(
        evidence({ verificationChecks: 0, verificationFailures: 0 }),
      ),
    ).toBe("none");
  });

  it("never reads an empty contract as a satisfied one", () => {
    // `met === total` holds trivially at zero, and a task that declares no criteria
    // must not look like a task whose criteria are all met.
    const shape = classifyCompletionEvidence(
      evidence({
        acceptanceCriteriaTotal: 0,
        acceptanceCriteriaMet: 0,
        verificationChecks: 1,
      }),
    );
    expect(shape).toBe("no-criteria");
    expect(shape).not.toBe("fully-satisfied");
  });

  it("separates unmeasured criteria from partially measured ones", () => {
    expect(
      classifyCompletionEvidence(
        evidence({
          acceptanceCriteriaTotal: 3,
          acceptanceCriteriaMet: undefined,
          verificationChecks: 2,
        }),
      ),
    ).toBe("unmeasured");
    expect(
      classifyCompletionEvidence(
        evidence({
          acceptanceCriteriaTotal: 3,
          acceptanceCriteriaMet: 1,
          verificationChecks: 2,
        }),
      ),
    ).toBe("partial");
  });

  it("classifies a fully established set as fully satisfied", () => {
    expect(
      classifyCompletionEvidence(
        evidence({ acceptanceCriteriaTotal: 2, acceptanceCriteriaMet: 2 }),
      ),
    ).toBe("fully-satisfied");
  });
});

describe("completion evidence: the facts the question carries", () => {
  it("states the counts explicitly, so nothing has to be inferred from absence", () => {
    const spec = buildCompletionSpec(
      evidence({
        acceptanceCriteriaTotal: 3,
        acceptanceCriteriaMet: 1,
        acceptanceCriteriaPending: 2,
        verificationChecks: 2,
        verificationFailures: 0,
      }),
    );
    expect(spec.context).toEqual([
      "criteria:1/3",
      "criteria-pending:2",
      "verification-checks:2",
      "verification-failures:0",
      "evidence:partial",
    ]);
  });

  it("keeps the unmeasured sentinel exactly as it was", () => {
    const spec = buildCompletionSpec(
      evidence({
        acceptanceCriteriaTotal: 2,
        acceptanceCriteriaMet: undefined,
        verificationChecks: 1,
      }),
    );
    expect(spec.context).toContain("criteria:unmeasured/2");
    expect(spec.context).toContain("criteria-pending:2");
    expect(spec.context).toContain("evidence:unmeasured");
  });

  it("counts pending from the record when the caller supplies it", () => {
    const spec = buildCompletionSpec(
      evidence({
        acceptanceCriteriaTotal: 4,
        acceptanceCriteriaMet: 1,
        acceptanceCriteriaPending: 2,
        verificationChecks: 1,
      }),
    );
    // Two are explicitly pending; the fact is the record's count, not total - met.
    expect(spec.context).toContain("criteria-pending:2");
  });

  it("falls back to the platform's own accounting when the caller does not", () => {
    const spec = buildCompletionSpec(
      evidence({
        acceptanceCriteriaTotal: 4,
        acceptanceCriteriaMet: 1,
        verificationChecks: 1,
      }),
    );
    expect(spec.context).toContain("criteria-pending:3");
  });

  it("appends its facts to the caller's context rather than replacing it", () => {
    const spec = buildCompletionSpec(
      evidence({ context: ["session:session-1"] }),
    );
    expect(spec.context[0]).toBe("session:session-1");
    expect(spec.context).toContain("evidence:fully-satisfied");
  });
});

describe("completion reason codes: bounded by the evidence", () => {
  it("offers criteria-met only where every declared criterion is established", () => {
    expect(completionReasonCodesFor("fully-satisfied")).toContain(
      "criteria-met",
    );
    for (const shape of [
      "partial",
      "unmeasured",
      "no-criteria",
    ] as const satisfies readonly CompletionEvidenceShape[]) {
      expect(completionReasonCodesFor(shape)).not.toContain("criteria-met");
    }
  });

  it("offers criteria-unclear exactly where something is not established", () => {
    for (const shape of [
      "partial",
      "unmeasured",
      "no-criteria",
    ] as const satisfies readonly CompletionEvidenceShape[]) {
      expect(completionReasonCodesFor(shape)).toContain("criteria-unclear");
    }
    expect(completionReasonCodesFor("fully-satisfied")).not.toContain(
      "criteria-unclear",
    );
  });

  it("always offers a code that claims nothing", () => {
    for (const shape of COMPLETION_EVIDENCE_SHAPES) {
      expect(completionReasonCodesFor(shape)).toContain(
        "evidence-insufficient",
      );
    }
  });

  it("offers only codes from the domain's closed vocabulary", () => {
    for (const shape of COMPLETION_EVIDENCE_SHAPES) {
      for (const code of completionReasonCodesFor(shape)) {
        expect(COMPLETION_REASON_CODES).toContain(code);
      }
    }
  });

  it("always offers the code its own deterministic gate answers with", () => {
    // A gated question still has to be well-formed: `assertDomainDecisionSpec` refuses a
    // deterministic reason code that is not in the offered set.
    const gated: readonly CompletionDecisionInput[] = [
      evidence({ verificationChecks: 3, verificationFailures: 1 }),
      evidence({ verificationChecks: 0, verificationFailures: 0 }),
    ];
    for (const input of gated) {
      const spec = buildCompletionSpec(input);
      expect(spec.deterministic).toBeDefined();
      expect(spec.reasonCodes).toContain(spec.deterministic!.reasonCode);
    }
  });
});

describe("completion precedence: code answers before the layer is asked", () => {
  it("answers a verification failure by code, without consulting the layer", async () => {
    const provider = createScriptedDecisionProvider([
      { response: { outcome: "selected", optionId: "complete" } },
    ]);
    const outcome = await evaluate(
      evidence({ verificationChecks: 3, verificationFailures: 2 }),
      provider,
    );
    expect(provider.calls).toBe(0);
    expect(outcome.answeredBy).toBe("deterministic");
    expect(outcome.selectedOptionId).toBe("incomplete");
    expect(outcome.reasonCode).toBe("verification-failed");
  });

  it("answers an attempt with no verification by code, without consulting the layer", async () => {
    const provider = createScriptedDecisionProvider([
      { response: { outcome: "selected", optionId: "complete" } },
    ]);
    const outcome = await evaluate(
      evidence({ verificationChecks: 0, verificationFailures: 0 }),
      provider,
    );
    expect(provider.calls).toBe(0);
    expect(outcome.selectedOptionId).toBe("uncertain");
    expect(outcome.reasonCode).toBe("no-verification-evidence");
  });
});

describe("completion claims: an unsupported one is refused, not recorded", () => {
  it("refuses criteria-met where the criteria were never established", async () => {
    const provider = createScriptedDecisionProvider([
      {
        response: {
          outcome: "selected",
          optionId: "complete",
          reasonCode: "criteria-met",
        },
      },
    ]);
    const outcome = await evaluate(
      evidence({
        acceptanceCriteriaTotal: 3,
        acceptanceCriteriaMet: 1,
        acceptanceCriteriaPending: 2,
        verificationChecks: 2,
      }),
      provider,
    );
    // The answer was asked for and given; it was rejected rather than repaired, and the
    // deterministic fallback answered with the question's own declared default.
    expect(provider.calls).toBe(1);
    expect(outcome.answeredBy).toBe("fallback");
    expect(outcome.fallbackReason).toBe("invalid-answer");
    expect(outcome.selectedOptionId).toBe("uncertain");
    expect(interpretCompletion(outcome, META).assessment).toBe("uncertain");
  });

  it("accepts the same answer once the criteria are established", async () => {
    const provider = createScriptedDecisionProvider([
      {
        response: {
          outcome: "selected",
          optionId: "complete",
          reasonCode: "criteria-met",
          confidence: 0.9,
        },
      },
    ]);
    const outcome = await evaluate(
      evidence({
        acceptanceCriteriaTotal: 2,
        acceptanceCriteriaMet: 2,
        verificationChecks: 3,
      }),
      provider,
    );
    expect(outcome.answeredBy).toBe("provider");
    expect(outcome.selectedOptionId).toBe("complete");
    expect(outcome.reasonCode).toBe("criteria-met");
    expect(interpretCompletion(outcome, META).assessment).toBe("complete");
  });

  it("accepts a claim the evidence does support on partially measured evidence", async () => {
    const provider = createScriptedDecisionProvider([
      {
        response: {
          outcome: "selected",
          optionId: "incomplete",
          reasonCode: "criteria-unclear",
        },
      },
    ]);
    const outcome = await evaluate(
      evidence({
        acceptanceCriteriaTotal: 3,
        acceptanceCriteriaMet: 1,
        verificationChecks: 2,
      }),
      provider,
    );
    expect(outcome.answeredBy).toBe("provider");
    expect(outcome.selectedOptionId).toBe("incomplete");
    expect(outcome.reasonCode).toBe("criteria-unclear");
  });

  it("bounds the claim, not the option: a bare uncertain answer is still an answer", async () => {
    const provider = createScriptedDecisionProvider([
      { response: { outcome: "selected", optionId: "uncertain" } },
    ]);
    const outcome = await evaluate(
      evidence({
        acceptanceCriteriaTotal: 3,
        acceptanceCriteriaMet: 1,
        verificationChecks: 2,
      }),
      provider,
    );
    expect(outcome.answeredBy).toBe("provider");
    expect(outcome.selectedOptionId).toBe("uncertain");
  });

  it("keeps the confidence gate above the record", async () => {
    const provider = createScriptedDecisionProvider([
      {
        response: {
          outcome: "selected",
          optionId: "complete",
          reasonCode: "verification-passed",
          confidence: 0.4,
        },
      },
    ]);
    const outcome = await evaluate(
      evidence({
        acceptanceCriteriaTotal: 2,
        acceptanceCriteriaMet: 2,
        verificationChecks: 2,
      }),
      provider,
    );
    const result = interpretCompletion(outcome, META);
    expect(result.assessment).toBe("uncertain");
    expect(result.reportedAssessment).toBe("complete");
    expect(result.confidenceGated).toBe(true);
    expect(result.confidence).toBe(0.4);
  });
});

/* ------------------------------------------------------------------ real runs */

const fixtures: EnforcementFixture[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (subject) => subject.cleanup()),
  );
});

async function fixture(
  options: Parameters<typeof createEnforcementFixture>[0],
): Promise<EnforcementFixture> {
  const created = await createEnforcementFixture(options);
  fixtures.push(created);
  return created;
}

function scopeOf(subject: EnforcementFixture) {
  return {
    projectId: subject.runtime.project.id,
    workspaceId: subject.runtime.workspace.id,
  };
}

/** A runner that reports exactly one verification suite and nothing else. */
function suiteRunner(
  suite: string,
  passed: number,
  failed: number,
): AgentRunner {
  return {
    id: "fixture-suite-runner",
    kind: "simulated",
    async attempt() {
      return {
        steps: [{ kind: "test", suite, passed, failed, durationMs: 1 }],
      };
    },
  };
}

/** Answers every question with the first option, except completion, as given. */
function completionProvider(completion: DecisionResponse): {
  readonly provider: DecisionProvider;
  readonly asked: readonly DecisionRequest[];
} {
  const asked: DecisionRequest[] = [];
  return {
    asked,
    provider: {
      id: "completion-fixture-provider",
      family: "rules",
      capabilities: () => ({
        kinds: DECISION_KINDS,
        deterministic: false,
        maxOptions: 8,
      }),
      async decide(request: DecisionRequest): Promise<DecisionResponse> {
        asked.push(request);
        if (request.kind === "completion") {
          return completion;
        }
        const first = request.options[0];
        if (first === undefined) {
          return { outcome: "abstained", reason: "no options offered" };
        }
        return request.ranked === true
          ? {
              outcome: "selected",
              optionId: first.id,
              rankedOptionIds: request.options.map((option) => option.id),
            }
          : { outcome: "selected", optionId: first.id };
      },
    },
  };
}

async function boundTask(
  subject: EnforcementFixture,
  acceptanceCriteria: Parameters<
    typeof subject.runtime.tasks.create
  >[0]["acceptanceCriteria"],
) {
  return subject.runtime.tasks.create(
    {
      title: "Assess completion semantics",
      description: "Prove the completion question carries the evidence it has.",
      acceptanceCriteria,
    },
    { project: subject.runtime.project, workspace: subject.runtime.workspace },
  );
}

async function completionDecisionOf(
  subject: EnforcementFixture,
  taskId: TaskId,
) {
  const trace = await subject.runtime.traces.read(scopeOf(subject), taskId);
  return trace.decisions.find((decision) => decision.kind === "completion");
}

describe("completion in a real run", () => {
  it("tells the layer a criterion is unmeasured rather than that all are met", async () => {
    const decision = completionProvider({
      outcome: "selected",
      optionId: "uncertain",
    });
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 1, 0),
      decisionProvider: decision.provider,
    });
    const stored = await boundTask(subject, [
      "A criterion only a human can judge",
    ]);

    const result = await subject.runtime.runTask.run(stored);
    expect(result.outcome).toBe("awaiting-review");

    const completion = decision.asked.find(
      (request) => request.kind === "completion",
    );
    expect(completion?.context).toContain("evidence:unmeasured");
    expect(completion?.context).toContain("criteria-pending:1");
    expect(completion?.reasonCodes).not.toContain("criteria-met");
  });

  it("describes a partially measured task as partially measured", async () => {
    const decision = completionProvider({
      outcome: "selected",
      optionId: "incomplete",
      reasonCode: "criteria-unclear",
    });
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 2, 0),
      decisionProvider: decision.provider,
    });
    const stored = await boundTask(subject, [
      {
        statement: "The bound suite passes",
        verifiedBy: { suite: "bound-suite" },
      },
      "A criterion only a human can judge",
    ]);

    const result = await subject.runtime.runTask.run(stored);
    expect(result.outcome).toBe("awaiting-review");

    const completion = decision.asked.find(
      (request) => request.kind === "completion",
    );
    expect(completion?.context).toContain("criteria:1/2");
    expect(completion?.context).toContain("criteria-pending:1");
    expect(completion?.context).toContain("evidence:partial");

    const recorded = await completionDecisionOf(subject, stored.task.id);
    expect(recorded?.answeredBy).toBe("provider");
    expect(recorded?.selectedOptionId).toBe("incomplete");
    expect(recorded?.reasonCode).toBe("criteria-unclear");
  });

  it("refuses a criteria-met claim on partially measured evidence, and asks a human", async () => {
    const decision = completionProvider({
      outcome: "selected",
      optionId: "complete",
      reasonCode: "criteria-met",
      confidence: 0.99,
    });
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 2, 0),
      decisionProvider: decision.provider,
    });
    const stored = await boundTask(subject, [
      {
        statement: "The bound suite passes",
        verifiedBy: { suite: "bound-suite" },
      },
      "A criterion only a human can judge",
    ]);

    const result = await subject.runtime.runTask.run(stored);
    expect(result.outcome).toBe("awaiting-review");
    // The layer was confident and said "complete": the platform did not act on it,
    // because the evidence never established the criterion it named.
    expect(result.completionAssessment).toBe("uncertain");
    expect(result.escalation).toBe("review");

    const recorded = await completionDecisionOf(subject, stored.task.id);
    expect(recorded?.answeredBy).toBe("fallback");
    expect(recorded?.reasonCode).toBe("invalid-answer");
    expect(recorded?.selectedOptionId).toBe("uncertain");
  });

  it("carries a fully established task to completion", async () => {
    const decision = completionProvider({
      outcome: "selected",
      optionId: "complete",
      reasonCode: "criteria-met",
      confidence: 0.95,
    });
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 2, 0),
      decisionProvider: decision.provider,
    });
    const stored = await boundTask(subject, [
      {
        statement: "The bound suite passes",
        verifiedBy: { suite: "bound-suite" },
      },
      {
        statement: "The bound suite also decides this",
        verifiedBy: { suite: "bound-suite" },
      },
    ]);

    const result = await subject.runtime.runTask.run(stored);
    expect(result.outcome).toBe("awaiting-review");
    expect(result.completionAssessment).toBe("complete");
    expect(result.escalation).toBeUndefined();
    // Nothing closed the task: completion is an assessment, and a human still owns it.
    expect(result.task.status).toBe("review");

    const completion = decision.asked.find(
      (request) => request.kind === "completion",
    );
    expect(completion?.context).toContain("criteria:2/2");
    expect(completion?.context).toContain("criteria-pending:0");
    expect(completion?.context).toContain("evidence:fully-satisfied");
  });
});
