import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DomainError } from "../../core/errors.js";
import {
  type ProjectId,
  type TaskId,
  type WorkspaceId,
  isValidId,
} from "../../core/ids.js";
import { assertNonNegativeInteger } from "../../core/validation.js";
import type {
  TaskRepository,
  StoredTask,
} from "../../ports/task-repository.js";
import type { ProjectScope, WorkspaceScope } from "../../ports/scope.js";
import { type Task, validateTask } from "../../tasks/task.js";
import { TASK_RECORD_SCHEMA_VERSION, tasksDirectory } from "./layout.js";

/**
 * File-backed task repository: a versioned record per task.
 *
 * `<projectRoot>/.ai/runtime/tasks/<workspaceId>/<taskId>.json`
 *
 * - **Version-guarded writes.** `save` carries the version the caller read, and a
 *   mismatch is a `CONFLICT` instead of a silent overwrite (ADR-012).
 * - **Atomic.** Written to a temporary file and renamed, so a crash cannot leave
 *   a half-written record.
 * - **Scoped.** A record must agree with the scope it is read or written under;
 *   a foreign project or workspace is `FORBIDDEN`.
 * - **Validated.** Records are re-validated on read with `validateTask`, so a
 *   hand-edited file fails loudly instead of feeding invalid data to the domain.
 */
export interface FileTaskRepositoryOptions {
  readonly projectRoot: string;
  readonly projectId: ProjectId;
  readonly knownWorkspaceIds?: readonly WorkspaceId[];
  readonly repositoryId?: string;
}

interface TaskRecord {
  readonly schemaVersion: number;
  readonly version: number;
  readonly task: Task;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function createFileTaskRepository(
  options: FileTaskRepositoryOptions,
): TaskRepository {
  const directory = tasksDirectory(options.projectRoot);
  const boundProjectId = options.projectId;
  const allowList =
    options.knownWorkspaceIds === undefined
      ? undefined
      : new Set<string>(options.knownWorkspaceIds);

  function assertWorkspace(workspaceId: WorkspaceId): void {
    if (!isValidId(workspaceId)) {
      throw new DomainError(
        "VALIDATION",
        `"${String(workspaceId)}" is not a usable workspace id`,
        { field: "workspaceId" },
      );
    }
    if (allowList !== undefined && !allowList.has(workspaceId)) {
      throw new DomainError(
        "FORBIDDEN",
        `workspace "${workspaceId}" is not part of project "${boundProjectId}"`,
        { field: "workspaceId" },
      );
    }
  }

  function assertScope(scope: ProjectScope): void {
    if (scope.projectId !== boundProjectId) {
      throw new DomainError(
        "FORBIDDEN",
        `this repository is bound to project "${boundProjectId}" and must not read project "${scope.projectId}"`,
        { field: "scope.projectId" },
      );
    }
    if (scope.workspaceId !== undefined) {
      assertWorkspace(scope.workspaceId);
    }
  }

  function assertTaskId(taskId: TaskId): void {
    if (!isValidId(taskId)) {
      throw new DomainError(
        "VALIDATION",
        `"${String(taskId)}" is not a usable task id`,
        { field: "taskId" },
      );
    }
  }

  function recordFile(workspaceId: WorkspaceId, taskId: TaskId): string {
    assertWorkspace(workspaceId);
    assertTaskId(taskId);
    return join(directory, workspaceId, `${taskId}.json`);
  }

  async function workspaceDirectories(
    scope: ProjectScope,
  ): Promise<readonly string[]> {
    if (scope.workspaceId !== undefined) {
      return [join(directory, scope.workspaceId)];
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }
    const found: string[] = [];
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (allowList !== undefined && !allowList.has(entry.name)) {
        continue;
      }
      found.push(join(directory, entry.name));
    }
    return found;
  }

  async function readRecord(
    file: string,
    scope: ProjectScope,
  ): Promise<StoredTask | undefined> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DomainError("VALIDATION", `${file} is not valid JSON`, {
        field: "task",
        file,
      });
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new DomainError("VALIDATION", `${file} must contain an object`, {
        field: "task",
        file,
      });
    }
    const record = parsed as Record<string, unknown>;
    if (record["schemaVersion"] !== TASK_RECORD_SCHEMA_VERSION) {
      throw new DomainError(
        "VALIDATION",
        `${file}: record.schemaVersion must be ${TASK_RECORD_SCHEMA_VERSION}`,
        { field: "record.schemaVersion", file },
      );
    }
    const version = assertNonNegativeInteger(
      record["version"],
      "record.version",
    );
    const task = record["task"] as Task;
    try {
      validateTask(task);
    } catch (error) {
      if (error instanceof DomainError) {
        throw new DomainError(error.code, `${file}: ${error.message}`, {
          ...error.details,
          file,
        });
      }
      throw error;
    }
    if (task.projectId !== scope.projectId) {
      throw new DomainError(
        "INVARIANT",
        `task "${task.id}" in ${file} belongs to project "${task.projectId}", but this repository is bound to "${scope.projectId}"`,
        { field: "task.projectId", file },
      );
    }
    if (
      scope.workspaceId !== undefined &&
      task.workspaceId !== scope.workspaceId
    ) {
      throw new DomainError(
        "INVARIANT",
        `task "${task.id}" belongs to workspace "${task.workspaceId}", not "${scope.workspaceId}"`,
        { field: "task.workspaceId", file },
      );
    }
    return { version, task };
  }

  return {
    id: options.repositoryId ?? `file-tasks:${boundProjectId}`,

    async save(scope: WorkspaceScope, task: Task, write) {
      assertScope(scope);
      if (task.projectId !== scope.projectId) {
        throw new DomainError(
          "FORBIDDEN",
          `task "${task.id}" belongs to project "${task.projectId}", not "${scope.projectId}"`,
          { field: "task.projectId" },
        );
      }
      if (task.workspaceId !== scope.workspaceId) {
        throw new DomainError(
          "FORBIDDEN",
          `task "${task.id}" belongs to workspace "${task.workspaceId}", not "${scope.workspaceId}"`,
          { field: "task.workspaceId" },
        );
      }
      validateTask(task);

      const file = recordFile(scope.workspaceId, task.id);
      const existing = await readRecord(file, scope);
      if (write.expectedVersion === undefined) {
        if (existing !== undefined) {
          throw new DomainError(
            "CONFLICT",
            `task record "${task.id}" already exists at version ${existing.version}`,
            { field: "task.id" },
          );
        }
      } else {
        if (existing === undefined) {
          throw new DomainError(
            "CONFLICT",
            `task record "${task.id}" does not exist, so it cannot be updated`,
            { field: "task.id" },
          );
        }
        if (existing.version !== write.expectedVersion) {
          throw new DomainError(
            "CONFLICT",
            `task record "${task.id}" is at version ${existing.version}, not the expected ${write.expectedVersion}`,
            { field: "version" },
          );
        }
      }

      const nextVersion = (existing?.version ?? 0) + 1;
      const record: TaskRecord = {
        schemaVersion: TASK_RECORD_SCHEMA_VERSION,
        version: nextVersion,
        task,
      };
      await mkdir(join(directory, scope.workspaceId), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify(record, null, 2)}\n`,
        "utf8",
      );
      await rename(temporary, file);
      return nextVersion;
    },

    async find(scope, taskId: TaskId) {
      assertScope(scope);
      assertTaskId(taskId);
      for (const workspacePath of await workspaceDirectories(scope)) {
        const found = await readRecord(
          join(workspacePath, `${taskId}.json`),
          scope,
        );
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    },

    async list(scope: ProjectScope) {
      assertScope(scope);
      const collected: StoredTask[] = [];
      for (const workspacePath of await workspaceDirectories(scope)) {
        let entries;
        try {
          entries = await readdir(workspacePath, { withFileTypes: true });
        } catch (error) {
          if (isMissingFile(error)) {
            continue;
          }
          throw error;
        }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) {
            continue;
          }
          const found = await readRecord(
            join(workspacePath, entry.name),
            scope,
          );
          if (found !== undefined) {
            collected.push(found);
          }
        }
      }
      return collected.sort((a, b) =>
        a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0,
      );
    },
  };
}
