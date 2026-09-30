import { type ManualClock, createManualClock } from "../../src/core/clock.js";
import { projectId, taskId, workspaceId } from "../../src/core/ids.js";
import { type Project, createProject } from "../../src/projects/project.js";
import {
  type CreateTaskInput,
  type Task,
  createTask,
} from "../../src/tasks/task.js";
import {
  type Workspace,
  createWorkspace,
  setWorkspaceStatus,
} from "../../src/workspaces/workspace.js";

export const START_INSTANT = "2026-09-20T10:00:00.000Z";
export const PROJECT_ROOT = "/srv/projects/demo";

export interface Harness {
  readonly clock: ManualClock;
  readonly project: Project;
  readonly workspace: Workspace;
  readonly task: Task;
}

/**
 * A fully deterministic project + ready workspace + task. Time is a manual clock
 * and ids are fixed, so nothing here depends on the machine it runs on.
 */
export function createHarness(overrides?: {
  readonly projectRoot?: string;
  readonly task?: Partial<CreateTaskInput>;
}): Harness {
  const clock = createManualClock(START_INSTANT);
  const project = createProject(
    {
      name: "Demo",
      slug: "demo",
      rootPath: overrides?.projectRoot ?? PROJECT_ROOT,
    },
    { id: projectId("prj-1"), clock },
  );
  const workspace = setWorkspaceStatus(
    createWorkspace(
      { name: "ws-1", rootPath: `${project.rootPath}/ws-1` },
      { id: workspaceId("wsp-1"), project, clock },
    ),
    "ready",
    clock,
  );
  const task = createTask(
    {
      title: "Add runtime validation",
      description: "Reject structurally invalid input at the boundary.",
      acceptanceCriteria: ["Invalid input is rejected"],
      riskLevel: "medium",
      ...overrides?.task,
    },
    { id: taskId("tsk-1"), project, workspace, clock },
  );
  return { clock, project, workspace, task };
}
