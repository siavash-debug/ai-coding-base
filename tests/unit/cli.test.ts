import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UsageError, flagValue, parseArgv } from "../../src/cli/args.js";
import type { FlagSpec } from "../../src/cli/args.js";
import { deriveSlug } from "../../src/cli/commands/init.js";
import { main } from "../../src/cli/main.js";
import type { CliEnv, CliIo } from "../../src/cli/io.js";
import { createFixedClock } from "../../src/core/clock.js";

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
  const root = await mkdtemp(join(tmpdir(), "ai-cli-"));
  roots.push(root);
  return root;
}

async function initialized(): Promise<{ root: string; env: CliEnv }> {
  const cwd = await directory();
  const env: CliEnv = {
    cwd,
    clock,
    runtimeVersion: "v24.21.0",
    platform: "test/test",
  };
  const capture1 = capture();
  expect(await main(["init"], capture1.io, env)).toBe(0);
  return { root: cwd, env };
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
      "Add retry to the poller",
      "--description",
      "Bound the retries.",
      "--acceptance",
      "Retries are bounded",
      "--json",
      ...extra,
    ],
    env,
  );
  expect(code, cap.errText()).toBe(0);
  return cap.outJson<{ task: { id: string } }>().task.id;
}

describe("arg parsing", () => {
  const specs: readonly FlagSpec[] = [
    { name: "title", value: true, description: "title" },
    { name: "json", value: false, description: "json" },
    {
      name: "acceptance",
      value: true,
      multiple: true,
      description: "criteria",
    },
    { name: "help", value: false, aliases: ["h"], description: "help" },
    { name: "workspace", value: true, description: "workspace" },
  ];

  it("reads a flag value in either form", () => {
    expect(flagValue(parseArgv(["--title", "Hello"], specs), "title")).toBe(
      "Hello",
    );
    expect(flagValue(parseArgv(["--title=Hello"], specs), "title")).toBe(
      "Hello",
    );
    expect(flagValue(parseArgv(["--title=--json"], specs), "title")).toBe(
      "--json",
    );
  });

  it("accepts short aliases", () => {
    expect(parseArgv(["-h"], specs).flags.get("help")).toEqual(["true"]);
  });

  it("collects repeated flags in order", () => {
    const parsed = parseArgv(["--acceptance", "a", "--acceptance", "b"], specs);
    expect(parsed.flags.get("acceptance")).toEqual(["a", "b"]);
  });

  it("collects positionals and stops parsing after --", () => {
    const parsed = parseArgv(["tsk-1", "--json", "--", "--not-a-flag"], specs);
    expect(parsed.positionals).toEqual(["tsk-1", "--not-a-flag"]);
    expect(parsed.flags.get("json")).toEqual(["true"]);
  });

  it("rejects an unknown option and names the supported ones", () => {
    expect(() => parseArgv(["--nope"], specs)).toThrow(UsageError);
    expect(() => parseArgv(["--nope"], specs)).toThrow(/--title/);
  });

  it("rejects a missing value, a value on a boolean, and a malformed option", () => {
    expect(() => parseArgv(["--title"], specs)).toThrow(/requires a value/);
    expect(() => parseArgv(["--json=yes"], specs)).toThrow(
      /does not take a value/,
    );
    expect(() => parseArgv(["---"], specs)).toThrow(UsageError);
    expect(() => parseArgv(["--=x"], specs)).toThrow(/malformed option/);
  });

  it("rejects a repeated flag that is not repeatable", () => {
    expect(() => parseArgv(["--title", "a", "--title", "b"], specs)).toThrow(
      /only be given once/,
    );
  });
});

describe("cli dispatch", () => {
  it("prints help and exits cleanly for `help`", async () => {
    const { code, cap } = await cli(["help"], {
      cwd: "/tmp",
      clock,
      runtimeVersion: "v24.21.0",
      platform: "test/test",
    });
    expect(code).toBe(0);
    expect(cap.outText()).toContain("ai doctor");
    expect(cap.errText()).toBe("");
  });

  it("treats a missing command as a usage error", async () => {
    const { code, cap } = await cli([], {
      cwd: "/tmp",
      clock,
      runtimeVersion: "v24.21.0",
      platform: "test/test",
    });
    expect(code).toBe(2);
    expect(cap.outText()).toContain("Usage:");
  });

  it("rejects an unknown command and an unknown global option", async () => {
    const env = {
      cwd: "/tmp",
      clock,
      runtimeVersion: "v24.21.0",
      platform: "t/t",
    };
    const unknownCommand = await cli(["deploy"], env);
    expect(unknownCommand.code).toBe(2);
    expect(unknownCommand.cap.errText()).toContain('unknown command "deploy"');

    const unknownOption = await cli(["--verbose"], env);
    expect(unknownOption.code).toBe(2);
    expect(unknownOption.cap.errText()).toContain("unknown option");
  });

  it("rejects an unknown subcommand", async () => {
    const { env } = await initialized();
    const { code, cap } = await cli(["task", "destroy"], env);
    expect(code).toBe(2);
    expect(cap.errText()).toContain("unknown subcommand");
  });

  it("lists subcommands when `task` is used without one", async () => {
    const { env } = await initialized();
    const { code, cap } = await cli(["task"], env);
    expect(code).toBe(1);
    expect(cap.outText()).toContain("Subcommands:");
  });
});

describe("cli init", () => {
  it("provisions the project and refuses to overwrite it by accident", async () => {
    const cwd = await directory();
    const env = { cwd, clock, runtimeVersion: "v24.21.0", platform: "t/t" };

    const first = await cli(["init"], env);
    expect(first.code).toBe(0);
    expect(first.cap.outText()).toContain("Initialised project");

    const config = JSON.parse(
      await readFile(join(cwd, ".ai", "project.json"), "utf8"),
    );
    expect(config.schemaVersion).toBe(1);
    expect(config.workspaces).toHaveLength(1);

    const second = await cli(["init"], env);
    expect(second.code).toBe(1);
    expect(second.cap.errText()).toContain("CONFLICT");

    const forced = await cli(["init", "--force"], env);
    expect(forced.code).toBe(0);
  });

  it("derives a legal slug from awkward directory names", () => {
    expect(deriveSlug("My API Service")).toBe("my-api-service");
    expect(deriveSlug("123-app")).toBe("app");
    expect(deriveSlug("---")).toBe("project");
    expect(deriveSlug("")).toBe("project");
  });

  it("emits the configuration as JSON on request", async () => {
    const cwd = await directory();
    const env = { cwd, clock, runtimeVersion: "v24.21.0", platform: "t/t" };
    const { code, cap } = await cli(["init", "--json"], env);
    expect(code).toBe(0);
    const parsed = cap.outJson<{
      project: { id: string };
      configPath: string;
    }>();
    expect(parsed.project.id).toBeTruthy();
    expect(parsed.configPath).toContain("project.json");
  });

  it("describes its own options", async () => {
    const { code, cap } = await cli(["init", "--help"], {
      cwd: "/tmp",
      clock,
      runtimeVersion: "v24.21.0",
      platform: "t/t",
    });
    expect(code).toBe(0);
    expect(cap.outText()).toContain("--force");
  });
});

describe("cli doctor", () => {
  it("passes on an initialized project", async () => {
    const { env } = await initialized();
    const { code, cap } = await cli(["doctor"], env);
    expect(code).toBe(0);
    expect(cap.outText()).toContain("[ok] Event store append/read");
    expect(cap.outText()).toContain("[warn] Agent runtime");
  });

  it("emits the report as JSON", async () => {
    const { env } = await initialized();
    const { code, cap } = await cli(["doctor", "--json"], env);
    expect(code).toBe(0);
    const report = cap.outJson<{ exitCode: number; checks: unknown[] }>();
    expect(report.exitCode).toBe(0);
    expect(report.checks.length).toBeGreaterThan(5);
  });

  it("fails in a directory that is not a project", async () => {
    const cwd = await directory();
    const { code, cap } = await cli(["doctor"], {
      cwd,
      clock,
      runtimeVersion: "v24.21.0",
      platform: "t/t",
    });
    expect(code).toBe(1);
    expect(cap.outText()).toContain("[FAIL]");
  });
});

describe("cli task", () => {
  it("creates a task and lists it", async () => {
    const { env } = await initialized();
    const id = await createTask(env);

    const listed = await cli(["task", "list", "--json"], env);
    expect(listed.code).toBe(0);
    const tasks = listed.cap.outJson<{ task: { id: string } }[]>();
    expect(tasks.map((entry) => entry.task.id)).toEqual([id]);

    const text = await cli(["task", "list"], env);
    expect(text.cap.outText()).toContain("Add retry to the poller");
  });

  it("records the budget flags it was given", async () => {
    const { env } = await initialized();
    const { code, cap } = await cli(
      [
        "task",
        "create",
        "--title",
        "Budgeted",
        "--description",
        "Has a budget",
        "--max-tokens",
        "5000",
        "--max-cost-usd",
        "0.5",
        "--max-iterations",
        "4",
        "--max-duration-min",
        "10",
        "--risk",
        "low",
        "--json",
      ],
      env,
    );
    expect(code).toBe(0);
    const stored = cap.outJson<{
      task: { budget: Record<string, number>; riskLevel: string };
    }>();
    expect(stored.task.budget).toEqual({
      maxTokens: 5000,
      maxCostMicros: 500000,
      maxIterations: 4,
      maxDurationMs: 600000,
    });
    expect(stored.task.riskLevel).toBe("low");
  });

  it("rejects invalid input as a usage error", async () => {
    const { env } = await initialized();
    const missingTitle = await cli(
      ["task", "create", "--description", "No title"],
      env,
    );
    expect(missingTitle.code).toBe(2);
    expect(missingTitle.cap.errText()).toContain("--title");

    const badRisk = await cli(
      [
        "task",
        "create",
        "--title",
        "T",
        "--description",
        "D",
        "--risk",
        "spicy",
      ],
      env,
    );
    expect(badRisk.code).toBe(2);
    expect(badRisk.cap.errText()).toContain("--risk");

    const badCost = await cli(
      [
        "task",
        "create",
        "--title",
        "T",
        "--description",
        "D",
        "--max-cost-usd",
        "-1",
      ],
      env,
    );
    expect(badCost.code).toBe(2);

    const badTokens = await cli(
      [
        "task",
        "create",
        "--title",
        "T",
        "--description",
        "D",
        "--max-tokens",
        "1.5",
      ],
      env,
    );
    expect(badTokens.code).toBe(2);

    const noArgument = await cli(["task", "status"], env);
    expect(noArgument.code).toBe(2);

    const malformedId = await cli(["task", "status", "../../etc/passwd"], env);
    expect(malformedId.code).toBe(2);
  });

  it("fails cleanly for a task that does not exist", async () => {
    const { env } = await initialized();
    const { code, cap } = await cli(["task", "status", "tsk-missing"], env);
    expect(code).toBe(1);
    expect(cap.errText()).toContain("NOT_FOUND");
  });

  it("runs a task, then reports its usage and cost", async () => {
    const { env } = await initialized();
    const id = await createTask(env);

    const run = await cli(["task", "run", id], env);
    expect(run.code, run.cap.errText()).toBe(0);
    expect(run.cap.outText()).toContain("Outcome  awaiting-review");

    const usage = await cli(["task", "usage", id], env);
    expect(usage.code).toBe(0);
    expect(usage.cap.outText()).toContain("llm calls       1");
    expect(usage.cap.outText()).toContain("input tokens    1,240");

    const cost = await cli(["task", "cost", id], env);
    expect(cost.code).toBe(0);
    expect(cost.cap.outText()).toContain("$0.00852");
    expect(cost.cap.outText()).toContain("Pricing           complete");

    const trace = await cli(["task", "trace", id], env);
    expect(trace.code).toBe(0);
    expect(trace.cap.outText()).toContain("INTEGRITY ok");
    expect(trace.cap.outText()).toContain("DECISIONS");

    const status = await cli(["task", "status", id], env);
    expect(status.code).toBe(0);
    expect(status.cap.outText()).toContain("status     review");
  });

  it("emits machine-readable trace and usage output", async () => {
    const { env } = await initialized();
    const id = await createTask(env);
    await cli(["task", "run", id], env);

    const { code, cap } = await cli(["task", "usage", "--json", id], env);
    expect(code).toBe(0);
    const trace = cap.outJson<{
      taskId: string;
      metrics: { llmCalls: number; totalTokens: number };
      integrity: { ok: boolean };
      sessions: { id: string }[];
    }>();
    expect(trace.taskId).toBe(id);
    expect(trace.metrics.llmCalls).toBe(1);
    expect(trace.metrics.totalTokens).toBe(1560);
    expect(trace.integrity.ok).toBe(true);
    expect(trace.sessions).toHaveLength(1);
  });

  it("closes a reviewed task on request, and only from a legal status", async () => {
    const { env } = await initialized();
    const id = await createTask(env);
    await cli(["task", "run", id], env);

    const completed = await cli(
      ["task", "complete", id, "--reason", "reviewed"],
      env,
    );
    expect(completed.code).toBe(0);
    expect(completed.cap.outText()).toContain("status     completed");

    const again = await cli(["task", "complete", id], env);
    expect(again.code).toBe(1);
    expect(again.cap.errText()).toContain("TRANSITION");
  });

  it("exits non-zero when a run does not reach review", async () => {
    const { env } = await initialized();
    const id = await createTask(env, ["--max-tokens", "1000"]);

    const run = await cli(["task", "run", id], env);
    expect(run.code).toBe(1);
    expect(run.cap.outText()).toContain("Outcome  budget-exceeded");

    const status = await cli(["task", "status", id], env);
    expect(status.cap.outText()).toContain("status     failed");
  });

  it("asks for approval instead of running a high risk task", async () => {
    const { env } = await initialized();
    const id = await createTask(env, ["--risk", "high"]);

    const run = await cli(["task", "run", id], env);
    expect(run.code).toBe(1);
    expect(run.cap.outText()).toContain("Outcome  awaiting-approval");

    const trace = await cli(["task", "trace", id], env);
    expect(trace.cap.outText()).toContain("pending");
    expect(trace.cap.outText()).toContain("risk high");
  });

  it("refuses an unknown workspace and reports the configured ones", async () => {
    const { env } = await initialized();
    const { code, cap } = await cli(
      ["task", "list", "--workspace", "wsp-nope"],
      env,
    );
    expect(code).toBe(1);
    expect(cap.errText()).toContain("NOT_FOUND");
    expect(cap.errText()).toContain("configured workspaces");
  });

  it("describes each subcommand's options", async () => {
    const { env } = await initialized();
    for (const subcommand of [
      "create",
      "list",
      "status",
      "run",
      "trace",
      "usage",
      "cost",
      "complete",
    ]) {
      const { code, cap } = await cli(["task", subcommand, "--help"], env);
      expect(code, `${subcommand} --help`).toBe(0);
      expect(cap.outText()).toContain("--json");
    }
  });

  it("keeps working in a project whose log already has history", async () => {
    const { root, env } = await initialized();
    const first = await createTask(env);
    await cli(["task", "run", first], env);

    // A fresh process (new runtime, re-read from disk) sees the same history and
    // continues its sequence rather than colliding with it.
    const second = await createTask(env, ["--constraint", "no global state"]);
    const run = await cli(["task", "run", second], env);
    expect(run.code, run.cap.errText()).toBe(0);

    const firstTrace = await cli(["task", "usage", "--json", first], env);
    const secondTrace = await cli(["task", "usage", "--json", second], env);
    expect(
      firstTrace.cap.outJson<{ metrics: { llmCalls: number } }>().metrics
        .llmCalls,
    ).toBe(1);
    expect(
      secondTrace.cap.outJson<{ metrics: { llmCalls: number } }>().metrics
        .llmCalls,
    ).toBe(1);

    // One workspace, one log file, and both histories appended in order.
    const eventsDir = join(root, ".ai", "runtime", "events");
    const files = await readdir(eventsDir);
    expect(files).toHaveLength(1);
    const lines = (await readFile(join(eventsDir, files[0]), "utf8"))
      .trim()
      .split("\n");
    // Two runs, each with a two-event context selection (started + selected).
    expect(lines).toHaveLength(40);
    const sequences = lines.map((line) => JSON.parse(line).sequence as number);
    expect(sequences).toEqual(
      Array.from({ length: 40 }, (_unused, index) => index + 1),
    );
  });
});
