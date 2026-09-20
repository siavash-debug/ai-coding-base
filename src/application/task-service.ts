import type { Clock } from "../core/clock.js";
import {
  type IdFactory,
  type TaskId,
  taskId as toTaskId,
} from "../core/ids.js";
import type { EventActor } from "../observability/events.js";
import type { ProjectScope } from "../ports/scope.js";
import { DomainError } from "../core/errors.js";
import type { Project } from "../projects/project.js";
import type { Workspace } from "../workspaces/workspace.js";
import type { TaskStatus } from "../tasks/lifecycle.js";
import {
  type CreateTaskInput,
  acceptanceSummary,
  createTask as createDomainTask,
  transitionTask as transitionDomainTask,
} from "../tasks/task.js";
import type { TaskRepository, StoredTask } from "../ports/task-repository.js";
import { type EventRecorder, taskCorrelationId } from "./event-recorder.js";

/**
 * Task lifecycle use case.
 *
 * Deliberately narrow: it creates tasks and moves them through the declared
 * transition table. It does not run anything, call a provider, or touch budgets —
 * `run-task.ts` composes those concerns on top.
 *
 * Write order is always **event first, record second**. The log is authoritative
 * (ADR-006), so a failure after the event leaves an honest log plus a stale
 * record, which `ai doctor` detects and reports. The reverse order would leave
 * the log lying.
 */
export const TASK_ACTOR: EventActor = { type: "code", id: "task-service" };

export interface CreateTaskContext {
  readonly project: Project;
  readonly workspace: Workspace;
}

export interface TaskService {
  create(
    input: CreateTaskInput,
    context: CreateTaskContext,
  ): Promise<StoredTask>;
  load(scope: ProjectScope, id: TaskId): Promise<StoredTask>;
  list(scope: ProjectScope): Promise<readonly StoredTask[]>;
  transition(
    stored: StoredTask,
    next: TaskStatus,
    reason?: string,
  ): Promise<StoredTask>;
  start(stored: StoredTask): Promise<StoredTask>;
  complete(stored: StoredTask, reason?: string): Promise<StoredTask>;
  fail(stored: StoredTask, reason: string): Promise<StoredTask>;
  cancel(stored: StoredTask, reason?: string): Promise<StoredTask>;
}

export interface TaskServiceDeps {
  readonly repository: TaskRepository;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly taskIds: IdFactory;
}

export function createTaskService(deps: TaskServiceDeps): TaskService {
  async function transition(
    stored: StoredTask,
    next: TaskStatus,
    reason?: string,
  ): Promise<StoredTask> {
    const { task } = stored;
    const advanced = transitionDomainTask(task, next, deps.clock);
    const correlationId = taskCorrelationId(
      task.projectId,
      task.workspaceId,
      task.id,
    );
    const base = {
      workspaceId: task.workspaceId,
      actor: TASK_ACTOR,
      taskId: task.id,
      correlationId,
    } as const;

    await deps.recorder.emit({
      ...base,
      type: "TaskStatusChanged",
      payload: { from: task.status, to: advanced.status },
    });

    if (next === "planning") {
      await deps.recorder.emit({
        ...base,
        type: "TaskStarted",
        payload: {
          title: advanced.title,
          riskLevel: advanced.riskLevel,
          workspaceId: advanced.workspaceId,
        },
      });
    } else if (next === "completed") {
      const summary = acceptanceSummary(advanced);
      await deps.recorder.emit({
        ...base,
        type: "TaskCompleted",
        payload: {
          acceptanceCriteriaMet: summary.met + summary.waived,
          acceptanceCriteriaTotal: summary.total,
          ...(reason === undefined ? {} : { reason }),
        },
      });
    } else if (next === "failed") {
      const summary = acceptanceSummary(advanced);
      await deps.recorder.emit({
        ...base,
        type: "TaskFailed",
        payload: {
          reason: reason ?? "task failed",
          acceptanceCriteriaMet: summary.met + summary.waived,
          acceptanceCriteriaTotal: summary.total,
        },
      });
    }

    const version = await deps.repository.save(
      { projectId: advanced.projectId, workspaceId: advanced.workspaceId },
      advanced,
      { expectedVersion: stored.version },
    );
    return { version, task: advanced };
  }

  return {
    async create(input, context) {
      const task = createDomainTask(input, {
        id: toTaskId(deps.taskIds.next()),
        project: context.project,
        workspace: context.workspace,
        clock: deps.clock,
      });

      await deps.recorder.emit({
        type: "TaskCreated",
        workspaceId: task.workspaceId,
        actor: TASK_ACTOR,
        taskId: task.id,
        correlationId: taskCorrelationId(
          task.projectId,
          task.workspaceId,
          task.id,
        ),
        payload: {
          title: task.title,
          riskLevel: task.riskLevel,
          workspaceId: task.workspaceId,
        },
      });

      const version = await deps.repository.save(
        { projectId: task.projectId, workspaceId: task.workspaceId },
        task,
        { expectedVersion: undefined },
      );
      return { version, task };
    },

    async load(scope, id) {
      const stored = await deps.repository.find(scope, id);
      if (stored === undefined) {
        throw new DomainError("NOT_FOUND", `unknown task "${id}"`, {
          field: "taskId",
        });
      }
      return stored;
    },

    list: (scope) => deps.repository.list(scope),
    transition,
    start: (stored) => transition(stored, "planning"),
    complete: (stored, reason) => transition(stored, "completed", reason),
    fail: (stored, reason) => transition(stored, "failed", reason),
    cancel: (stored, reason) => transition(stored, "cancelled", reason),
  };
}
