import type { TaskId } from "../core/ids.js";
import type { Task } from "../tasks/task.js";
import type { ProjectScope, WorkspaceScope } from "./scope.js";

/**
 * A task record plus the version it was read at.
 *
 * Writes carry the version the caller read, so two writers cannot silently
 * clobber each other. See V2-ARCHITECTURE §27 and DECISIONS.md ADR-012.
 */
export interface StoredTask {
  readonly version: number;
  readonly task: Task;
}

export interface TaskWriteOptions {
  /**
   * The version the caller read. `undefined` means "this is a create".
   * A mismatch is a `CONFLICT`, never a silent overwrite.
   */
  readonly expectedVersion: number | undefined;
}

/**
 * TaskRepository port.
 *
 * Persistence shapes are deliberately separate from the domain shape (the JSONL
 * adapter stores a versioned envelope, not a bare `Task`), so a schema change
 * does not force a domain rewrite and a domain refactor does not corrupt data.
 */
export interface TaskRepository {
  readonly id: string;

  /** Creates or updates a task record. Returns the new version. */
  save(
    scope: WorkspaceScope,
    task: Task,
    options: TaskWriteOptions,
  ): Promise<number>;

  /** Resolves a task by id. Without a workspace it searches the whole project. */
  find(scope: ProjectScope, taskId: TaskId): Promise<StoredTask | undefined>;

  /** All task records in the scope, ordered by task id. */
  list(scope: ProjectScope): Promise<readonly StoredTask[]>;
}
