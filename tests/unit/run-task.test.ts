import { afterEach, describe, expect, it } from "vitest";

import { createRunTask } from "../../src/application/run-task.js";
import type { Policy } from "../../src/decisions/policy.js";
import { createManualClock } from "../../src/core/clock.js";
import type { Clock } from "../../src/core/clock.js";
import { DomainError, hasDomainErrorCode } from "../../src/core/errors.js";
import { workspaceId } from "../../src/core/ids.js";
import type { WorkspaceId } from "../../src/core/ids.js";
import type { StoredTask } from "../../src/ports/task-repository.js";
import {
  createTestProject,
  createTickingClock,
  type TestProject,
} from "../support/project.js";

/**
 * The vertical slice, end to end: a task is created, run once, and every step it
 * produced is verified through the trace rather than through in-memory state.
 */
const projects: TestProject[] = [];

async function project(options?: {
  readonly includeRetry?: boolean;
  readonly clock?: Clock;
}): Promise<TestProject> {
  const created = await createTestProject({
    clock: options?.clock ?? createTickingClock(),
    ...(options?.includeRetry === undefined
      ? {}
      : { includeRetry: options.includeRetry }),
  });
  projects.push(created);
  return created;
}

async function createTask(
  subject: TestProject,
  input: {
    readonly title?: string;
    readonly riskLevel?: "low" | "medium" | "high" | "critical";
    readonly maxTokens?: number;
    readonly maxCostMicros?: number;
  } = {},
): Promise<StoredTask> {
  return subject.runtime.tasks.create(
    {
      title: input.title ?? "Add retry to the deploy poller",
      description: "Bound the retries and back off between attempts.",
      acceptanceCriteria: ["Retries are bounded"],
      ...(input.riskLevel === undefined ? {} : { riskLevel: input.riskLevel }),
      budget: {
        ...(input.maxTokens === undefined
          ? {}
          : { maxTokens: input.maxTokens }),
        ...(input.maxCostMicros === undefined
          ? {}
          : { maxCostMicros: input.maxCostMicros }),
      },
    },
    { project: subject.runtime.project, workspace: subject.runtime.workspace },
  );
}

function scopeOf(subject: TestProject) {
  return {
    projectId: subject.runtime.project.id,
    workspaceId: subject.runtime.workspace.id,
  };
}

afterEach(async () => {
  while (projects.length > 0) {
    await projects.pop()?.cleanup();
  }
});

describe("run: the recorded lifecycle", () => {
  it("drives created -> planning -> in_progress -> verification -> review", async () => {
    const subject = await project();
    const stored = await createTask(subject);
    const result = await subject.runtime.runTask.run(stored);

    expect(result.outcome).toBe("awaiting-review");
    expect(result.task.status).toBe("review");
    expect(result.session?.status).toBe("completed");

    const events = await subject.runtime.store.readByTask(
      scopeOf(subject),
      stored.task.id,
    );
    expect(events.map((event) => event.type)).toEqual([
      "TaskCreated",
      "DecisionRequested",
      "DecisionCompleted",
      "TaskStatusChanged",
      "TaskStarted",
      "TaskStatusChanged",
      "SessionStarted",
      "ContextSelectionStarted",
      "ContextSelected",
      // The attempt's capability envelope, then the one operation it performs.
      // Enforcement events are written when the operation is *requested*, which for
      // a runner that reports its steps afterwards means they land before the model
      // turns they surround; `occurredAt` is the wall-clock order (see the trace
      // section of README).
      "CapabilitiesDeclared",
      // Two bounded questions before the attempt does any work: the route it takes
      // and the tool it uses. Both are answered by code here, and both are recorded,
      // because "why did this task run the way it did" has to be answerable from the
      // log rather than inferred.
      "DecisionRequested",
      "DecisionCompleted",
      "DecisionRequested",
      "DecisionCompleted",
      "CapabilityCheckRequested",
      "CapabilityCheckCompleted",
      "OperationStarted",
      "OperationCompleted",
      "LLMRequestStarted",
      "LLMRequestCompleted",
      // The per-step risk assessment, then the policy effect it fed — the same
      // evaluation the platform performed before a decision layer existed.
      "DecisionRequested",
      "DecisionCompleted",
      "DecisionRequested",
      "DecisionCompleted",
      "ToolCallStarted",
      "ToolCallCompleted",
      "TestStarted",
      "TestCompleted",
      "TaskStatusChanged",
      // Closings questions: does the evidence suggest completion, and should a human
      // review the outcome. Neither can change the task state on its own.
      "DecisionRequested",
      "DecisionCompleted",
      "DecisionRequested",
      "DecisionCompleted",
      "SessionEnded",
      "TaskStatusChanged",
    ]);
  });

  it("records the status chain in order, ending at review", async () => {
    const subject = await project();
    const stored = await createTask(subject);
    await subject.runtime.runTask.run(stored);

    const events = await subject.runtime.store.readByTask(
      scopeOf(subject),
      stored.task.id,
    );
    const chain = events
      .filter((event) => event.type === "TaskStatusChanged")
      .map((event) => `${event.payload.from}->${event.payload.to}`);
    expect(chain).toEqual([
      "created->planning",
      "planning->in_progress",
      "in_progress->verification",
      "verification->review",
    ]);
  });

  it("records the session and its steps against both the task and the session", async () => {
    const subject = await project();
    const stored = await createTask(subject);
    const result = await subject.runtime.runTask.run(stored);
    const session = result.session;
    if (session === undefined) {
      throw new Error("expected the run to open a session");
    }

    const bySession = await subject.runtime.store.readBySession(
      scopeOf(subject),
      session.id,
    );
    expect(bySession.length).toBeGreaterThan(0);
    for (const event of bySession) {
      expect(event.taskId).toBe(stored.task.id);
      expect(event.correlationId).toContain(stored.task.id);
    }
  });

  it("records exactly one iteration, one tool call and one verification run", async () => {
    const subject = await project();
    const stored = await createTask(subject);
    await subject.runtime.runTask.run(stored);

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.metrics.llmCalls).toBe(1);
    expect(trace.metrics.iterations).toBe(1);
    expect(trace.metrics.retries).toBe(0);
    expect(trace.metrics.toolCalls).toBe(1);
    expect(trace.tests).toHaveLength(1);
    expect(trace.tests[0].failed).toBe(0);
    expect(trace.integrity.ok).toBe(true);
  });

  it("counts a retried turn as a retry, not as an iteration", async () => {
    const subject = await project({ includeRetry: true });
    const stored = await createTask(subject);
    await subject.runtime.runTask.run(stored);

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.metrics.llmCalls).toBe(2);
    expect(trace.metrics.iterations).toBe(1);
    expect(trace.metrics.retries).toBe(1);
    expect(trace.sessions[0].llmCalls).toBe(2);
    expect(trace.sessions[0].iterations).toBe(1);
  });
});

describe("run: usage and cost are derived from the recorded events", () => {
  it("reports the provider's own token counts and measured latency", async () => {
    const subject = await project();
    const stored = await createTask(subject);
    await subject.runtime.runTask.run(stored);

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    // The offline provider's first canned turn: 1240 input, 320 output.
    expect(trace.metrics.inputTokens).toBe(1240);
    expect(trace.metrics.outputTokens).toBe(320);
    expect(trace.metrics.totalTokens).toBe(1560);
    // The ticking clock makes latency measurable without the wall clock.
    expect(trace.metrics.llmLatencyMs).toBeGreaterThan(0);
    expect(trace.llmCalls[0].latencyMs).toBeGreaterThan(0);
  });

  it("prices the run from the configured rate table", async () => {
    const subject = await project();
    const stored = await createTask(subject);
    await subject.runtime.runTask.run(stored);

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.metrics.costComplete).toBe(true);
    expect(trace.metrics.cost.micros).toBe(8520);
  });

  it("records an elapsed duration once the task leaves the log open", async () => {
    const subject = await project();
    const stored = await createTask(subject);
    await subject.runtime.runTask.run(stored);
    const reviewed = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );

    // `review` is not terminal, so the metrics duration is intentionally open...
    expect(reviewed.metrics.open).toBe(true);

    // ...and becomes a real duration once a human closes the task.
    const loaded = await subject.runtime.tasks.load(
      scopeOf(subject),
      stored.task.id,
    );
    await subject.runtime.tasks.complete(loaded, "reviewed");
    const completed = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(completed.status).toBe("completed");
    expect(completed.terminal).toBe(true);
    expect(completed.metrics.open).toBe(false);
    expect(completed.metrics.durationMs).toBeGreaterThan(0);
  });

  it("keeps the record and the event log in agreement", async () => {
    const subject = await project();
    const stored = await createTask(subject);
    await subject.runtime.runTask.run(stored);

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.record?.task.status).toBe(trace.status);
    expect(trace.integrity.ok).toBe(true);
  });
});

describe("run: gates", () => {
  it("requires human approval for a high risk task, before any work", async () => {
    const subject = await project();
    const stored = await createTask(subject, { riskLevel: "high" });
    const result = await subject.runtime.runTask.run(stored);

    expect(result.outcome).toBe("awaiting-approval");
    // Nothing was attempted, so the task is untouched.
    expect(result.task.status).toBe("created");
    expect(result.session).toBeUndefined();

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.metrics.llmCalls).toBe(0);
    expect(trace.metrics.totalTokens).toBe(0);
    expect(trace.metrics.escalations).toBe(1);
    expect(trace.sessions).toEqual([]);
    expect(trace.approvals).toHaveLength(1);
    expect(trace.approvals[0].riskLevel).toBe("high");
    expect(trace.approvals[0].grantedAt).toBeUndefined();
    expect(trace.integrity.ok).toBe(true);
  });

  it("stops the attempt when the token budget is exhausted", async () => {
    const subject = await project();
    const stored = await createTask(subject, { maxTokens: 1000 });
    const result = await subject.runtime.runTask.run(stored);

    expect(result.outcome).toBe("budget-exceeded");
    expect(result.task.status).toBe("failed");
    expect(result.session?.status).toBe("aborted");
    expect(result.reason).toContain("tokens");

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.budget.exceeded).toBe(true);
    // The tokens that were spent are still recorded, not discarded.
    expect(trace.metrics.totalTokens).toBe(1560);
    expect(trace.metrics.cost.micros).toBe(8520);
    // And the tool call after the failed gate never happened.
    expect(trace.metrics.toolCalls).toBe(0);
  });

  it("stops the attempt when the cost budget is exhausted", async () => {
    const subject = await project();
    const stored = await createTask(subject, { maxCostMicros: 100 });
    const result = await subject.runtime.runTask.run(stored);

    expect(result.outcome).toBe("budget-exceeded");
    expect(result.task.status).toBe("failed");
    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.budget.exceeded).toBe(true);
    expect(
      trace.budget.dimensions.find(
        (dimension) => dimension.dimension === "cost",
      )?.consumed,
    ).toBe(8520);
  });

  it("denies a step the policy refuses, and records the refusal", async () => {
    const subject = await project();
    const stored = await createTask(subject);
    const denying: Policy = {
      id: "policy-deny-all",
      name: "Deny all operations",
      version: 1,
      defaultEffect: "deny",
      rules: [],
    };
    const runTask = createRunTask({
      tasks: subject.runtime.tasks,
      sessions: subject.runtime.sessions,
      decisions: subject.runtime.decisions,
      approvals: subject.runtime.approvals,
      ledger: subject.runtime.ledger,
      context: subject.runtime.context,
      contextConfig: subject.runtime.contextConfig,
      runner: subject.runtime.runner,
      policy: denying,
      workspace: subject.runtime.workspace,
      rates: subject.runtime.modelRates,
      clock: createManualClock("2026-09-20T10:00:00.000Z"),
      providerId: subject.runtime.providerId,
      modelId: subject.runtime.modelId,
      // The real enforcement boundary, so a step that is denied by the risk policy
      // is still evaluated by the capability layer exactly as it is in production.
      operations: subject.runtime.operations,
      recorder: subject.runtime.recorder,
      decisionLayer: subject.runtime.decisionLayer,
    });

    const result = await runTask.run(stored);
    expect(result.outcome).toBe("policy-denied");
    expect(result.task.status).toBe("failed");
    expect(result.session?.status).toBe("aborted");

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.metrics.toolCalls).toBe(0);
    expect(
      trace.decisions.find((decision) => decision.kind === "policy")
        ?.selectedOptionId,
    ).toBe("deny");
  });

  it("requests approval when policy demands it mid-attempt, and leaves the task open", async () => {
    const subject = await project();
    const stored = await createTask(subject);
    const cautious: Policy = {
      id: "policy-approve-all",
      name: "Approve every operation",
      version: 1,
      defaultEffect: "require-approval",
      rules: [],
    };
    const runTask = createRunTask({
      tasks: subject.runtime.tasks,
      sessions: subject.runtime.sessions,
      decisions: subject.runtime.decisions,
      approvals: subject.runtime.approvals,
      ledger: subject.runtime.ledger,
      context: subject.runtime.context,
      contextConfig: subject.runtime.contextConfig,
      runner: subject.runtime.runner,
      policy: cautious,
      workspace: subject.runtime.workspace,
      rates: subject.runtime.modelRates,
      clock: createManualClock("2026-09-20T10:00:00.000Z"),
      providerId: subject.runtime.providerId,
      modelId: subject.runtime.modelId,
      // The real enforcement boundary, so a step that is denied by the risk policy
      // is still evaluated by the capability layer exactly as it is in production.
      operations: subject.runtime.operations,
      recorder: subject.runtime.recorder,
      decisionLayer: subject.runtime.decisionLayer,
    });

    const result = await runTask.run(stored);
    expect(result.outcome).toBe("awaiting-approval");
    expect(result.task.status).toBe("in_progress");
    expect(result.session?.status).toBe("aborted");

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.approvals).toHaveLength(1);
    expect(trace.approvals[0].operation).toBe("read");
    // The model turn before the gate still counts.
    expect(trace.metrics.llmCalls).toBe(1);
    expect(trace.integrity.ok).toBe(true);
  });

  it("does not let a task with no acceptance criteria pass verification", async () => {
    const subject = await project();
    const stored = await subject.runtime.tasks.create(
      { title: "Unverifiable task", description: "No acceptance criteria" },
      {
        project: subject.runtime.project,
        workspace: subject.runtime.workspace,
      },
    );
    const result = await subject.runtime.runTask.run(stored);

    // A task with nothing to verify against is not verified (see acceptanceSummary
    // and docs/architecture/V2-ARCHITECTURE.md §18).
    expect(result.outcome).toBe("verification-failed");
    expect(result.task.status).toBe("failed");
  });

  it("fails the task when verification reports a failing check", async () => {
    const subject = await project();
    const stored = await createTask(subject);
    const failing = {
      id: "failing-runner",
      kind: "simulated" as const,
      attempt: async () => ({
        steps: [
          {
            kind: "test" as const,
            suite: "task-contract",
            passed: 0,
            failed: 1,
            durationMs: 5,
          },
        ],
      }),
    };
    const runTask = createRunTask({
      tasks: subject.runtime.tasks,
      sessions: subject.runtime.sessions,
      decisions: subject.runtime.decisions,
      approvals: subject.runtime.approvals,
      ledger: subject.runtime.ledger,
      context: subject.runtime.context,
      contextConfig: subject.runtime.contextConfig,
      runner: failing,
      policy: subject.runtime.policy,
      workspace: subject.runtime.workspace,
      rates: subject.runtime.modelRates,
      clock: createManualClock("2026-09-20T10:00:00.000Z"),
      providerId: subject.runtime.providerId,
      modelId: subject.runtime.modelId,
      // The real enforcement boundary, so a step that is denied by the risk policy
      // is still evaluated by the capability layer exactly as it is in production.
      operations: subject.runtime.operations,
      recorder: subject.runtime.recorder,
      decisionLayer: subject.runtime.decisionLayer,
    });

    const result = await runTask.run(stored);
    expect(result.outcome).toBe("verification-failed");
    expect(result.task.status).toBe("failed");
    expect(result.session?.status).toBe("failed");

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.status).toBe("failed");
    expect(trace.tests[0].failed).toBe(1);
    // The task honestly reached verification before failing.
    expect(
      trace.events.some(
        (event) =>
          event.type === "TaskStatusChanged" &&
          event.payload.to === "verification",
      ),
    ).toBe(true);
  });
});

describe("run: isolation", () => {
  it("refuses to run a task belonging to another workspace", async () => {
    const subject = await project();
    const stored = await createTask(subject);
    const foreign: StoredTask = {
      version: stored.version,
      task: {
        ...stored.task,
        workspaceId: workspaceId("wsp-elsewhere") as WorkspaceId,
      },
    };

    await expect(subject.runtime.runTask.run(foreign)).rejects.toSatisfy(
      (error) => hasDomainErrorCode(error, "FORBIDDEN"),
    );
    expect(DomainError).toBeDefined();
  });

  it("leaves the log untouched when a run is refused", async () => {
    const subject = await project();
    const stored = await createTask(subject);
    const before = await subject.runtime.store.readAll(scopeOf(subject));

    await expect(
      subject.runtime.runTask.run({
        version: stored.version,
        task: {
          ...stored.task,
          workspaceId: workspaceId("wsp-elsewhere") as WorkspaceId,
        },
      }),
    ).rejects.toThrow();

    const after = await subject.runtime.store.readAll(scopeOf(subject));
    expect(after).toHaveLength(before.length);
  });
});
