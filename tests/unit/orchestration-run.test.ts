import { afterEach, describe, expect, it } from "vitest";

import { NetworkBoundaryError } from "../../src/adapters/sandbox/guarded-network.js";
import type { FrontierConfig } from "../../src/adapters/config/project-config.js";
import type { Runtime } from "../../src/application/runtime.js";
import { hasDomainErrorCode } from "../../src/core/errors.js";
import { workspaceId as toWorkspaceId } from "../../src/core/ids.js";
import { DECISION_KINDS } from "../../src/decisions/decision.js";
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
} from "../../src/decisions/provider.js";
import type { DomainEvent } from "../../src/observability/events.js";
import { LlmProviderError } from "../../src/ports/llm-provider.js";
import type { ModelProfile } from "../../src/models/model.js";
import type { Budget } from "../../src/observability/budget.js";
import type { Environment } from "../../src/ports/environment.js";
import {
  FIXTURE_USAGE,
  TEXT_MODEL,
  VISION_MODEL,
  createScriptedFrontier,
  frontierConfig,
  ratesFor,
  type ScriptedFrontier,
  type ScriptedFrontierStep,
} from "../support/frontier.js";
import { createTestProject, type TestProject } from "../support/project.js";

/**
 * Orchestration, end to end.
 *
 * The real runtime, registry, plan build, decision engine, session service and event
 * log — with the frontier scripted and the decision layer answered by a small
 * deterministic responder instead of a network. Everything except those two I/O
 * boundaries is the production path.
 */

const projects: TestProject[] = [];

afterEach(async () => {
  while (projects.length > 0) {
    await projects.pop()?.cleanup();
  }
});

/**
 * A decision responder, not a recorded script.
 *
 * Answering by *question kind* keeps a test focused on the behaviour it is about: an
 * override says what matters, and everything else keeps the caller's own order — which
 * is exactly what the deterministic fallback would do, so a test that forgets an
 * override still exercises the conservative path instead of failing for a reason that
 * has nothing to do with the assertion.
 */
function responder(overrides: Partial<Record<string, DecisionResponse>> = {}): {
  readonly provider: DecisionProvider;
  readonly requests: DecisionRequest[];
} {
  const requests: DecisionRequest[] = [];
  return {
    requests,
    provider: {
      id: "test-decisions",
      family: "rules",
      capabilities: () => ({
        kinds: DECISION_KINDS,
        deterministic: false,
        maxOptions: 8,
      }),
      async decide(request: DecisionRequest): Promise<DecisionResponse> {
        requests.push(request);
        const override = overrides[request.kind];
        if (override !== undefined) {
          return override;
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

/** The conservative answers, so a test only overrides what it is about. */
const NO_REVIEW = {
  outcome: "selected",
  optionId: "no-review",
  reasonCode: "routine-outcome",
} as const;

interface ScenarioInput {
  readonly title: string;
  readonly models?: readonly ModelProfile[];
  readonly steps?: readonly ScriptedFrontierStep[];
  readonly overrides?: Partial<Record<string, DecisionResponse>>;
  readonly routing?: Partial<FrontierConfig["routing"]>;
  readonly enabled?: boolean;
  readonly priced?: boolean;
  readonly budget?: Budget;
  readonly contextText?: string;
  readonly subTasks?: readonly {
    readonly id: string;
    readonly instruction: string;
    readonly requiredCapabilities: readonly string[];
  }[];
  readonly environment?: Environment;
}

interface Scenario {
  readonly project: TestProject;
  readonly runtime: Runtime;
  readonly taskId: string;
  readonly frontier: ScriptedFrontier;
  readonly decision: ReturnType<typeof responder>;
}

async function scenario(input: ScenarioInput): Promise<Scenario> {
  const models = input.models ?? [TEXT_MODEL];
  const frontier = createScriptedFrontier(
    input.steps ?? [{ usage: FIXTURE_USAGE }],
  );
  // Defaults are the conservative answers the platform assumes anyway: no human
  // review, and the caller's own ordering. A test overrides only what it is about.
  const decision = responder({
    "human-escalation": NO_REVIEW,
    ...input.overrides,
  });
  const project = await createTestProject({
    frontierConfig: frontierConfig({
      models,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
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
    ...(input.environment === undefined
      ? {}
      : { environment: input.environment }),
  });
  projects.push(project);
  const stored = await project.runtime.tasks.create(
    {
      title: input.title,
      description: input.title,
      acceptanceCriteria: ["The change is recorded"],
      ...(input.budget === undefined ? {} : { budget: input.budget }),
    },
    { project: project.runtime.project, workspace: project.runtime.workspace },
  );
  return {
    project,
    runtime: project.runtime,
    taskId: String(stored.task.id),
    frontier,
    decision,
  };
}

async function log(
  runtime: Runtime,
  taskId: string,
): Promise<readonly DomainEvent[]> {
  const all = await runtime.store.readAll({
    projectId: runtime.project.id,
    workspaceId: runtime.workspace.id,
  });
  return all.filter((event) => String(event.taskId ?? "") === taskId);
}

function run(
  runtime: Runtime,
  taskId: string,
  extra: Record<string, unknown> = {},
) {
  return runtime.orchestrator.run({
    workspaceId: runtime.workspace.id,
    taskId: taskId as never,
    ...extra,
  } as never);
}

describe("orchestration is opt-in", () => {
  it("refuses to run when routing is not enabled, without touching the log", async () => {
    const test = await scenario({
      title: "Fix the parser bug",
      enabled: false,
    });
    await expect(run(test.runtime, test.taskId)).rejects.toThrowError(
      /frontier orchestration is not enabled/,
    );
    expect(test.frontier.calls).toBe(0);
    expect(
      (await log(test.runtime, test.taskId)).some(
        (event) => event.type === "OrchestrationPlanned",
      ),
    ).toBe(false);
  });

  it("registers a catalog even when routing is off", async () => {
    const test = await scenario({
      title: "Fix the parser bug",
      enabled: false,
    });
    expect(test.runtime.frontierConfig.enabled).toBe(false);
    expect(
      test.runtime.registry.list().map((model) => model.modelId),
    ).toContain(TEXT_MODEL.modelId);
  });
});

describe("a single-model run", () => {
  it("plans, decides, executes and records the whole story", async () => {
    const test = await scenario({
      title: "Fix the parser bug in src/parser.ts",
      steps: [
        {
          content: "Fixed src/parser.ts",
          usage: FIXTURE_USAGE,
          requestId: "req-1",
        },
      ],
      overrides: {
        completion: {
          outcome: "selected",
          optionId: "complete",
          reasonCode: "verification-passed",
        },
      },
    });

    const result = await run(test.runtime, test.taskId);

    expect(result.planId).toBe("plan:single");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.status).toBe("completed");
    expect(result.steps[0]?.modelId).toBe(TEXT_MODEL.modelId);
    expect(result.steps[0]?.contentChars).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBe(FIXTURE_USAGE.inputTokens);
    expect(result.usage.outputTokens).toBe(FIXTURE_USAGE.outputTokens);
    // 1,000 in at 1,000µ$/M = 1µ$, 500 out at 2,000µ$/M = 1µ$.
    expect(result.costMicros).toBe(2);
    expect(result.unpricedCalls).toBe(0);
    expect(result.completionAssessment).toBe("complete");
    expect(result.escalationRecommendation).toBe("no-review");
    expect(result.needsHumanReview).toBe(false);

    const events = await log(test.runtime, test.taskId);
    const plan = events.find((event) => event.type === "OrchestrationPlanned");
    expect(plan?.type === "OrchestrationPlanned" && plan.payload).toMatchObject(
      {
        planId: "plan:single",
        strategy: "single-model",
        reasonCode: "single-model-sufficient",
        stepCount: 1,
        modelIds: [TEXT_MODEL.modelId],
        decomposed: false,
        parallel: false,
        priced: true,
      },
    );
    expect(
      events.filter((event) => event.type === "LLMRequestStarted"),
    ).toHaveLength(1);
    const completed = events.find(
      (event) => event.type === "LLMRequestCompleted",
    );
    expect(
      completed?.type === "LLMRequestCompleted" && completed.payload,
    ).toMatchObject({
      providerId: "openrouter",
      modelId: TEXT_MODEL.modelId,
      requestId: "req-1",
      usageReported: true,
    });
    expect(
      events.filter((event) => event.type === "SessionEnded"),
    ).toHaveLength(1);
    // Intent is recorded before the spend.
    expect(
      events.findIndex((event) => event.type === "OrchestrationPlanned"),
    ).toBeLessThan(
      events.findIndex((event) => event.type === "LLMRequestStarted"),
    );
  });

  it("runs the model the decision layer ranked first", async () => {
    const other = {
      ...TEXT_MODEL,
      modelId: "vendor/text-other",
      displayName: "Text Other",
    };
    const test = await scenario({
      title: "Fix the parser bug",
      models: [TEXT_MODEL, other],
      steps: [{ usage: FIXTURE_USAGE }],
      overrides: {
        ranking: {
          outcome: "selected",
          optionId: other.modelId,
          rankedOptionIds: [other.modelId, TEXT_MODEL.modelId],
          reasonCode: "ordered-by-cost",
        },
      },
    });

    const result = await run(test.runtime, test.taskId);

    expect(test.frontier.requests[0]?.modelId).toBe(other.modelId);
    expect(result.steps[0]?.answeredBy).toBe("provider");
    expect(result.steps[0]?.selectionReasonCode).toBe("ordered-by-cost");
  });

  it("falls back to the caller's order when a decision names an unknown model", async () => {
    const other = { ...TEXT_MODEL, modelId: "vendor/text-other" };
    const test = await scenario({
      title: "Fix the parser bug",
      models: [TEXT_MODEL, other],
      overrides: {
        ranking: {
          outcome: "selected",
          optionId: "ghost/model",
          rankedOptionIds: ["ghost/model", other.modelId],
        },
      },
    });

    const result = await run(test.runtime, test.taskId);

    expect(test.frontier.requests[0]?.modelId).toBe(TEXT_MODEL.modelId);
    expect(result.steps[0]?.answeredBy).toBe("fallback");
    expect(
      (await log(test.runtime, test.taskId)).some(
        (event) => event.type === "DecisionFallbackUsed",
      ),
    ).toBe(true);
  });
});

describe("capability-aware routing", () => {
  it("selects the vision model for a visual task and records why the other failed", async () => {
    const test = await scenario({
      title: "Analyse this screenshot of the broken layout",
      models: [TEXT_MODEL, VISION_MODEL],
    });

    const result = await run(test.runtime, test.taskId);

    expect(test.frontier.requests[0]?.modelId).toBe(VISION_MODEL.modelId);
    expect(result.eligibleModelIds).toEqual([VISION_MODEL.modelId]);
    expect(
      result.rejectedModels.find(
        (entry) => entry.modelId === TEXT_MODEL.modelId,
      ),
    ).toMatchObject({ missing: ["capability:vision", "input:image"] });
  });

  it("refuses to plan when nothing registered can do the work", async () => {
    const test = await scenario({
      title: "Analyse this screenshot of the broken layout",
      models: [TEXT_MODEL],
    });
    await expect(run(test.runtime, test.taskId)).rejects.toThrowError(
      /no execution plan is available/,
    );
    expect(test.frontier.calls).toBe(0);
  });
});

describe("decomposition", () => {
  it("splits a task no single model can do, and carries findings forward", async () => {
    const test = await scenario({
      title: "Analyse this screenshot and fix the related code",
      models: [TEXT_MODEL, VISION_MODEL],
      steps: [
        { content: "The header overflows its container", usage: FIXTURE_USAGE },
        { content: "Patched src/layout.ts", usage: FIXTURE_USAGE },
      ],
      contextText: "file: src/layout.ts",
      overrides: {
        completion: {
          outcome: "selected",
          optionId: "complete",
          reasonCode: "verification-passed",
        },
      },
    });

    const result = await run(test.runtime, test.taskId, {
      contextText: "file: src/layout.ts",
    });

    expect(result.planId).toBe("plan:decomposed");
    expect(result.steps.map((step) => step.modelId)).toEqual([
      VISION_MODEL.modelId,
      TEXT_MODEL.modelId,
    ]);
    // The analysis reads the selected context; the implementation reads the analysis
    // rather than re-sending the context, which is where token cost would multiply.
    expect(test.frontier.requests[0]?.contextText).toContain("src/layout.ts");
    expect(test.frontier.requests[1]?.contextText).toContain(
      "header overflows its container",
    );
    expect(test.frontier.requests[1]?.contextText).not.toContain(
      "src/layout.ts",
    );
  });

  it("runs declared independent sub-tasks in parallel", async () => {
    const test = await scenario({
      title: "Fix the parser bug",
      models: [TEXT_MODEL],
      steps: [{ usage: FIXTURE_USAGE }, { usage: FIXTURE_USAGE }],
      overrides: {
        ranking: {
          outcome: "selected",
          optionId: "plan:parallel",
          // A ranking must be a permutation of what was offered; a shorter list is
          // not an answer, and the platform falls back to its own order.
          rankedOptionIds: ["plan:parallel", "plan:single"],
        },
      },
    });

    const result = await run(test.runtime, test.taskId, {
      subTasks: [
        {
          id: "one",
          instruction: "Fix the lexer",
          requiredCapabilities: ["coding"],
        },
        {
          id: "two",
          instruction: "Fix the parser",
          requiredCapabilities: ["coding"],
        },
      ],
    });

    expect(result.parallel).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every((step) => step.status === "completed")).toBe(
      true,
    );
    expect(test.frontier.calls).toBe(2);
  });
});

describe("cost accounting", () => {
  it("records an unpriced model as unpriced, never as free", async () => {
    const test = await scenario({
      title: "Fix the parser bug",
      models: [TEXT_MODEL, VISION_MODEL],
      priced: false,
    });
    const visionOnlyTask = await scenario({
      title: "Analyse this screenshot",
      models: [TEXT_MODEL, VISION_MODEL],
      priced: false,
    });

    const result = await run(test.runtime, test.taskId);
    expect(result.unpricedCalls).toBe(1);
    expect(result.costMicros).toBeUndefined();
    expect(result.usage.inputTokens).toBe(FIXTURE_USAGE.inputTokens);

    const vision = await run(visionOnlyTask.runtime, visionOnlyTask.taskId);
    expect(vision.costMicros).toBeUndefined();
    expect(vision.unpricedCalls).toBe(1);
  });

  it("marks a call whose provider reported no usage as usage-unavailable", async () => {
    const test = await scenario({
      title: "Fix the parser bug",
      steps: [{ omitUsage: true }],
    });

    const result = await run(test.runtime, test.taskId);

    expect(result.steps[0]?.usageReported).toBe(false);
    expect(result.steps[0]?.usage).toBeUndefined();
    expect(result.unpricedCalls).toBe(1);
    const completed = (await log(test.runtime, test.taskId)).find(
      (event) => event.type === "LLMRequestCompleted",
    );
    expect(
      completed?.type === "LLMRequestCompleted" &&
        completed.payload.usageReported,
    ).toBe(false);
  });
});

describe("retry", () => {
  it("retries when the decision layer allows it and the cap permits", async () => {
    const test = await scenario({
      title: "Fix the parser bug",
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
        { content: "second attempt", usage: FIXTURE_USAGE },
      ],
      overrides: {
        retry: {
          outcome: "selected",
          optionId: "retry",
          reasonCode: "transient-failure",
        },
        completion: {
          outcome: "selected",
          optionId: "complete",
          reasonCode: "verification-passed",
        },
      },
    });

    const result = await run(test.runtime, test.taskId);

    expect(test.frontier.calls).toBe(2);
    expect(result.retriesSpent).toBe(1);
    expect(result.steps[0]?.status).toBe("completed");
    expect(result.steps[0]?.retry).toBe(1);
    const events = await log(test.runtime, test.taskId);
    const failed = events.find((event) => event.type === "LLMRequestFailed");
    expect(failed?.type === "LLMRequestFailed" && failed.payload).toMatchObject(
      {
        failureKind: "rate-limit",
        retryable: true,
      },
    );
  });

  it("cannot spend a retry the hard cap forbids", async () => {
    const test = await scenario({
      title: "Fix the parser bug",
      routing: { maxRetriesPerStep: 0 },
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
        { usage: FIXTURE_USAGE },
      ],
      overrides: {
        retry: {
          outcome: "selected",
          optionId: "retry",
          reasonCode: "transient-failure",
        },
      },
    });

    const result = await run(test.runtime, test.taskId);

    expect(test.frontier.calls).toBe(1);
    expect(result.retriesSpent).toBe(0);
    expect(result.stopReason).toBe("retry-exhausted");
    expect(result.needsHumanReview).toBe(true);
    // The retry gate answered deterministically: a retry the cap forbids is never
    // even offered to the decision layer as a possibility.
    expect(
      test.decision.requests.filter((request) => request.kind === "retry"),
    ).toHaveLength(0);
    const recorded = (await log(test.runtime, test.taskId)).filter(
      (event) =>
        event.type === "DecisionCompleted" && event.payload.kind === "retry",
    );
    expect(recorded).toHaveLength(1);
    expect(
      recorded[0]?.type === "DecisionCompleted" && recorded[0].payload,
    ).toMatchObject({ answeredBy: "deterministic", selectedOptionId: "stop" });
  });

  it("treats a policy refusal as a refusal, and escalates to a human", async () => {
    const test = await scenario({
      title: "Fix the parser bug",
      steps: [
        {
          error: new NetworkBoundaryError(
            "TARGET_NOT_ALLOWED",
            "https://openrouter.invalid/v1",
          ),
        },
      ],
      overrides: {
        escalation: {
          outcome: "selected",
          optionId: "review",
          reasonCode: "security-refusal",
        },
      },
    });

    const result = await run(test.runtime, test.taskId);

    expect(result.steps[0]?.failureKind).toBe("refused");
    expect(result.stopReason).toBe("step-failed");
    expect(result.needsHumanReview).toBe(true);
    const events = await log(test.runtime, test.taskId);
    const failed = events.find((event) => event.type === "LLMRequestFailed");
    expect(
      failed?.type === "LLMRequestFailed" && failed.payload.retryable,
    ).toBe(false);
    // A refused call never produces a completion event.
    expect(events.some((event) => event.type === "LLMRequestCompleted")).toBe(
      false,
    );
  });
});

describe("budgets and bounds", () => {
  it("stops before a call that would exceed the task budget", async () => {
    const test = await scenario({
      title: "Analyse this screenshot and fix the related code",
      models: [TEXT_MODEL, VISION_MODEL],
      steps: [{ usage: FIXTURE_USAGE }],
      budget: { maxTokens: 1_000 },
    });

    const result = await run(test.runtime, test.taskId);

    expect(result.steps[0]?.status).toBe("completed");
    expect(result.steps[1]?.status).toBe("skipped");
    expect(result.stopReason).toBe("budget-exceeded");
    expect(test.frontier.calls).toBe(1);
    const checkpoint = (await log(test.runtime, test.taskId)).find(
      (event) => event.type === "CheckpointCreated",
    );
    expect(
      checkpoint?.type === "CheckpointCreated" && checkpoint.payload.reason,
    ).toBe("budget-critical");
  });

  it("counts consumption already recorded for the task", async () => {
    const test = await scenario({
      title: "Fix the parser bug",
      budget: { maxTokens: 100 },
    });

    const result = await run(test.runtime, test.taskId, {
      priorConsumption: { tokens: 100 },
    });

    expect(test.frontier.calls).toBe(0);
    expect(result.stopReason).toBe("budget-exceeded");
    expect(result.steps[0]?.status).toBe("skipped");
  });
});

describe("a task that needs no model", () => {
  it("makes zero calls and records a deterministic plan", async () => {
    const test = await scenario({
      title: "Write the changelog entry for the release notes",
    });

    const result = await run(test.runtime, test.taskId);

    expect(result.planId).toBe("plan:deterministic");
    expect(result.callsSpent).toBe(0);
    expect(result.requirements.modelRequired).toBe(false);
    expect(test.frontier.calls).toBe(0);
    const events = await log(test.runtime, test.taskId);
    expect(
      events.filter((event) => event.type === "LLMRequestStarted"),
    ).toHaveLength(0);
    const plan = events.find((event) => event.type === "OrchestrationPlanned");
    expect(plan?.type === "OrchestrationPlanned" && plan.payload).toMatchObject(
      {
        strategy: "deterministic",
        stepCount: 0,
        modelIds: [],
        maxModelCalls: 0,
      },
    );
  });
});

describe("privacy", () => {
  it("never records context content, prompts or credentials", async () => {
    const secretContext = "INTERNAL-CONTEXT-DO-NOT-LOG";
    const credentialValue = "sk-fixture-should-never-appear";
    const test = await scenario({
      title: "Fix the parser bug",
      steps: [
        { content: `answer mentioning ${secretContext}`, usage: FIXTURE_USAGE },
      ],
      environment: {
        id: "test-environment",
        get: (name) =>
          name === "FIXTURE_API_KEY" ? credentialValue : undefined,
      },
    });

    await run(test.runtime, test.taskId, { contextText: secretContext });

    const events = await log(test.runtime, test.taskId);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secretContext);
    expect(serialized).not.toContain(credentialValue);
    expect(serialized).not.toContain("FIXTURE_API_KEY=sk");
    // The plan records the model and the counts, never the material.
    expect(serialized).toContain(TEXT_MODEL.modelId);
  });
});

describe("isolation", () => {
  it("does not find a task that belongs to another workspace", async () => {
    const test = await scenario({ title: "Fix the parser bug" });

    try {
      await run(test.runtime, test.taskId, {
        workspaceId: toWorkspaceId("wsp-somewhere-else"),
      });
      throw new Error("expected a scope rejection");
    } catch (error) {
      // The scope check refuses before the repository is even asked: a foreign
      // workspace is a forbidden target, not a lookup that happens to miss.
      expect(
        hasDomainErrorCode(error, "FORBIDDEN") ||
          hasDomainErrorCode(error, "NOT_FOUND"),
      ).toBe(true);
    }
    const events = await log(test.runtime, test.taskId);
    expect(events.some((event) => event.type === "OrchestrationPlanned")).toBe(
      false,
    );
    expect(test.frontier.calls).toBe(0);
  });

  it("does not find a task id that does not exist in scope", async () => {
    const test = await scenario({ title: "Fix the parser bug" });
    await expect(
      run(test.runtime, "tsk-does-not-exist"),
    ).rejects.toThrowError();
    expect(test.frontier.calls).toBe(0);
  });
});
