import { isAbsolute, relative, resolve } from "node:path";

import { type Clock, toIsoString } from "../core/clock.js";
import { DomainError } from "../core/errors.js";
import type { WorkspaceId } from "../core/ids.js";
import {
  assertIsoTimestamp,
  assertNonEmptyString,
  assertOneOf,
  assertSafeAbsolutePath,
} from "../core/validation.js";
import type { Project } from "../projects/project.js";
import {
  type IsolationProfile,
  defaultIsolationProfile,
  validateIsolationProfile,
} from "./isolation.js";

/**
 * Workspace: the isolated execution context in which tasks run.
 * See docs/architecture/V2-ARCHITECTURE.md §5 and §19.
 */
export const WORKSPACE_STATUSES = [
  "provisioning",
  "ready",
  "paused",
  "archived",
] as const;

export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export interface Workspace {
  readonly id: WorkspaceId;
  readonly projectId: Project["id"];
  readonly name: string;
  readonly rootPath: string;
  readonly isolation: IsolationProfile;
  readonly status: WorkspaceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWorkspaceInput {
  readonly name: string;
  readonly rootPath: string;
  readonly isolation?: IsolationProfile;
}

/** True when `child` is `parent` itself or nested inside it. */
export function isPathWithin(parent: string, child: string): boolean {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);
  const rel = relative(parentResolved, childResolved);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function createWorkspace(
  input: CreateWorkspaceInput,
  options: {
    readonly id: WorkspaceId;
    readonly project: Project;
    readonly clock: Clock;
    /**
     * Opt-in for a workspace outside `project.rootPath`. The platform MUST NOT
     * allow this silently; an allowance must be recorded (see §19.3 AccessGrant).
     */
    readonly allowOutsideProject?: boolean;
  },
): Workspace {
  const name = assertNonEmptyString(input.name, "name");
  const rootPath = assertSafeAbsolutePath(input.rootPath, "rootPath");
  const isolation = validateIsolationProfile(
    input.isolation ?? defaultIsolationProfile(),
  );
  if (
    options.allowOutsideProject !== true &&
    !isPathWithin(options.project.rootPath, rootPath)
  ) {
    throw new DomainError(
      "INVARIANT",
      "workspace rootPath must be inside project.rootPath unless an explicit allowance is recorded",
      { field: "rootPath" },
    );
  }
  const now = toIsoString(options.clock.now());

  return {
    id: options.id,
    projectId: options.project.id,
    name,
    rootPath,
    isolation,
    status: "provisioning",
    createdAt: now,
    updatedAt: now,
  };
}

/** A workspace may only be used with the project it belongs to. */
export function assertWorkspaceBelongsToProject(
  workspace: Workspace,
  project: Project,
): void {
  if (workspace.projectId !== project.id) {
    throw new DomainError(
      "INVARIANT",
      "workspace does not belong to the given project",
      { field: "workspace.projectId" },
    );
  }
}

export function isWorkspaceWithinProject(
  workspace: Workspace,
  project: Project,
): boolean {
  return isPathWithin(project.rootPath, workspace.rootPath);
}

/**
 * `archived` is terminal: an archived workspace must be restored by explicit
 * human action, not by a status assignment. Other changes are idempotent.
 */
export function setWorkspaceStatus(
  workspace: Workspace,
  status: WorkspaceStatus,
  clock: Clock,
): Workspace {
  const next = assertOneOf(status, WORKSPACE_STATUSES, "status");
  if (workspace.status === next) {
    return workspace;
  }
  if (workspace.status === "archived") {
    throw new DomainError(
      "INVARIANT",
      "an archived workspace is terminal and cannot change status",
      { field: "workspace.status" },
    );
  }
  return { ...workspace, status: next, updatedAt: toIsoString(clock.now()) };
}

export function validateWorkspace(workspace: Workspace): void {
  assertNonEmptyString(workspace.id, "workspace.id");
  assertNonEmptyString(workspace.projectId, "workspace.projectId");
  assertNonEmptyString(workspace.name, "workspace.name");
  assertSafeAbsolutePath(workspace.rootPath, "workspace.rootPath");
  validateIsolationProfile(workspace.isolation);
  assertOneOf(workspace.status, WORKSPACE_STATUSES, "workspace.status");
  const createdAt = assertIsoTimestamp(
    workspace.createdAt,
    "workspace.createdAt",
  );
  const updatedAt = assertIsoTimestamp(
    workspace.updatedAt,
    "workspace.updatedAt",
  );
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new DomainError(
      "INVARIANT",
      "workspace.updatedAt must not precede workspace.createdAt",
      { field: "workspace.updatedAt" },
    );
  }
}
