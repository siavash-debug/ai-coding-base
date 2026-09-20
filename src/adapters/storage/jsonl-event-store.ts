import {
  appendFile,
  mkdir,
  readFile as readTextFile,
  readdir,
} from "node:fs/promises";
import { basename, join } from "node:path";

import { DomainError, isDomainError } from "../../core/errors.js";
import {
  type ProjectId,
  type SessionId,
  type TaskId,
  type WorkspaceId,
  isValidId,
} from "../../core/ids.js";
import {
  type DomainEvent,
  assertDomainEvent,
} from "../../observability/events.js";
import type { AppendLock } from "../../ports/append-lock.js";
import { createNullAppendLock } from "../../ports/append-lock.js";
import type { EventStore } from "../../ports/event-store.js";
import type { ProjectScope } from "../../ports/scope.js";
import { EVENT_LOG_EXTENSION, eventsDirectory } from "./layout.js";

/**
 * Append-only JSONL event store (Phase C).
 *
 * One file per workspace, inside the project's own `.ai/runtime/events/`:
 * `<projectRoot>/.ai/runtime/events/<workspaceId>.jsonl`.
 *
 * Guarantees:
 *
 * - **Append-only.** Uses `appendFile`, never `writeFile`; the log is never
 *   truncated or rewritten. Nothing is silently overwritten.
 * - **Strictly increasing sequence per stream.** An append whose sequence does
 *   not extend the stream is rejected as a `CONFLICT`.
 * - **Deterministic serialization.** Canonical JSON (object keys sorted
 *   recursively) means the same event always produces byte-identical output.
 * - **Validation on read.** Every line is re-validated with `assertDomainEvent`,
 *   because a hand-edited log is untrusted input.
 * - **Project-scoped.** The store is bound to one project at construction and
 *   rejects a foreign scope, a foreign event, or an event filed under the wrong
 *   workspace.
 *
 * - **Serialized appends.** Every append happens inside `AppendLock.withLock` for
 *   its workspace stream, and the stream's current tail is re-read *under* the
 *   lock rather than trusted from cache. Two writers therefore cannot both append
 *   sequence 8: the loser's batch no longer extends the stream and is rejected as
 *   a `CONFLICT` (ADR-036). With the default no-op lock (`createNullAppendLock`) the
 *   sequence guard still rejects a stale writer, but coordination between
 *   processes is the caller's responsibility — `ai doctor` reports which lock is in
 *   use.
 */
export interface JsonlEventStoreOptions {
  readonly projectRoot: string;
  readonly projectId: ProjectId;
  /** Workspaces this store is allowed to touch. Omitted means "no allow-list". */
  readonly knownWorkspaceIds?: readonly WorkspaceId[];
  /** Append coordination. Defaults to no coordination (single-writer). */
  readonly lock?: AppendLock;
  readonly storeId?: string;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry !== undefined) {
        sorted[key] = sortJsonValue(entry);
      }
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical JSON for one event: object keys sorted recursively, arrays kept in
 * order, `undefined` members dropped. Two structurally equal events always
 * serialize to the same bytes, regardless of how they were constructed.
 */
export function canonicalizeEvent(event: DomainEvent): string {
  return JSON.stringify(sortJsonValue(event));
}

/** Ordering contract: wall-clock first, then sequence, then id. */
function compareEvents(a: DomainEvent, b: DomainEvent): number {
  const aAt = Date.parse(a.occurredAt);
  const bAt = Date.parse(b.occurredAt);
  if (aAt !== bAt) {
    return aAt - bAt;
  }
  if (a.sequence !== b.sequence) {
    return a.sequence - b.sequence;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function createJsonlEventStore(
  options: JsonlEventStoreOptions,
): EventStore {
  const directory = eventsDirectory(options.projectRoot);
  const boundProjectId = options.projectId;
  const allowList =
    options.knownWorkspaceIds === undefined
      ? undefined
      : new Set<string>(options.knownWorkspaceIds);
  const tailSequences = new Map<string, number>();
  const lock = options.lock ?? createNullAppendLock();

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
        `this store is bound to project "${boundProjectId}" and must not read project "${scope.projectId}"`,
        { field: "scope.projectId" },
      );
    }
    if (scope.workspaceId !== undefined) {
      assertWorkspace(scope.workspaceId);
    }
  }

  function logFile(workspaceId: WorkspaceId): string {
    assertWorkspace(workspaceId);
    return join(directory, `${workspaceId}${EVENT_LOG_EXTENSION}`);
  }

  /**
   * Workspace logs visible to a scope. A project-wide read unions the workspace
   * partitions in a deterministic (filename) order; it never reads a single
   * shared file, so unrelated workspaces cannot leak into each other.
   */
  async function listLogFiles(scope: ProjectScope): Promise<readonly string[]> {
    if (scope.workspaceId !== undefined) {
      return [logFile(scope.workspaceId)];
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
    const files: string[] = [];
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isFile() || !entry.name.endsWith(EVENT_LOG_EXTENSION)) {
        continue;
      }
      const workspaceName = entry.name.slice(0, -EVENT_LOG_EXTENSION.length);
      if (!isValidId(workspaceName)) {
        throw new DomainError(
          "FORBIDDEN",
          `unexpected event log "${entry.name}" in ${directory}: the file name is not a workspace id`,
          { field: "eventLog" },
        );
      }
      if (allowList !== undefined && !allowList.has(workspaceName)) {
        // A log for a workspace this store is not configured for. Skipped rather
        // than read: the store only speaks for its configured workspaces.
        continue;
      }
      files.push(join(directory, entry.name));
    }
    return files;
  }

  async function parseEventLog(
    file: string,
    expectedWorkspaceId: WorkspaceId,
  ): Promise<readonly DomainEvent[]> {
    let raw: string;
    try {
      raw = await readTextFile(file, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }

    const events: DomainEvent[] = [];
    const lines = raw.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line === "") {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new DomainError(
          "VALIDATION",
          `${file} line ${index + 1} is not valid JSON`,
          { field: "event", line: index + 1 },
        );
      }
      let event: DomainEvent;
      try {
        event = assertDomainEvent(parsed);
      } catch (error) {
        if (isDomainError(error)) {
          throw new DomainError(
            error.code,
            `${file} line ${index + 1}: ${error.message}`,
            { ...error.details, line: index + 1, file },
          );
        }
        throw error;
      }
      if (event.projectId !== boundProjectId) {
        throw new DomainError(
          "INVARIANT",
          `event "${event.id}" in ${file} belongs to project "${event.projectId}", but this store is bound to "${boundProjectId}"`,
          { field: "event.projectId", file },
        );
      }
      if (event.workspaceId !== expectedWorkspaceId) {
        throw new DomainError(
          "INVARIANT",
          `event "${event.id}" is filed under workspace "${expectedWorkspaceId}" but belongs to workspace "${event.workspaceId}"`,
          { field: "event.workspaceId", file },
        );
      }
      events.push(event);
    }
    return events;
  }

  async function readAll(scope: ProjectScope): Promise<readonly DomainEvent[]> {
    assertScope(scope);
    const collected: DomainEvent[] = [];
    for (const file of await listLogFiles(scope)) {
      const expected = basename(file).slice(
        0,
        -EVENT_LOG_EXTENSION.length,
      ) as WorkspaceId;
      for (const event of await parseEventLog(file, expected)) {
        collected.push(event);
        const seen = tailSequences.get(event.workspaceId) ?? 0;
        if (event.sequence > seen) {
          tailSequences.set(event.workspaceId, event.sequence);
        }
      }
    }
    return collected.sort(compareEvents);
  }

  async function appendMany(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    // Validate everything before touching the log, so a rejected batch leaves
    // the log unchanged.
    const byWorkspace = new Map<string, DomainEvent[]>();
    for (const candidate of events) {
      const event = assertDomainEvent(candidate);
      if (event.projectId !== boundProjectId) {
        throw new DomainError(
          "FORBIDDEN",
          `event "${event.id}" belongs to project "${event.projectId}" but this store is bound to "${boundProjectId}"`,
          { field: "event.projectId" },
        );
      }
      assertWorkspace(event.workspaceId);
      const group = byWorkspace.get(event.workspaceId) ?? [];
      group.push(event);
      byWorkspace.set(event.workspaceId, group);
    }

    await mkdir(directory, { recursive: true });
    for (const [workspaceKey, group] of byWorkspace) {
      const workspace = workspaceKey as WorkspaceId;
      const file = logFile(workspace);

      // Everything that depends on "what is currently in the stream" happens
      // inside the lock, including reading the tail. Reading it from cache here
      // would reintroduce exactly the race the lock exists to close.
      const highest = await lock.withLock(workspaceKey, async () => {
        const existing = await parseEventLog(file, workspace);
        let tail = tailSequences.get(workspaceKey) ?? 0;
        for (const event of existing) {
          if (event.sequence > tail) {
            tail = event.sequence;
          }
        }
        let next = tail;
        for (const event of group) {
          if (event.sequence <= next) {
            throw new DomainError(
              "CONFLICT",
              `event "${event.id}" has sequence ${event.sequence}, which does not extend the "${workspaceKey}" stream (last sequence ${next})`,
              { field: "sequence", lastSequence: next },
            );
          }
          next = event.sequence;
        }
        const payload = group
          .map((event) => `${canonicalizeEvent(event)}\n`)
          .join("");
        await appendFile(file, payload, "utf8");
        return next;
      });

      tailSequences.set(workspaceKey, highest);
    }
  }

  return {
    id: options.storeId ?? `jsonl:${boundProjectId}`,

    append: (event) => appendMany([event]),

    appendMany,

    readAll,

    async readByTask(scope, taskId: TaskId) {
      const events = await readAll(scope);
      return events.filter((event) => event.taskId === taskId);
    },

    async readBySession(scope, sessionId: SessionId) {
      const events = await readAll(scope);
      return events.filter((event) => event.sessionId === sessionId);
    },

    async listTaskIds(scope) {
      const events = await readAll(scope);
      const seen = new Set<string>();
      const ordered: TaskId[] = [];
      for (const event of events) {
        if (event.taskId !== undefined && !seen.has(event.taskId)) {
          seen.add(event.taskId);
          ordered.push(event.taskId);
        }
      }
      return ordered;
    },
  };
}
