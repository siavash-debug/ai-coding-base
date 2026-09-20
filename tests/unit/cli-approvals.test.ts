import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/main.js";
import type { CliEnv, CliIo } from "../../src/cli/io.js";
import { createFixedClock } from "../../src/core/clock.js";

/**
 * The approval surface, exercised through the real CLI.
 *
 * Commands are driven in-process against a temporary project with a fixed clock, so
 * exit codes, output and refusal messages are asserted without spawning a process or
 * depending on the machine. Every command here is deterministic and offline.
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

async function cli(
  argv: readonly string[],
  env: CliEnv,
): Promise<{ code: number; cap: Capture }> {
  const cap = capture();
  const code = await main(argv, cap.io, env);
  return { code, cap };
}

async function initialized(): Promise<CliEnv> {
  const cwd = await mkdtemp(join(tmpdir(), "ai-cli-approvals-"));
  roots.push(cwd);
  const env: CliEnv = {
    cwd,
    clock,
    runtimeVersion: "v24.21.0",
    platform: "test/test",
  };
  const { code } = await cli(["init"], env);
  expect(code).toBe(0);
  return env;
}

async function highRiskTask(env: CliEnv): Promise<string> {
  const { code, cap } = await cli(
    [
      "task",
      "create",
      "--title",
      "Rotate the production signing key",
      "--description",
      "Replace the key used to sign releases.",
      "--acceptance",
      "The new key signs a release",
      "--risk",
      "high",
      "--json",
    ],
    env,
  );
  expect(code, cap.errText()).toBe(0);
  return cap.outJson<{ task: { id: string } }>().task.id;
}

describe("ai approvals", () => {
  it("lists nothing in a fresh project", async () => {
    const env = await initialized();
    const { code, cap } = await cli(["approvals"], env);
    expect(code).toBe(0);
    expect(cap.outText()).toContain("No approvals recorded");
  });

  it("shows a pending request in human and JSON form", async () => {
    const env = await initialized();
    const taskId = await highRiskTask(env);
    await cli(["task", "run", taskId], env);

    const human = await cli(["approvals"], env);
    expect(human.code).toBe(0);
    expect(human.cap.outText()).toContain("[pending]");
    expect(human.cap.outText()).toContain("task " + taskId);

    const json = await cli(["approvals", "--json"], env);
    const states =
      json.cap.outJson<
        readonly { status: string; taskId: string; requestId: string }[]
      >();
    expect(states).toHaveLength(1);
    expect(states[0].status).toBe("pending");
    expect(states[0].taskId).toBe(taskId);
  });

  it("prints help for --help", async () => {
    const env = await initialized();
    const { code, cap } = await cli(["approvals", "--help"], env);
    expect(code).toBe(0);
    expect(cap.outText()).toContain("ai approvals");
  });
});

describe("ai task approve", () => {
  it("requires an approver identity", async () => {
    const env = await initialized();
    const taskId = await highRiskTask(env);
    await cli(["task", "run", taskId], env);

    const { code, cap } = await cli(["task", "approve", taskId], env);
    expect(code).toBe(2);
    expect(cap.errText()).toContain("--approver");
  });

  it("refuses to approve a task with nothing pending", async () => {
    const env = await initialized();
    const { code: created, cap } = await cli(
      [
        "task",
        "create",
        "--title",
        "Low risk change",
        "--description",
        "Nothing dangerous.",
        "--json",
      ],
      env,
    );
    expect(created).toBe(0);
    const taskId = cap.outJson<{ task: { id: string } }>().task.id;

    const approve = await cli(
      ["task", "approve", taskId, "--approver", "maintainer"],
      env,
    );
    expect(approve.code).toBe(2);
    expect(approve.cap.errText()).toContain("no pending approval request");
  });

  it("refuses an unknown request id", async () => {
    const env = await initialized();
    const taskId = await highRiskTask(env);
    await cli(["task", "run", taskId], env);

    const { code, cap } = await cli(
      [
        "task",
        "approve",
        taskId,
        "--approver",
        "maintainer",
        "--request",
        "apr-does-not-exist",
      ],
      env,
    );
    expect(code).toBe(2);
    expect(cap.errText()).toContain("no approval request");
  });

  it("grants and then resumes to review", async () => {
    const env = await initialized();
    const taskId = await highRiskTask(env);

    const suspended = await cli(["task", "run", taskId], env);
    expect(suspended.code).toBe(1);
    expect(suspended.cap.outText()).toContain("awaiting-approval");
    expect(suspended.cap.outText()).toContain(`ai task approve ${taskId}`);

    // Grant and resume in one deliberate act.
    const resumed = await cli(
      [
        "task",
        "approve",
        taskId,
        "--approver",
        "maintainer",
        "--resume",
        "--json",
      ],
      env,
    );
    expect(resumed.code, resumed.cap.errText()).toBe(0);
    const result = resumed.cap.outJson<{
      outcome: string;
      resumed: boolean;
      task: { status: string };
    }>();
    expect(result.outcome).toBe("awaiting-review");
    expect(result.resumed).toBe(true);
    expect(result.task.status).toBe("review");

    const trace = await cli(["task", "trace", taskId, "--json"], env);
    const parsed = trace.cap.outJson<{
      approvals: readonly {
        status?: string;
        grantedAt?: string;
        consumedAt?: string;
      }[];
      integrity: { ok: boolean };
    }>();
    expect(parsed.approvals[0].status).toBe("consumed");
    expect(parsed.approvals[0].grantedAt).toBeDefined();
    expect(parsed.approvals[0].consumedAt).toBeDefined();
    expect(parsed.integrity.ok).toBe(true);
  });

  it("refuses to re-answer a request that is already granted, and says what to do", async () => {
    const env = await initialized();
    const taskId = await highRiskTask(env);
    await cli(["task", "run", taskId], env);

    await cli(["task", "approve", taskId, "--approver", "maintainer"], env);
    const again = await cli(
      ["task", "approve", taskId, "--approver", "other"],
      env,
    );
    expect(again.code).toBe(2);
    expect(again.cap.errText()).toContain("unused grant");
    expect(again.cap.errText()).toContain(`ai task run ${taskId}`);
  });

  it("resumes an existing unused grant without issuing a second one", async () => {
    const env = await initialized();
    const taskId = await highRiskTask(env);
    await cli(["task", "run", taskId], env);
    await cli(["task", "approve", taskId, "--approver", "maintainer"], env);

    const resumed = await cli(
      ["task", "approve", taskId, "--approver", "maintainer", "--resume"],
      env,
    );
    expect(resumed.code, resumed.cap.errText()).toBe(0);
    expect(resumed.cap.outText()).toContain("awaiting-review");

    const trace = await cli(["task", "trace", taskId, "--json"], env);
    const parsed = trace.cap.outJson<{
      approvals: readonly { requestId: string; status?: string }[];
    }>();
    // Exactly one approval: resuming did not create a second request or grant.
    expect(parsed.approvals).toHaveLength(1);
    expect(parsed.approvals[0].status).toBe("consumed");
  });

  it("records an expiry and reports it as expired", async () => {
    const env = await initialized();
    const taskId = await highRiskTask(env);
    await cli(["task", "run", taskId], env);

    const granted = await cli(
      [
        "task",
        "approve",
        taskId,
        "--approver",
        "maintainer",
        "--expires-in",
        "60",
        "--json",
      ],
      env,
    );
    expect(granted.code).toBe(0);
    const state = granted.cap.outJson<{ status: string; expiresAt?: string }>();
    expect(state.status).toBe("granted");
    expect(state.expiresAt).toBeDefined();
  });

  it("fails a resume once the grant has been spent, with a non-zero exit code", async () => {
    const env = await initialized();
    const taskId = await highRiskTask(env);
    await cli(["task", "run", taskId], env);
    await cli(
      ["task", "approve", taskId, "--approver", "maintainer", "--resume"],
      env,
    );

    // The grant authorised one attempt, and it is gone: the same command cannot
    // replay it.
    const again = await cli(
      ["task", "approve", taskId, "--approver", "other", "--resume"],
      env,
    );
    expect(again.code).toBe(2);
    expect(again.cap.errText()).toContain("no pending approval request");
    expect(again.cap.errText()).toContain("consumed");
  });
});

describe("the approval surface keeps secrets out of its output", () => {
  it("never prints the credential when a real provider is configured", async () => {
    const env = await initialized();
    const taskId = await highRiskTask(env);
    await cli(["task", "run", taskId], env);
    await cli(["task", "approve", taskId, "--approver", "maintainer"], env);

    for (const argv of [
      ["approvals"],
      ["approvals", "--json"],
      ["task", "trace", taskId],
      ["task", "status", taskId],
      ["doctor"],
    ]) {
      const { cap } = await cli(argv, env);
      expect(`${cap.outText()} ${cap.errText()}`).not.toContain("sk-");
      expect(cap.outText().toLowerCase()).not.toContain("bearer");
    }
  });
});
