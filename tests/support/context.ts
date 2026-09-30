import type { ContextConfig } from "../../src/adapters/config/project-config.js";
import { DEFAULT_CONTEXT_CONFIG } from "../../src/adapters/config/project-config.js";
import { createDeterministicContextEngine } from "../../src/application/context-engine.js";
import { createEventRecorder } from "../../src/application/event-recorder.js";
import type { ContextEngine } from "../../src/ports/context-engine.js";
import type { DomainEvent } from "../../src/observability/events.js";
import { nextSequence } from "../../src/observability/events.js";
import type { EventStore } from "../../src/ports/event-store.js";
import type { ProjectScope } from "../../src/ports/scope.js";
import type {
  ChangeProvider,
  ChangedPaths,
} from "../../src/ports/change-provider.js";
import type {
  RepositoryEntry,
  RepositoryListing,
  RepositoryReader,
} from "../../src/ports/repository-reader.js";
import type { Project } from "../../src/projects/project.js";
import type { Workspace } from "../../src/workspaces/workspace.js";
import { type Clock, createFixedClock } from "../../src/core/clock.js";
import { DomainError } from "../../src/core/errors.js";
import {
  type TaskId,
  createSequentialIdFactory,
  projectId,
  workspaceId,
} from "../../src/core/ids.js";

/**
 * In-memory fakes for the context engine.
 *
 * The engine is pure logic over two ports, so its tests use fakes rather than the
 * filesystem: discovery order, exclusion rules, scoring and budgeting are then
 * asserted directly, with no temp directories and no dependence on what happens to
 * be in the repository. The real adapters have their own tests against real files,
 * because a fake reader cannot prove that `.env` is never read from disk.
 *
 * The fakes are deliberately *strict*: the reader records every path it was asked
 * for, which is how "a secret file is never read" becomes an assertion instead of a
 * promise. The event store enforces scope, so an isolation test cannot pass by
 * accident.
 *
 * Everything is offline, clock-driven and deterministic.
 */
export const CONTEXT_TEST_INSTANT = "2026-09-20T10:00:00.000Z";

export interface FakeFile {
  readonly content: string;
  /** Overrides the byte count, to test "too large to read" without a big file. */
  readonly bytes?: number;
}

export interface FakeReader extends RepositoryReader {
  /** Every `ref` this reader was asked to read, in order. Duplicates included. */
  readonly readLog: string[];
}

export function createFakeReader(
  files: Readonly<Record<string, string | FakeFile>>,
  options: { readonly truncated?: boolean; readonly readerId?: string } = {},
): FakeReader {
  const entries: RepositoryEntry[] = Object.keys(files)
    .sort()
    .map((ref) => {
      const value = files[ref];
      const file: FakeFile =
        typeof value === "string" ? { content: value } : value;
      return {
        ref,
        bytes: file.bytes ?? Buffer.byteLength(file.content, "utf8"),
      };
    });
  const readLog: string[] = [];

  return {
    id: options.readerId ?? "fake-reader",
    readLog,
    async list(): Promise<RepositoryListing> {
      return { entries, truncated: options.truncated === true };
    },
    async read(ref: string): Promise<string> {
      readLog.push(ref);
      const value = files[ref];
      if (value === undefined) {
        throw new DomainError("NOT_FOUND", `no file "${ref}"`, {
          field: "ref",
        });
      }
      return typeof value === "string" ? value : value.content;
    },
    async tryRead(ref: string): Promise<string | undefined> {
      if (files[ref] === undefined) {
        return undefined;
      }
      return await this.read(ref);
    },
  };
}

export function createFakeChanges(
  refs: readonly string[],
  options: {
    readonly available?: boolean;
    readonly reason?: ChangedPaths["reason"];
    readonly revision?: string;
    readonly providerId?: string;
  } = {},
): ChangeProvider & { calls: number } {
  const available = options.available ?? true;
  return {
    id: options.providerId ?? "fake-changes",
    calls: 0,
    async changedRefs(): Promise<ChangedPaths> {
      this.calls += 1;
      return available
        ? {
            available: true,
            refs,
            ...(options.revision === undefined
              ? {}
              : { revision: options.revision }),
          }
        : {
            available: false,
            reason: options.reason ?? "not-a-repository",
          };
    },
  };
}

/** A scope-enforcing, append-only, in-memory `EventStore`. */
export function createMemoryEventStore(input: {
  readonly projectId: string;
  readonly workspaceIds: readonly string[];
}): EventStore & { readonly events: readonly DomainEvent[] } {
  const events: DomainEvent[] = [];
  const known = new Set(input.workspaceIds);

  function assertScope(scope: ProjectScope): void {
    if (scope.projectId !== input.projectId) {
      throw new DomainError(
        "FORBIDDEN",
        `scope project "${scope.projectId}" is not "${input.projectId}"`,
        { field: "scope.projectId" },
      );
    }
    if (scope.workspaceId !== undefined && !known.has(scope.workspaceId)) {
      throw new DomainError(
        "FORBIDDEN",
        `workspace "${scope.workspaceId}" is not configured`,
        { field: "scope.workspaceId" },
      );
    }
  }

  function visible(scope: ProjectScope): readonly DomainEvent[] {
    assertScope(scope);
    return events.filter(
      (event) =>
        event.projectId === scope.projectId &&
        (scope.workspaceId === undefined ||
          event.workspaceId === scope.workspaceId),
    );
  }

  return {
    id: "memory-event-store",
    get events() {
      return [...events];
    },
    async append(event: DomainEvent): Promise<void> {
      if (event.projectId !== input.projectId) {
        throw new DomainError("FORBIDDEN", "foreign project event", {
          field: "event.projectId",
        });
      }
      if (!known.has(event.workspaceId)) {
        throw new DomainError("FORBIDDEN", "unconfigured workspace", {
          field: "event.workspaceId",
        });
      }
      const stream = events.filter(
        (candidate) => candidate.workspaceId === event.workspaceId,
      );
      if (event.sequence !== nextSequence(stream)) {
        throw new DomainError(
          "CONFLICT",
          `expected sequence ${nextSequence(stream)}`,
          { field: "event.sequence" },
        );
      }
      events.push(event);
    },
    async appendMany(batch: readonly DomainEvent[]): Promise<void> {
      for (const event of batch) {
        await this.append(event);
      }
    },
    async readAll(scope: ProjectScope): Promise<readonly DomainEvent[]> {
      return visible(scope);
    },
    async readByTask(
      scope: ProjectScope,
      taskId,
    ): Promise<readonly DomainEvent[]> {
      return visible(scope).filter((event) => event.taskId === taskId);
    },
    async readBySession(
      scope: ProjectScope,
      sessionId,
    ): Promise<readonly DomainEvent[]> {
      return visible(scope).filter((event) => event.sessionId === sessionId);
    },
    async listTaskIds(scope: ProjectScope): Promise<readonly TaskId[]> {
      const ids: TaskId[] = [];
      for (const event of visible(scope)) {
        if (event.taskId !== undefined && !ids.includes(event.taskId)) {
          ids.push(event.taskId);
        }
      }
      return ids;
    },
  };
}

export interface ContextHarness {
  readonly engine: ContextEngine;
  readonly store: EventStore & { readonly events: readonly DomainEvent[] };
  /** The reader the engine actually uses: the fake, unless one was injected. */
  readonly reader: RepositoryReader;
  /**
   * The recording fake, always present. Separate from `reader` so that a test which
   * injects a real reader cannot mistake an empty fake log for "nothing was read".
   */
  readonly fakeReader: FakeReader;
  readonly changes: ChangeProvider & { calls: number };
  readonly project: Project;
  readonly workspace: Workspace;
}

export interface ContextHarnessOptions {
  /** Defaults to empty when a real `reader` is supplied. */
  readonly files?: Readonly<Record<string, string | FakeFile>>;
  /** A real reader, for tests that must exercise the filesystem. */
  readonly reader?: RepositoryReader;
  readonly changedRefs?: readonly string[];
  readonly changesAvailable?: boolean;
  readonly changeReason?: ChangedPaths["reason"];
  readonly truncated?: boolean;
  readonly config?: Partial<ContextConfig>;
  readonly clock?: Clock;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly includeRetry?: boolean;
}

/**
 * A project + workspace + engine + memory store, wired exactly as the runtime wires
 * them, so an engine test exercises the real composition rather than a special case.
 */
export function createContextHarness(
  options: ContextHarnessOptions,
): ContextHarness {
  const clock = options.clock ?? createFixedClock(CONTEXT_TEST_INSTANT);
  const project: Project = {
    id: projectId(options.projectId ?? "prj-context"),
    name: "Context Tests",
    slug: "context-tests",
    rootPath: "/srv/context-tests",
    status: "active",
    createdAt: CONTEXT_TEST_INSTANT,
    updatedAt: CONTEXT_TEST_INSTANT,
  };
  const workspace: Workspace = {
    id: workspaceId(options.workspaceId ?? "wsp-context"),
    projectId: project.id,
    name: "default",
    rootPath: "/srv/context-tests",
    isolation: {
      filesystem: { mode: "scoped", enforcement: "declared" },
      git: { mode: "scoped", enforcement: "declared" },
      processes: { mode: "process", enforcement: "declared" },
      dependencies: { mode: "scoped", enforcement: "declared" },
      environment: { mode: "scoped", enforcement: "declared" },
      secrets: { mode: "scoped", enforcement: "declared" },
      network: { mode: "none", enforcement: "declared" },
      aiContext: { mode: "scoped", enforcement: "declared" },
      aiMemory: { mode: "scoped", enforcement: "declared" },
      taskHistory: { mode: "scoped", enforcement: "declared" },
      telemetry: { mode: "scoped", enforcement: "declared" },
      resourceLimits: { mode: "scoped", enforcement: "declared" },
    },
    status: "ready",
    createdAt: CONTEXT_TEST_INSTANT,
    updatedAt: CONTEXT_TEST_INSTANT,
  };
  const store = createMemoryEventStore({
    projectId: project.id,
    workspaceIds: [workspace.id],
  });
  const fake = createFakeReader(options.files ?? {}, {
    ...(options.truncated === undefined
      ? {}
      : { truncated: options.truncated }),
  });
  const reader = options.reader ?? fake;
  const changes = createFakeChanges(options.changedRefs ?? [], {
    ...(options.changesAvailable === undefined
      ? {}
      : { available: options.changesAvailable }),
    ...(options.changeReason === undefined
      ? {}
      : { reason: options.changeReason }),
  });
  const engine = createDeterministicContextEngine({
    reader,
    changes,
    recorder: createEventRecorder({
      store,
      projectId: project.id,
      clock,
      eventIds: createSequentialIdFactory("ctx-event"),
    }),
    clock,
    config: { ...DEFAULT_CONTEXT_CONFIG, ...options.config },
    project,
    workspace,
    selectionIds: createSequentialIdFactory("sel"),
    engineId: "test-context-engine",
  });

  return {
    engine,
    store,
    reader,
    fakeReader: fake,
    changes,
    project,
    workspace,
  };
}

/**
 * Wraps a real reader and records every ref it was asked for.
 *
 * "A secret file is never read" is a claim about behaviour, so it needs a witness
 * at the I/O boundary rather than an assertion about the resulting selection — a
 * selection could be correct while the read already happened.
 */
export function recordingReader(reader: RepositoryReader): {
  readonly reader: RepositoryReader;
  readonly readLog: string[];
} {
  const readLog: string[] = [];
  return {
    readLog,
    reader: {
      id: reader.id,
      async list() {
        return await reader.list();
      },
      async read(ref: string) {
        readLog.push(ref);
        return await reader.read(ref);
      },
      async tryRead(ref: string) {
        readLog.push(ref);
        return await reader.tryRead(ref);
      },
    },
  };
}

export const CONTEXT_PROJECT_A = projectId("prj-context-a");
export const CONTEXT_PROJECT_B = projectId("prj-context-b");
export const CONTEXT_WORKSPACE_A = workspaceId("wsp-context-a");
