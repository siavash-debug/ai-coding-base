import { type Clock, toIsoString } from "../core/clock.js";
import { DomainError } from "../core/errors.js";
import type { TaskId } from "../core/ids.js";
import {
  assertIsoTimestamp,
  assertNonEmptyString,
  assertOneOf,
  assertStringArray,
} from "../core/validation.js";
import { RISK_LEVELS, type RiskLevel } from "../decisions/risk.js";
import type { Budget } from "../observability/budget.js";
import { validateBudget } from "../observability/budget.js";
import type { Project } from "../projects/project.js";
import { assertWorkspaceBelongsToProject } from "../workspaces/workspace.js";
import type { Workspace } from "../workspaces/workspace.js";
import {
  type TaskStatus,
  TASK_STATUSES,
  isTerminalStatus,
  transitionStatus,
} from "./lifecycle.js";

/**
 * Task: the first-class unit of engineering work and the anchor of traceability.
 *
 * The task holds identity and contract only. Usage, cost, calls, decisions and
 * tests are attached by `taskId` through the event log.
 * See docs/architecture/V2-ARCHITECTURE.md §6 and DECISIONS.md ADR-005.
 */
export const ACCEPTANCE_CRITERION_STATUSES = [
  "pending",
  "met",
  "not-met",
  "waived",
] as const;

export type AcceptanceCriterionStatus =
  (typeof ACCEPTANCE_CRITERION_STATUSES)[number];

export interface TaskAcceptanceCriterion {
  readonly id: string;
  readonly statement: string;
  readonly status: AcceptanceCriterionStatus;
}

/** Maps to docs/TASK_CONTRACT.md §9.1 verification levels. */
export const VERIFICATION_LEVELS = [1, 2, 3, 4, 5] as const;

export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

export interface VerificationStep {
  readonly level: VerificationLevel;
  readonly command: string;
  readonly required: boolean;
}

export interface Task {
  readonly id: TaskId;
  readonly projectId: Project["id"];
  readonly workspaceId: Workspace["id"];
  readonly title: string;
  readonly description: string;
  readonly context: readonly string[];
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly TaskAcceptanceCriterion[];
  readonly riskLevel: RiskLevel;
  readonly budget: Budget;
  readonly status: TaskStatus;
  readonly verificationStrategy: readonly VerificationStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly description: string;
  readonly context?: readonly string[];
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly riskLevel?: RiskLevel;
  readonly budget?: Budget;
  readonly verificationStrategy?: readonly VerificationStep[];
}

export interface AcceptanceSummary {
  readonly total: number;
  readonly met: number;
  readonly notMet: number;
  readonly waived: number;
  readonly pending: number;
  /** A task with no acceptance criteria is NOT considered verified. */
  readonly allMet: boolean;
}

function toAcceptanceCriteria(
  statements: readonly string[],
): readonly TaskAcceptanceCriterion[] {
  return statements.map((statement, index) => ({
    id: `AC-${index + 1}`,
    statement,
    status: "pending" as const,
  }));
}

function validateVerificationStep(
  step: VerificationStep,
  index: number,
): VerificationStep {
  const field = `verificationStrategy[${index}]`;
  const level = step.level;
  if (!VERIFICATION_LEVELS.includes(level)) {
    throw new DomainError(
      "VALIDATION",
      `${field}.level must be one of: ${VERIFICATION_LEVELS.join(", ")}`,
      { field: `${field}.level` },
    );
  }
  const command = assertNonEmptyString(step.command, `${field}.command`);
  if (typeof step.required !== "boolean") {
    throw new DomainError("VALIDATION", `${field}.required must be a boolean`, {
      field: `${field}.required`,
    });
  }
  return { level, command, required: step.required };
}

export function createTask(
  input: CreateTaskInput,
  options: {
    readonly id: TaskId;
    readonly project: Project;
    readonly workspace: Workspace;
    readonly clock: Clock;
  },
): Task {
  assertWorkspaceBelongsToProject(options.workspace, options.project);
  if (options.project.status !== "active") {
    throw new DomainError(
      "INVARIANT",
      "a task cannot be created in an archived project",
      { field: "project.status" },
    );
  }
  if (options.workspace.status === "archived") {
    throw new DomainError(
      "INVARIANT",
      "a task cannot be created in an archived workspace",
      { field: "workspace.status" },
    );
  }

  const title = assertNonEmptyString(input.title, "title");
  const description = assertNonEmptyString(input.description, "description");
  const context = assertStringArray(input.context ?? [], "context");
  const constraints = assertStringArray(input.constraints ?? [], "constraints");
  const acceptanceCriteria = toAcceptanceCriteria(
    assertStringArray(input.acceptanceCriteria ?? [], "acceptanceCriteria"),
  );
  // `medium` is the safe default: it requires verification and cannot lower the
  // effective risk of any operation (see decisions/risk.ts).
  const riskLevel =
    input.riskLevel === undefined
      ? "medium"
      : assertOneOf(input.riskLevel, RISK_LEVELS, "riskLevel");
  const budget = input.budget ?? {};
  validateBudget(budget);
  const verificationStrategy = (input.verificationStrategy ?? []).map(
    validateVerificationStep,
  );
  const now = toIsoString(options.clock.now());

  return {
    id: options.id,
    projectId: options.project.id,
    workspaceId: options.workspace.id,
    title,
    description,
    context,
    constraints,
    acceptanceCriteria,
    riskLevel,
    budget,
    status: "created",
    verificationStrategy,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Only legal transitions are applied; illegal ones throw a typed error.
 * `completedAt` is set if and only if the task becomes `completed`.
 */
export function transitionTask(
  task: Task,
  next: TaskStatus,
  clock: Clock,
): Task {
  const status = transitionStatus(task.status, next);
  const now = toIsoString(clock.now());
  const transitioned: Task = {
    ...task,
    status,
    updatedAt: now,
    ...(status === "completed" ? { completedAt: now } : {}),
  };
  return transitioned;
}

export function markAcceptanceCriterion(
  task: Task,
  criterionId: string,
  status: AcceptanceCriterionStatus,
  clock: Clock,
): Task {
  if (isTerminalStatus(task.status)) {
    throw new DomainError(
      "INVARIANT",
      `acceptance criteria of a terminal task (${task.status}) cannot change`,
      { field: "task.status" },
    );
  }
  const index = task.acceptanceCriteria.findIndex(
    (criterion) => criterion.id === criterionId,
  );
  if (index === -1) {
    throw new DomainError(
      "NOT_FOUND",
      `unknown acceptance criterion "${criterionId}"`,
      { field: "criterionId" },
    );
  }
  const criterionStatus = assertOneOf(
    status,
    ACCEPTANCE_CRITERION_STATUSES,
    "status",
  );
  const acceptanceCriteria = task.acceptanceCriteria.map((criterion, at) =>
    at === index ? { ...criterion, status: criterionStatus } : criterion,
  );
  return {
    ...task,
    acceptanceCriteria,
    updatedAt: toIsoString(clock.now()),
  };
}

export function acceptanceSummary(task: Task): AcceptanceSummary {
  let met = 0;
  let notMet = 0;
  let waived = 0;
  let pending = 0;
  for (const criterion of task.acceptanceCriteria) {
    if (criterion.status === "met") {
      met += 1;
    } else if (criterion.status === "not-met") {
      notMet += 1;
    } else if (criterion.status === "waived") {
      waived += 1;
    } else {
      pending += 1;
    }
  }
  const total = task.acceptanceCriteria.length;
  return {
    total,
    met,
    notMet,
    waived,
    pending,
    allMet: total > 0 && met + waived === total,
  };
}

export function validateTask(task: Task): void {
  assertNonEmptyString(task.id, "task.id");
  assertNonEmptyString(task.projectId, "task.projectId");
  assertNonEmptyString(task.workspaceId, "task.workspaceId");
  assertNonEmptyString(task.title, "task.title");
  assertNonEmptyString(task.description, "task.description");
  assertStringArray(task.context, "task.context");
  assertStringArray(task.constraints, "task.constraints");
  assertOneOf(task.riskLevel, RISK_LEVELS, "task.riskLevel");
  assertOneOf(task.status, TASK_STATUSES, "task.status");
  validateBudget(task.budget);
  task.verificationStrategy.forEach(validateVerificationStep);

  const criterionIds = new Set<string>();
  task.acceptanceCriteria.forEach((criterion, index) => {
    const id = assertNonEmptyString(
      criterion.id,
      `task.acceptanceCriteria[${index}].id`,
    );
    if (criterionIds.has(id)) {
      throw new DomainError(
        "INVARIANT",
        `duplicate acceptance criterion id "${id}"`,
        { field: "task.acceptanceCriteria" },
      );
    }
    criterionIds.add(id);
    assertNonEmptyString(
      criterion.statement,
      `task.acceptanceCriteria[${index}].statement`,
    );
    assertOneOf(
      criterion.status,
      ACCEPTANCE_CRITERION_STATUSES,
      `task.acceptanceCriteria[${index}].status`,
    );
  });

  const createdAt = assertIsoTimestamp(task.createdAt, "task.createdAt");
  const updatedAt = assertIsoTimestamp(task.updatedAt, "task.updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new DomainError(
      "INVARIANT",
      "task.updatedAt must not precede task.createdAt",
      { field: "task.updatedAt" },
    );
  }

  if (task.status === "completed") {
    if (task.completedAt === undefined) {
      throw new DomainError(
        "INVARIANT",
        "a completed task must carry completedAt",
        { field: "task.completedAt" },
      );
    }
  } else if (task.completedAt !== undefined) {
    throw new DomainError(
      "INVARIANT",
      "completedAt may only be set when the task is completed",
      { field: "task.completedAt" },
    );
  }
}
