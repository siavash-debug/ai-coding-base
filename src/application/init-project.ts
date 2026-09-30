import type { Clock } from "../core/clock.js";
import { projectId, workspaceId } from "../core/ids.js";
import type { ModelRate } from "../observability/cost.js";
import { type Project, createProject } from "../projects/project.js";
import {
  type Workspace,
  createWorkspace,
  setWorkspaceStatus,
} from "../workspaces/workspace.js";

/**
 * The `ai init` use case: build the initial project and its first workspace.
 *
 * The default workspace root is the project root itself. For a single-repository
 * project the repository *is* the workspace; multi-workspace layouts create
 * subdirectory workspaces later. This cannot be permissive by accident: the
 * workspace root is validated to stay inside the project root by
 * `createWorkspace`.
 *
 * The use case stays in the application layer and returns domain objects. Writing
 * `.ai/project.json` is an adapter concern performed by the composition root, so
 * nothing here knows about the filesystem layout.
 */
export const DEFAULT_WORKSPACE_NAME = "default";

export interface InitialProjectInput {
  readonly name: string;
  readonly slug: string;
  readonly rootPath: string;
}

export interface InitialProjectDeps {
  readonly clock: Clock;
  readonly newProjectId: () => string;
  readonly newWorkspaceId: () => string;
  /** Pricing to seed for the models this installation actually uses. */
  readonly modelRates?: readonly ModelRate[];
}

export interface InitialProject {
  readonly project: Project;
  readonly workspaces: readonly Workspace[];
  readonly modelRates: readonly ModelRate[];
}

export function buildInitialProject(
  input: InitialProjectInput,
  deps: InitialProjectDeps,
): InitialProject {
  const project = createProject(
    { name: input.name, slug: input.slug, rootPath: input.rootPath },
    { id: projectId(deps.newProjectId()), clock: deps.clock },
  );

  // `ai init` provisions the runtime layout before this is called, so a `ready`
  // workspace is an accurate statement rather than an optimistic one.
  const workspace = setWorkspaceStatus(
    createWorkspace(
      { name: DEFAULT_WORKSPACE_NAME, rootPath: project.rootPath },
      {
        id: workspaceId(deps.newWorkspaceId()),
        project,
        clock: deps.clock,
      },
    ),
    "ready",
    deps.clock,
  );

  return {
    project,
    workspaces: [workspace],
    modelRates: deps.modelRates ?? [],
  };
}
