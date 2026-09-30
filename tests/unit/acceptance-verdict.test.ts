import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/main.js";
import type { CliEnv, CliIo } from "../../src/cli/io.js";
import { createFixedClock } from "../../src/core/clock.js";
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
} from "../../src/decisions/provider.js";
import { DECISION_KINDS } from "../../src/decisions/decision.js";
import {
  ACCEPTANCE_VERDICT_STATUSES,
  acceptanceSummary,
  assessAcceptanceCriteria,
  markAcceptanceCriterion,
  measuredAcceptanceCriteriaMet,
  validateTask,
  type CreateTaskInput,
  type Task,
} from "../../src/tasks/task.js";
import type { AgentRunner } from "../../src/ports/agent-runner.js";
import {
  FIXTURE_INSTANT,
  createEnforcementFixture,
  readWritePolicy,
  type EnforcementFixture,
} from "../support/policy.js";
import { createTestProject } from "../support/project.js";
import { createHarness } from "../support/harness.js";

/**
 * Explicit human acceptance verdicts, end to end.
 *
 * A criterion can stop being `pending` in exactly two ways, and they are different
 * authorities: a verification the task author bound it to (`assessAcceptanceCriteria`),
 * or a person saying so (`recordAcceptanceVerdict`). These tests establish that the
 * second is reachable through the production interface, that it is recorded with human
 * provenance, and that neither authority can imitate the other.
 *
 * Nothing here may change what completion means: a verdict establishes a criterion, and
 * the completion question still receives the same aggregate evidence it did before.
 */

const clock = createFixedClock(FIXTURE_INSTANT);

/** A real project/workspace/task with the criteria under test. */
function taskWith(criteria: CreateTaskInput["acceptanceCriteria"]): Task {
  return createHarness({ task: { acceptanceCriteria: criteria } }).task;
}

describe("acceptance verdict: the domain records provenance", () => {
  it("marks a criterion with its author and without machine evidence", () => {
    const bound = taskWith([
      { statement: "The bound suite passes", verifiedBy: { suite: "suite" } },
      "A criterion only a person can judge",
    ]);
    const assessed = assessAcceptanceCriteria(
      bound,
      [{ suite: "suite", passed: 2, failed: 0 }],
      clock,
    ).task;
    expect(assessed.acceptanceCriteria[0]?.evidence).toBeDefined();

    // A human overrules the verification: the status moves, the author is recorded, and
    // the machine's references go with the machine's status.
    const waived = markAcceptanceCriterion(
      assessed,
      "AC-1",
      "waived",
      clock,
      "alice",
    );
    const criterion = waived.acceptanceCriteria[0];
    expect(criterion?.status).toBe("waived");
    expect(criterion?.verdictBy).toBe("alice");
    expect(criterion?.evidence).toBeUndefined();
    // The author's *binding* is not provenance and is not erased: it still says which
    // evidence was supposed to decide the criterion.
    expect(criterion?.verifiedBy).toEqual({ suite: "suite" });
    expect(() => validateTask(waived)).not.toThrow();
  });

  it("refuses to record two sources of one status", () => {
    const task = taskWith(["A criterion"]);
    const withVerdict = markAcceptanceCriterion(
      task,
      "AC-1",
      "met",
      clock,
      "alice",
    );
    const forged = {
      ...withVerdict,
      acceptanceCriteria: [
        { ...withVerdict.acceptanceCriteria[0]!, evidence: ["suite:s"] },
      ],
    };
    expect(() => validateTask(forged)).toThrow(/both verification evidence/);
  });

  it("refuses a verdict on a terminal task", () => {
    const completed: Task = {
      ...taskWith(["A criterion"]),
      status: "completed",
      completedAt: FIXTURE_INSTANT,
    };
    expect(() =>
      markAcceptanceCriterion(completed, "AC-1", "waived", clock, "alice"),
    ).toThrow(/terminal/);
  });

  it("refuses a criterion the task does not declare", () => {
    expect(() =>
      markAcceptanceCriterion(taskWith(["A criterion"]), "AC-9", "met", clock),
    ).toThrow(/unknown acceptance criterion/);
  });

  it("has no verdict that returns a criterion to pending", () => {
    expect(ACCEPTANCE_VERDICT_STATUSES).toEqual(["met", "not-met", "waived"]);
  });
});

describe("acceptance summary: what a human verdict contributes", () => {
  it("counts met and waived, reports not-met, and leaves pending unmeasured", () => {
    const start = taskWith(["a", "b", "c", "d"]);
    // Nothing assessed yet: "not measured" is not "zero met".
    expect(measuredAcceptanceCriteriaMet(start)).toBeUndefined();
    expect(acceptanceSummary(start).allMet).toBe(false);

    const met = markAcceptanceCriterion(start, "AC-1", "met", clock, "alice");
    const waived = markAcceptanceCriterion(met, "AC-2", "waived", clock, "bob");
    const failed = markAcceptanceCriterion(
      waived,
      "AC-3",
      "not-met",
      clock,
      "bob",
    );

    expect(measuredAcceptanceCriteriaMet(failed)).toBe(2);
    expect(acceptanceSummary(failed)).toMatchObject({
      total: 4,
      met: 1,
      notMet: 1,
      waived: 1,
      pending: 1,
      allMet: false,
    });

    // A criterion established and a criterion rejected: the set is still not satisfied,
    // and the count of established criteria does not decide that.
    const allFour = markAcceptanceCriterion(
      failed,
      "AC-4",
      "met",
      clock,
      "bob",
    );
    expect(acceptanceSummary(allFour).allMet).toBe(false);
    expect(measuredAcceptanceCriteriaMet(allFour)).toBe(3);
  });

  it("reports a fully established set as satisfied only when nothing is outstanding", () => {
    const start = taskWith(["a", "b"]);
    const met = markAcceptanceCriterion(start, "AC-1", "met", clock, "alice");
    const waived = markAcceptanceCriterion(met, "AC-2", "waived", clock, "bob");
    expect(acceptanceSummary(waived)).toMatchObject({
      met: 1,
      waived: 1,
      notMet: 0,
      pending: 0,
      allMet: true,
    });
    expect(measuredAcceptanceCriteriaMet(waived)).toBe(2);
  });
});

/* --------------------------------------------------------------- real runs */

const fixtures: EnforcementFixture[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (subject) => subject.cleanup()),
  );
});

async function fixture(
  options: Parameters<typeof createEnforcementFixture>[0],
): Promise<EnforcementFixture> {
  const created = await createEnforcementFixture(options);
  fixtures.push(created);
  return created;
}

function suiteRunner(
  suite: string,
  passed: number,
  failed: number,
): AgentRunner {
  return {
    id: "fixture-suite-runner",
    kind: "simulated",
    async attempt() {
      return {
        steps: [{ kind: "test", suite, passed, failed, durationMs: 1 }],
      };
    },
  };
}

/** Answers every question with the first option, except completion as given. */
function completionProvider(completion: DecisionResponse): {
  readonly provider: DecisionProvider;
  readonly asked: readonly DecisionRequest[];
} {
  const asked: DecisionRequest[] = [];
  return {
    asked,
    provider: {
      id: "verdict-fixture-provider",
      family: "rules",
      capabilities: () => ({
        kinds: DECISION_KINDS,
        deterministic: false,
        maxOptions: 8,
      }),
      async decide(request: DecisionRequest): Promise<DecisionResponse> {
        asked.push(request);
        if (request.kind === "completion") {
          return completion;
        }
        const first = request.options[0];
        if (first === undefined) {
          return { outcome: "abstained", reason: "no options offered" };
        }
        return { outcome: "selected", optionId: first.id };
      },
    },
  };
}

async function decideTask(
  subject: EnforcementFixture,
  acceptanceCriteria: Parameters<
    typeof subject.runtime.tasks.create
  >[0]["acceptanceCriteria"],
) {
  return subject.runtime.tasks.create(
    {
      title: "Decide acceptance",
      description: "Establish a criterion as a person, then run.",
      acceptanceCriteria,
    },
    { project: subject.runtime.project, workspace: subject.runtime.workspace },
  );
}

describe("acceptance verdict: a real run cannot undo it, and cannot imitate it", () => {
  it("keeps a human verdict when later verification evidence arrives", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 2, 0),
    });
    const stored = await decideTask(subject, [
      {
        statement: "The bound suite passes",
        verifiedBy: { suite: "bound-suite" },
      },
      "A criterion only a person can judge",
    ]);

    // The human decides before the run: AC-1 is waived, AC-2 is accepted by hand.
    const waived = await subject.runtime.tasks.recordAcceptanceVerdict(stored, {
      criterionId: "AC-1",
      status: "waived",
      verdictBy: "alice",
    });
    const accepted = await subject.runtime.tasks.recordAcceptanceVerdict(
      waived,
      {
        criterionId: "AC-2",
        status: "met",
        verdictBy: "alice",
      },
    );

    // The run reports the suite passing, which previously decided AC-1.
    const result = await subject.runtime.runTask.run(accepted);
    expect(result.outcome).toBe("awaiting-review");

    const criteria = result.task.acceptanceCriteria;
    expect(criteria[0]?.status).toBe("waived");
    expect(criteria[0]?.verdictBy).toBe("alice");
    expect(criteria[0]?.evidence).toBeUndefined();
    expect(criteria[1]?.status).toBe("met");
    expect(criteria[1]?.verdictBy).toBe("alice");
    expect(criteria[1]?.evidence).toBeUndefined();
    // The human's own acts are the only non-pending statuses, and nothing was assessed.
    expect(measuredAcceptanceCriteriaMet(result.task)).toBe(2);
  });

  it("lets a human overrule a machine not-met, and then holds that status", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 1, 0),
    });
    const stored = await decideTask(subject, [
      {
        statement: "The bound suite passes",
        verifiedBy: { suite: "bound-suite" },
      },
    ]);
    // A machine assessment that failed the criterion, as a failing run would leave it.
    const failed = markAcceptanceCriterion(
      stored.task,
      "AC-1",
      "not-met",
      clock,
    );
    const version = await subject.runtime.repository.save(
      {
        projectId: subject.runtime.project.id,
        workspaceId: subject.runtime.workspace.id,
      },
      failed,
      { expectedVersion: stored.version },
    );

    const overruled = await subject.runtime.tasks.recordAcceptanceVerdict(
      { version, task: failed },
      { criterionId: "AC-1", status: "met", verdictBy: "carol" },
    );
    expect(overruled.task.acceptanceCriteria[0]).toMatchObject({
      status: "met",
      verdictBy: "carol",
    });

    // A later run cannot take it back: the criterion is no longer `pending`, so the
    // assessment leaves it alone (ADR-060).
    const result = await subject.runtime.runTask.run(overruled);
    expect(result.task.acceptanceCriteria[0]).toMatchObject({
      status: "met",
      verdictBy: "carol",
    });
    expect(result.task.acceptanceCriteria[0]?.evidence).toBeUndefined();
  });

  it("never lets a decision layer establish a criterion", async () => {
    const answering = completionProvider({
      outcome: "selected",
      optionId: "complete",
      reasonCode: "verification-passed",
      confidence: 0.99,
    });
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 3, 0),
      decisionProvider: answering.provider,
    });
    const stored = await decideTask(subject, [
      {
        statement: "The bound suite passes",
        verifiedBy: { suite: "bound-suite" },
      },
      "A criterion only a person can judge",
    ]);

    const result = await subject.runtime.runTask.run(stored);
    expect(result.completionAssessment).toBe("complete");

    const criteria = result.task.acceptanceCriteria;
    // The layer was asked and answered, and it established nothing: the bound criterion
    // is met because the suite decided it, and the unbound one is still unmeasured.
    expect(criteria[0]).toMatchObject({ status: "met" });
    expect(criteria[0]?.verdictBy).toBeUndefined();
    expect(criteria[1]).toMatchObject({ status: "pending" });
    expect(criteria[1]?.verdictBy).toBeUndefined();
    expect(criteria[1]?.evidence).toBeUndefined();
    expect(measuredAcceptanceCriteriaMet(result.task)).toBe(1);
  });

  it("does not move the task's lifecycle", async () => {
    const subject = await fixture({ policy: readWritePolicy() });
    const stored = await decideTask(subject, ["A criterion"]);
    const decided = await subject.runtime.tasks.recordAcceptanceVerdict(
      stored,
      {
        criterionId: "AC-1",
        status: "met",
        verdictBy: "alice",
      },
    );
    expect(decided.task.status).toBe("created");
    expect(decided.task.completedAt).toBeUndefined();

    const events = await subject.runtime.store.readByTask(
      {
        projectId: subject.runtime.project.id,
        workspaceId: subject.runtime.workspace.id,
      },
      stored.task.id,
    );
    expect(
      events.filter((event) => event.type === "TaskStatusChanged"),
    ).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------- CLI */

const roots: string[] = [];
const cliClock = createFixedClock("2026-09-20T10:00:00.000Z");

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
  const cwd = await mkdtemp(join(tmpdir(), "ai-cli-verdict-"));
  roots.push(cwd);
  const env: CliEnv = {
    cwd,
    clock: cliClock,
    runtimeVersion: "v24.21.0",
    platform: "test/test",
  };
  const { code } = await cli(["init"], env);
  expect(code).toBe(0);
  return env;
}

/** The recorded event log, so "nothing was written" can be asserted rather than assumed. */
async function eventLog(cwd: string): Promise<string> {
  const directory = join(cwd, ".ai", "runtime", "events");
  const names = await readdir(directory);
  const files = await Promise.all(
    names.map(async (name) => readFile(join(directory, name), "utf8")),
  );
  return files.join("\n");
}

async function criterionTask(env: CliEnv): Promise<string> {
  const { code, cap } = await cli(
    [
      "task",
      "create",
      "--title",
      "Decide the criteria",
      "--description",
      "Establish two criteria, one of them as a person.",
      "--acceptance",
      "The bound suite passes",
      "--acceptance",
      "The design was reviewed",
      "--json",
    ],
    env,
  );
  expect(code, cap.errText()).toBe(0);
  return cap.outJson<{ task: { id: string } }>().task.id;
}

describe("ai task verdict: the production path", () => {
  it("records met, not-met and waived as a human verdict", async () => {
    const env = await initialized();
    const taskId = await criterionTask(env);

    const met = await cli(
      [
        "task",
        "verdict",
        taskId,
        "--criterion",
        "AC-2",
        "--status",
        "met",
        "--by",
        "alice",
      ],
      env,
    );
    expect(met.code, met.cap.errText()).toBe(0);
    expect(met.cap.outText()).toContain('Recorded "met" for AC-2');
    expect(met.cap.outText()).toContain("[met] AC-2 The design was reviewed");
    expect(met.cap.outText()).toContain("(by alice)");

    const notMet = await cli(
      [
        "task",
        "verdict",
        taskId,
        "--criterion",
        "AC-1",
        "--status",
        "not-met",
        "--by",
        "bob",
      ],
      env,
    );
    expect(notMet.code, notMet.cap.errText()).toBe(0);
    expect(notMet.cap.outText()).toContain(
      "[not-met] AC-1 The bound suite passes",
    );
    expect(notMet.cap.outText()).toContain("(by bob)");

    const waived = await cli(
      [
        "task",
        "verdict",
        taskId,
        "--criterion",
        "AC-1",
        "--status",
        "waived",
        "--by",
        "bob",
        "--json",
      ],
      env,
    );
    expect(waived.code, waived.cap.errText()).toBe(0);
    const recorded = waived.cap.outJson<{
      readonly version: number;
      readonly task: {
        readonly status: string;
        readonly acceptanceCriteria: readonly {
          readonly id: string;
          readonly status: string;
          readonly verdictBy?: string;
        }[];
      };
    }>();
    expect(recorded.task.acceptanceCriteria[0]).toMatchObject({
      id: "AC-1",
      status: "waived",
      verdictBy: "bob",
    });
    // A verdict is not a lifecycle event.
    expect(recorded.task.status).toBe("created");

    const status = await cli(["task", "status", taskId], env);
    expect(status.code).toBe(0);
    expect(status.cap.outText()).toContain("acceptance 2/2 met");
    expect(status.cap.outText()).toContain(
      "[waived] AC-1 The bound suite passes  (by bob)",
    );
    expect(status.cap.outText()).toContain(
      "[met] AC-2 The design was reviewed  (by alice)",
    );
  });

  it("writes an AcceptanceVerdictRecorded event naming the human", async () => {
    const env = await initialized();
    const taskId = await criterionTask(env);
    await cli(
      [
        "task",
        "verdict",
        taskId,
        "--criterion",
        "AC-1",
        "--status",
        "waived",
        "--by",
        "alice",
      ],
      env,
    );

    const log = await eventLog(env.cwd);
    const line = log
      .split("\n")
      .find((entry) => entry.includes("AcceptanceVerdictRecorded"));
    expect(line).toBeDefined();
    const event = JSON.parse(line!) as {
      readonly type: string;
      readonly actor: { readonly type: string; readonly id: string };
      readonly taskId: string;
      readonly payload: Record<string, unknown>;
    };
    expect(event.actor).toEqual({ type: "human", id: "alice" });
    expect(event.taskId).toBe(taskId);
    expect(event.payload).toMatchObject({
      criterionId: "AC-1",
      from: "pending",
      to: "waived",
      verdictBy: "alice",
    });
  });

  it("records each verdict as a transition, so the history is replayable", async () => {
    const env = await initialized();
    const taskId = await criterionTask(env);
    for (const status of ["met", "not-met", "waived"]) {
      const { code, cap } = await cli(
        [
          "task",
          "verdict",
          taskId,
          "--criterion",
          "AC-1",
          "--status",
          status,
          "--by",
          "alice",
        ],
        env,
      );
      expect(code, cap.errText()).toBe(0);
    }

    const transitions = (await eventLog(env.cwd))
      .split("\n")
      .filter((entry) => entry.includes("AcceptanceVerdictRecorded"))
      .map(
        (entry) =>
          (JSON.parse(entry) as { payload: { from: string; to: string } })
            .payload,
      );
    expect(
      transitions.map((payload) => `${payload.from}->${payload.to}`),
    ).toEqual(["pending->met", "met->not-met", "not-met->waived"]);
  });

  it("refuses a status that is not a verdict, and a verdict with nobody behind it", async () => {
    const env = await initialized();
    const taskId = await criterionTask(env);

    const pending = await cli(
      [
        "task",
        "verdict",
        taskId,
        "--criterion",
        "AC-1",
        "--status",
        "pending",
        "--by",
        "alice",
      ],
      env,
    );
    expect(pending.code).not.toBe(0);
    expect(pending.cap.errText()).toContain(
      "must be one of: met, not-met, waived",
    );

    const anonymous = await cli(
      ["task", "verdict", taskId, "--criterion", "AC-1", "--status", "met"],
      env,
    );
    expect(anonymous.code).not.toBe(0);
    expect(anonymous.cap.errText()).toContain("--by");

    const unknown = await cli(
      [
        "task",
        "verdict",
        taskId,
        "--criterion",
        "AC-9",
        "--status",
        "met",
        "--by",
        "alice",
      ],
      env,
    );
    expect(unknown.code).not.toBe(0);
    expect(unknown.cap.errText()).toContain("unknown acceptance criterion");

    // Nothing was recorded by any of the three refusals.
    expect(await eventLog(env.cwd)).not.toContain("AcceptanceVerdictRecorded");
  });

  it("records nothing on a dry run", async () => {
    const env = await initialized();
    const taskId = await criterionTask(env);
    const before = await cli(["task", "status", taskId, "--json"], env);
    const versionBefore = before.cap.outJson<{ version: number }>().version;

    const dry = await cli(
      [
        "task",
        "verdict",
        taskId,
        "--criterion",
        "AC-1",
        "--status",
        "met",
        "--by",
        "alice",
        "--dry-run",
      ],
      env,
    );
    expect(dry.code, dry.cap.errText()).toBe(0);
    expect(dry.cap.outText()).toContain('Dry run: would record "met" for AC-1');
    expect(dry.cap.outText()).toContain("No event was written");

    const after = await cli(["task", "status", taskId, "--json"], env);
    expect(after.cap.outJson<{ version: number }>().version).toBe(
      versionBefore,
    );
    expect(await eventLog(env.cwd)).not.toContain("AcceptanceVerdictRecorded");
  });

  it("decides a criterion after a run, and still leaves closing to the human", async () => {
    const env = await initialized();
    const taskId = await criterionTask(env);

    // A run that established nothing (no criterion is bound to a suite) still ends in
    // `review` — the state that already means "a human owns this".
    const run = await cli(["task", "run", taskId], env);
    expect(run.code, run.cap.errText()).toBe(0);
    expect(run.cap.outText()).toContain("review");

    for (const [id, status] of [
      ["AC-1", "met"],
      ["AC-2", "waived"],
    ] as const) {
      const { code, cap } = await cli(
        [
          "task",
          "verdict",
          taskId,
          "--criterion",
          id,
          "--status",
          status,
          "--by",
          "alice",
        ],
        env,
      );
      expect(code, cap.errText()).toBe(0);
    }

    const closed = await cli(
      ["task", "complete", taskId, "--reason", "reviewed"],
      env,
    );
    expect(closed.code, closed.cap.errText()).toBe(0);
    expect(closed.cap.outText()).toContain("status     completed");
    expect(closed.cap.outText()).toContain("acceptance 2/2 met");
  });

  it("refuses a verdict on a closed task", async () => {
    const env = await initialized();
    const taskId = await criterionTask(env);
    const run = await cli(["task", "run", taskId], env);
    expect(run.code, run.cap.errText()).toBe(0);
    const closed = await cli(["task", "complete", taskId], env);
    expect(closed.code, closed.cap.errText()).toBe(0);

    const late = await cli(
      [
        "task",
        "verdict",
        taskId,
        "--criterion",
        "AC-1",
        "--status",
        "met",
        "--by",
        "alice",
      ],
      env,
    );
    expect(late.code).not.toBe(0);
    expect(late.cap.errText()).toContain("terminal");
  });
});

describe("a human verdict leaves completion semantics alone", () => {
  it("counts a waived criterion as established evidence for the completion question", async () => {
    const decision = completionProvider({
      outcome: "selected",
      optionId: "incomplete",
      reasonCode: "criteria-unclear",
    });
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 1, 0),
      decisionProvider: decision.provider,
    });
    const stored = await decideTask(subject, [
      {
        statement: "The bound suite passes",
        verifiedBy: { suite: "bound-suite" },
      },
      "A criterion only a person can judge",
    ]);
    const decided = await subject.runtime.tasks.recordAcceptanceVerdict(
      stored,
      {
        criterionId: "AC-2",
        status: "waived",
        verdictBy: "alice",
      },
    );

    const result = await subject.runtime.runTask.run(decided);
    expect(result.outcome).toBe("awaiting-review");

    // AC-1 is established by the suite and AC-2 by the human; the completion question is
    // told how much is established, exactly as before, and the assertion is unchanged.
    const completion = decision.asked.find(
      (request) => request.kind === "completion",
    );
    expect(completion?.context).toContain("criteria:2/2");
    expect(completion?.context).toContain("criteria-pending:0");
    expect(completion?.context).toContain("evidence:fully-satisfied");
    // The criterion the human decided carries human provenance, not evidence refs.
    expect(result.task.acceptanceCriteria[1]).toMatchObject({
      status: "waived",
      verdictBy: "alice",
    });
    expect(result.task.acceptanceCriteria[1]?.evidence).toBeUndefined();
  });
});

describe("human verdicts do not leak across workspaces", () => {
  it("records against the task's own scope", async () => {
    const project = await createTestProject();
    try {
      const stored = await project.runtime.tasks.create(
        {
          title: "Scoped verdict",
          description:
            "A verdict is written to the workspace holding the task.",
          acceptanceCriteria: ["A criterion"],
        },
        {
          project: project.runtime.project,
          workspace: project.runtime.workspace,
        },
      );
      const decided = await project.runtime.tasks.recordAcceptanceVerdict(
        stored,
        { criterionId: "AC-1", status: "met", verdictBy: "alice" },
      );
      expect(decided.task.acceptanceCriteria[0]?.verdictBy).toBe("alice");
    } finally {
      await project.cleanup();
    }
  });
});

describe("acceptance verdict: an unbound criterion is still never inferred", () => {
  it("keeps a bare criterion pending after a passing run", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("some-suite", 5, 0),
    });
    const stored = await decideTask(subject, ["A criterion nothing verifies"]);
    const result = await subject.runtime.runTask.run(stored);
    expect(result.outcome).toBe("awaiting-review");
    expect(result.task.acceptanceCriteria[0]).toMatchObject({
      status: "pending",
    });
    expect(result.task.acceptanceCriteria[0]?.evidence).toBeUndefined();
    expect(measuredAcceptanceCriteriaMet(result.task)).toBeUndefined();
  });
});
