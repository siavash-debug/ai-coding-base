import type { FrontierConfig } from "../../src/adapters/config/project-config.js";
import type { Runtime } from "../../src/application/runtime.js";
import {
  buildDecisionQualityReport,
  wasDecisionLayerConsulted,
  type DecisionQualityReport,
} from "../../src/application/decision-quality.js";
import { DECISION_KINDS } from "../../src/decisions/decision.js";
import type {
  DecisionRequest,
  DecisionResponse,
} from "../../src/decisions/provider.js";
import type { UsageReportingDecisionProvider } from "../../src/decisions/provider.js";
import type { ModelProfile } from "../../src/models/model.js";
import type { Budget } from "../../src/observability/budget.js";
import type { DomainEvent } from "../../src/observability/events.js";
import { LlmProviderError } from "../../src/ports/llm-provider.js";
import type { FrontierStepRequest } from "../../src/ports/frontier.js";
import {
  FIXTURE_USAGE,
  TEXT_MODEL,
  VISION_MODEL,
  createScriptedFrontier,
  frontierConfig,
  frontierModel,
  ratesFor,
  type ScriptedFrontierStep,
} from "../support/frontier.js";
import { createTestProject, type TestProject } from "../support/project.js";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The JEV decision benchmark: cases A–J, offline and deterministic.
 *
 * **What this suite is:** a *semantic decision test*. It proves orchestration
 * semantics — that a recorded decision changes what the platform executes — using
 * the production runtime, registry, classifier, plan builder, decision engine and
 * event log.
 *
 * **What this suite is NOT:** a TypeSafe integration test. The decision provider
 * here is a deterministic local responder whose answers carry
 * `executionSource: "test-double"`; no live TypeSafe SDK call is made or proven by
 * anything in this file. The live-SDK path is proven separately, at the adapter's
 * SDK boundary, in `decision-provenance.test.ts`.
 *
 * It answers, per representative task, *what the brain decided and what it cost* —
 * and it answers it from the platform's own recorded output
 * (`buildDecisionQualityReport`), not from a re-implementation of the logic under
 * test.
 *
 * What makes this a benchmark rather than a pile of assertions:
 *
 * - **Every case runs the production path.** The real runtime, registry, capability
 *   classifier, plan builder, decision engine and event log. Only two I/O boundaries
 *   are substituted: the frontier (scripted) and the decision *provider* (a
 *   deterministic responder standing in for TypeSafe). Exactly as in
 *   `orchestration-run.test.ts`, and for the same reason: the architecture under test
 *   is the part between them.
 * - **The responder is not an oracle.** It answers by question kind and otherwise
 *   obeys its caller, which is what lets a case prove that *the brain's answer* changed
 *   what Frontier executed — case B deliberately returns the reverse of the offered
 *   order and asserts that the platform executed the brain's first pick, not the
 *   deterministic one.
 * - **Nothing is scored.** Every metric is a count the platform already records:
 *   model calls, retries, candidates, decisions, context items. There is no
 *   self-assigned quality number, no invented latency and no invented price — an
 *   unpriced case is reported as unpriced.
 *
 * The naive baseline is stated explicitly (`naiveModelCalls`): a caller with no
 * decision layer sends every task to a model. The difference between that number and
 * the recorded call count is the platform's actual saving, and it is asserted rather
 * than estimated.
 */

const projects: TestProject[] = [];

afterEach(async () => {
  while (projects.length > 0) {
    await projects.pop()?.cleanup();
  }
});

/**
 * The benchmark's candidate pool: four models whose *declared* capabilities differ.
 *
 * `structuredOutput` and `computerUse` are each declared by exactly one model and
 * withheld from the others on purpose, so a case can prove that requirement matching
 * actually narrows the pool instead of merely recording a preference.
 */
const COMPUTER_MODEL = frontierModel({
  modelId: "vendor/computer-use:free",
  providerId: "openrouter",
  displayName: "Computer Use",
  capabilities: [
    "general",
    "reasoning",
    "agentic",
    "computerUse",
    "toolCalling",
  ],
  priority: 20,
});

const STRUCTURED_MODEL = frontierModel({
  modelId: "vendor/structured:free",
  providerId: "openrouter",
  displayName: "Structured",
  capabilities: ["general", "reasoning", "coding", "structuredOutput"],
  priority: 30,
});

const POOL: readonly ModelProfile[] = [
  TEXT_MODEL,
  VISION_MODEL,
  COMPUTER_MODEL,
  STRUCTURED_MODEL,
];

/**
 * A decision responder, not a recorded script.
 *
 * Answers by question `kind`; a case overrides only the questions it is about. The
 * default is deliberately the *caller's own first option*, which is what the
 * deterministic path would have produced anyway, so a case that forgets an override
 * still exercises the platform instead of failing for an unrelated reason.
 */
/** An answer, or a function that derives one from the question as it was asked. */
type DecisionAnswer =
  DecisionResponse | ((request: DecisionRequest) => DecisionResponse);

function responder(overrides: Partial<Record<string, DecisionAnswer>> = {}): {
  readonly provider: UsageReportingDecisionProvider;
  readonly requests: DecisionRequest[];
} {
  const requests: DecisionRequest[] = [];
  const answerFor = (
    request: DecisionRequest,
  ): DecisionResponse | undefined => {
    const override = overrides[request.kind];
    if (typeof override === "function") {
      return override(request);
    }
    return override;
  };
  const defaultAnswer = (request: DecisionRequest): DecisionResponse => {
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
  };
  return {
    requests,
    provider: {
      id: "benchmark-decisions",
      family: "rules",
      capabilities: () => ({
        kinds: DECISION_KINDS,
        deterministic: false,
        maxOptions: 8,
      }),
      async decide(request: DecisionRequest): Promise<DecisionResponse> {
        requests.push(request);
        return answerFor(request) ?? defaultAnswer(request);
      },
      // Implemented (not just inherited) so every benchmark answer carries the
      // honest provenance through the whole pipeline: this responder is a local
      // rules double, not the live TypeSafe SDK, and the recorded decisions say so.
      async decideWithMetadata(request) {
        const response = await this.decide(request);
        return { response, executionSource: "test-double" };
      },
    },
  };
}

const NO_REVIEW = {
  outcome: "selected",
  optionId: "no-review",
  reasonCode: "routine-outcome",
} as const;

/** A rank order that is the *reverse* of the candidates offered. */
function reversedRanking(request: DecisionRequest): DecisionResponse {
  const ids = request.options.map((option) => option.id).reverse();
  const first = ids[0];
  return first === undefined
    ? { outcome: "abstained", reason: "no options offered" }
    : {
        outcome: "selected",
        optionId: first,
        rankedOptionIds: ids,
        reasonCode: "ordered-by-relevance",
      };
}

interface BenchRun {
  readonly id: string;
  readonly report: DecisionQualityReport;
  readonly frontierCalls: number;
  readonly requests: readonly FrontierStepRequest[];
  readonly decisionRequests: readonly DecisionRequest[];
  readonly events: readonly DomainEvent[];
  readonly registry: Runtime["registry"];
}

const runs = new Map<string, BenchRun>();

/** The model ids the platform found eligible, in the report's own order. */
function eligibleIds(report: DecisionQualityReport): readonly string[] {
  return report.candidates
    .filter((candidate) => candidate.eligible)
    .map((candidate) => candidate.modelId);
}

/** The option ids one question offered, in the order the caller offered them. */
function offeredOptions(
  requests: readonly DecisionRequest[],
  kind: string,
): readonly string[] {
  const request = requests.find((entry) => entry.kind === kind);
  return request?.options.map((option) => option.id) ?? [];
}

interface BenchCaseInput {
  readonly id: string;
  readonly prompt: string;
  readonly models?: readonly ModelProfile[];
  readonly steps?: readonly ScriptedFrontierStep[];
  readonly overrides?: Partial<Record<string, DecisionAnswer>>;
  readonly routing?: Partial<FrontierConfig["routing"]>;
  readonly riskLevel?: "low" | "medium" | "high";
  readonly priced?: boolean;
  readonly budget?: Budget;
  /** Context text as a *caller* supplies it, the way the CLI does after selecting. */
  readonly contextText?: string;
}

async function runCase(input: BenchCaseInput): Promise<BenchRun> {
  const models = input.models ?? POOL;
  const frontier = createScriptedFrontier(
    input.steps ?? [{ content: "Done.", usage: FIXTURE_USAGE }],
  );
  const decision = responder({
    "human-escalation": NO_REVIEW,
    ...input.overrides,
  });
  const project = await createTestProject({
    frontierConfig: frontierConfig({
      models,
      ...(input.routing === undefined
        ? {}
        : {
            routing: {
              mode: "balanced",
              allowDecomposition: true,
              allowParallel: true,
              maxModelCalls: 4,
              maxRetriesPerStep: 1,
              ...input.routing,
            },
          }),
    }),
    ...(input.priced === false ? {} : { modelRates: ratesFor(models) }),
    decisionProvider: decision.provider,
    frontier,
  });
  projects.push(project);

  const stored = await project.runtime.tasks.create(
    {
      title: input.prompt,
      description: input.prompt,
      acceptanceCriteria: ["The requested result is produced"],
      ...(input.riskLevel === undefined ? {} : { riskLevel: input.riskLevel }),
      ...(input.budget === undefined ? {} : { budget: input.budget }),
    },
    { project: project.runtime.project, workspace: project.runtime.workspace },
  );
  const taskId = String(stored.task.id);

  const result = await project.runtime.orchestrator.run({
    workspaceId: project.runtime.workspace.id,
    taskId: taskId as never,
    ...(input.contextText === undefined
      ? {}
      : {
          contextText: input.contextText,
          contextSelectionId: "selection-benchmark",
          contextSelectedTokens: 64,
        }),
  });
  const scope = {
    projectId: project.runtime.project.id,
    workspaceId: project.runtime.workspace.id,
  };
  const trace = await project.runtime.traces.read(scope, taskId as never);
  const events = (await project.runtime.store.readAll(scope)).filter(
    (event) => String(event.taskId ?? "") === taskId,
  );

  const run: BenchRun = {
    id: input.id,
    report: buildDecisionQualityReport({ result, trace }),
    frontierCalls: frontier.calls,
    requests: frontier.requests,
    decisionRequests: decision.requests,
    events,
    registry: project.runtime.registry,
  };
  runs.set(input.id, run);
  return run;
}

function runOf(id: string): BenchRun {
  const run = runs.get(id);
  if (run === undefined) {
    throw new Error(
      `benchmark case "${id}" has not run; cases must be declared before the summary`,
    );
  }
  return run;
}

/* ------------------------------------------------------------------ Case A */

describe("case A — deterministic work spends nothing", () => {
  it("classifies arithmetic as a task no model is required for", async () => {
    const run = await runCase({
      id: "A",
      prompt: "Calculate 27 * 19.",
    });
    const { report } = run;

    expect(report.modelRequired).toBe(false);
    expect(report.requirements.classifications).toContain("mathematics");
    expect(report.planId).toBe("plan:deterministic");
    expect(report.modelCalls).toBe(0);
    expect(report.retryCount).toBe(0);
    expect(run.frontierCalls).toBe(0);
    // The question was answered by code, with its own reason, and the model-ranking
    // question was never asked at all — there was nothing to rank.
    expect(report.executionStrategy).toMatchObject({
      selectedOptionId: "deterministic",
      answeredBy: "code",
      reasonCode: "no-model-capability-required",
      providerCalls: 0,
    });
    expect(report.ranking).toBeUndefined();
    // The provider was consulted exactly once, about the escalation recommendation —
    // a judgement that spends no model call. Nothing about *execution* was asked.
    expect(
      report.decisions
        .filter((decision) => decision.answeredBy === "provider")
        .map((decision) => decision.domain),
    ).toEqual(["human-escalation"]);
  });
});

/* ------------------------------------------------------------------ Case B */

describe("case B — reasoning work is routed through the brain", () => {
  it("lets the brain's ranking, not the deterministic order, choose the model", async () => {
    const run = await runCase({
      id: "B",
      prompt:
        "Analyze why this algorithm has O(n^2) behavior and explain how to reduce it.",
      steps: [
        { content: "The nested scan is quadratic.", usage: FIXTURE_USAGE },
      ],
      // The responder answers with the *reverse* of the candidates it was offered.
      // Whatever the platform executes next is therefore proof that the brain's answer
      // — not code's ordering — decided it.
      overrides: {
        ranking: (request: DecisionRequest) => reversedRanking(request),
      },
    });
    const { report } = run;
    const offered = offeredOptions(run.decisionRequests, "ranking");

    expect(report.modelRequired).toBe(true);
    expect(report.requirements.capabilities).toContain("reasoning");
    expect(report.eligibleCount).toBe(POOL.length);
    expect(report.executionStrategy).toMatchObject({
      selectedOptionId: "model",
      answeredBy: "code",
      reasonCode: "eligible-model-available",
    });
    // The pool has more than one candidate, so the ranking question is a judgement
    // and the provider answers it.
    expect(report.ranking?.answeredBy).toBe("provider");
    expect(report.ranking?.providerCalls).toBe(1);
    // Frontier executed the model the brain ranked first, and the trace agrees.
    expect(report.selectedModelId).toBe(report.ranking?.ranking?.[0]);
    expect(run.requests[0]?.modelId).toBe(report.selectedModelId);
    expect(report.modelCalls).toBe(1);
    expect(report.retryCount).toBe(0);
    expect(report.invokedModelIds).toEqual([report.selectedModelId]);
    // And it was demonstrably *not* the answer code would have given: the brain's pick
    // is the last candidate offered, while code's own order puts the first one first.
    expect(offered.length).toBeGreaterThan(1);
    expect(report.selectedModelId).toBe(offered[offered.length - 1]);
    expect(report.selectedModelId).not.toBe(offered[0]);
  });
});

/* ------------------------------------------------------------------ Case C */

describe("case C — coding work requires and matches coding capability", () => {
  it("narrows the pool to coding-capable models and calls one", async () => {
    const run = await runCase({
      id: "C",
      prompt:
        "Implement a parser for the following format: id=value pairs, then fix any lint errors.",
    });
    const { report } = run;

    expect(report.requirements.classifications).toContain("coding");
    expect(report.requirements.capabilities).toContain("coding");
    expect(report.modelRequired).toBe(true);
    // Every candidate can code; every rejection is a missing `coding`.
    for (const candidate of report.candidates) {
      if (candidate.eligible) {
        continue;
      }
      expect(candidate.missing).toContain("capability:coding");
    }
    expect(report.eligibleCount).toBe(2);
    expect(report.modelCalls).toBe(1);
    expect(run.frontierCalls).toBe(1);
  });
});

/* ------------------------------------------------------------------ Case D */

describe("case D — computer use is a capability, not a keyword", () => {
  it("requires computerUse and reaches only the model that declares it", async () => {
    const run = await runCase({
      id: "D",
      prompt:
        "Open the browser, inspect the form, and determine which field is invalid.",
    });
    const { report } = run;

    expect(report.requirements.classifications).toContain("computer-use");
    expect(report.requirements.capabilities).toContain("computerUse");
    expect(report.modelRequired).toBe(true);
    expect(eligibleIds(report)).toEqual([COMPUTER_MODEL.modelId]);
    for (const candidate of report.candidates) {
      if (candidate.eligible) {
        continue;
      }
      expect(candidate.missing).toContain("capability:computerUse");
    }
    expect(report.selectedModelId).toBe(COMPUTER_MODEL.modelId);
    expect(report.modelCalls).toBe(1);
  });

  it("does not turn an ordinary mention of the browser into a computer-use task", async () => {
    const run = await runCase({
      id: "D2",
      prompt:
        "Fix the browser cache bug in the fetch layer and add a regression test.",
    });
    const { report } = run;

    expect(report.requirements.capabilities).not.toContain("computerUse");
    expect(report.requirements.capabilities).toContain("coding");
    expect(report.planId).not.toBe("plan:none");
  });
});

/* ------------------------------------------------------------------ Case E */

describe("case E — vision work excludes models that cannot see", () => {
  it("requires vision and an image input, and reaches only the seeing model", async () => {
    const run = await runCase({
      id: "E",
      prompt: "Inspect this screenshot and identify the UI error.",
    });
    const { report } = run;

    expect(report.requirements.capabilities).toContain("vision");
    expect(report.requirements.inputModalities).toContain("image");
    expect(eligibleIds(report)).toEqual([VISION_MODEL.modelId]);
    expect(
      report.candidates.find((entry) => entry.modelId === TEXT_MODEL.modelId)
        ?.missing,
    ).toContain("capability:vision");
    expect(report.modelCalls).toBe(1);
  });
});

/* ------------------------------------------------------------------ Case F */

describe("case F — structured output is not interchangeable", () => {
  it("requires structuredOutput and excludes models without it", async () => {
    const run = await runCase({
      id: "F",
      prompt: "Return the result as JSON matching this schema.",
    });
    const { report } = run;

    expect(report.requirements.classifications).toContain("structured-output");
    expect(report.requirements.capabilities).toContain("structuredOutput");
    expect(report.modelRequired).toBe(true);
    expect(eligibleIds(report)).toEqual([STRUCTURED_MODEL.modelId]);
    expect(
      report.candidates.find((entry) => entry.modelId === TEXT_MODEL.modelId)
        ?.missing,
    ).toContain("capability:structuredOutput");
    expect(report.modelCalls).toBe(1);
  });

  it("does not read the bare word JSON in coding work as a structured-output demand", async () => {
    const run = await runCase({
      id: "F2",
      prompt:
        "Fix the JSON config loader so it reports the file it could not parse.",
    });
    const { report } = run;

    expect(report.requirements.capabilities).not.toContain("structuredOutput");
    expect(report.requirements.capabilities).toContain("coding");
  });
});

/* ------------------------------------------------------------------ Case G */

describe("case G — retry is a decision, not a setting", () => {
  it("stops on a failure the platform will not retry, without a second call", async () => {
    const run = await runCase({
      id: "G1",
      prompt: "Fix the parser bug in src/parser.ts.",
      steps: [
        {
          error: new LlmProviderError(
            {
              failureKind: "auth",
              providerId: "openrouter",
              modelId: TEXT_MODEL.modelId,
              attempts: 1,
              retryable: false,
            },
            "scripted auth failure",
          ),
        },
      ],
    });
    const { report } = run;

    expect(report.retries).toHaveLength(1);
    expect(report.retries[0]).toMatchObject({
      answeredBy: "code",
      selectedOptionId: "stop",
      reasonCode: "failure-not-retryable",
      providerCalls: 0,
    });
    expect(run.frontierCalls).toBe(1);
    expect(report.retryCount).toBe(0);
    expect(report.finalStatus).toBe("failed");
    expect(report.failureKinds).toContain("auth");
  });

  it("spends one retry when the brain judges the failure transient and budget allows", async () => {
    const run = await runCase({
      id: "G2",
      prompt: "Fix the parser bug in src/parser.ts.",
      steps: [
        {
          error: new LlmProviderError(
            {
              failureKind: "server",
              providerId: "openrouter",
              modelId: TEXT_MODEL.modelId,
              attempts: 1,
              retryable: true,
              statusCode: 500,
            },
            "scripted server failure",
          ),
        },
        { content: "Patched src/parser.ts.", usage: FIXTURE_USAGE },
      ],
      overrides: {
        retry: {
          outcome: "selected",
          optionId: "retry",
          reasonCode: "retryable-failure",
        },
        completion: {
          outcome: "selected",
          optionId: "complete",
          reasonCode: "verification-passed",
        },
      },
    });
    const { report } = run;

    expect(report.retries[0]).toMatchObject({
      answeredBy: "provider",
      selectedOptionId: "retry",
      reasonCode: "retryable-failure",
      providerCalls: 1,
    });
    expect(report.retryCount).toBe(1);
    expect(run.frontierCalls).toBe(2);
    // Two provider calls: the failure and the retry. The step accounting would say
    // one, which is exactly why the report counts calls from the log.
    expect(report.modelCalls).toBe(2);
    expect(report.stepsSpent).toBe(1);
    expect(report.finalStatus).toBe("completed");

    // Fallback is the brain's, not the Frontier's: an approved retry *switches* to the
    // next candidate, and that order is exactly the ranking the brain produced. Two
    // models were called, in the brain's order, from one step.
    expect(run.requests[0]?.modelId).not.toBe(run.requests[1]?.modelId);
    expect(run.requests[0]?.modelId).toBe(report.ranking?.ranking?.[0]);
    expect(run.requests[1]?.modelId).toBe(report.ranking?.ranking?.[1]);
    expect(report.invokedModelIds).toEqual([
      run.requests[0]?.modelId,
      run.requests[1]?.modelId,
    ]);
  });

  it("refuses the retry when no retry budget remains", async () => {
    const run = await runCase({
      id: "G3",
      prompt: "Fix the parser bug in src/parser.ts.",
      routing: { maxRetriesPerStep: 0 },
      steps: [
        {
          error: new LlmProviderError(
            {
              failureKind: "rate-limit",
              providerId: "openrouter",
              modelId: TEXT_MODEL.modelId,
              attempts: 1,
              retryable: true,
              statusCode: 429,
            },
            "scripted rate limit",
          ),
        },
      ],
    });
    const { report } = run;

    expect(report.retries[0]).toMatchObject({
      answeredBy: "code",
      selectedOptionId: "stop",
      reasonCode: "budget-exhausted",
    });
    expect(run.frontierCalls).toBe(1);
    expect(report.retryCount).toBe(0);
    expect(report.stopReason).toBe("retry-exhausted");
  });
});

/* ------------------------------------------------------------------ Case H */

describe("case H — a successful HTTP call is not a completed task", () => {
  it("reports an empty completion as failed evidence, never as done", async () => {
    const run = await runCase({
      id: "H",
      prompt: "Fix the parser bug in src/parser.ts.",
      steps: [{ content: "   ", usage: FIXTURE_USAGE, omitUsage: false }],
      overrides: {
        completion: {
          outcome: "selected",
          optionId: "complete",
          reasonCode: "criteria-met",
        },
      },
    });
    const { report } = run;

    // The provider answered, so the call is recorded — and the run still fails.
    expect(report.modelCalls).toBe(1);
    expect(report.failureKinds).toContain("malformed-response");
    // The completion decision is *not* the provider's optimistic answer: failed
    // verification is answered by code, above any opinion.
    expect(report.completion).toMatchObject({
      answeredBy: "code",
      selectedOptionId: "incomplete",
      reasonCode: "verification-failed",
    });
    expect(report.completionAssessment).not.toBe("complete");
    expect(report.finalStatus).toBe("failed");
    expect(report.needsHumanReview).toBe(true);
  });
});

/* ------------------------------------------------------------------ Case I */

describe("case I — sufficient evidence can complete", () => {
  it("completes on verification evidence and keeps the output out of the log", async () => {
    const output = "Patched src/parser.ts and the parser tests pass.";
    const run = await runCase({
      id: "I",
      prompt: "Fix the parser bug in src/parser.ts.",
      steps: [{ content: output, usage: FIXTURE_USAGE }],
      overrides: {
        completion: {
          outcome: "selected",
          optionId: "complete",
          reasonCode: "verification-passed",
        },
      },
    });
    const { report } = run;

    expect(report.completion).toMatchObject({
      answeredBy: "provider",
      selectedOptionId: "complete",
      reasonCode: "verification-passed",
    });
    expect(report.completionAssessment).toBe("complete");
    expect(report.escalation).toMatchObject({
      selectedOptionId: "no-review",
      answeredBy: "provider",
    });
    expect(report.finalStatus).toBe("completed");
    expect(report.modelCalls).toBe(1);
    expect(report.retryCount).toBe(0);
    expect(report.invokedModelIds).toHaveLength(1);
    // The step ran and produced output; the output itself is nowhere in the log.
    expect(report.steps[0]).toMatchObject({
      status: "completed",
      modelId: report.selectedModelId,
      attempts: 1,
      retry: 0,
    });
    expect(report.steps[0]?.contentChars).toBe(output.length);
    const serialized = JSON.stringify(run.events);
    expect(serialized).not.toContain(output);
    expect(serialized).not.toContain("Patched src/parser.ts");
  });
});

/* ------------------------------------------------------------------ Case J */

describe("case J — no model call is spent when code can finish", () => {
  it("keeps a low-risk deterministic task away from Frontier entirely", async () => {
    const run = await runCase({
      id: "J1",
      prompt: "Calculate the invoice total: 12 items at 3.50 each.",
    });
    const { report } = run;

    expect(report.modelRequired).toBe(false);
    expect(report.modelCalls).toBe(0);
    expect(run.frontierCalls).toBe(0);
    expect(report.decisionCount).toBeGreaterThan(0);
    // Frontier was never asked for anything; only the escalation judgement — which the
    // brain owns and which costs nothing — reached the provider.
    expect(
      report.decisions
        .filter((decision) => decision.answeredBy === "provider")
        .map((decision) => decision.domain),
    ).toEqual(["human-escalation"]);
  });

  it("asks the brain about a high-risk task code could finish", async () => {
    const run = await runCase({
      id: "J2",
      prompt: "Calculate the totals and record them in the summary file.",
      riskLevel: "high",
      overrides: {
        "execution-strategy": {
          outcome: "selected",
          optionId: "deterministic",
          reasonCode: "routine-change",
        },
      },
    });
    const { report } = run;

    // Risk above the deterministic threshold turns the shortcut into a judgement, so
    // the provider is asked rather than the code assuming.
    expect(report.executionStrategy).toMatchObject({
      answeredBy: "provider",
      selectedOptionId: "deterministic",
      reasonCode: "routine-change",
      providerCalls: 1,
    });
    expect(report.modelCalls).toBe(0);
    expect(run.frontierCalls).toBe(0);

    // What the brain was *told* is likewise metadata: codes, counts and a risk level,
    // never task text. This is the traceability half of the decision (ADR-013/ADR-053).
    const question = run.decisionRequests.find(
      (request) => request.kind === "execution-strategy",
    );
    expect(question?.options.map((option) => option.id)).toEqual([
      "deterministic",
      "model",
      "human",
    ]);
    expect(question?.context).toContain("risk:high");
    expect(question?.context).toContain("model-required:false");
    expect(question?.reasonCodes).toContain("no-model-capability-required");
    expect(JSON.stringify(question?.context)).not.toContain(
      "Calculate the totals",
    );
  });

  it("honours a human answer by attempting nothing at all", async () => {
    const run = await runCase({
      id: "J3",
      prompt: "Calculate the totals and record them in the summary file.",
      riskLevel: "high",
      overrides: {
        "execution-strategy": {
          outcome: "selected",
          optionId: "human",
          reasonCode: "human-judgement-required",
        },
      },
    });
    const { report } = run;

    expect(report.executionStrategy).toMatchObject({
      answeredBy: "provider",
      selectedOptionId: "human",
    });
    expect(report.stopReason).toBe("strategy-human");
    expect(report.modelCalls).toBe(0);
    expect(report.retryCount).toBe(0);
    expect(run.frontierCalls).toBe(0);
    expect(report.finalStatus).toBe("not-attempted");
    expect(report.needsHumanReview).toBe(true);
    // Nothing was claimed to have been done.
    expect(run.events.some((event) => event.type === "LLMRequestStarted")).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ Case L */

describe("case L — context reaches the model and never the log", () => {
  it("carries selected context to Frontier as data, and records no content", async () => {
    const contextText =
      "file: src/parser.ts\n\nexport function parse(input: string) { return input.split(','); }";
    const run = await runCase({
      id: "L",
      prompt:
        "Analyze the selected parser helper and explain what it fails to handle.",
      contextText,
      steps: [
        {
          content: "It does not handle quoted separators.",
          usage: FIXTURE_USAGE,
        },
      ],
    });
    const { report } = run;

    // The context was *selected above* this layer (the Context Engine owns that —
    // ADR-018/ADR-039), so the orchestrator reports no selection of its own rather
    // than claiming to have minimized something it never looked at.
    expect(report.context.selectionCount).toBe(0);
    expect(report.context.selectedRefs).toEqual([]);
    // It did reach the executor, which is the whole point of selecting it.
    expect(run.requests[0]?.contextText).toBe(contextText);
    expect(report.modelCalls).toBe(1);
    // And nothing about it — or about the model's answer — is in the record.
    const serialized = JSON.stringify(run.events);
    expect(serialized).not.toContain("split(',')");
    expect(serialized).not.toContain("quoted separators");
    expect(serialized).not.toContain(contextText);
  });
});

/* ------------------------------------------------------------- the summary */

describe("the benchmark summary", () => {
  it("exposes the decisions and the model-call efficiency of every case", () => {
    const ids = [...runs.keys()];
    expect(ids).toEqual([
      "A",
      "B",
      "C",
      "D",
      "D2",
      "E",
      "F",
      "F2",
      "G1",
      "G2",
      "G3",
      "H",
      "I",
      "J1",
      "J2",
      "J3",
      "L",
    ]);

    const banner =
      "case | model? | caps | candidates | selected | calls | retries | decisions | by-provider | unpriced | final";
    const rows = ids.map((id) => {
      const run = runOf(id);
      const report = run.report;
      return [
        id.padEnd(4),
        (report.modelRequired ? "yes" : "no").padEnd(6),
        String(report.requirements.capabilities.length).padEnd(4),
        String(report.candidateCount).padEnd(10),
        (report.selectedModelId ?? "-").padEnd(24),
        String(report.modelCalls).padEnd(5),
        String(report.retryCount).padEnd(7),
        String(report.decisionCount).padEnd(9),
        String(report.decisionsAnsweredByProvider).padEnd(11),
        String(report.unpricedCalls).padEnd(8),
        report.finalStatus,
      ].join(" | ");
    });
    // Printed so the benchmark is readable in CI output; every field is metadata.
    console.log([banner, ...rows].join("\n"));

    const reports = ids.map((id) => runOf(id).report);
    const jevModelCalls = reports.reduce(
      (total, report) => total + report.modelCalls,
      0,
    );
    const jevRetries = reports.reduce(
      (total, report) => total + report.retryCount,
      0,
    );
    // The baseline: an orchestrator with no decision layer sends every task to a
    // model, once, whatever the task asked for.
    const naiveModelCalls = ids.length;

    console.log(
      [
        `cases: ${ids.length}`,
        `naive model calls (every task -> one call): ${naiveModelCalls}`,
        `JEV-directed model calls: ${jevModelCalls}`,
        `retries spent: ${jevRetries}`,
        `tasks that needed no model: ${
          reports.filter((report) => !report.modelRequired).length
        }`,
        `decisions answered by the provider: ${reports.reduce(
          (total, report) => total + report.decisionsAnsweredByProvider,
          0,
        )}`,
        `decisions answered by code: ${reports.reduce(
          (total, report) => total + report.decisionsAnsweredByCode,
          0,
        )}`,
      ].join("\n"),
    );

    // The efficiency claim, asserted rather than described.
    expect(jevModelCalls).toBeLessThan(naiveModelCalls);
    expect(
      reports.filter((report) => !report.modelRequired).length,
    ).toBeGreaterThan(0);
    // The judgement claim the summary is allowed to make: at least one case had its
    // model *selection* decided by the provider rather than by code's ordering.
    expect(wasDecisionLayerConsulted(runOf("B").report)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never reports a price it was not given, and never invents a metric", async () => {
    const run = await runCase({
      id: "K1",
      prompt:
        "Analyze why the deployment is slow and explain the likely cause.",
      priced: false,
      steps: [
        { content: "The queue is the bottleneck.", usage: FIXTURE_USAGE },
      ],
    });
    const { report } = run;

    // The calls happened and the models simply have no known rate: the report says
    // unpriced and carries no cost field at all, rather than a fabricated zero.
    expect(report.modelCalls).toBe(1);
    expect(report.unpricedCalls).toBe(1);
    expect(report.costMicros).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("costMicros");
  });

  it("carries metadata only — no credential, header, prompt or output text", () => {
    const serialized = JSON.stringify(
      [...runs.values()].map((run) => run.report),
    );
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{6,}/);
    expect(serialized).not.toMatch(/Bearer\s/);
    expect(serialized).not.toMatch(/authorization/i);
    expect(serialized).not.toMatch(/api[_-]?key/i);

    // Benchmark honesty (Test E): every provider-answered decision in this suite
    // records the double's own admission. If any of these were "live-sdk", this
    // file would be claiming an integration it does not perform.
    const providerAnswered = [...runs.values()]
      .flatMap((run) => run.report.decisions)
      .filter(
        (decision) =>
          decision.answeredBy === "provider" &&
          decision.executionSource !== undefined,
      );
    expect(providerAnswered.length).toBeGreaterThan(0);
    for (const decision of providerAnswered) {
      expect(decision.executionSource).toBe("test-double");
    }
    expect(serialized).not.toContain("live-sdk");

    // No content-bearing *key* anywhere in the report. Capability values legitimately
    // include the word "reasoning"; what must never appear is a field that would carry
    // hidden chain-of-thought, a prompt or an output.
    const keys = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (typeof value !== "object" || value === null) {
        return;
      }
      for (const [key, entry] of Object.entries(value)) {
        keys.add(key);
        collect(entry);
      }
    };
    collect([...runs.values()].map((run) => run.report));
    for (const forbidden of [
      "content",
      "prompt",
      "output",
      "reasoning",
      "reasoningDetails",
      "authorization",
      "headers",
      "apiKey",
      "detail",
      "body",
    ]) {
      expect([...keys]).not.toContain(forbidden);
    }
  });

  it("keeps the registry and Frontier out of the decision business", () => {
    // The registry's own object has no API that could choose a model. It answers
    // questions; only the decision layer (or deterministic code ahead of it) chooses.
    const registry = runOf("B").registry;
    for (const forbidden of ["best", "select", "rank", "choose"]) {
      expect(Object.keys(registry)).not.toContain(forbidden);
    }
    const report = runOf("B").report;
    // The executed model is the one the decision layer ranked first, and the step's
    // own record names the layer that chose it.
    expect(report.ranking?.answeredBy).toBe("provider");
    expect(report.selectedModelId).toBe(runOf("B").requests[0]?.modelId);
    expect(report.steps[0]?.answeredBy).toBe("provider");
  });
});
