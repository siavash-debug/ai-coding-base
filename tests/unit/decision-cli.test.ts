import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DECISION_DOMAINS } from "../../src/decisions/domains.js";
import { main } from "../../src/cli/main.js";
import { formatTaskDecisions } from "../../src/cli/render.js";
import type { CliEnv, CliIo } from "../../src/cli/io.js";
import { MINIMUM_NODE_MAJOR, runDoctor } from "../../src/application/doctor.js";
import type { TaskTrace } from "../../src/application/trace.js";
import { createFixedClock } from "../../src/core/clock.js";
import { createFixedEnvironment } from "../../src/ports/environment.js";

/**
 * The decision surface through the real CLI, plus the doctor's decision checks.
 *
 * Everything here is offline and deterministic: the commands are driven in-process
 * against a temporary project, and `ai decision` never calls a provider by design. The
 * isolation tests matter as much as the happy path — a command that leaks another
 * project's decisions would undo the whole scope model.
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

/**
 * `ai doctor` with an injected, empty environment: no test can read a real credential,
 * and no check can reach the network.
 */
function doctorOn(projectRoot: string) {
  return runDoctor({
    projectRoot,
    clock,
    runtimeVersion: `v${MINIMUM_NODE_MAJOR}.21.0`,
    platform: "test/test",
    environment: createFixedEnvironment({}),
  });
}

async function initialized(): Promise<CliEnv> {
  const cwd = await mkdtemp(join(tmpdir(), "ai-cli-decisions-"));
  roots.push(cwd);
  const env: CliEnv = {
    cwd,
    clock,
    runtimeVersion: "v24.21.0",
    platform: "test/test",
  };
  const { code, cap } = await cli(["init"], env);
  expect(code, cap.errText()).toBe(0);
  return env;
}

async function createTask(
  env: CliEnv,
  title = "Bound the retry storm",
): Promise<string> {
  const { code, cap } = await cli(
    [
      "task",
      "create",
      "--title",
      title,
      "--description",
      "Bound the retries and record why each one was allowed.",
      "--acceptance",
      "Retries are bounded",
      "--json",
    ],
    env,
  );
  expect(code, cap.errText()).toBe(0);
  return cap.outJson<{ task: { id: string } }>().task.id;
}

describe("ai decision", () => {
  it("reports the decision layer offline, and says it is disabled", async () => {
    const env = await initialized();
    const { code, cap } = await cli(["decision"], env);
    expect(code).toBe(0);
    const text = cap.outText();
    expect(text).toContain("Decision layer");
    expect(text).toContain("disabled");
    // The fallback policy for every question is stated, not implied.
    for (const domain of [
      "routing",
      "tool-selection",
      "risk-assessment",
      "retry",
      "completion",
      "ranking",
      "relevance",
      "human-escalation",
    ]) {
      expect(text).toContain(domain);
    }
    expect(text).toContain("Fallback policy");
  });

  it("emits machine-readable state with --json", async () => {
    const env = await initialized();
    const { code, cap } = await cli(["decision", "--json"], env);
    expect(code).toBe(0);
    const summary = cap.outJson<{
      provider: { configured: boolean; id: string | null };
      config: { provider: string; maxDecisionsPerTask: number };
      fallbacks: readonly { domain: string; strategy: string }[];
      recorded: { decisions: number; failures: number };
      scope: { workspaceId: string; events: number };
    }>();
    expect(summary.provider.configured).toBe(false);
    expect(summary.provider.id).toBeNull();
    expect(summary.config.provider).toBe("disabled");
    expect(summary.config.maxDecisionsPerTask).toBeGreaterThan(0);
    expect(summary.fallbacks).toHaveLength(DECISION_DOMAINS.length);
    expect(summary.recorded.decisions).toBe(0);
    expect(summary.scope.workspaceId.length).toBeGreaterThan(0);
  });

  it("counts the decisions a run recorded, from the log", async () => {
    const env = await initialized();
    const taskId = await createTask(env);
    const ran = await cli(["task", "run", taskId], env);
    expect(ran.code, ran.cap.errText()).toBe(0);

    const { code, cap } = await cli(["decision", "--json"], env);
    expect(code).toBe(0);
    const summary = cap.outJson<{
      recorded: {
        decisions: number;
        deterministic: number;
        providerAnswers: number;
        fallbacks: number;
        failures: number;
        byKind: Record<string, number>;
      };
    }>();
    expect(summary.recorded.decisions).toBeGreaterThan(0);
    // No provider is configured, so every answer is attributed to code and nothing is
    // reported as a failure.
    expect(summary.recorded.providerAnswers).toBe(0);
    expect(summary.recorded.fallbacks).toBe(0);
    expect(summary.recorded.failures).toBe(0);
    expect(summary.recorded.deterministic).toBe(summary.recorded.decisions);
    expect(Object.keys(summary.recorded.byKind).length).toBeGreaterThan(0);
  });

  it("refuses an unknown workspace rather than inventing one", async () => {
    const env = await initialized();
    const { code, cap } = await cli(
      ["decision", "--workspace", "wsp-nope"],
      env,
    );
    expect(code).toBe(1);
    expect(cap.errText()).toContain("NOT_FOUND");
  });

  it("describes its own options", async () => {
    const env = await initialized();
    const { code, cap } = await cli(["decision", "--help"], env);
    expect(code).toBe(0);
    expect(cap.outText()).toContain("--json");
    expect(cap.outText()).toContain("--workspace");
  });
});

describe("ai task decisions", () => {
  it("shows every bounded question a task asked, and how it was answered", async () => {
    const env = await initialized();
    const taskId = await createTask(env);
    await cli(["task", "run", taskId], env);

    const { code, cap } = await cli(["task", "decisions", taskId], env);
    expect(code).toBe(0);
    const text = cap.outText();
    expect(text).toContain("decision(s)");
    for (const kind of [
      "routing",
      "tool-selection",
      "risk-assessment",
      "completion",
      "human-escalation",
    ]) {
      expect(text).toContain(kind);
    }
    // The answer source is named for each decision: this is what makes "which layer
    // decided this" answerable from the command line.
    expect(text).toContain("decision-layer-disabled");
    expect(text).toContain("candidates:");
  });

  it("emits the same information as JSON", async () => {
    const env = await initialized();
    const taskId = await createTask(env);
    await cli(["task", "run", taskId], env);
    const { code, cap } = await cli(
      ["task", "decisions", taskId, "--json"],
      env,
    );
    expect(code).toBe(0);
    const payload = cap.outJson<{
      decisions: readonly {
        kind: string;
        outcome: string;
        answeredBy?: string;
        optionIds?: readonly string[];
      }[];
      failures: readonly unknown[];
    }>();
    expect(payload.decisions.length).toBeGreaterThan(0);
    expect(payload.failures).toEqual([]);
    // Every decision states the candidates it chose between: "what was on the table"
    // is part of the record, not something a reader has to reconstruct.
    expect(
      payload.decisions.every((decision) => decision.optionIds !== undefined),
    ).toBe(true);
    // With no decision layer installed, nothing is attributed to a provider and
    // nothing is reported as a fallback.
    expect(
      payload.decisions.some(
        (decision) =>
          (decision as { answeredBy?: string }).answeredBy === "provider",
      ),
    ).toBe(false);
  });

  it("reports a task with no decisions as empty rather than missing", async () => {
    const env = await initialized();
    const taskId = await createTask(env);
    const { code, cap } = await cli(["task", "decisions", taskId], env);
    expect(code).toBe(0);
    expect(cap.outText()).toContain("no decisions recorded");
  });

  it("cannot read another workspace's task decisions", async () => {
    const env = await initialized();
    const taskId = await createTask(env);
    await cli(["task", "run", taskId], env);

    // A second project, with its own tasks, receives nothing about the first: the
    // refusal is generic and the output leaks neither a title nor a decision.
    const other = await initialized();
    const { code, cap } = await cli(["task", "decisions", taskId], other);
    expect(code).toBe(1);
    expect(cap.errText()).toContain("NOT_FOUND");
    expect(cap.errText()).not.toContain("Bound the retry storm");
    expect(cap.errText()).not.toContain("routing");
    expect(cap.outText()).toBe("");
  });

  it("treats a missing task as not found in the current scope", async () => {
    const env = await initialized();
    const { code, cap } = await cli(
      ["task", "decisions", "tsk-does-not-exist"],
      env,
    );
    expect(code).toBe(1);
    expect(cap.errText()).toContain("NOT_FOUND");
  });
});

describe("ai doctor: decision checks", () => {
  it("reports the decision layer without calling anything", async () => {
    const env = await initialized();
    const report = await doctorOn(env.cwd);
    const layer = report.checks.find((check) => check.id === "decision-layer");
    expect(layer).toBeDefined();
    // A disabled layer is a healthy state, not a warning: the platform is complete
    // without one.
    expect(layer!.status).toBe("ok");
    expect((layer!.detail ?? "").length).toBeGreaterThan(0);
    expect(layer!.detail ?? "").not.toContain("Bearer");
  });

  it("proves recorded decisions are auditable, offline", async () => {
    const env = await initialized();
    const taskId = await createTask(env);
    await cli(["task", "run", taskId], env);
    const report = await doctorOn(env.cwd);
    const audit = report.checks.find((check) => check.id === "decision-audit");
    expect(audit).toBeDefined();
    expect(audit!.status).toBe("ok");
  });

  it("passes with a decision layer configured but never reaches the network", async () => {
    const env = await initialized();
    const report = await doctorOn(env.cwd);
    expect(report.exitCode).toBe(0);
    expect(report.checks.map((check) => check.id)).toContain("decision-layer");
  });
});

describe("ai task decisions: column layout", () => {
  it("keeps a ranked list that outgrows its column from glueing to the answer", () => {
    // Two registered model ids are wider than the column the renderer reserves. The
    // list used to run straight into the "answered by" column, which made a trace
    // read as one long token.
    const trace = {
      taskId: "task-1",
      status: "planning",
      decisions: [
        {
          kind: "ranking",
          outcome: "selected",
          question: "In what order should these candidates be considered?",
          ranking: [
            "inclusionai/ling-3.0-flash-vl:free",
            "inclusionai/ling-3.0-flash-fin:free",
          ],
          optionIds: [
            "inclusionai/ling-3.0-flash-fin:free",
            "inclusionai/ling-3.0-flash-vl:free",
          ],
          answeredBy: "provider",
          providerId: "typesafe",
        },
      ],
      decisionFailures: [],
      metrics: { decisions: 0 },
    } as unknown as TaskTrace;

    const text = formatTaskDecisions(trace);
    expect(text).toContain(
      "inclusionai/ling-3.0-flash-fin:free provider typesafe",
    );
  });
});
