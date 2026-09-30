import { randomUUID } from "node:crypto";

import { DomainError } from "./errors.js";

/**
 * Branded identifiers.
 *
 * Every entity id is a branded string so that a `ProjectId` can never be passed
 * where a `WorkspaceId` is expected. See docs/architecture/DECISIONS.md ADR-013.
 */
export type Brand<TValue, TBrand extends string> = TValue & {
  readonly __brand: TBrand;
};

export type ProjectId = Brand<string, "ProjectId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type TaskId = Brand<string, "TaskId">;
export type SessionId = Brand<string, "SessionId">;
export type DecisionId = Brand<string, "DecisionId">;
export type EventId = Brand<string, "EventId">;

/** Ids are opaque, but must be usable in logs, filenames and event stores. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    ID_PATTERN.test(value)
  );
}

function brand<TBrand extends string>(
  value: unknown,
  label: TBrand,
): Brand<string, TBrand> {
  if (!isValidId(value)) {
    throw new DomainError(
      "VALIDATION",
      `Invalid ${label}: expected a non-empty identifier of at most 128 ` +
        `characters matching ${ID_PATTERN.source}`,
      { field: label },
    );
  }
  return value as Brand<string, TBrand>;
}

export const projectId = (value: unknown): ProjectId =>
  brand(value, "ProjectId");
export const workspaceId = (value: unknown): WorkspaceId =>
  brand(value, "WorkspaceId");
export const taskId = (value: unknown): TaskId => brand(value, "TaskId");
export const sessionId = (value: unknown): SessionId =>
  brand(value, "SessionId");
export const decisionId = (value: unknown): DecisionId =>
  brand(value, "DecisionId");
export const eventId = (value: unknown): EventId => brand(value, "EventId");

/**
 * Id generation is injected for the same reason time is: determinism.
 * Tests use `createSequentialIdFactory`; production uses `createUuidIdFactory`.
 */
export interface IdFactory {
  readonly name: string;
  next(): string;
}

export function createSequentialIdFactory(
  prefix: string,
  start = 1,
): IdFactory {
  if (prefix.trim().length === 0) {
    throw new DomainError("VALIDATION", "Id factory prefix must not be empty", {
      field: "prefix",
    });
  }
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new DomainError(
      "VALIDATION",
      "Id factory start must be a non-negative safe integer",
      { field: "start" },
    );
  }
  let counter = start;
  return {
    name: prefix,
    next: () => `${prefix}-${counter++}`,
  };
}

export function createUuidIdFactory(): IdFactory {
  return {
    name: "uuid",
    next: () => randomUUID(),
  };
}
