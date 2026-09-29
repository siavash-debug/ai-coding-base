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
  assessAcceptanceCriteria,
  createTask,
  markAcceptanceCriterion,
  measuredAcceptanceCriteriaMet,
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

describe("measuredAcceptanceCriteriaMet", () => {
  it("reports nothing while every criterion is still unmeasured", () => {
    // "not measured" must never be sent as "zero met": the completion contract
    // treats the two as different facts (decisions/domains.ts).
    const { task } = createHarness({
      task: { acceptanceCriteria: ["a", "b", "c"] },
    });
    expect(measuredAcceptanceCriteriaMet(task)).toBeUndefined();
  });

  it("reports nothing for a task with no criteria at all", () => {
    const { task } = createHarness();
    expect(
      measuredAcceptanceCriteriaMet({ ...task, acceptanceCriteria: [] }),
    ).toBeUndefined();
  });

  it("reports the satisfied count once a criterion has been assessed", () => {
    const { task, clock } = createHarness({
      task: { acceptanceCriteria: ["a", "b", "c"] },
    });
    const updated = markAcceptanceCriterion(task, "AC-1", "met", clock);
    expect(measuredAcceptanceCriteriaMet(updated)).toBe(1);
  });

  it("reports a truthful zero when a criterion was measured and did not pass", () => {
    const { task, clock } = createHarness();
    const updated = markAcceptanceCriterion(task, "AC-1", "not-met", clock);
    // Zero here means "measured, none satisfied" — not "unmeasured".
    expect(measuredAcceptanceCriteriaMet(updated)).toBe(0);
  });

  it("counts met and waived criteria together", () => {
    const { task, clock } = createHarness({
      task: { acceptanceCriteria: ["a", "b", "c"] },
    });
    let current = markAcceptanceCriterion(task, "AC-1", "met", clock);
    current = markAcceptanceCriterion(current, "AC-2", "waived", clock);
    expect(measuredAcceptanceCriteriaMet(current)).toBe(2);
  });
});

describe("assessAcceptanceCriteria", () => {
  const boundTask = () =>
    createHarness({
      task: {
        acceptanceCriteria: [
          {
            statement: "src/core/text.ts exports normalizeText",
            verifiedBy: { suite: "verification-command" },
          },
          { statement: "The API is easy to use" },
        ],
      },
    });

  it("leaves a bound criterion pending when its suite produced no evidence", () => {
    const { task, clock } = boundTask();
    const result = assessAcceptanceCriteria(task, [], clock);
    expect(result.assessed).toEqual([]);
    expect(result.task).toBe(task);
    expect(result.task.acceptanceCriteria[0]?.status).toBe("pending");
  });

  it("leaves a bound criterion pending when only an unrelated suite ran", () => {
    const { task, clock } = boundTask();
    const result = assessAcceptanceCriteria(
      task,
      [{ suite: "task-contract", passed: 4, failed: 0 }],
      clock,
    );
    expect(result.assessed).toEqual([]);
    expect(result.task.acceptanceCriteria[0]?.status).toBe("pending");
  });

  it("marks a bound criterion met from a passing suite, with provenance", () => {
    const { task, clock } = boundTask();
    const result = assessAcceptanceCriteria(
      task,
      [{ suite: "verification-command", passed: 5, failed: 0 }],
      clock,
    );
    expect(result.assessed).toEqual([
      {
        criterionId: "AC-1",
        status: "met",
        suite: "verification-command",
        passed: 5,
        failed: 0,
      },
    ]);
    const criterion = result.task.acceptanceCriteria[0];
    expect(criterion?.status).toBe("met");
    expect(criterion?.evidence).toEqual([
      "suite:verification-command",
      "passed:5",
      "failed:0",
    ]);
    // The unbound criterion is untouched: nothing inferred it from the pass.
    expect(result.task.acceptanceCriteria[1]?.status).toBe("pending");
  });

  it("marks a bound criterion not-met from a failing suite, with provenance", () => {
    const { task, clock } = boundTask();
    const result = assessAcceptanceCriteria(
      task,
      [{ suite: "verification-command", passed: 3, failed: 2 }],
      clock,
    );
    expect(result.assessed[0]).toMatchObject({
      criterionId: "AC-1",
      status: "not-met",
      passed: 3,
      failed: 2,
    });
    expect(result.task.acceptanceCriteria[0]?.evidence).toEqual([
      "suite:verification-command",
      "passed:3",
      "failed:2",
    ]);
  });

  it("treats a suite that reported no checks as no evidence", () => {
    const { task, clock } = boundTask();
    const result = assessAcceptanceCriteria(
      task,
      [{ suite: "verification-command", passed: 0, failed: 0 }],
      clock,
    );
    expect(result.assessed).toEqual([]);
    expect(result.task.acceptanceCriteria[0]?.status).toBe("pending");
  });

  it("merges repeated evidence for the same suite before judging it", () => {
    const { task, clock } = boundTask();
    const result = assessAcceptanceCriteria(
      task,
      [
        { suite: "verification-command", passed: 3, failed: 0 },
        { suite: "verification-command", passed: 0, failed: 1 },
      ],
      clock,
    );
    expect(result.assessed[0]).toMatchObject({ passed: 3, failed: 1 });
    expect(result.task.acceptanceCriteria[0]?.status).toBe("not-met");
  });

  it("never overwrites an explicit waiver or a human assertion", () => {
    const { task, clock } = createHarness({
      task: {
        acceptanceCriteria: [
          {
            statement: "Waived by the operator",
            verifiedBy: { suite: "verification-command" },
          },
          {
            statement: "Asserted met by a human",
            verifiedBy: { suite: "verification-command" },
          },
        ],
      },
    });
    const waived = markAcceptanceCriterion(task, "AC-1", "waived", clock);
    const asserted = markAcceptanceCriterion(waived, "AC-2", "met", clock);
    const result = assessAcceptanceCriteria(
      asserted,
      [{ suite: "verification-command", passed: 0, failed: 9 }],
      clock,
    );
    // A failing suite does not overturn a deliberate acknowledgement or assertion.
    expect(result.assessed).toEqual([]);
    expect(result.task.acceptanceCriteria[0]?.status).toBe("waived");
    expect(result.task.acceptanceCriteria[1]?.status).toBe("met");
  });

  it("reports one assessed criterion among pending ones without inventing the rest", () => {
    const { task, clock } = createHarness({
      task: {
        acceptanceCriteria: [
          {
            statement: "bound",
            verifiedBy: { suite: "verification-command" },
          },
          "unbound one",
          "unbound two",
        ],
      },
    });
    const result = assessAcceptanceCriteria(
      task,
      [{ suite: "verification-command", passed: 1, failed: 0 }],
      clock,
    );
    expect(acceptanceSummary(result.task)).toMatchObject({
      total: 3,
      met: 1,
      pending: 2,
    });
    // 1 of 3 measured: the other two are not presented as failures.
    expect(measuredAcceptanceCriteriaMet(result.task)).toBe(1);
  });

  it("carries an explicit binding from structured criteria input", () => {
    const { task } = createHarness({
      task: {
        acceptanceCriteria: [
          { statement: "a", verifiedBy: { suite: "verification-command" } },
          "b",
        ],
      },
    });
    expect(task.acceptanceCriteria[0]).toEqual({
      id: "AC-1",
      statement: "a",
      status: "pending",
      verifiedBy: { suite: "verification-command" },
    });
    expect(task.acceptanceCriteria[1]).toEqual({
      id: "AC-2",
      statement: "b",
      status: "pending",
    });
  });
});

describe("assessAcceptanceCriteria: criterion-specific evidence", () => {
  const checkedTask = () =>
    createHarness({
      task: {
        acceptanceCriteria: [
          {
            statement: "check A passes",
            verifiedBy: { suite: "verification-command", check: "check-a" },
          },
          {
            statement: "check B passes",
            verifiedBy: { suite: "verification-command", check: "check-b" },
          },
          "human judgement",
        ],
      },
    });

  it("marks a criterion met from its own passing check, with stable provenance", () => {
    const { task, clock } = checkedTask();
    const result = assessAcceptanceCriteria(
      task,
      [
        {
          suite: "verification-command",
          check: "check-a",
          passed: 1,
          failed: 0,
        },
      ],
      clock,
    );
    expect(result.assessed).toEqual([
      {
        criterionId: "AC-1",
        status: "met",
        suite: "verification-command",
        check: "check-a",
        passed: 1,
        failed: 0,
      },
    ]);
    expect(result.task.acceptanceCriteria[0]?.evidence).toEqual([
      "suite:verification-command",
      "check:check-a",
      "result:passed",
      "passed:1",
      "failed:0",
    ]);
  });

  it("marks a criterion not-met from its own failing check", () => {
    const { task, clock } = checkedTask();
    const result = assessAcceptanceCriteria(
      task,
      [
        {
          suite: "verification-command",
          check: "check-a",
          passed: 0,
          failed: 1,
        },
      ],
      clock,
    );
    expect(result.assessed[0]).toMatchObject({
      criterionId: "AC-1",
      status: "not-met",
      check: "check-a",
    });
    expect(result.task.acceptanceCriteria[0]?.evidence).toContain(
      "result:failed",
    );
  });

  it("does not let an unrelated failing check invalidate a passing one", () => {
    const { task, clock } = checkedTask();
    const result = assessAcceptanceCriteria(
      task,
      [
        {
          suite: "verification-command",
          check: "check-a",
          passed: 1,
          failed: 0,
        },
        {
          suite: "verification-command",
          check: "check-b",
          passed: 0,
          failed: 1,
        },
      ],
      clock,
    );
    // AC-1 is `met` on its own check even though a sibling check failed; AC-2 is
    // `not-met` on its own. One check's outcome never leaks into the other.
    expect(result.task.acceptanceCriteria[0]?.status).toBe("met");
    expect(result.task.acceptanceCriteria[1]?.status).toBe("not-met");
  });

  it("leaves a criterion pending when its check never ran", () => {
    const { task, clock } = checkedTask();
    const result = assessAcceptanceCriteria(
      task,
      [
        {
          suite: "verification-command",
          check: "check-b",
          passed: 1,
          failed: 0,
        },
      ],
      clock,
    );
    // AC-1's check did not run: no guessing, and no borrowing the suite's verdict.
    expect(result.task.acceptanceCriteria[0]?.status).toBe("pending");
    expect(result.task.acceptanceCriteria[0]?.evidence).toBeUndefined();
    expect(result.assessed.map((entry) => entry.criterionId)).toEqual(["AC-2"]);
  });

  it("does not fabricate a status from a whole-suite result when a check is bound", () => {
    const { task, clock } = checkedTask();
    const result = assessAcceptanceCriteria(
      task,
      [{ suite: "verification-command", passed: 9, failed: 0 }],
      clock,
    );
    // A whole-suite pass is not evidence for a criterion that asked for one check.
    expect(result.assessed).toEqual([]);
    expect(result.task.acceptanceCriteria[0]?.status).toBe("pending");
  });

  it("keeps a suite-only binding on the whole-suite verdict (back-compat)", () => {
    const { task, clock } = createHarness({
      task: {
        acceptanceCriteria: [
          {
            statement: "the whole suite passes",
            verifiedBy: { suite: "verification-command" },
          },
        ],
      },
    });
    const result = assessAcceptanceCriteria(
      task,
      [
        { suite: "verification-command", passed: 2, failed: 0 },
        {
          suite: "verification-command",
          check: "check-z",
          passed: 0,
          failed: 1,
        },
      ],
      clock,
    );
    // Suite-only evidence is the aggregate of everything reported under the suite,
    // exactly as before named checks existed; the provenance is unchanged.
    expect(result.assessed[0]).toMatchObject({ passed: 2, failed: 1 });
    expect(result.task.acceptanceCriteria[0]?.evidence).toEqual([
      "suite:verification-command",
      "passed:2",
      "failed:1",
    ]);
  });

  it("never overwrites a waiver when its bound check fails", () => {
    const { task, clock } = createHarness({
      task: {
        acceptanceCriteria: [
          {
            statement: "waived by the operator",
            verifiedBy: { suite: "verification-command", check: "check-a" },
          },
        ],
      },
    });
    const waived = markAcceptanceCriterion(task, "AC-1", "waived", clock);
    const result = assessAcceptanceCriteria(
      waived,
      [
        {
          suite: "verification-command",
          check: "check-a",
          passed: 0,
          failed: 1,
        },
      ],
      clock,
    );
    expect(result.assessed).toEqual([]);
    expect(result.task.acceptanceCriteria[0]?.status).toBe("waived");
  });

  it("carries a check binding from structured criteria input", () => {
    const { task } = createHarness({
      task: {
        acceptanceCriteria: [
          {
            statement: "a",
            verifiedBy: { suite: "verification-command", check: "check-a" },
          },
        ],
      },
    });
    expect(task.acceptanceCriteria[0]?.verifiedBy).toEqual({
      suite: "verification-command",
      check: "check-a",
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

  it("rejects an acceptance criterion binding without a suite", () => {
    expectDomainError(
      () =>
        validateTask({
          ...task,
          acceptanceCriteria: [
            {
              id: "AC-1",
              statement: "x",
              status: "pending",
              verifiedBy: { suite: "" },
            },
          ],
        }),
      "VALIDATION",
    );
  });

  it("rejects an acceptance criterion binding with an empty check id", () => {
    expectDomainError(
      () =>
        validateTask({
          ...task,
          acceptanceCriteria: [
            {
              id: "AC-1",
              statement: "x",
              status: "pending",
              verifiedBy: { suite: "verification-command", check: "" },
            },
          ],
        }),
      "VALIDATION",
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
