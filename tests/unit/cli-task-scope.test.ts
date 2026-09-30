import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/main.js";
import type { CliEnv, CliIo } from "../../src/cli/io.js";
import { createFixedClock } from "../../src/core/clock.js";

/**
 * Reading a task that this scope does not know about.
 *
 * A projection of zero events looks exactly like a real task whose run has not
 * started, so printing one for an arbitrary id asserts something the log does not
 * say. These tests pin the contract that replaced that behaviour: an unknown id is
 * a NOT_FOUND (exit 1) with a message that names the scope and never confirms
 * whether the id exists elsewhere, while a task that genuinely has no events yet
 * still reads successfully.
 *
 * The scope rules themselves live in the store and repository; nothing here is
 * authorised by a task id alone.
 */
const clock = createFixedClock("2026-09-20T10:00:00.000Z");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

interface Capture {
  readonly io: CliIo;
  readonly outText: () => string;
  readonly errText: () => string;
  readonly outJson: <T>() => T;
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    },
    outText: () => out.join("\n"),
    errText: () => err.join("\n"),
    outJson: <T>() => JSON.parse(out.join("\n")) as T,
  };
}

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-cli-scope-"));
  roots.push(root);
  return root;
}

async function initialized(): Promise<CliEnv> {
  const cwd = await directory();
  const env: CliEnv = {
    cwd,
    clock,
    runtimeVersion: "v24.21.0",
    platform: "test/test",
  };
  const cap = capture();
  expect(await main(["init"], cap.io, env)).toBe(0);
  return env;
}

async function cli(
  argv: readonly string[],
  env: CliEnv,
): Promise<{ code: number; cap: Capture }> {
  const cap = capture();
  const code = await main(argv, cap.io, env);
  return { code, cap };
}

async function createTask(
  env: CliEnv,
  title = "Scope test task",
): Promise<string> {
  const { code, cap } = await cli(
    [
      "task",
      "create",
      "--title",
      title,
      "--description",
      "Exercise task scope resolution.",
      "--acceptance",
      "Scope is respected",
      "--json",
    ],
    env,
  );
  expect(code, cap.errText()).toBe(0);
  return cap.outJson<{ task: { id: string } }>().task.id;
}

/**
 * Adds a second, valid workspace to the project — a real one, so the failure under
 * test is scope resolution rather than "no such workspace".
 */
async function addSecondWorkspace(env: CliEnv): Promise<string> {
  const path = join(env.cwd, ".ai", "project.json");
  const config = JSON.parse(await readFile(path, "utf8")) as {
    project: { id: string };
    workspaces: Record<string, unknown>[];
  };
  const [first] = config.workspaces;
  const second = {
    ...first,
    id: "wsp-second",
    name: "second",
    createdAt: first["createdAt"],
    updatedAt: first["updatedAt"],
  };
  config.workspaces = [first, second];
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return "wsp-second";
}

async function truncateLog(env: CliEnv): Promise<void> {
  const eventsDir = join(env.cwd, ".ai", "runtime", "events");
  for (const file of await readdir(eventsDir)) {
    await rm(join(eventsDir, file), { force: true });
  }
}

describe("task scope: a task that is known here", () => {
  it("reads a task that exists, before and after it has events", async () => {
    const env = await initialized();
    const id = await createTask(env);

    // A record whose events are not in this log at all: the task is known to this
    // scope, and the projection says so while holding no events. This is the state
    // that must stay distinguishable from an unknown id.
    await truncateLog(env);
    const empty = await cli(["task", "trace", id, "--json"], env);
    expect(empty.code, empty.cap.errText()).toBe(0);
    const emptyTrace = empty.cap.outJson<{
      found: boolean;
      events: unknown[];
      metrics: { llmCalls: number };
    }>();
    expect(emptyTrace.found).toBe(true);
    expect(emptyTrace.events).toEqual([]);
    expect(emptyTrace.metrics.llmCalls).toBe(0);

    // And the same id reads normally once it has run.
    const id2 = await createTask(env, "A task with a run");
    const run = await cli(["task", "run", id2], env);
    expect(run.code, run.cap.errText()).toBe(0);

    const trace = await cli(["task", "trace", id2, "--json"], env);
    expect(trace.code, trace.cap.errText()).toBe(0);
    expect(trace.cap.outJson<{ found: boolean }>().found).toBe(true);

    for (const subcommand of ["usage", "cost"]) {
      const { code, cap } = await cli(["task", subcommand, id2, "--json"], env);
      expect(code, cap.errText()).toBe(0);
    }
  });
});

describe("task scope: an id this scope cannot vouch for", () => {
  it("reports a missing task as NOT_FOUND rather than an empty projection", async () => {
    const env = await initialized();
    const { code, cap } = await cli(["task", "trace", "tsk-missing"], env);

    expect(code).toBe(1);
    expect(cap.errText()).toContain("NOT_FOUND");
    expect(cap.errText()).toContain("not found in the current scope");
    // Nothing on stdout: an empty projection is exactly what must not be printed.
    expect(cap.outText()).toBe("");
  });

  it("treats every reading command the same way", async () => {
    const env = await initialized();
    for (const argv of [
      ["task", "trace", "tsk-missing"],
      ["task", "trace", "tsk-missing", "--json"],
      ["task", "usage", "tsk-missing"],
      ["task", "cost", "tsk-missing"],
      ["task", "context", "tsk-missing"],
    ]) {
      const { code, cap } = await cli(argv, env);
      expect(code, argv.join(" ")).toBe(1);
      expect(cap.errText(), argv.join(" ")).toContain("NOT_FOUND");
      expect(cap.outText(), argv.join(" ")).toBe("");
    }
  });

  it("cannot read another project's task, and does not learn that it exists", async () => {
    const envA = await initialized();
    const idA = await createTask(envA, "Belongs to project A");
    await cli(["task", "run", idA], envA);

    const envB = await initialized();
    const { code, cap } = await cli(["task", "trace", idA, "--json"], envB);

    expect(code).toBe(1);
    expect(cap.errText()).toContain("NOT_FOUND");
    expect(cap.errText()).toContain("not found in the current scope");
    expect(cap.outText()).toBe("");
    // The message names the id the caller already had and nothing else: no title,
    // no project, no hint that the task exists somewhere.
    expect(cap.errText()).not.toContain("Belongs to project A");
    expect(cap.errText()).not.toContain("prj-");
    expect(cap.errText()).not.toContain(envA.cwd);
  });

  it("cannot read another workspace's task when scoped to this workspace", async () => {
    const env = await initialized();
    const second = await addSecondWorkspace(env);
    const id = await createTask(env, "Lives in the default workspace");
    await cli(["task", "run", id], env);

    // Project scope sees it: the project is the isolation boundary.
    const projectScope = await cli(["task", "trace", id, "--json"], env);
    expect(projectScope.code, projectScope.cap.errText()).toBe(0);
    expect(projectScope.cap.outJson<{ found: boolean }>().found).toBe(true);

    // Narrowed to the other workspace, the same id is unknown here.
    const workspaceScope = await cli(
      ["task", "trace", id, "--workspace", second, "--json"],
      env,
    );
    expect(workspaceScope.code).toBe(1);
    expect(workspaceScope.cap.errText()).toContain("NOT_FOUND");
    expect(workspaceScope.cap.outText()).toBe("");

    for (const subcommand of ["usage", "cost"]) {
      const { code, cap } = await cli(
        ["task", subcommand, id, "--workspace", second],
        env,
      );
      expect(code, subcommand).toBe(1);
      expect(cap.outText(), subcommand).toBe("");
    }
  });
});
