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
  type AcceptanceVerdictStatus,
  type CreateTaskInput,
  type Task,
  type VerificationSuiteEvidence,
  acceptanceSummary,
  assessAcceptanceCriteria,
  createTask as createDomainTask,
  markAcceptanceCriterion,
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

/**
 * One explicit human verdict on one acceptance criterion.
 *
 * `verdictBy` is required, not optional: a status a human establishes without a name
 * attached is exactly the anonymous assertion this record exists to prevent. It is an
 * identity, never a secret — the same convention `--approver` follows (ADR-037).
 */
export interface AcceptanceVerdictInput {
  readonly criterionId: string;
  readonly status: AcceptanceVerdictStatus;
  readonly verdictBy: string;
}

export interface TaskService {
  create(
    input: CreateTaskInput,
    context: CreateTaskContext,
  ): Promise<StoredTask>;
  /**
   * Builds the task `create` would store, without emitting an event or writing a
   * projection. The dry-run seam: the same domain constructor and validation,
   * none of the persistence.
   */
  planCreate(input: CreateTaskInput, context: CreateTaskContext): Task;
  load(scope: ProjectScope, id: TaskId): Promise<StoredTask>;
  list(scope: ProjectScope): Promise<readonly StoredTask[]>;
  transition(
    stored: StoredTask,
    next: TaskStatus,
    reason?: string,
  ): Promise<StoredTask>;
  start(stored: StoredTask): Promise<StoredTask>;
  complete(stored: StoredTask, reason?: string): Promise<StoredTask>;
  /**
   * Computes the record `complete` would store, without writing it. The same
   * domain transition (so an illegal transition still refuses), no event and no
   * save.
   */
  planComplete(stored: StoredTask): Task;
  fail(stored: StoredTask, reason: string): Promise<StoredTask>;
  cancel(stored: StoredTask, reason?: string): Promise<StoredTask>;
  /**
   * Assesses `pending`, explicitly bound acceptance criteria from the verification
   * evidence a run produced, recording an `AcceptanceAssessed` event before the
   * projection (ADR-023). Returns the task unchanged when nothing was assessed, so a
   * run with no bound criteria writes nothing extra.
   */
  assessAcceptance(
    stored: StoredTask,
    evidence: readonly VerificationSuiteEvidence[],
  ): Promise<StoredTask>;
  /**
   * Records an explicit human verdict on one acceptance criterion, event first.
   *
   * The counterpart of `assessAcceptance` for the other authority: a person deciding. It
   * writes the same criterion field and leaves different provenance, so a reader can
   * always tell which of the two established a status (ADR-060, ADR-062). A verdict never
   * moves the task: the lifecycle is unchanged by it, and the task's status is read
   * afterwards exactly as before.
   */
  recordAcceptanceVerdict(
    stored: StoredTask,
    input: AcceptanceVerdictInput,
  ): Promise<StoredTask>;
  /**
   * Computes the record `recordAcceptanceVerdict` would store, without writing it. The
   * same domain mutation — so an unknown criterion or a terminal task still refuses —
   * with no event and no save.
   */
  planAcceptanceVerdict(
    stored: StoredTask,
    input: AcceptanceVerdictInput,
  ): Task;
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

    planCreate(input, context) {
      return createDomainTask(input, {
        id: toTaskId(deps.taskIds.next()),
        project: context.project,
        workspace: context.workspace,
        clock: deps.clock,
      });
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
    planComplete: (stored) =>
      transitionDomainTask(stored.task, "completed", deps.clock),
    fail: (stored, reason) => transition(stored, "failed", reason),
    cancel: (stored, reason) => transition(stored, "cancelled", reason),

    planAcceptanceVerdict(stored, input) {
      return markAcceptanceCriterion(
        stored.task,
        input.criterionId,
        input.status,
        deps.clock,
        input.verdictBy,
      );
    },

    async recordAcceptanceVerdict(stored, input) {
      const { task } = stored;
      const previous = task.acceptanceCriteria.find(
        (criterion) => criterion.id === input.criterionId,
      );
      // The transition the event records is read from the record *before* the mutation,
      // so a replay of the log can reconstruct every step of a criterion's history
      // rather than only its latest state.
      const from = previous?.status ?? "pending";
      const verdict = markAcceptanceCriterion(
        task,
        input.criterionId,
        input.status,
        deps.clock,
        input.verdictBy,
      );
      await deps.recorder.emit({
        type: "AcceptanceVerdictRecorded",
        workspaceId: task.workspaceId,
        // A human action is recorded as a human action. The identity is the operator's
        // own name, supplied by them, and it is never derived from the environment.
        actor: { type: "human", id: input.verdictBy },
        taskId: task.id,
        correlationId: taskCorrelationId(
          task.projectId,
          task.workspaceId,
          task.id,
        ),
        payload: {
          criterionId: input.criterionId,
          from,
          to: input.status,
          verdictBy: input.verdictBy,
        },
      });
      const version = await deps.repository.save(
        { projectId: verdict.projectId, workspaceId: verdict.workspaceId },
        verdict,
        { expectedVersion: stored.version },
      );
      return { version, task: verdict };
    },

    async assessAcceptance(stored, evidence) {
      const { task } = stored;
      const result = assessAcceptanceCriteria(task, evidence, deps.clock);
      if (result.assessed.length === 0) {
        return stored;
      }
      const correlationId = taskCorrelationId(
        task.projectId,
        task.workspaceId,
        task.id,
      );
      // Event first, record second (ADR-023): the criterion statuses are a projection
      // of this event plus the suite's own `TestCompleted`, so a replay can rebuild
      // them and a failure between the two leaves an honest, detectable disagreement.
      await deps.recorder.emit({
        type: "AcceptanceAssessed",
        workspaceId: task.workspaceId,
        actor: TASK_ACTOR,
        taskId: task.id,
        correlationId,
        payload: {
          assessed: result.assessed.length,
          met: result.assessed.filter((entry) => entry.status === "met").length,
          notMet: result.assessed.filter((entry) => entry.status === "not-met")
            .length,
          criteria: result.assessed.map(
            (entry) =>
              `${entry.criterionId}:${entry.status}:${entry.suite}` +
              (entry.check === undefined ? "" : `:${entry.check}`),
          ),
        },
      });
      const version = await deps.repository.save(
        {
          projectId: result.task.projectId,
          workspaceId: result.task.workspaceId,
        },
        result.task,
        { expectedVersion: stored.version },
      );
      return { version, task: result.task };
    },
  };
}
