import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { eventsDirectory } from "../../src/adapters/storage/layout.js";
import { main } from "../../src/cli/main.js";
import type { CliEnv, CliIo } from "../../src/cli/io.js";
import { createFixedClock } from "../../src/core/clock.js";

/**
 * `ai task context`, driven in-process against a real temporary project.
 *
 * The command has two modes on purpose, and both are tested: reading reports what a
 * previous run actually selected, while `--select` performs a fresh selection and
 * *says* that it recorded one. A read command that quietly appended to the log
 * would be exactly the kind of surprise this project avoids elsewhere.
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
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    outText: () => out.join("\n"),
    errText: () => err.join("\n"),
    outJson: <T>() => JSON.parse(out.join("\n")) as T,
  };
}

async function projectWithFiles(
  files: Readonly<Record<string, string>>,
): Promise<CliEnv> {
  const cwd = await mkdtemp(join(tmpdir(), "ai-context-cli-"));
  roots.push(cwd);
  for (const [ref, content] of Object.entries(files)) {
    const path = join(cwd, ...ref.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  const env: CliEnv = {
    cwd,
    clock,
    runtimeVersion: "v24.21.0",
    platform: "test/test",
  };
  expect(await main(["init"], capture().io, env)).toBe(0);
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
  extra: readonly string[] = [],
): Promise<string> {
  const { code, cap } = await cli(
    [
      "task",
      "create",
      "--title",
      "Rework the engine",
      "--description",
      "Parse the new fixture format.",
      "--acceptance",
      "The engine parses the fixture",
      "--json",
      ...extra,
    ],
    env,
  );
  expect(code, cap.errText()).toBe(0);
  return cap.outJson<{ task: { id: string } }>().task.id;
}

describe("ai task context: reading what was selected", () => {
  it("shows the recorded selection, its reasons and its arithmetic", async () => {
    const env = await projectWithFiles({
      "src/engine.ts": "export const engine = 1;\n",
      "src/engine.test.ts": "import './engine.js';\n",
      "docs/architecture/ADR-001-engine.md": "# Engine\n",
    });
    const id = await createTask(env, ["--context", "src/engine.ts"]);
    expect((await cli(["task", "run", id], env)).code).toBe(0);

    const { code, cap } = await cli(["task", "context", id], env);
    expect(code).toBe(0);
    const text = cap.outText();
    expect(text).toContain("Context selection ");
    expect(text).toContain("strategy        deterministic v1");
    expect(text).toContain("src/engine.ts");
    expect(text).toContain("(required by the task)");
    expect(text).toContain("Selected:");
    expect(text).toContain("Excluded:");
    // No file text, ever.
    expect(text).not.toContain("export const engine");
  });

  it("explains each candidate in words with --explain", async () => {
    const env = await projectWithFiles({
      "src/engine.ts": "export const engine = 1;\n",
    });
    const id = await createTask(env, ["--context", "src/engine.ts"]);
    await cli(["task", "run", id], env);

    const { cap } = await cli(["task", "context", id, "--explain"], env);
    expect(cap.outText()).toContain("- explicitly referenced by the task");
  });

  it("emits the recorded selections as JSON", async () => {
    const env = await projectWithFiles({
      "src/engine.ts": "export const engine = 1;\n",
    });
    const id = await createTask(env, ["--context", "src/engine.ts"]);
    await cli(["task", "run", id], env);

    const { cap } = await cli(["task", "context", id, "--json"], env);
    const selections = cap.outJson<
      readonly {
        readonly complete: boolean;
        readonly budgetTokens: number;
        readonly selected: readonly { readonly ref: string }[];
      }[]
    >();
    expect(selections).toHaveLength(1);
    expect(selections[0]?.complete).toBe(true);
    expect(selections[0]?.budgetTokens).toBe(8_000);
    expect(selections[0]?.selected.map((entry) => entry.ref)).toContain(
      "src/engine.ts",
    );
  });

  it("says so, with a usable next step, when nothing has been selected yet", async () => {
    const env = await projectWithFiles({
      "src/engine.ts": "export const engine = 1;\n",
    });
    const id = await createTask(env);

    const { code, cap } = await cli(["task", "context", id], env);
    expect(code).toBe(0);
    expect(cap.outText()).toContain("no context selection recorded");
    expect(cap.outText()).toContain("--select");
  });
});

describe("ai task context --select: a fresh selection, recorded and declared", () => {
  it("performs and records a selection before any run", async () => {
    const env = await projectWithFiles({
      "src/engine.ts": "export const engine = 1;\n",
      "package.json": "{}\n",
    });
    const id = await createTask(env, ["--context", "src/engine.ts"]);

    const before = await cli(["task", "context", id, "--json"], env);
    expect(before.cap.outJson<readonly unknown[]>()).toHaveLength(0);

    const selected = await cli(["task", "context", id, "--select"], env);
    expect(selected.code).toBe(0);
    expect(selected.cap.outText()).toContain("Recorded selection ");
    expect(selected.cap.outText()).toContain("src/engine.ts");

    const after = await cli(["task", "context", id, "--json"], env);
    const selections =
      after.cap.outJson<readonly { readonly complete: boolean }[]>();
    expect(selections).toHaveLength(1);
    expect(selections[0]?.complete).toBe(true);
    // The events were written to the project's own log, as a real fact about it.
    const events = await readdir(eventsDirectory(env.cwd));
    expect(events).toHaveLength(1);
  });

  it("emits the fresh selection as JSON with --json", async () => {
    const env = await projectWithFiles({
      "src/engine.ts": "export const engine = 1;\n",
    });
    const id = await createTask(env, ["--context", "src/engine.ts"]);

    const { code, cap } = await cli(
      ["task", "context", id, "--select", "--json"],
      env,
    );
    expect(code).toBe(0);
    const selection = cap.outJson<{
      readonly selectionId: string;
      readonly strategy: string;
      readonly budgetTokens: number;
      readonly selectedTokens: number;
      readonly selected: readonly { readonly ref: string }[];
    }>();
    expect(selection.strategy).toBe("deterministic");
    expect(selection.budgetTokens).toBe(8_000);
    expect(selection.selectedTokens).toBeGreaterThan(0);
    expect(selection.selectedTokens).toBeLessThanOrEqual(
      selection.budgetTokens,
    );
    expect(selection.selected.map((entry) => entry.ref)).toContain(
      "src/engine.ts",
    );
  });

  it("exits non-zero when the referenced context cannot fit the budget", async () => {
    const env = await projectWithFiles({
      "src/engine.ts": "export const engine = 1;\n".repeat(500),
    });
    const id = await createTask(env, [
      "--context",
      "src/engine.ts",
      "--max-tokens",
      "20",
    ]);

    const { code, cap } = await cli(["task", "context", id, "--select"], env);
    expect(code).toBe(1);
    expect(cap.outText()).toContain("OVER BUDGET");
    expect(cap.outText()).toContain("refuses to proceed");
  });

  it("keeps the workspace flag working and never prints file content", async () => {
    const env = await projectWithFiles({
      "src/engine.ts": "export const engine = 'LEAK-ME-PLEASE';\n",
    });
    const id = await createTask(env, ["--context", "src/engine.ts"]);
    const { code, cap } = await cli(
      ["task", "context", id, "--select", "--explain"],
      env,
    );
    expect(code, cap.errText()).toBe(0);
    expect(cap.outText()).toContain("explicitly referenced by the task");
    expect(cap.outText()).not.toContain("LEAK-ME-PLEASE");
  });
});

describe("ai task context: usage errors stay usage errors", () => {
  it("rejects an unknown option with exit code 2", async () => {
    const env = await projectWithFiles({ "src/a.ts": "export const a = 1;\n" });
    const id = await createTask(env);
    const { code, cap } = await cli(["task", "context", id, "--nope"], env);
    expect(code).toBe(2);
    expect(cap.errText()).toContain("unknown option");
  });

  it("documents its options in help", async () => {
    const env = await projectWithFiles({ "src/a.ts": "export const a = 1;\n" });
    const { code, cap } = await cli(["task", "context", "--help"], env);
    expect(code).toBe(0);
    expect(cap.outText()).toContain("--select");
    expect(cap.outText()).toContain("--explain");
  });
});
