import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileAppendLock } from "../../src/adapters/storage/file-append-lock.js";
import { createJsonlEventStore } from "../../src/adapters/storage/jsonl-event-store.js";
import { eventsDirectory } from "../../src/adapters/storage/layout.js";
import { createFixedClock } from "../../src/core/clock.js";
import { hasDomainErrorCode } from "../../src/core/errors.js";
import { projectId, taskId, workspaceId } from "../../src/core/ids.js";
import type { AppendLock } from "../../src/ports/append-lock.js";
import { createNullAppendLock } from "../../src/ports/append-lock.js";
import {
  createImmediateSleep,
  createRecordingSleep,
} from "../../src/ports/sleep.js";
import { taskCreated } from "../support/events.js";

/**
 * Concurrency at the storage boundary.
 *
 * The claim under test is narrow and specific: **two writers cannot both append the
 * same sequence.** It is tested by actually racing two stores over one file, not by
 * asserting that a lock function was called — and the honest limits are asserted too
 * (a lock cannot be acquired forever, reading is never blocked, a stale lock is
 * reclaimed rather than wedging the stream).
 *
 * Everything is in one process and uses the injected clock and sleep, so the tests
 * are deterministic and instantaneous.
 */
const FIXED_INSTANT = "2026-09-20T10:00:00.000Z";
const PROJECT = projectId("prj-concurrency");
const WORKSPACE = workspaceId("wsp-concurrency");
const TASK = taskId("tsk-concurrency");

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-concurrency-"));
  roots.push(root);
  return root;
}

function lockFor(root: string): AppendLock {
  return createFileAppendLock({
    directory: eventsDirectory(root),
    clock: createFixedClock(FIXED_INSTANT),
    sleep: createRecordingSleep(),
  });
}

function storeFor(root: string, lock: AppendLock) {
  return createJsonlEventStore({
    projectRoot: root,
    projectId: PROJECT,
    knownWorkspaceIds: [WORKSPACE],
    lock,
  });
}

function scope() {
  return { projectId: PROJECT, workspaceId: WORKSPACE };
}

function event(sequence: number, occurrenceIndex = 0) {
  return taskCreated(
    {
      clock: createFixedClock(FIXED_INSTANT),
      projectId: PROJECT,
      workspaceId: WORKSPACE,
    },
    sequence,
    TASK,
    `task ${sequence}/${occurrenceIndex}`,
  );
}

async function logLines(root: string): Promise<readonly string[]> {
  const raw = await readFile(
    join(eventsDirectory(root), `${WORKSPACE}.jsonl`),
    "utf8",
  );
  return raw.split("\n").filter((line) => line.trim() !== "");
}

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop() as string, { recursive: true, force: true });
  }
});

describe("append coordination: two writers, one stream", () => {
  it("lets exactly one of two racers append a given sequence", async () => {
    const root = await makeRoot();
    const lock = lockFor(root);
    const first = storeFor(root, lock);
    const second = storeFor(root, lock);

    const results = await Promise.allSettled([
      first.append(event(1)),
      second.append(event(1)),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const failure = (rejected[0] as PromiseRejectedResult).reason;
    expect(hasDomainErrorCode(failure, "CONFLICT")).toBe(true);

    // The log is a single well-formed line: no interleaved or duplicated append.
    expect(await logLines(root)).toHaveLength(1);
    const readBack = await first.readAll(scope());
    expect(readBack).toHaveLength(1);
    expect(readBack[0].sequence).toBe(1);
  });

  it("lets a second writer continue a stream the first writer started", async () => {
    const root = await makeRoot();
    const lock = lockFor(root);
    const first = storeFor(root, lock);
    const second = storeFor(root, lock);

    await first.append(event(1));
    // The second store never saw a read; it learns the tail under the lock.
    await second.append(event(2));

    const events = await first.readAll(scope());
    expect(events.map((entry) => entry.sequence)).toEqual([1, 2]);
  });

  it("still refuses a stale sequence with no lock configured", async () => {
    const root = await makeRoot();
    const store = storeFor(root, createNullAppendLock());
    await store.append(event(1));
    await expect(store.append(event(1))).rejects.toSatisfy((error: unknown) =>
      hasDomainErrorCode(error, "CONFLICT"),
    );
  });
});

describe("append coordination: acquisition, release and staleness", () => {
  it("times out explicitly when another writer holds the stream", async () => {
    const root = await makeRoot();
    const directory = eventsDirectory(root);
    const clock = createFixedClock(FIXED_INSTANT);
    const sleep = createRecordingSleep();
    const lock = createFileAppendLock({
      directory,
      clock,
      sleep,
      lockTimeoutMs: 5,
      pollIntervalMs: 5,
    });
    // A fresh lock file that no cooperating writer will release.
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `.${WORKSPACE}.lock`), "{}", "utf8");

    await expect(
      lock.withLock(String(WORKSPACE), async () => "unreachable"),
    ).rejects.toSatisfy((error: unknown) =>
      hasDomainErrorCode(error, "LOCK_TIMEOUT"),
    );
    // It actually polled rather than failing instantly.
    expect(sleep.delays.length).toBeGreaterThan(0);
  });

  it("reclaims an abandoned lock instead of wedging the stream", async () => {
    const root = await makeRoot();
    const directory = eventsDirectory(root);
    const lockPath = join(directory, `.${WORKSPACE}.lock`);
    await mkdir(directory, { recursive: true });
    await writeFile(lockPath, "{}", "utf8");
    // Backdate it well beyond the stale threshold.
    const longAgo = new Date(Date.parse(FIXED_INSTANT) - 3_600_000);
    await utimes(lockPath, longAgo, longAgo);

    const lock = createFileAppendLock({
      directory,
      clock: createFixedClock(FIXED_INSTANT),
      sleep: createImmediateSleep(),
      staleLockMs: 60_000,
      lockTimeoutMs: 50,
    });
    const value = await lock.withLock(String(WORKSPACE), async () => "ran");
    expect(value).toBe("ran");
    // And it was released afterwards.
    await expect(stat(lockPath)).rejects.toBeDefined();
  });

  it("releases the lock after the work fails", async () => {
    const root = await makeRoot();
    const lock = lockFor(root);
    const store = storeFor(root, lock);
    await store.append(event(1));

    // A conflicting append must not leave the stream locked.
    await expect(store.append(event(1))).rejects.toSatisfy((error: unknown) =>
      hasDomainErrorCode(error, "CONFLICT"),
    );
    await expect(
      stat(join(eventsDirectory(root), `.${WORKSPACE}.lock`)),
    ).rejects.toBeDefined();

    // The next legitimate append works, which is the property that matters.
    await store.append(event(2));
    expect(
      (await store.readAll(scope())).map((entry) => entry.sequence),
    ).toEqual([1, 2]);
  });

  it("serialises writers inside one process", async () => {
    const root = await makeRoot();
    const lock = createFileAppendLock({
      directory: eventsDirectory(root),
      clock: createFixedClock(FIXED_INSTANT),
      sleep: createImmediateSleep(),
    });
    const trace: string[] = [];
    const work = (name: string) => async () => {
      trace.push(`enter ${name}`);
      // Yield, to prove the second writer waits rather than interleaving.
      await Promise.resolve();
      trace.push(`exit ${name}`);
      return name;
    };

    const both = await Promise.all([
      lock.withLock(String(WORKSPACE), work("a")),
      lock.withLock(String(WORKSPACE), work("b")),
    ]);
    expect(both).toEqual(["a", "b"]);
    expect(trace).toEqual(["enter a", "exit a", "enter b", "exit b"]);
  });

  it("never blocks a reader while a writer holds the stream", async () => {
    const root = await makeRoot();
    const lock = lockFor(root);
    const store = storeFor(root, lock);
    await store.append(event(1));

    const held = await lock.withLock(String(WORKSPACE), async () =>
      store.readAll(scope()),
    );
    expect(held).toHaveLength(1);
  });
});

describe("append coordination: the guarantee is stated, not implied", () => {
  it("reports what it actually guarantees", () => {
    expect(lockFor("/tmp/x").guarantee).toBe("local-process-and-file");
    expect(createNullAppendLock().guarantee).toBe("none");
  });

  it("keeps the log valid JSONL under a burst of sequential writers", async () => {
    const root = await makeRoot();
    const lock = lockFor(root);
    const stores = [
      storeFor(root, lock),
      storeFor(root, lock),
      storeFor(root, lock),
    ];
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      await stores[sequence % stores.length].append(event(sequence));
    }
    const lines = await logLines(root);
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(
      (await stores[0].readAll(scope())).map((entry) => entry.sequence),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
