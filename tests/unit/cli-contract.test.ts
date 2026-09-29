import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/main.js";
import type { CliEnv, CliIo } from "../../src/cli/io.js";
import { createFixedClock } from "../../src/core/clock.js";
import { accessPolicy } from "../support/policy.js";
import {
  FIXTURE_USAGE,
  TEXT_MODEL,
  createScriptedFrontier,
  frontierConfig,
  ratesFor,
} from "../support/frontier.js";
import { createTestProject } from "../support/project.js";

/**
 * The CLI contract: exit codes and `--dry-run` (V2-ARCHITECTURE §25.2).
 *
 * Two contracts live here, deliberately kept apart:
 *
 * - **Task execution outcomes** use the domain codes `3` policy denied, `4` budget
 *   exceeded, `5` approval required, on top of the universal `0`/`1`/`2`. These are
 *   read from the structured `RunOutcome`, never from rendered text.
 * - **`ai policy --check`** is a *query*, not a run: it keeps its own `0`/`1`/`2`
 *   contract (allowed / denied-or-approval-required / uninterpretable). It is
 *   covered by `policy-cli.test.ts`, and nothing here changes it.
 *
 * The `--dry-run` tests assert the negative guarantee directly: after a dry run the
 * observable state — task list, status, recorded selections, approvals, event log —
 * is exactly what it was before.
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

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-contract-"));
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
  const init = capture();
  expect(await main(["init"], init.io, env)).toBe(0);
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
      "Bound the retries",
      "--description",
      "Retries are bounded.",
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

async function eventLineCount(root: string): Promise<number> {
  const directoryPath = join(root, ".ai", "runtime", "events");
  const files = await readdir(directoryPath);
  let total = 0;
  for (const file of files) {
    const text = await readFile(join(directoryPath, file), "utf8");
    total += text.trim() === "" ? 0 : text.trim().split("\n").length;
  }
  return total;
}

describe("CLI exit codes: universal 0/1/2", () => {
  it("0 for a run that reaches review", async () => {
    const env = await initialized();
    const id = await createTask(env);
    const run = await cli(["task", "run", id], env);
    expect(run.code, run.cap.errText()).toBe(0);
    expect(run.cap.outText()).toContain("Outcome  awaiting-review");
  });

  it("1 for an ordinary domain failure (NOT_FOUND)", async () => {
    const env = await initialized();
    const { code, cap } = await cli(["task", "trace", "tsk-missing"], env);
    expect(code).toBe(1);
    expect(cap.errText()).toContain("NOT_FOUND");
  });

  it("2 for a usage error", async () => {
    const env = await initialized();
    const { code, cap } = await cli(["task", "create"], env);
    expect(code).toBe(2);
    expect(cap.errText()).toContain("title");
  });
});

describe("CLI exit codes: task execution outcomes 3/4/5", () => {
  it("3 when the enforcement boundary denies an operation", async () => {
    // Everything is allowed except reading, which the runner's one operation
    // needs. The run must stop as a policy denial, not a generic failure.
    const project = await createTestProject({
      policy: accessPolicy({ allowed: ["git.read"], readableRoots: ["."] }),
    });
    roots.push(project.root);
    const task = await project.runtime.tasks.create(
      {
        title: "Denied by policy",
        description: "The operation is refused.",
        acceptanceCriteria: ["Nothing runs"],
      },
      {
        project: project.runtime.project,
        workspace: project.runtime.workspace,
      },
    );
    const env: CliEnv = {
      cwd: project.root,
      clock,
      runtimeVersion: "v24.21.0",
      platform: "test/test",
    };
    const { code, cap } = await cli(["task", "run", task.task.id], env);
    expect(code, cap.errText()).toBe(3);
    expect(cap.outText()).toContain("Outcome  policy-denied");
  });

  it("4 when the task budget is exhausted", async () => {
    const env = await initialized();
    const id = await createTask(env, ["--max-tokens", "1000"]);
    const run = await cli(["task", "run", id], env);
    expect(run.code, run.cap.errText()).toBe(4);
    expect(run.cap.outText()).toContain("Outcome  budget-exceeded");
  });

  it("5 when a run suspends for human approval", async () => {
    const env = await initialized();
    const id = await createTask(env, ["--risk", "high"]);
    const run = await cli(["task", "run", id], env);
    expect(run.code, run.cap.errText()).toBe(5);
    expect(run.cap.outText()).toContain("Outcome  awaiting-approval");
  });

  it("carries the same mapping through approve --resume", async () => {
    const env = await initialized();
    const id = await createTask(env, ["--risk", "high"]);
    await cli(["task", "run", id], env);
    const resumed = await cli(
      ["task", "approve", id, "--approver", "maintainer", "--resume"],
      env,
    );
    expect(resumed.code, resumed.cap.errText()).toBe(0);
    expect(resumed.cap.outText()).toContain("awaiting-review");
  });
});

describe("--dry-run: init", () => {
  it("reports what would be written and writes nothing", async () => {
    const cwd = await directory();
    const env: CliEnv = {
      cwd,
      clock,
      runtimeVersion: "v24.21.0",
      platform: "test/test",
    };
    const dry = await cli(["init", "--dry-run"], env);
    expect(dry.code, dry.cap.errText()).toBe(0);
    expect(dry.cap.outText()).toContain("would initialise");
    expect(dry.cap.outText()).toContain("Nothing was written");

    // The project was not created, so the next command still finds nothing.
    const missing = await cli(["task", "list"], env);
    expect(missing.code).toBe(1);

    // And a real init then succeeds, proving the dry run left a clean slate.
    const real = await cli(["init"], env);
    expect(real.code, real.cap.errText()).toBe(0);
  });
});

describe("--dry-run: task create", () => {
  it("validates and reports, but creates no task and appends no event", async () => {
    const env = await initialized();
    const before = await eventLineCount(env.cwd);

    const dry = await cli(
      [
        "task",
        "create",
        "--title",
        "Would be created",
        "--description",
        "Not yet",
        "--dry-run",
      ],
      env,
    );
    expect(dry.code, dry.cap.errText()).toBe(0);
    expect(dry.cap.outText()).toContain("Dry run: would create task");
    expect(dry.cap.outText()).toContain("No event was written");

    const listed = await cli(["task", "list", "--json"], env);
    expect(listed.cap.outJson<readonly unknown[]>()).toHaveLength(0);
    expect(await eventLineCount(env.cwd)).toBe(before);
  });

  it("still refuses an invalid task", async () => {
    const env = await initialized();
    const { code } = await cli(
      [
        "task",
        "create",
        "--title",
        "x",
        "--description",
        "y",
        "--risk",
        "nope",
        "--dry-run",
      ],
      env,
    );
    expect(code).toBe(2);
  });
});

describe("--dry-run: task complete", () => {
  it("computes the transition without completing the task", async () => {
    const env = await initialized();
    const id = await createTask(env);
    await cli(["task", "run", id], env);
    const before = await eventLineCount(env.cwd);

    const dry = await cli(["task", "complete", id, "--dry-run"], env);
    expect(dry.code, dry.cap.errText()).toBe(0);
    expect(dry.cap.outText()).toContain("Dry run: would complete task");

    const status = await cli(["task", "status", id, "--json"], env);
    expect(status.cap.outJson<{ task: { status: string } }>().task.status).toBe(
      "review",
    );
    expect(await eventLineCount(env.cwd)).toBe(before);
  });
});

describe("--dry-run: task approve", () => {
  it("reports the grant that would be recorded, records nothing, and does not resume", async () => {
    const env = await initialized();
    const id = await createTask(env, ["--risk", "high"]);
    await cli(["task", "run", id], env);
    const before = await eventLineCount(env.cwd);

    const dry = await cli(
      ["task", "approve", id, "--approver", "maintainer", "--dry-run"],
      env,
    );
    expect(dry.code, dry.cap.errText()).toBe(0);
    expect(dry.cap.outText()).toContain("would grant approval");
    expect(dry.cap.outText()).toContain("maintainer");

    // The request is still pending: nothing was granted and nothing ran.
    const approvals = await cli(["approvals", "--json"], env);
    const states = approvals.cap.outJson<readonly { status?: string }[]>();
    expect(states.every((state) => state.status === "pending")).toBe(true);
    expect(await eventLineCount(env.cwd)).toBe(before);
  });

  it("still refuses a missing --approver", async () => {
    const env = await initialized();
    const id = await createTask(env, ["--risk", "high"]);
    await cli(["task", "run", id], env);
    const { code, cap } = await cli(["task", "approve", id, "--dry-run"], env);
    expect(code).toBe(2);
    expect(cap.errText()).toContain("approver");
  });
});

describe("--dry-run: task run", () => {
  it("accepts --dry-run, reports a plan, and writes nothing", async () => {
    const env = await initialized();
    const id = await createTask(env);
    const before = await eventLineCount(env.cwd);

    const dry = await cli(["task", "run", id, "--dry-run"], env);
    expect(dry.code, dry.cap.errText()).toBe(0);
    expect(dry.cap.outText()).toContain("plan only");
    expect(dry.cap.outText()).toContain("was not run");

    const status = await cli(["task", "status", id, "--json"], env);
    expect(status.cap.outJson<{ task: { status: string } }>().task.status).toBe(
      "created",
    );
    expect(await eventLineCount(env.cwd)).toBe(before);
  });
});

describe("--dry-run: task orchestrate", () => {
  it("accepts --dry-run and reports a plan without executing", async () => {
    const project = await createTestProject({
      frontierConfig: frontierConfig({ models: [TEXT_MODEL] }),
      frontier: createScriptedFrontier([{ usage: FIXTURE_USAGE }]),
      modelRates: ratesFor([TEXT_MODEL]),
    });
    roots.push(project.root);
    const env: CliEnv = {
      cwd: project.root,
      clock,
      runtimeVersion: "v24.21.0",
      platform: "test/test",
    };
    const stored = await project.runtime.tasks.create(
      {
        title: "Plan an orchestration",
        description: "Nothing should run",
        acceptanceCriteria: ["Recorded"],
      },
      {
        project: project.runtime.project,
        workspace: project.runtime.workspace,
      },
    );
    const before = await eventLineCount(project.root);

    const dry = await cli(
      ["task", "orchestrate", String(stored.task.id), "--dry-run"],
      env,
    );
    expect(dry.code, dry.cap.errText()).toBe(0);
    expect(dry.cap.outText()).toContain("plan only");
    expect(dry.cap.outText()).toContain("was not orchestrated");
    expect(await eventLineCount(project.root)).toBe(before);
  });
});

describe("--dry-run: task context --select", () => {
  it("computes a selection without recording it", async () => {
    const env = await initialized();
    const id = await createTask(env);
    const before = await eventLineCount(env.cwd);

    const dry = await cli(
      ["task", "context", id, "--select", "--dry-run"],
      env,
    );
    expect(dry.code, dry.cap.errText()).toBe(0);
    expect(dry.cap.outText()).toContain("computed but not recorded");

    const read = await cli(["task", "context", id, "--json"], env);
    expect(read.cap.outJson<readonly unknown[]>()).toHaveLength(0);
    expect(await eventLineCount(env.cwd)).toBe(before);
  });
});
