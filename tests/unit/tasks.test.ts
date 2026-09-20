import { describe, expect, it } from "vitest";
import { createFixedClock, toIsoString } from "../../src/core/clock.js";
import { projectId, taskId } from "../../src/core/ids.js";
import { type RiskLevel } from "../../src/decisions/risk.js";
import { archiveProject, createProject } from "../../src/projects/project.js";
import {
  TASK_STATUSES,
  type TaskStatus,
  allowedTransitions,
  canTransition,
  isTerminalStatus,
  transitionStatus,
} from "../../src/tasks/lifecycle.js";
import {
  type Task,
  type VerificationLevel,
  acceptanceSummary,
  createTask,
  markAcceptanceCriterion,
  transitionTask,
  validateTask,
} from "../../src/tasks/task.js";
import { setWorkspaceStatus } from "../../src/workspaces/workspace.js";
import { expectDomainError } from "../support/errors.js";
import { START_INSTANT, createHarness } from "../support/harness.js";

const INSTANT = START_INSTANT;

describe("createTask", () => {
  it("derives a created task with explicit defaults", () => {
    const { task, project, workspace } = createHarness();
    expect(task).toEqual({
      id: "tsk-1",
      projectId: project.id,
      workspaceId: workspace.id,
      title: "Add runtime validation",
      description: "Reject structurally invalid input at the boundary.",
      context: [],
      constraints: [],
      acceptanceCriteria: [
        {
          id: "AC-1",
          statement: "Invalid input is rejected",
          status: "pending",
        },
      ],
      riskLevel: "medium",
      budget: {},
      status: "created",
      verificationStrategy: [],
      createdAt: INSTANT,
      updatedAt: INSTANT,
    });
    expect(() => validateTask(task)).not.toThrow();
  });

  it("numbers acceptance criteria deterministically", () => {
    const { task } = createHarness({
      task: { acceptanceCriteria: ["a", "b", "c"] },
    });
    expect(task.acceptanceCriteria.map((criterion) => criterion.id)).toEqual([
      "AC-1",
      "AC-2",
      "AC-3",
    ]);
  });

  it("requires intent", () => {
    const { project, workspace, clock } = createHarness();
    const options = { id: taskId("tsk-2"), project, workspace, clock };
    expectDomainError(
      () => createTask({ title: "  ", description: "x" }, options),
      "VALIDATION",
    );
    expectDomainError(
      () => createTask({ title: "x", description: "" }, options),
      "VALIDATION",
    );
    expectDomainError(
      () =>
        createTask(
          { title: "x", description: "y", riskLevel: "extreme" as RiskLevel },
          options,
        ),
      "VALIDATION",
    );
  });

  it("rejects verification steps outside the declared levels", () => {
    const { project, workspace, clock } = createHarness();
    expectDomainError(
      () =>
        createTask(
          {
            title: "x",
            description: "y",
            verificationStrategy: [
              {
                level: 6 as unknown as VerificationLevel,
                command: "pnpm test",
                required: true,
              },
            ],
          },
          { id: taskId("tsk-3"), project, workspace, clock },
        ),
      "VALIDATION",
    );
  });

  it("refuses to target an archived project", () => {
    const { project, workspace, clock } = createHarness();
    const archived = archiveProject(project, clock);
    expectDomainError(
      () =>
        createTask(
          { title: "x", description: "y" },
          { id: taskId("tsk-4"), project: archived, workspace, clock },
        ),
      "INVARIANT",
    );
  });

  it("refuses to target an archived workspace", () => {
    const { project, workspace, clock } = createHarness();
    const archived = setWorkspaceStatus(workspace, "archived", clock);
    expectDomainError(
      () =>
        createTask(
          { title: "x", description: "y" },
          { id: taskId("tsk-5"), project, workspace: archived, clock },
        ),
      "INVARIANT",
    );
  });

  it("refuses a workspace from another project", () => {
    const { workspace, clock } = createHarness();
    const other = createProject(
      { name: "Other", slug: "other", rootPath: "/srv/projects/other" },
      { id: projectId("prj-2"), clock: createFixedClock(INSTANT) },
    );
    expectDomainError(
      () =>
        createTask(
          { title: "x", description: "y" },
          { id: taskId("tsk-6"), project: other, workspace, clock },
        ),
      "INVARIANT",
    );
  });
});

describe("task lifecycle", () => {
  it("declares the terminal states", () => {
    expect(TASK_STATUSES.filter(isTerminalStatus)).toEqual([
      "completed",
      "failed",
      "cancelled",
    ]);
    expect(allowedTransitions("created")).toEqual(["planning", "cancelled"]);
  });

  it("walks the happy path and stamps completedAt exactly once", () => {
    const { task, clock } = createHarness();
    let current: Task = task;
    for (const next of [
      "planning",
      "in_progress",
      "verification",
      "review",
    ] as const) {
      clock.advance(1000);
      current = transitionTask(current, next, clock);
      expect(current.completedAt).toBeUndefined();
    }
    clock.advance(1000);
    current = transitionTask(current, "completed", clock);
    expect(current.status).toBe("completed");
    expect(current.completedAt).toBe(toIsoString(clock.now()));
    expect(current.updatedAt).toBe(current.completedAt);
    expect(() => validateTask(current)).not.toThrow();
  });

  it("sets no completedAt on failure", () => {
    const { task, clock } = createHarness();
    const failed = transitionTask(
      transitionTask(task, "planning", clock),
      "failed",
      clock,
    );
    expect(failed.status).toBe("failed");
    expect(failed.completedAt).toBeUndefined();
  });

  it("rejects illegal transitions with a typed error", () => {
    const { task, clock } = createHarness();
    expectDomainError(
      () => transitionTask(task, "completed", clock),
      "TRANSITION",
    );
    expectDomainError(
      () => transitionTask(task, "created", clock),
      "TRANSITION",
    );
  });

  it("treats terminal states as immutable", () => {
    const { task, clock } = createHarness();
    const cancelled = transitionTask(task, "cancelled", clock);
    expectDomainError(
      () => transitionTask(cancelled, "planning", clock),
      "TRANSITION",
    );
    expectDomainError(
      () => markAcceptanceCriterion(cancelled, "AC-1", "met", clock),
      "INVARIANT",
    );
  });

  it("allows the two backwards transitions that rework requires", () => {
    expect(canTransition("verification", "in_progress")).toBe(true);
    expect(canTransition("review", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "planning")).toBe(false);
    expect(canTransition("planning", "review")).toBe(false);
  });

  it("reports the allowed transitions in the error details", () => {
    const error = expectDomainError(
      () => transitionStatus("planning", "review"),
      "TRANSITION",
    );
    expect(error.details["allowed"]).toEqual([
      "in_progress",
      "cancelled",
      "failed",
    ]);
  });

  it("cancels from every non-terminal state", () => {
    for (const status of [
      "created",
      "planning",
      "in_progress",
      "review",
    ] as const) {
      expect(canTransition(status, "cancelled")).toBe(true);
    }
    expect(canTransition("verification", "cancelled")).toBe(false);
  });
});

describe("acceptance criteria", () => {
  it("marks an individual criterion", () => {
    const { task, clock } = createHarness();
    const updated = markAcceptanceCriterion(task, "AC-1", "met", clock);
    expect(updated.acceptanceCriteria[0]?.status).toBe("met");
    expect(updated.updatedAt).toBe(toIsoString(clock.now()));
    expect(task.acceptanceCriteria[0]?.status).toBe("pending");
  });

  it("rejects an unknown criterion and an unknown status", () => {
    const { task, clock } = createHarness();
    expectDomainError(
      () => markAcceptanceCriterion(task, "AC-9", "met", clock),
      "NOT_FOUND",
    );
    expectDomainError(
      () =>
        markAcceptanceCriterion(
          task,
          "AC-1",
          "probably" as unknown as "met",
          clock,
        ),
      "VALIDATION",
    );
  });

  it("never treats a task without criteria as verified", () => {
    const { task } = createHarness();
    expect(acceptanceSummary({ ...task, acceptanceCriteria: [] })).toEqual({
      total: 0,
      met: 0,
      notMet: 0,
      waived: 0,
      pending: 0,
      allMet: false,
    });
  });

  it("counts met and waived criteria as satisfied", () => {
    const { task, clock } = createHarness({
      task: { acceptanceCriteria: ["a", "b", "c"] },
    });
    let current = markAcceptanceCriterion(task, "AC-1", "met", clock);
    current = markAcceptanceCriterion(current, "AC-2", "waived", clock);
    expect(acceptanceSummary(current)).toEqual({
      total: 3,
      met: 1,
      notMet: 0,
      waived: 1,
      pending: 1,
      allMet: false,
    });
    current = markAcceptanceCriterion(current, "AC-3", "met", clock);
    expect(acceptanceSummary(current).allMet).toBe(true);
  });

  it("treats not-met criteria as unsatisfied", () => {
    const { task, clock } = createHarness();
    const updated = markAcceptanceCriterion(task, "AC-1", "not-met", clock);
    expect(acceptanceSummary(updated)).toMatchObject({
      notMet: 1,
      allMet: false,
    });
  });
});

describe("validateTask", () => {
  const { task } = createHarness();

  it("requires completedAt if and only if the task is completed", () => {
    expectDomainError(
      () => validateTask({ ...task, status: "completed" }),
      "INVARIANT",
    );
    expectDomainError(
      () => validateTask({ ...task, completedAt: INSTANT }),
      "INVARIANT",
    );
    expect(() =>
      validateTask({
        ...task,
        status: "completed",
        completedAt: INSTANT,
      }),
    ).not.toThrow();
  });

  it("rejects duplicate acceptance criterion ids", () => {
    expectDomainError(
      () =>
        validateTask({
          ...task,
          acceptanceCriteria: [
            { id: "AC-1", statement: "a", status: "pending" },
            { id: "AC-1", statement: "b", status: "pending" },
          ],
        }),
      "INVARIANT",
    );
  });

  it("rejects an unknown status and an invalid budget", () => {
    expectDomainError(
      () =>
        validateTask({ ...task, status: "almost" as unknown as TaskStatus }),
      "VALIDATION",
    );
    expectDomainError(
      () => validateTask({ ...task, budget: { maxTokens: -5 } }),
      "VALIDATION",
    );
  });

  it("rejects timestamps that went backwards", () => {
    expectDomainError(
      () => validateTask({ ...task, updatedAt: "2026-09-19T00:00:00.000Z" }),
      "INVARIANT",
    );
  });

  it("accepts verification steps inside the declared levels", () => {
    expect(() =>
      validateTask({
        ...task,
        verificationStrategy: [
          { level: 1, command: "pnpm format:check", required: true },
          { level: 2, command: "pnpm test", required: true },
          { level: 5, command: "pnpm e2e", required: false },
        ],
      }),
    ).not.toThrow();
  });
});

describe("determinism", () => {
  it("produces identical tasks from identical inputs and time", () => {
    expect(createHarness().task).toEqual(createHarness().task);
  });
});
