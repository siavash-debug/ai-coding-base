import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFixedClock } from "../../src/core/clock.js";
import { hasDomainErrorCode } from "../../src/core/errors.js";
import {
  projectId,
  sessionId,
  taskId,
  workspaceId,
} from "../../src/core/ids.js";
import type { ProjectId, TaskId, WorkspaceId } from "../../src/core/ids.js";
import type { DomainEvent } from "../../src/observability/events.js";
import { createJsonlEventStore } from "../../src/adapters/storage/jsonl-event-store.js";
import type { EventStore } from "../../src/ports/event-store.js";
import {
  type EventContext,
  llmCompleted,
  llmStarted,
  sessionEnded,
  sessionStarted,
  taskCreated,
  taskStatusChanged,
  toolCompleted,
  toolStarted,
} from "../support/events.js";

const clock = createFixedClock("2026-09-20T10:00:00.000Z");
const PROJECT: ProjectId = projectId("prj-a");
const WORKSPACE: WorkspaceId = workspaceId("wsp-a");
const OTHER_WORKSPACE: WorkspaceId = workspaceId("wsp-b");
const TASK: TaskId = taskId("tsk-1");
const OTHER_TASK: TaskId = taskId("tsk-2");
const SESSION = sessionId("ses-1");

const context: EventContext = {
  clock,
  projectId: PROJECT,
  workspaceId: WORKSPACE,
};

const scope = { projectId: PROJECT, workspaceId: WORKSPACE };

let roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-store-"));
  roots.push(root);
  return root;
}

async function openStore(
  options: {
    readonly workspaceIds?: readonly WorkspaceId[];
  } = {},
): Promise<{ store: EventStore; root: string }> {
  const root = await tempRoot();
  return {
    root,
    store: createJsonlEventStore({
      projectRoot: root,
      projectId: PROJECT,
      knownWorkspaceIds: options.workspaceIds ?? [WORKSPACE, OTHER_WORKSPACE],
    }),
  };
}

function logFile(root: string, workspace: WorkspaceId = WORKSPACE): string {
  return join(root, ".ai", "runtime", "events", `${workspace}.jsonl`);
}

/** Writes a log file directly, to simulate a hand-edited or corrupted log. */
async function writeRawLog(
  root: string,
  workspace: WorkspaceId,
  content: string,
): Promise<void> {
  await mkdir(join(root, ".ai", "runtime", "events"), { recursive: true });
  await writeFile(logFile(root, workspace), content, "utf8");
}

async function readLines(path: string): Promise<readonly string[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line !== "");
}

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots = [];
});

describe("JSONL event store: append and read", () => {
  it("appends one event per line and reads it back", async () => {
    const { store, root } = await openStore();
    await store.append(taskCreated(context, 1, TASK));

    const lines = await readLines(logFile(root));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).type).toBe("TaskCreated");

    const events = await store.readAll(scope);
    expect(events).toHaveLength(1);
    expect(events[0].taskId).toBe(TASK);
    expect(events[0].sequence).toBe(1);
  });

  it("preserves append order across many appends", async () => {
    const { store } = await openStore();
    await store.appendMany([
      taskCreated(context, 1, TASK),
      sessionStarted(context, 2, TASK, SESSION),
      llmStarted(context, 3, TASK, SESSION, "p", "m"),
      llmCompleted(context, 4, TASK, SESSION, {
        providerId: "p",
        modelId: "m",
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
        latencyMs: 12,
      }),
      sessionEnded(context, 5, TASK, SESSION, "completed"),
    ]);

    const events = await store.readAll(scope);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events.map((event) => event.type)).toEqual([
      "TaskCreated",
      "SessionStarted",
      "LLMRequestStarted",
      "LLMRequestCompleted",
      "SessionEnded",
    ]);
  });

  it("filters by task and by session", async () => {
    const { store } = await openStore();
    await store.appendMany([
      taskCreated(context, 1, TASK),
      taskCreated(context, 2, OTHER_TASK),
      sessionStarted(context, 3, TASK, SESSION),
      llmStarted(context, 4, TASK, SESSION, "p", "m"),
      sessionEnded(context, 5, TASK, SESSION, "completed"),
    ]);

    expect(
      (await store.readByTask(scope, TASK)).map((e) => e.sequence),
    ).toEqual([1, 3, 4, 5]);
    expect(
      (await store.readBySession(scope, SESSION)).map((e) => e.sequence),
    ).toEqual([3, 4, 5]);
    expect(await store.listTaskIds(scope)).toEqual([TASK, OTHER_TASK]);
  });

  it("keeps events for different workspaces in separate logs", async () => {
    const { store, root } = await openStore();
    await store.append(taskCreated(context, 1, TASK));
    await store.append(
      taskCreated({ ...context, workspaceId: OTHER_WORKSPACE }, 1, OTHER_TASK),
    );

    expect(await readLines(logFile(root, WORKSPACE))).toHaveLength(1);
    expect(await readLines(logFile(root, OTHER_WORKSPACE))).toHaveLength(1);

    // A workspace-scoped read sees only that workspace's stream.
    expect(await store.readAll(scope)).toHaveLength(1);

    // A project-wide read is an explicit union over the partitions.
    const projectWide = await store.readAll({ projectId: PROJECT });
    expect(projectWide).toHaveLength(2);
    expect(projectWide.map((event) => event.workspaceId).sort()).toEqual(
      [WORKSPACE, OTHER_WORKSPACE].sort(),
    );
  });
});

describe("JSONL event store: append-only guarantees", () => {
  it("never rewrites existing lines", async () => {
    const { store, root } = await openStore();
    await store.append(taskCreated(context, 1, TASK));
    const afterFirst = await readFile(logFile(root), "utf8");

    await store.append(
      taskStatusChanged(context, 2, TASK, "created", "planning"),
    );
    const afterSecond = await readFile(logFile(root), "utf8");

    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(await readLines(logFile(root))).toHaveLength(2);
  });

  it("rejects an event whose sequence does not extend the stream", async () => {
    const { store } = await openStore();
    await store.append(taskCreated(context, 5, TASK));

    await expect(store.append(taskCreated(context, 5, TASK))).rejects.toSatisfy(
      (error) => hasDomainErrorCode(error, "CONFLICT"),
    );
    await expect(store.append(taskCreated(context, 4, TASK))).rejects.toSatisfy(
      (error) => hasDomainErrorCode(error, "CONFLICT"),
    );

    expect(await store.readAll(scope)).toHaveLength(1);
  });

  it("leaves the log unchanged when a batch contains a rejected event", async () => {
    const { store, root } = await openStore();
    await store.append(taskCreated(context, 1, TASK));

    await expect(
      store.appendMany([
        taskStatusChanged(context, 2, TASK, "created", "planning"),
        {
          ...taskStatusChanged(context, 3, TASK, "planning", "in_progress"),
          schemaVersion: 99,
        } as unknown as DomainEvent,
      ]),
    ).rejects.toSatisfy((error) => hasDomainErrorCode(error, "VALIDATION"));

    expect(await readLines(logFile(root))).toHaveLength(1);
  });

  it("allows two appends to the same workspace only when sequences increase", async () => {
    const { store } = await openStore();
    await store.appendMany([
      taskCreated(context, 1, TASK),
      taskStatusChanged(context, 2, TASK, "created", "planning"),
      taskStatusChanged(context, 3, TASK, "planning", "in_progress"),
    ]);
    expect((await store.readAll(scope)).map((e) => e.sequence)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe("JSONL event store: malformed and untrusted input", () => {
  it("rejects a hand-written line that is not JSON", async () => {
    const { store, root } = await openStore();
    await writeRawLog(root, WORKSPACE, "not json\n");
    await expect(store.readAll(scope)).rejects.toSatisfy((error) =>
      hasDomainErrorCode(error, "VALIDATION"),
    );
  });

  it("rejects a well-formed JSON line that is not a valid event", async () => {
    const { store, root } = await openStore();
    await writeRawLog(
      root,
      WORKSPACE,
      `${JSON.stringify({ schemaVersion: 1, type: "TaskCreated" })}\n`,
    );
    await expect(store.readAll(scope)).rejects.toSatisfy((error) =>
      hasDomainErrorCode(error, "VALIDATION"),
    );
  });

  it("rejects an event filed under the wrong workspace", async () => {
    const { store, root } = await openStore();
    const foreign = taskCreated(
      { ...context, workspaceId: OTHER_WORKSPACE },
      1,
      TASK,
    );
    await writeRawLog(root, WORKSPACE, `${JSON.stringify(foreign)}\n`);
    await expect(store.readAll(scope)).rejects.toSatisfy((error) =>
      hasDomainErrorCode(error, "INVARIANT"),
    );
  });

  it("rejects an event belonging to another project", async () => {
    const { store, root } = await openStore();
    const foreign = taskCreated(
      { ...context, projectId: projectId("prj-b") },
      1,
      TASK,
    );
    await writeRawLog(root, WORKSPACE, `${JSON.stringify(foreign)}\n`);
    await expect(store.readAll(scope)).rejects.toSatisfy((error) =>
      hasDomainErrorCode(error, "INVARIANT"),
    );
  });
});

describe("JSONL event store: persistence and isolation", () => {
  it("survives reopening the project", async () => {
    const { store, root } = await openStore();
    await store.appendMany([
      taskCreated(context, 1, TASK),
      sessionStarted(context, 2, TASK, SESSION),
      sessionEnded(context, 3, TASK, SESSION, "completed"),
    ]);

    const reopened = createJsonlEventStore({
      projectRoot: root,
      projectId: PROJECT,
      knownWorkspaceIds: [WORKSPACE, OTHER_WORKSPACE],
    });
    const events = await reopened.readAll(scope);
    expect(events.map((event) => event.type)).toEqual([
      "TaskCreated",
      "SessionStarted",
      "SessionEnded",
    ]);
    // The sequence continues, rather than restarting and colliding.
    await reopened.append(
      taskStatusChanged(context, 4, TASK, "created", "planning"),
    );
    expect((await reopened.readAll(scope)).at(-1)?.sequence).toBe(4);
  });

  it("refuses a scope for another project", async () => {
    const { store } = await openStore();
    await store.append(taskCreated(context, 1, TASK));

    await expect(
      store.readByTask(
        { projectId: projectId("prj-b"), workspaceId: WORKSPACE },
        TASK,
      ),
    ).rejects.toSatisfy((error) => hasDomainErrorCode(error, "FORBIDDEN"));

    await expect(
      store.append(
        taskCreated({ ...context, projectId: projectId("prj-b") }, 2, TASK),
      ),
    ).rejects.toSatisfy((error) => hasDomainErrorCode(error, "FORBIDDEN"));
  });

  it("refuses a workspace that is not part of the project", async () => {
    const { store } = await openStore({ workspaceIds: [WORKSPACE] });
    await expect(
      store.readAll({ projectId: PROJECT, workspaceId: OTHER_WORKSPACE }),
    ).rejects.toSatisfy((error) => hasDomainErrorCode(error, "FORBIDDEN"));
  });

  it("does not expose another project's log even when both exist on disk", async () => {
    const { store, root } = await openStore();
    await store.append(taskCreated(context, 1, TASK));

    // A second project rooted elsewhere on the same disk.
    const otherRoot = await tempRoot();
    const otherStore = createJsonlEventStore({
      projectRoot: otherRoot,
      projectId: projectId("prj-b"),
      knownWorkspaceIds: [workspaceId("wsp-c")],
    });
    expect(await otherStore.readAll({ projectId: projectId("prj-b") })).toEqual(
      [],
    );
    expect(
      await otherStore.listTaskIds({ projectId: projectId("prj-b") }),
    ).toEqual([]);

    // And this project's store is unaffected by the other project's presence.
    expect((await store.readAll(scope)).length).toBe(1);
    expect(root).not.toBe(otherRoot);
  });
});

describe("JSONL event store: deterministic serialization", () => {
  it("writes structurally equal events to identical bytes", async () => {
    const first = await openStore();
    const second = await openStore();
    const event = taskCreated(context, 1, TASK);

    await first.store.append(event);
    await second.store.append(event);

    expect(await readFile(logFile(first.root), "utf8")).toBe(
      await readFile(logFile(second.root), "utf8"),
    );
  });

  it("sorts object keys so construction order cannot change the bytes", async () => {
    const rootA = await tempRoot();
    const rootB = await tempRoot();
    const event = taskCreated(context, 1, TASK);
    const reordered = {
      payload: event.payload,
      sequence: event.sequence,
      type: event.type,
      id: event.id,
      actor: event.actor,
      projectId: event.projectId,
      workspaceId: event.workspaceId,
      occurredAt: event.occurredAt,
      schemaVersion: event.schemaVersion,
      correlationId: event.correlationId,
      taskId: event.taskId,
    } as unknown as DomainEvent;

    const storeA = createJsonlEventStore({
      projectRoot: rootA,
      projectId: PROJECT,
      knownWorkspaceIds: [WORKSPACE],
    });
    const storeB = createJsonlEventStore({
      projectRoot: rootB,
      projectId: PROJECT,
      knownWorkspaceIds: [WORKSPACE],
    });
    await storeA.append(event);
    await storeB.append(reordered);

    expect(await readFile(logFile(rootA), "utf8")).toBe(
      await readFile(logFile(rootB), "utf8"),
    );
  });

  it("orders events by time and then by sequence", async () => {
    const { store, root } = await openStore();
    // Written out of order on disk: same instant, descending sequence.
    const late = taskStatusChanged(context, 3, TASK, "planning", "in_progress");
    const middle = taskStatusChanged(context, 2, TASK, "created", "planning");
    const first = taskCreated(context, 1, TASK);
    await writeRawLog(
      root,
      WORKSPACE,
      [late, middle, first]
        .map((event) => `${JSON.stringify(event)}\n`)
        .join(""),
    );

    const events = await store.readAll(scope);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });
});

describe("JSONL event store: tool call pairing fixtures", () => {
  it("stores started and completed tool calls in order", async () => {
    const { store } = await openStore();
    await store.appendMany([
      taskCreated(context, 1, TASK),
      sessionStarted(context, 2, TASK, SESSION),
      toolStarted(context, 3, TASK, SESSION, "read-file"),
      toolCompleted(context, 4, TASK, SESSION, "read-file", true, 7),
    ]);
    const events = await store.readBySession(scope, SESSION);
    expect(events.map((event) => event.type)).toEqual([
      "SessionStarted",
      "ToolCallStarted",
      "ToolCallCompleted",
    ]);
  });
});
