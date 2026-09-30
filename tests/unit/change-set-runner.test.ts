import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createChangeSetAgentRunner } from "../../src/adapters/agent/change-set-agent-runner.js";
import {
  CHANGE_SET_SUITE,
  VERIFICATION_SUITE,
} from "../../src/adapters/agent/change-set-agent-runner.js";
import type { AgentAttempt } from "../../src/ports/agent-runner.js";
import {
  RUN_TESTS_TOOL,
  WRITE_FILE_TOOL,
} from "../../src/ports/agent-runner.js";
import { createRunTask } from "../../src/application/run-task.js";
import { createFixedClock, createManualClock } from "../../src/core/clock.js";
import { createFakeProvider } from "../support/llm.js";
import {
  accessPolicy,
  createEnforcementFixture,
  readWritePolicy,
  type EnforcementFixture,
} from "../support/policy.js";
import {
  createSandboxFixture,
  type SandboxFixture,
} from "../support/policy.js";
import { createTestProject, type TestProject } from "../support/project.js";

const INSTANT = "2026-09-20T10:00:00.000Z";

const fixtures: EnforcementFixture[] = [];
const sandboxes: SandboxFixture[] = [];
const projects: TestProject[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    await fixtures.pop()?.cleanup();
  }
  while (sandboxes.length > 0) {
    await sandboxes.pop()?.cleanup();
  }
  while (projects.length > 0) {
    await projects.pop()?.cleanup();
  }
});

/** A policy that may write anywhere in the workspace and run `node`. */
function writableExecutePolicy(
  overrides: Parameters<typeof accessPolicy>[0] = {},
) {
  return accessPolicy({
    allowed: ["filesystem.read", "filesystem.write", "process.execute"],
    readableRoots: ["."],
    writableRoots: ["."],
    allowedCommands: ["node"],
    ...overrides,
  });
}

async function fixture(
  policy = writableExecutePolicy(),
): Promise<EnforcementFixture> {
  const created = await createEnforcementFixture({ policy });
  fixtures.push(created);
  return created;
}

function runnerWith(
  content: string,
  overrides: Partial<Parameters<typeof createChangeSetAgentRunner>[0]> = {},
) {
  const provider = createFakeProvider([{ content }], {
    id: "fake-provider",
    modelId: "fake-model",
  });
  return createChangeSetAgentRunner({
    provider,
    modelId: "fake-model",
    clock: createFixedClock(INSTANT),
    verification: { command: "node", args: ["-e", "process.exit(0)"] },
    ...overrides,
  });
}

function attemptFor(
  f: EnforcementFixture,
  runner: ReturnType<typeof createChangeSetAgentRunner>,
): Promise<AgentAttempt> {
  return runner.attempt({
    task: f.task.task,
    workspace: f.runtime.workspace,
    providerId: "fake-provider",
    modelId: "fake-model",
    correlationId: "corr-1",
    operations: f.gateway(),
  });
}

const changeSet = (
  changes: readonly { ref: string; content: string }[],
): string => JSON.stringify({ changes });

describe("change-set runner: positive path", () => {
  it("writes the proposed file, runs the command, and records verification", async () => {
    const f = await fixture();
    const runner = runnerWith(
      changeSet([
        {
          ref: "src/text/normalize.ts",
          content: "export const normalizeText = (v: string): string => v;\n",
        },
      ]),
    );
    const attempt = await attemptFor(f, runner);

    expect(attempt.steps.map((step) => step.kind)).toEqual([
      "llm",
      "tool",
      "tool",
      "test",
    ]);
    const write = attempt.steps[1];
    if (write?.kind !== "tool") throw new Error("expected a tool step");
    expect(write.toolId).toBe(WRITE_FILE_TOOL);
    expect(write.operation).toBe("write");
    expect(write.ok).toBe(true);

    const exec = attempt.steps[2];
    if (exec?.kind !== "tool") throw new Error("expected a tool step");
    expect(exec.toolId).toBe(RUN_TESTS_TOOL);
    expect(exec.operation).toBe("execute");
    expect(exec.ok).toBe(true);

    const test = attempt.steps[3];
    if (test?.kind !== "test") throw new Error("expected a test step");
    expect(test.suite).toBe(VERIFICATION_SUITE);
    expect(test.passed).toBe(1);
    expect(test.failed).toBe(0);

    const onDisk = await readFile(
      join(f.root, "src", "text", "normalize.ts"),
      "utf8",
    );
    expect(onDisk).toContain("normalizeText");
  });

  it("reports a failing command as a failed verification, not a failed tool", async () => {
    const f = await fixture();
    const runner = runnerWith(changeSet([{ ref: "a.ts", content: "x" }]), {
      verification: { command: "node", args: ["-e", "process.exit(3)"] },
    });
    const attempt = await attemptFor(f, runner);
    const exec = attempt.steps[2];
    if (exec?.kind !== "tool") throw new Error("expected a tool step");
    expect(exec.ok).toBe(true);
    const test = attempt.steps[3];
    if (test?.kind !== "test") throw new Error("expected a test step");
    expect(test.failed).toBe(1);
  });
});

describe("change-set runner: named checks", () => {
  function checksRunner(
    checks: Parameters<typeof createChangeSetAgentRunner>[0]["checks"],
  ) {
    const provider = createFakeProvider(
      [{ content: changeSet([{ ref: "src/a.ts", content: "x" }]) }],
      { id: "fake-provider", modelId: "fake-model" },
    );
    return createChangeSetAgentRunner({
      provider,
      modelId: "fake-model",
      clock: createFixedClock(INSTANT),
      checks,
    });
  }

  it("runs each declared check and reports it under its stable id", async () => {
    const f = await fixture();
    const runner = checksRunner([
      { id: "check-a", command: "node", args: ["-e", "process.exit(0)"] },
      { id: "check-b", command: "node", args: ["-e", "process.exit(1)"] },
    ]);
    const attempt = await attemptFor(f, runner);
    const tests = attempt.steps.flatMap((step) =>
      step.kind === "test" ? [step] : [],
    );
    // Two independent checks, both recorded, under the ids the operator declared.
    expect(tests.map((step) => step.check)).toEqual(["check-a", "check-b"]);
    expect(tests[0]).toMatchObject({
      suite: VERIFICATION_SUITE,
      check: "check-a",
      passed: 1,
      failed: 0,
    });
    // A failing check does not stop the next: check-b still ran and is its own record.
    expect(tests[1]).toMatchObject({
      suite: VERIFICATION_SUITE,
      check: "check-b",
      passed: 0,
      failed: 1,
    });
    // Each check is one `process.exec` through the same boundary, and nothing else.
    const execs = attempt.steps.flatMap((step) =>
      step.kind === "tool" && step.toolId === RUN_TESTS_TOOL ? [step] : [],
    );
    expect(execs).toHaveLength(2);
    expect(execs.every((step) => step.ok)).toBe(true);
  });

  it("stops at a refused check rather than running the rest", async () => {
    const f = await fixture(writableExecutePolicy({ allowedCommands: [] }));
    const runner = checksRunner([
      { id: "check-a", command: "node", args: ["-e", "process.exit(0)"] },
    ]);
    const attempt = await attemptFor(f, runner);
    const last = attempt.steps[attempt.steps.length - 1];
    if (last?.kind !== "tool") throw new Error("expected a tool step");
    expect(last.toolId).toBe(RUN_TESTS_TOOL);
    expect(last.refusal?.reasonCode).toBe("TARGET_NOT_ALLOWED");
    expect(attempt.steps.some((step) => step.kind === "test")).toBe(false);
  });
});

describe("change-set runner: fail-closed", () => {
  it("writes nothing when the model output is malformed", async () => {
    const f = await fixture();
    const attempt = await attemptFor(f, runnerWith("I refuse to answer."));
    expect(attempt.steps.map((step) => step.kind)).toEqual(["llm", "test"]);
    const test = attempt.steps[1];
    if (test?.kind !== "test") throw new Error("expected a test step");
    expect(test.suite).toBe(CHANGE_SET_SUITE);
    expect(test.failed).toBe(1);
  });

  it("writes nothing when a ref traverses", async () => {
    const f = await fixture();
    const attempt = await attemptFor(
      f,
      runnerWith(changeSet([{ ref: "../escape.ts", content: "x" }])),
    );
    expect(attempt.steps.map((step) => step.kind)).toEqual(["llm", "test"]);
  });

  it("writes nothing when the change set is oversized", async () => {
    const f = await fixture();
    const attempt = await attemptFor(
      f,
      runnerWith(changeSet([{ ref: "a.ts", content: "12345" }]), {
        limits: { maxWriteBytes: 4 },
      }),
    );
    expect(attempt.steps.map((step) => step.kind)).toEqual(["llm", "test"]);
  });

  it("stops at a write outside the writable root", async () => {
    const f = await fixture(writableExecutePolicy({ writableRoots: ["src"] }));
    const attempt = await attemptFor(
      f,
      runnerWith(
        changeSet([
          { ref: "src/a.ts", content: "ok" },
          { ref: "tests/b.ts", content: "outside" },
        ]),
      ),
    );
    const kinds = attempt.steps.map((step) => step.kind);
    expect(kinds[kinds.length - 1]).toBe("tool");
    const last = attempt.steps[attempt.steps.length - 1];
    if (last?.kind !== "tool") throw new Error("expected a tool step");
    expect(last.ok).toBe(false);
    expect(last.refusal?.reasonCode).toBe("RESOURCE_OUTSIDE_BOUNDARY");
  });

  it("refuses a runtime-state target", async () => {
    const f = await fixture();
    const attempt = await attemptFor(
      f,
      runnerWith(changeSet([{ ref: ".ai/project.json", content: "x" }])),
    );
    const last = attempt.steps[attempt.steps.length - 1];
    if (last?.kind !== "tool") throw new Error("expected a tool step");
    expect(last.refusal?.reasonCode).toBe("RUNTIME_STATE_DENIED");
  });

  it("refuses a secret-shaped target", async () => {
    const f = await fixture();
    const attempt = await attemptFor(
      f,
      runnerWith(changeSet([{ ref: ".env", content: "x" }])),
    );
    const last = attempt.steps[attempt.steps.length - 1];
    if (last?.kind !== "tool") throw new Error("expected a tool step");
    expect(last.refusal?.reasonCode).toBe("SECRET_PATH_DENIED");
  });

  it("refuses a command that is not allowlisted", async () => {
    const f = await fixture(writableExecutePolicy({ allowedCommands: [] }));
    const attempt = await attemptFor(
      f,
      runnerWith(changeSet([{ ref: "a.ts", content: "x" }])),
    );
    const last = attempt.steps[attempt.steps.length - 1];
    if (last?.kind !== "tool") throw new Error("expected a tool step");
    expect(last.toolId).toBe(RUN_TESTS_TOOL);
    expect(last.refusal?.reasonCode).toBe("TARGET_NOT_ALLOWED");
  });
});

describe("sandbox: the write-size bound", () => {
  it("refuses a write over the boundary cap before writing anything", async () => {
    const sandbox = await createSandboxFixture({
      policy: readWritePolicy(),
      maxWriteBytes: 4,
    });
    sandboxes.push(sandbox);
    const outcome = await sandbox.sandbox.fs.write("a.txt", "12345");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.reasonCode).toBe("WRITE_TOO_LARGE");
    }
    await expect(sandbox.readFromDisk("a.txt")).rejects.toThrow();
  });
});

describe("change-set runner: through the run use case", () => {
  it("reaches review with the file written and verification recorded", async () => {
    const subject = await createTestProject({
      policy: writableExecutePolicy(),
    });
    projects.push(subject);
    const stored = await subject.runtime.tasks.create(
      {
        title: "Add normalizeText",
        description: "Add the utility.",
        acceptanceCriteria: ["The utility exists"],
        riskLevel: "low",
      },
      {
        project: subject.runtime.project,
        workspace: subject.runtime.workspace,
      },
    );

    const provider = createFakeProvider(
      [
        {
          content: changeSet([
            {
              ref: "src/text/normalize.ts",
              content:
                "export const normalizeText = (v: string): string => v;\n",
            },
          ]),
        },
      ],
      { id: "fake-provider", modelId: "fake-model" },
    );
    const runner = createChangeSetAgentRunner({
      provider,
      modelId: "fake-model",
      clock: createManualClock(INSTANT),
      verification: { command: "node", args: ["-e", "process.exit(0)"] },
    });

    const runTask = createRunTask({
      tasks: subject.runtime.tasks,
      sessions: subject.runtime.sessions,
      decisions: subject.runtime.decisions,
      approvals: subject.runtime.approvals,
      ledger: subject.runtime.ledger,
      context: subject.runtime.context,
      contextConfig: subject.runtime.contextConfig,
      runner,
      policy: subject.runtime.policy,
      workspace: subject.runtime.workspace,
      rates: subject.runtime.modelRates,
      clock: createManualClock(INSTANT),
      providerId: "fake-provider",
      modelId: "fake-model",
      operations: subject.runtime.operations,
      recorder: subject.runtime.recorder,
      decisionLayer: subject.runtime.decisionLayer,
    });

    const result = await runTask.run(stored);
    expect(result.outcome).toBe("awaiting-review");
    expect(result.task.status).toBe("review");

    const onDisk = await readFile(
      join(subject.root, "src", "text", "normalize.ts"),
      "utf8",
    );
    expect(onDisk).toContain("normalizeText");

    const trace = await subject.runtime.traces.read(
      {
        projectId: subject.runtime.project.id,
        workspaceId: subject.runtime.workspace.id,
      },
      stored.task.id,
    );
    // The write and the verification command each counted as a tool call.
    expect(trace.metrics.toolCalls).toBe(2);
    expect(trace.tests.map((test) => test.suite)).toContain(VERIFICATION_SUITE);
  });
});
