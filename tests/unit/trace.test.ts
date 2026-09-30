import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "../../src/core/clock.js";
import { createManualClock } from "../../src/core/clock.js";
import { hasDomainErrorCode } from "../../src/core/errors.js";
import { sessionId, taskId } from "../../src/core/ids.js";
import type {
  ProjectId,
  SessionId,
  TaskId,
  WorkspaceId,
} from "../../src/core/ids.js";
import type { ProjectScope, WorkspaceScope } from "../../src/ports/scope.js";
import type { DomainEvent } from "../../src/observability/events.js";
import {
  type EventContext,
  approvalGranted,
  approvalRequested,
  decisionCompleted,
  decisionRequested,
  llmCompleted,
  llmStarted,
  sessionEnded,
  sessionStarted,
  taskCompleted,
  taskCreated,
  taskStatusChanged,
  testCompleted,
  toolCompleted,
  toolStarted,
} from "../support/events.js";
import {
  FIXED_INSTANT,
  createTestProject,
  type TestProject,
} from "../support/project.js";

const PROVIDER = "deterministic";
const MODEL = "deterministic-1";

const projects: TestProject[] = [];

afterEach(async () => {
  while (projects.length > 0) {
    await projects.pop()?.cleanup();
  }
});

interface Scenario {
  readonly project: TestProject;
  readonly task: TaskId;
  readonly session: SessionId;
  readonly context: EventContext;
  readonly scope: WorkspaceScope;
}

/**
 * A complete, hand-built task history: planning, one session, a priced model turn,
 * a retried second turn, a policy decision, a tool call, a verification run, and a
 * human-approved close. Times advance one second per step, so every duration in the
 * assertions is exact.
 */
async function buildScenario(): Promise<Scenario> {
  const clock = createManualClock(FIXED_INSTANT);
  const project = await createTestProject({ clock });
  projects.push(project);

  const context: EventContext = {
    clock,
    projectId: project.runtime.project.id,
    workspaceId: project.runtime.workspace.id,
  };
  const task = taskId("tsk-trace-1");
  const session = sessionId("ses-trace-1");
  const scope: WorkspaceScope = {
    projectId: project.runtime.project.id as ProjectId,
    workspaceId: project.runtime.workspace.id as WorkspaceId,
  };

  const events: DomainEvent[] = [];
  let sequence = 1;
  const next = (): number => sequence++;

  events.push(taskCreated(context, next(), task, "Add retry to the poller"));
  events.push(
    decisionRequested(
      context,
      next(),
      task,
      "escalation",
      'May task "tsk-trace-1" run without approval?',
    ),
  );
  events.push(
    decisionCompleted(context, next(), task, {
      decisionId: "dec-1",
      kind: "escalation",
      outcome: "selected",
      decidedBy: "code",
      selectedOptionId: "proceed",
    }),
  );

  clock.advance(1000);
  events.push(taskStatusChanged(context, next(), task, "created", "planning"));
  events.push(
    taskStatusChanged(context, next(), task, "planning", "in_progress"),
  );

  clock.advance(1000);
  events.push(sessionStarted(context, next(), task, session, "local-agent"));

  clock.advance(1000);
  events.push(llmStarted(context, next(), task, session, PROVIDER, MODEL, 2));
  events.push(
    llmCompleted(context, next(), task, session, {
      providerId: PROVIDER,
      modelId: MODEL,
      usage: { inputTokens: 1240, outputTokens: 320, cachedInputTokens: 0 },
      latencyMs: 1000,
      retry: 0,
    }),
  );

  clock.advance(1000);
  events.push(
    decisionRequested(
      context,
      next(),
      task,
      "policy",
      'What policy effect applies to operation "read"?',
      4,
    ),
  );
  events.push(
    decisionCompleted(context, next(), task, {
      decisionId: "dec-2",
      kind: "policy",
      outcome: "selected",
      decidedBy: "policy",
      selectedOptionId: "verify",
    }),
  );

  clock.advance(1000);
  events.push(
    toolStarted(context, next(), task, session, "list-files", "read"),
  );
  events.push(
    toolCompleted(context, next(), task, session, "list-files", true, 12),
  );

  clock.advance(1000);
  events.push(llmStarted(context, next(), task, session, PROVIDER, MODEL, 3));
  events.push(
    llmCompleted(context, next(), task, session, {
      providerId: PROVIDER,
      modelId: MODEL,
      usage: { inputTokens: 2180, outputTokens: 460, cachedInputTokens: 1024 },
      latencyMs: 150,
      retry: 1,
    }),
  );

  clock.advance(1000);
  events.push(
    testCompleted(context, next(), task, session, "task-contract", 2, 0, 30),
  );

  clock.advance(1000);
  events.push(
    taskStatusChanged(context, next(), task, "in_progress", "verification"),
  );
  events.push(
    taskStatusChanged(context, next(), task, "verification", "review"),
  );
  events.push(sessionEnded(context, next(), task, session, "completed"));

  clock.advance(1000);
  events.push(approvalRequested(context, next(), task, "apr-1", "medium"));
  events.push(approvalGranted(context, next(), task, "apr-1", "maintainer"));

  clock.advance(1000);
  events.push(taskStatusChanged(context, next(), task, "review", "completed"));
  events.push(taskCompleted(context, next(), task, 0, 1));

  await project.runtime.store.appendMany(events);
  return { project, task, session, context, scope };
}

async function traceOf(scenario: Scenario) {
  return scenario.project.runtime.traces.read(
    scenario.scope as WorkspaceScope,
    scenario.task,
  );
}

describe("trace reconstruction: task identity and status", () => {
  it("derives task metadata and lifecycle from events alone", async () => {
    const scenario = await buildScenario();
    const trace = await traceOf(scenario);

    expect(trace.taskId).toBe(scenario.task);
    expect(trace.title).toBe("Add retry to the poller");
    expect(trace.riskLevel).toBe("medium");
    expect(trace.status).toBe("completed");
    expect(trace.terminal).toBe(true);
    expect(trace.projectId).toBe(scenario.scope.projectId);
    expect(trace.workspaceId).toBe(scenario.scope.workspaceId);
    expect(trace.events).toHaveLength(22);
  });

  it("computes the elapsed span from the first and last event", async () => {
    const scenario = await buildScenario();
    const trace = await traceOf(scenario);

    // Step 1 is emitted at t0 and the last step advances by 1s each time.
    expect(trace.firstEventAt).toBe(FIXED_INSTANT);
    expect(trace.endedAt).toBeDefined();
    expect(trace.elapsedMs).toBeGreaterThan(0);
    expect(trace.elapsedMs).toBe(
      Date.parse(trace.lastEventAt as string) -
        Date.parse(trace.firstEventAt as string),
    );
  });

  it("returns a well-formed empty trace for a task with no events", async () => {
    const scenario = await buildScenario();
    const trace = await scenario.project.runtime.traces.read(
      scenario.scope,
      taskId("tsk-unknown"),
    );

    expect(trace.events).toEqual([]);
    expect(trace.status).toBe("created");
    expect(trace.terminal).toBe(false);
    expect(trace.metrics.llmCalls).toBe(0);
    expect(trace.metrics.open).toBe(true);
    expect(trace.integrity.ok).toBe(true);
  });

  it("does not include another task's events", async () => {
    const scenario = await buildScenario();
    await scenario.project.runtime.store.append(
      taskStatusChanged(
        scenario.context,
        300,
        taskId("tsk-other"),
        "created",
        "planning",
      ),
    );

    const trace = await traceOf(scenario);
    expect(trace.events.every((event) => event.taskId === scenario.task)).toBe(
      true,
    );
    expect(trace.status).toBe("completed");
  });
});

describe("trace reconstruction: sessions, calls and verification", () => {
  it("reconstructs the session with its counters", async () => {
    const scenario = await buildScenario();
    const trace = await traceOf(scenario);

    expect(trace.sessions).toHaveLength(1);
    const [session] = trace.sessions;
    expect(session.id).toBe(scenario.session);
    expect(session.agentId).toBe("local-agent");
    expect(session.status).toBe("completed");
    expect(session.llmCalls).toBe(2);
    expect(session.toolCalls).toBe(1);
    // Only the non-retry turn is an iteration.
    expect(session.iterations).toBe(1);
    expect(session.providerIds).toEqual([PROVIDER]);
    expect(session.modelIds).toEqual([MODEL]);
  });

  it("keeps every model turn in order, with its usage and latency", async () => {
    const scenario = await buildScenario();
    const trace = await traceOf(scenario);

    expect(trace.llmCalls).toHaveLength(2);
    expect(trace.llmCalls.map((call) => call.retry)).toEqual([0, 1]);
    expect(trace.llmCalls.map((call) => call.latencyMs)).toEqual([1000, 150]);
    expect(trace.llmCalls[0].usage).toEqual({
      inputTokens: 1240,
      outputTokens: 320,
      cachedInputTokens: 0,
    });
    expect(trace.llmCalls[1].usage.cachedInputTokens).toBe(1024);
  });

  it("merges a tool call's start and completion into one record", async () => {
    const scenario = await buildScenario();
    const trace = await traceOf(scenario);

    expect(trace.toolCalls).toEqual([
      {
        toolId: "list-files",
        sessionId: scenario.session,
        operation: "read",
        ok: true,
        startedAt: expect.any(String),
        completedAt: expect.any(String),
        latencyMs: 12,
      },
    ]);
  });

  it("reconstructs verification runs", async () => {
    const scenario = await buildScenario();
    const trace = await traceOf(scenario);

    expect(trace.tests).toHaveLength(1);
    expect(trace.tests[0]).toMatchObject({
      suite: "task-contract",
      passed: 2,
      failed: 0,
      durationMs: 30,
    });
  });

  it("reconstructs decisions, keeping the question with its answer", async () => {
    const scenario = await buildScenario();
    const trace = await traceOf(scenario);

    expect(trace.decisions).toHaveLength(2);
    expect(trace.decisions[0]).toMatchObject({
      kind: "escalation",
      outcome: "selected",
      decidedBy: "code",
      selectedOptionId: "proceed",
      question: 'May task "tsk-trace-1" run without approval?',
      optionCount: 2,
    });
    expect(trace.decisions[1]).toMatchObject({
      kind: "policy",
      outcome: "selected",
      decidedBy: "policy",
      selectedOptionId: "verify",
      optionCount: 4,
    });
    expect(trace.metrics.decisions).toBe(2);
  });

  it("reconstructs the approval round trip", async () => {
    const scenario = await buildScenario();
    const trace = await traceOf(scenario);

    expect(trace.approvals).toHaveLength(1);
    expect(trace.approvals[0]).toMatchObject({
      requestId: "apr-1",
      riskLevel: "medium",
      approver: "maintainer",
    });
    expect(trace.approvals[0].grantedAt).toBeDefined();
  });
});

describe("trace reconstruction: metrics derived from events", () => {
  it("aggregates tokens, calls, iterations, retries and latency", async () => {
    const scenario = await buildScenario();
    const { metrics } = await traceOf(scenario);

    expect(metrics.inputTokens).toBe(3420);
    expect(metrics.outputTokens).toBe(780);
    expect(metrics.cachedInputTokens).toBe(1024);
    // Cached tokens are a subset of input, never added again.
    expect(metrics.totalTokens).toBe(4200);
    expect(metrics.llmCalls).toBe(2);
    expect(metrics.llmLatencyMs).toBe(1150);
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.iterations).toBe(1);
    expect(metrics.retries).toBe(1);
    expect(metrics.decisions).toBe(2);
    expect(metrics.decisionsByProvider).toBe(0);
    expect(metrics.open).toBe(false);
  });

  it("prices calls from the configured rate table", async () => {
    const scenario = await buildScenario();
    const { metrics, llmCalls } = await traceOf(scenario);

    // 1240 input @ $3/M + 320 output @ $15/M.
    expect(llmCalls[0].cost).toEqual({ currency: "USD", micros: 8520 });
    // 1156 billable input @ $3/M + 1024 cached @ $0.3/M + 460 output @ $15/M.
    expect(llmCalls[1].cost).toEqual({ currency: "USD", micros: 10675 });
    expect(metrics.cost.micros).toBe(19195);
    expect(metrics.costComplete).toBe(true);
    expect(metrics.unpricedCalls).toBe(0);
  });

  it("reports an unknown model as unpriced rather than as free", async () => {
    const scenario = await buildScenario();
    await scenario.project.runtime.store.appendMany([
      llmStarted(
        scenario.context,
        100,
        scenario.task,
        scenario.session,
        "acme",
        "mystery-1",
        1,
      ),
      llmCompleted(scenario.context, 101, scenario.task, scenario.session, {
        providerId: "acme",
        modelId: "mystery-1",
        usage: { inputTokens: 5000, outputTokens: 1000, cachedInputTokens: 0 },
        latencyMs: 42,
      }),
    ]);

    const trace = await traceOf(scenario);
    const unpriced = trace.llmCalls.find((call) => call.providerId === "acme");
    expect(unpriced?.cost).toBeUndefined();
    expect(trace.metrics.unpricedCalls).toBe(1);
    expect(trace.metrics.costComplete).toBe(false);
    // The priced calls are still counted in full.
    expect(trace.metrics.cost.micros).toBe(19195);
    expect(trace.metrics.totalTokens).toBe(10200);
  });

  it("evaluates the task budget against event-derived consumption", async () => {
    const clock = createManualClock(FIXED_INSTANT);
    const project = await createTestProject({ clock });
    projects.push(project);
    const stored = await project.runtime.tasks.create(
      {
        title: "Budgeted task",
        description: "Has a token budget",
        budget: { maxTokens: 5000, maxCostMicros: 1_000_000 },
      },
      {
        project: project.runtime.project,
        workspace: project.runtime.workspace,
      },
    );
    const scope: ProjectScope = { projectId: project.runtime.project.id };
    const context: EventContext = {
      clock,
      projectId: scope.projectId,
      workspaceId: project.runtime.workspace.id,
    };
    const session = sessionId("ses-budget");

    // `tasks.create` already recorded TaskCreated as sequence 1, so this history
    // continues from 2 rather than re-writing the task's origin.
    await project.runtime.store.appendMany([
      sessionStarted(context, 2, stored.task.id, session),
      llmStarted(context, 3, stored.task.id, session, PROVIDER, MODEL, 2),
      llmCompleted(context, 4, stored.task.id, session, {
        providerId: PROVIDER,
        modelId: MODEL,
        // 6000 tokens against a 5000 limit: over budget.
        usage: { inputTokens: 5000, outputTokens: 1000, cachedInputTokens: 0 },
        latencyMs: 10,
      }),
    ]);

    const trace = await project.runtime.traces.read(scope, stored.task.id);
    const tokens = trace.budget.dimensions.find(
      (dimension) => dimension.dimension === "tokens",
    );
    const cost = trace.budget.dimensions.find(
      (dimension) => dimension.dimension === "cost",
    );

    expect(trace.metrics.totalTokens).toBe(6000);
    expect(tokens).toMatchObject({
      limit: 5000,
      consumed: 6000,
      level: "exceeded",
    });
    expect(cost?.consumed).toBe(trace.metrics.cost.micros);
    expect(trace.budget.exceeded).toBe(true);
    expect(trace.budget.actions).toContain("stop");
  });
});

describe("trace reconstruction: integrity", () => {
  it("reports a model request that was never completed", async () => {
    const scenario = await buildScenario();
    await scenario.project.runtime.store.append(
      llmStarted(
        scenario.context,
        200,
        scenario.task,
        scenario.session,
        PROVIDER,
        MODEL,
        1,
      ),
    );

    const trace = await traceOf(scenario);
    expect(trace.integrity.ok).toBe(false);
    expect(trace.integrity.issues.join(" ")).toContain("never completed");
  });

  it("reports a tool call that was never completed", async () => {
    const scenario = await buildScenario();
    await scenario.project.runtime.store.append(
      toolStarted(
        scenario.context,
        201,
        scenario.task,
        scenario.session,
        "ghost-tool",
        "write",
      ),
    );

    const trace = await traceOf(scenario);
    expect(trace.integrity.ok).toBe(false);
    expect(trace.integrity.issues.join(" ")).toContain("ghost-tool");
  });

  it("reports a session that was started but never ended", async () => {
    const scenario = await buildScenario();
    await scenario.project.runtime.store.append(
      sessionStarted(
        scenario.context,
        202,
        scenario.task,
        sessionId("ses-unclosed"),
        "agent-2",
      ),
    );

    const trace = await traceOf(scenario);
    expect(trace.integrity.ok).toBe(false);
    expect(trace.integrity.issues.join(" ")).toContain("never ended");
    expect(
      trace.sessions.find((session) => session.id === "ses-unclosed")?.status,
    ).toBe("active");
  });

  it("reports a stored record that disagrees with the event log", async () => {
    const scenario = await buildScenario();
    // Write a record claiming a status the log never recorded.
    const stale = await scenario.project.runtime.tasks.create(
      { title: "Different task", description: "Unrelated record" },
      {
        project: scenario.project.runtime.project,
        workspace: scenario.project.runtime.workspace,
      },
    );
    await scenario.project.runtime.repository.save(
      {
        projectId: scenario.scope.projectId,
        workspaceId: scenario.scope.workspaceId,
      },
      { ...stale.task, id: scenario.task },
      { expectedVersion: undefined },
    );

    const trace = await traceOf(scenario);
    expect(trace.integrity.ok).toBe(false);
    expect(trace.integrity.issues.join(" ")).toContain('"created"');
    expect(trace.status).toBe("completed");
  });

  it("reports a decision answered without a recorded question", async () => {
    const scenario = await buildScenario();
    await scenario.project.runtime.store.append(
      decisionCompleted(scenario.context, 203, scenario.task, {
        decisionId: "dec-orphan",
        kind: "routing",
        outcome: "abstained",
        decidedBy: "code",
      }),
    );

    const trace = await traceOf(scenario);
    expect(trace.integrity.issues.join(" ")).toContain(
      "no matching DecisionRequested",
    );
    expect(
      trace.decisions.find((decision) => decision.decisionId === "dec-orphan")
        ?.question,
    ).toBeUndefined();
  });

  it("keeps an unanswered decision visible as pending", async () => {
    const scenario = await buildScenario();
    await scenario.project.runtime.store.append(
      decisionRequested(
        scenario.context,
        204,
        scenario.task,
        "approval",
        "Should this ship?",
      ),
    );

    const trace = await traceOf(scenario);
    const pending = trace.decisions.find(
      (decision) => decision.outcome === "pending",
    );
    expect(pending?.question).toBe("Should this ship?");
    expect(pending?.decidedBy).toBeUndefined();
    // An unanswered question is not a decision, so it is not counted as one.
    expect(trace.metrics.decisions).toBe(2);
  });
});

describe("trace reconstruction: project isolation", () => {
  it("cannot read across projects, and a task id alone grants nothing", async () => {
    const first = await createTestProject();
    const second = await createTestProject();
    projects.push(first, second);

    const stored = await first.runtime.tasks.create(
      {
        title: "Private task",
        description: "Belongs to project A",
        acceptanceCriteria: ["Is not visible in B"],
      },
      { project: first.runtime.project, workspace: first.runtime.workspace },
    );
    await first.runtime.runTask.run(stored);

    // A runtime refuses a scope that is not the project it is bound to.
    await expect(
      first.runtime.traces.read(
        { projectId: second.runtime.project.id },
        stored.task.id,
      ),
    ).rejects.toSatisfy((error) => hasDomainErrorCode(error, "FORBIDDEN"));

    // Holding the id and asking within one's own scope yields nothing at all.
    const foreign = await second.runtime.traces.read(
      { projectId: second.runtime.project.id },
      stored.task.id,
    );
    expect(foreign.events).toEqual([]);
    expect(foreign.sessions).toEqual([]);
    expect(foreign.metrics.llmCalls).toBe(0);
    expect(foreign.record).toBeUndefined();

    // Owner's trace is intact and complete.
    const own = await first.runtime.traces.read(
      { projectId: first.runtime.project.id },
      stored.task.id,
    );
    expect(own.events.length).toBeGreaterThan(10);
    expect(own.integrity.ok).toBe(true);
  });
});

describe("trace reconstruction: determinism", () => {
  it("produces the same trace for the same log, read twice", async () => {
    const scenario = await buildScenario();
    const first = await scenario.project.runtime.traces.read(
      scenario.scope,
      scenario.task,
    );
    const second = await scenario.project.runtime.traces.read(
      scenario.scope,
      scenario.task,
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("is unaffected by the clock at read time", async () => {
    const scenario = await buildScenario();
    const before = await traceOf(scenario);
    (scenario.context.clock as Clock & { advance(ms: number): void }).advance(
      86_400_000,
    );
    const after = await traceOf(scenario);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});
