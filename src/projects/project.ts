import { type Clock, toIsoString } from "../core/clock.js";
import { DomainError } from "../core/errors.js";
import type { ProjectId } from "../core/ids.js";
import {
  assertIsoTimestamp,
  assertOneOf,
  assertNonEmptyString,
  assertSafeAbsolutePath,
} from "../core/validation.js";

/**
 * Project: the ownership, isolation and engineering-memory boundary.
 * See docs/architecture/V2-ARCHITECTURE.md §4.
 */
export const PROJECT_STATUSES = ["active", "archived"] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly slug: string;
  readonly rootPath: string;
  readonly status: ProjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly slug: string;
  readonly rootPath: string;
  readonly status?: ProjectStatus;
}

export function createProject(
  input: CreateProjectInput,
  options: { readonly id: ProjectId; readonly clock: Clock },
): Project {
  const name = assertNonEmptyString(input.name, "name");
  const slug = assertNonEmptyString(input.slug, "slug");
  if (!PROJECT_SLUG_PATTERN.test(slug)) {
    throw new DomainError("VALIDATION", "slug must match ^[a-z][a-z0-9-]*$", {
      field: "slug",
    });
  }
  const rootPath = assertSafeAbsolutePath(input.rootPath, "rootPath");
  const status =
    input.status === undefined
      ? "active"
      : assertOneOf(input.status, PROJECT_STATUSES, "status");
  const now = toIsoString(options.clock.now());

  return {
    id: options.id,
    name,
    slug,
    rootPath,
    status,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Archiving freezes new work but preserves all events, memory and traceability.
 * Idempotent: archiving an archived project returns it unchanged.
 */
export function archiveProject(project: Project, clock: Clock): Project {
  return project.status === "archived"
    ? project
    : { ...project, status: "archived", updatedAt: toIsoString(clock.now()) };
}

export function restoreProject(project: Project, clock: Clock): Project {
  return project.status === "active"
    ? project
    : { ...project, status: "active", updatedAt: toIsoString(clock.now()) };
}

export function validateProject(project: Project): void {
  assertNonEmptyString(project.id, "project.id");
  assertNonEmptyString(project.name, "project.name");
  const slug = assertNonEmptyString(project.slug, "project.slug");
  if (!PROJECT_SLUG_PATTERN.test(slug)) {
    throw new DomainError(
      "VALIDATION",
      "project.slug must match ^[a-z][a-z0-9-]*$",
      {
        field: "project.slug",
      },
    );
  }
  assertSafeAbsolutePath(project.rootPath, "project.rootPath");
  assertOneOf(project.status, PROJECT_STATUSES, "project.status");
  const createdAt = assertIsoTimestamp(project.createdAt, "project.createdAt");
  const updatedAt = assertIsoTimestamp(project.updatedAt, "project.updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new DomainError(
      "INVARIANT",
      "project.updatedAt must not precede project.createdAt",
      { field: "project.updatedAt" },
    );
  }
}
