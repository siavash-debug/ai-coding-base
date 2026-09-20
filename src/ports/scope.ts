import type { ProjectId, WorkspaceId } from "../core/ids.js";

/**
 * The scope every storage read and write is expressed in.
 *
 * Scope is explicit rather than implicit for one reason: **a task id alone is
 * not authorization**. A caller must state which project (and optionally which
 * workspace) it believes it is operating on, and the adapter must prove that the
 * scope is the one it is bound to. See V2-ARCHITECTURE §19.
 *
 * `workspaceId` is optional because some reads are legitimately project-wide
 * (for example `ai task trace <task-id>` resolving a task without the caller
 * knowing its workspace). Writes always name a workspace.
 */
export interface ProjectScope {
  readonly projectId: ProjectId;
  readonly workspaceId?: WorkspaceId;
}

/** A scope that names its workspace, required by every write operation. */
export interface WorkspaceScope extends ProjectScope {
  readonly workspaceId: WorkspaceId;
}
