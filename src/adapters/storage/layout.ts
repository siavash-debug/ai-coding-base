import { join } from "node:path";

/**
 * The project-scoped `.ai/` layout.
 *
 * ```text
 * <projectRoot>/.ai/
 * ├── project.json          # project configuration (committed)
 * └── runtime/              # runtime state (NOT committed, see .gitignore)
 *     ├── events/<workspaceId>.jsonl
 *     └── tasks/<workspaceId>/<taskId>.json
 * ```
 *
 * Two properties matter here:
 *
 * 1. **Everything lives under the project root.** There is no global, shared
 *    location, so a store bound to one project cannot reach another project's
 *    data by accident (V2-ARCHITECTURE §19: isolation by default).
 * 2. **Events are partitioned per workspace**, so a workspace's stream is
 *    physically separate. Project-wide reads are an explicit union over those
 *    partitions, not a shared file.
 *
 * `runtime/` is deliberately separate from the engineering-memory tree of §21:
 * memory is human-reviewable knowledge that belongs in version control, runtime
 * state does not.
 */
export const AI_DIRECTORY = ".ai";
export const RUNTIME_DIRECTORY = "runtime";
export const EVENTS_DIRECTORY = "events";
export const TASKS_DIRECTORY = "tasks";
export const PROJECT_CONFIG_FILE = "project.json";
export const PROJECT_CONFIG_SCHEMA_VERSION = 1;
/** Version of the on-disk task record envelope in `runtime/tasks/`. */
export const TASK_RECORD_SCHEMA_VERSION = 1;
export const EVENT_LOG_EXTENSION = ".jsonl";

export function aiDirectory(projectRoot: string): string {
  return join(projectRoot, AI_DIRECTORY);
}

export function runtimeDirectory(projectRoot: string): string {
  return join(aiDirectory(projectRoot), RUNTIME_DIRECTORY);
}

export function eventsDirectory(projectRoot: string): string {
  return join(runtimeDirectory(projectRoot), EVENTS_DIRECTORY);
}

export function tasksDirectory(projectRoot: string): string {
  return join(runtimeDirectory(projectRoot), TASKS_DIRECTORY);
}

export function projectConfigPath(projectRoot: string): string {
  return join(aiDirectory(projectRoot), PROJECT_CONFIG_FILE);
}

/** Directories the runtime needs, in creation order. */
export function runtimeDirectories(projectRoot: string): readonly string[] {
  return [
    aiDirectory(projectRoot),
    runtimeDirectory(projectRoot),
    eventsDirectory(projectRoot),
    tasksDirectory(projectRoot),
  ];
}
