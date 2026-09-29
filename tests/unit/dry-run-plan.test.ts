import { afterEach, describe, expect, it } from "vitest";

import type { Runtime } from "../../src/application/runtime.js";
import type { TaskId } from "../../src/core/ids.js";
import { createTestProject, type TestProject } from "../support/project.js";
import {
  FIXTURE_USAGE,
  TEXT_MODEL,
  createMultiModelProvider,
  createScriptedFrontier,
  frontierConfig,
  ratesFor,
} from "../support/frontier.js";

/**
 * `--dry-run` for the two execution use cases: their negative guarantee.
 *
 * The property under test is not output but *absence*: after `runTask.plan` and
 * `orchestrator.plan`, no event was written, no session was opened, no provider or
 * frontier step was executed, and the task was not moved. The fakes are real port
 * implementations that record what they were asked to do — a call would be visible
 * as a recorded request, not swallowed — and the event store is the real JSONL log.
 */

const projects: TestProject[] = [];

afterEach(async () => {
  for (const project of projects) {
    await project.cleanup();
  }
  projects.length = 0;
});

async function project(
  options: Parameters<typeof createTestProject>[0],
): Promise<TestProject> {
  const created = await createTestProject(options);
  projects.push(created);
  return created;
}

function scopeOf(runtime: Runtime) {
  return {
    projectId: runtime.project.id,
    workspaceId: runtime.workspace.id,
  };
}

async function createTask(
  runtime: Runtime,
  title: string,
  riskLevel?: "high",
): Promise<TaskId> {
  const stored = await runtime.tasks.create(
    {
      title,
      description: title,
      acceptanceCriteria: ["Recorded"],
      ...(riskLevel === undefined ? {} : { riskLevel }),
    },
    { project: runtime.project, workspace: runtime.workspace },
  );
  return stored.task.id;
}

describe("task run --dry-run: plan only", () => {
  it("makes no provider call, opens no session, and writes no event", async () => {
    const provider = createMultiModelProvider({
      id: "counter",
      modelIds: [TEXT_MODEL.modelId],
    });
    const subject = await project({
      provider,
      modelRates: ratesFor([TEXT_MODEL]),
    });
    const runtime = subject.runtime;
    const scope = scopeOf(runtime);
    const id = await createTask(runtime, "Plan a run");
    const stored = await runtime.tasks.load(scope, id);

    const before = (await runtime.store.readAll(scope)).length;
    const plan = await runtime.runTask.plan(stored);

    // The negative guarantee: the provider port was never touched.
    expect(provider.requests).toHaveLength(0);
    // No event was appended, so no session, decision, or lifecycle transition exists.
    expect((await runtime.store.readAll(scope)).length).toBe(before);
    expect(plan.taskStatus).toBe("created");
    expect(plan.requiresHumanApproval).toBe(false);
    expect(plan.steps.length).toBeGreaterThan(0);

    const trace = await runtime.traces.read(scope, id);
    expect(trace.sessions).toHaveLength(0);
    expect((await runtime.tasks.load(scope, id)).task.status).toBe("created");
  });

  it("still runs the deterministic risk gate and validation", async () => {
    const subject = await project({
      provider: createMultiModelProvider({
        id: "counter",
        modelIds: [TEXT_MODEL.modelId],
      }),
    });
    const runtime = subject.runtime;
    const scope = scopeOf(runtime);
    const id = await createTask(runtime, "High risk plan", "high");
    const stored = await runtime.tasks.load(scope, id);
    const before = (await runtime.store.readAll(scope)).length;

    const plan = await runtime.runTask.plan(stored);
    expect(plan.requiresHumanApproval).toBe(true);
    // No approval was requested merely by planning.
    expect((await runtime.store.readAll(scope)).length).toBe(before);
    expect(plan.pendingApprovalRequestId).toBeUndefined();

    // A stale projection is still refused: validation did not move to the CLI.
    await expect(
      runtime.runTask.plan({ ...stored, version: stored.version + 1 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("task orchestrate --dry-run: plan only", () => {
  it("makes no frontier call, opens no session, and writes no event", async () => {
    const frontier = createScriptedFrontier([{ usage: FIXTURE_USAGE }]);
    const subject = await project({
      frontierConfig: frontierConfig({ models: [TEXT_MODEL] }),
      frontier,
      modelRates: ratesFor([TEXT_MODEL]),
    });
    const runtime = subject.runtime;
    const scope = scopeOf(runtime);
    const id = await createTask(runtime, "Plan an orchestration");
    const stored = await runtime.tasks.load(scope, id);

    const before = (await runtime.store.readAll(scope)).length;
    const plan = await runtime.orchestrator.plan({
      workspaceId: runtime.workspace.id,
      taskId: stored.task.id,
    });

    // The negative guarantee: the frontier executor was never asked to run a step.
    expect(frontier.calls).toBe(0);
    expect(plan.variants.length).toBeGreaterThan(0);
    expect(plan.eligibleModelIds).toContain(TEXT_MODEL.modelId);
    expect((await runtime.store.readAll(scope)).length).toBe(before);

    const trace = await runtime.traces.read(scope, id);
    expect(trace.sessions).toHaveLength(0);
    // `run` moves created -> planning; the plan must not.
    expect((await runtime.tasks.load(scope, id)).task.status).toBe("created");
  });

  it("refuses when the frontier is not enabled, before any work", async () => {
    const subject = await project({
      frontierConfig: frontierConfig({ enabled: false }),
      frontier: createScriptedFrontier([{ usage: FIXTURE_USAGE }]),
    });
    const runtime = subject.runtime;
    const id = await createTask(runtime, "Disabled frontier");
    const stored = await runtime.tasks.load(scopeOf(runtime), id);

    await expect(
      runtime.orchestrator.plan({
        workspaceId: runtime.workspace.id,
        taskId: stored.task.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
