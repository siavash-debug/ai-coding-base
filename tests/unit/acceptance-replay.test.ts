import { afterEach, describe, expect, it } from "vitest";

import { replayAcceptance } from "../../src/application/acceptance-replay.js";
import type { TaskId } from "../../src/core/ids.js";
import { sessionId, taskId } from "../../src/core/ids.js";
import type { DomainEvent } from "../../src/observability/events.js";
import type { AgentRunner } from "../../src/ports/agent-runner.js";
import {
  assessAcceptanceCriteria,
  markAcceptanceCriterion,
  measuredAcceptanceCriteriaMet,
  type CreateTaskInput,
  type Task,
} from "../../src/tasks/task.js";
import {
  acceptanceAssessed,
  acceptanceVerdictRecorded,
  taskCreated,
  testCompleted,
  type EventContext,
} from "../support/events.js";
import { createHarness } from "../support/harness.js";
import {
  createEnforcementFixture,
  readWritePolicy,
  type EnforcementFixture,
} from "../support/policy.js";

/**
 * The acceptance replay: can the persisted record be rebuilt from its own log?
 *
 * The properties under test are the ones an auditor needs. A record the platform wrote
 * replays cleanly; a record that disagrees with the log is reported with the criterion
 * named and is never repaired; the fold reproduces the domain's own rules — a machine
 * assessment establishes a `pending`, bound criterion, a person's verdict replaces it
 * and keeps the binding, and neither authority can imitate the other — rather than
 * inventing a second interpretation of them.
 */

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

/** One bound criterion on a real project/workspace/task, plus the event context. */
function bound(
  criteria: CreateTaskInput["acceptanceCriteria"] = [
    { statement: "The bound suite passes", verifiedBy: { suite: "unit" } },
  ],
): { readonly task: Task; readonly ctx: EventContext } {
  const harness = createHarness({ task: { acceptanceCriteria: criteria } });
  return {
    task: harness.task,
    ctx: {
      clock: harness.clock,
      projectId: harness.project.id,
      workspaceId: harness.workspace.id,
    },
  };
}

function scopeOf(subject: EnforcementFixture) {
  return {
    projectId: subject.runtime.project.id,
    workspaceId: subject.runtime.workspace.id,
  };
}

/** A runner that reports exactly one verification suite, and nothing else. */
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

describe("replay: a record the platform wrote replays cleanly", () => {
  it("replays a machine assessment onto the record it produced", () => {
    const { task, ctx } = bound();
    const assessed = assessAcceptanceCriteria(
      task,
      [{ suite: "unit", passed: 3, failed: 0 }],
      ctx.clock,
    ).task;
    const events = [
      acceptanceAssessed(ctx, 2, task.id, {
        assessed: 1,
        met: 1,
        notMet: 0,
        criteria: ["AC-1:met:unit"],
      }),
    ];

    // The evidence the replay had to accept is the real one, counts and all.
    expect(assessed.acceptanceCriteria[0]?.evidence).toEqual([
      "suite:unit",
      "passed:3",
      "failed:0",
    ]);
    const replay = replayAcceptance(assessed, events);
    expect(replay.findings).toEqual([]);
    expect(replay).toMatchObject({ criteria: 1, assessments: 1, verdicts: 0 });
  });

  it("replays a failed assessment onto the record it produced", () => {
    const { task, ctx } = bound();
    const assessed = assessAcceptanceCriteria(
      task,
      [{ suite: "unit", passed: 2, failed: 1 }],
      ctx.clock,
    ).task;
    const events = [
      acceptanceAssessed(ctx, 2, task.id, {
        assessed: 1,
        met: 0,
        notMet: 1,
        criteria: ["AC-1:not-met:unit"],
      }),
    ];

    expect(assessed.acceptanceCriteria[0]?.status).toBe("not-met");
    expect(replayAcceptance(assessed, events).findings).toEqual([]);
  });

  it("replays a named-check assessment onto the record it produced", () => {
    const { task, ctx } = bound([
      {
        statement: "The named check passes",
        verifiedBy: { suite: "verification-command", check: "check-a" },
      },
    ]);
    const assessed = assessAcceptanceCriteria(
      task,
      [
        {
          suite: "verification-command",
          check: "check-a",
          passed: 1,
          failed: 0,
        },
      ],
      ctx.clock,
    ).task;
    const events = [
      acceptanceAssessed(ctx, 2, task.id, {
        assessed: 1,
        met: 1,
        notMet: 0,
        criteria: ["AC-1:met:verification-command:check-a"],
      }),
    ];

    expect(assessed.acceptanceCriteria[0]?.evidence).toEqual([
      "suite:verification-command",
      "check:check-a",
      "result:passed",
      "passed:1",
      "failed:0",
    ]);
    expect(replayAcceptance(assessed, events).findings).toEqual([]);
  });

  it('replays an explicit human "met" verdict onto the record it produced', () => {
    const { task, ctx } = bound();
    const decided = markAcceptanceCriterion(
      task,
      "AC-1",
      "met",
      ctx.clock,
      "alice",
    );
    const events = [
      acceptanceVerdictRecorded(ctx, 2, task.id, {
        criterionId: "AC-1",
        from: "pending",
        to: "met",
        verdictBy: "alice",
      }),
    ];

    const replay = replayAcceptance(decided, events);
    expect(replay.findings).toEqual([]);
    expect(replay).toMatchObject({ assessments: 0, verdicts: 1 });
  });

  it('replays an explicit human "not-met" verdict onto the record it produced', () => {
    const { task, ctx } = bound();
    const decided = markAcceptanceCriterion(
      task,
      "AC-1",
      "not-met",
      ctx.clock,
      "bob",
    );
    const events = [
      acceptanceVerdictRecorded(ctx, 2, task.id, {
        criterionId: "AC-1",
        from: "pending",
        to: "not-met",
        verdictBy: "bob",
      }),
    ];

    const replay = replayAcceptance(decided, events);
    expect(replay.findings).toEqual([]);
    expect(decided.acceptanceCriteria[0]?.status).toBe("not-met");
  });

  it('replays an explicit human "waived" verdict onto the record it produced', () => {
    const { task, ctx } = bound();
    const decided = markAcceptanceCriterion(
      task,
      "AC-1",
      "waived",
      ctx.clock,
      "carol",
    );
    const events = [
      acceptanceVerdictRecorded(ctx, 2, task.id, {
        criterionId: "AC-1",
        from: "pending",
        to: "waived",
        verdictBy: "carol",
      }),
    ];

    // A waiver keeps the author's binding and carries no machine evidence.
    expect(decided.acceptanceCriteria[0]).toMatchObject({
      status: "waived",
      verdictBy: "carol",
      verifiedBy: { suite: "unit" },
    });
    expect(decided.acceptanceCriteria[0]?.evidence).toBeUndefined();
    expect(replayAcceptance(decided, events).findings).toEqual([]);
    expect(measuredAcceptanceCriteriaMet(decided)).toBe(1);
  });

  it("replays a verdict that replaced a machine status without the machine's evidence", () => {
    const { task, ctx } = bound();
    const assessed = assessAcceptanceCriteria(
      task,
      [{ suite: "unit", passed: 3, failed: 0 }],
      ctx.clock,
    ).task;
    const overruled = markAcceptanceCriterion(
      assessed,
      "AC-1",
      "waived",
      ctx.clock,
      "alice",
    );
    const events = [
      acceptanceAssessed(ctx, 2, task.id, {
        assessed: 1,
        met: 1,
        notMet: 0,
        criteria: ["AC-1:met:unit"],
      }),
      acceptanceVerdictRecorded(ctx, 3, task.id, {
        criterionId: "AC-1",
        from: "met",
        to: "waived",
        verdictBy: "alice",
      }),
    ];

    expect(overruled.acceptanceCriteria[0]).toMatchObject({
      status: "waived",
      verdictBy: "alice",
      verifiedBy: { suite: "unit" },
    });
    expect(overruled.acceptanceCriteria[0]?.evidence).toBeUndefined();
    expect(replayAcceptance(overruled, events).findings).toEqual([]);

    // The reverse — a record that kept the machine's evidence beside the verdict — is
    // reported, because the verdict replaced it.
    const stale: Task = {
      ...overruled,
      acceptanceCriteria: overruled.acceptanceCriteria.map((criterion) => ({
        ...criterion,
        evidence: ["suite:unit", "passed:3", "failed:0"],
      })),
    };
    expect(replayAcceptance(stale, events).findings.join("; ")).toContain(
      "the record carries machine evidence, and the log records no assessment that produced it",
    );
  });

  it("ignores a later machine assessment of a criterion a person established", () => {
    const { task, ctx } = bound();
    const decided = markAcceptanceCriterion(
      task,
      "AC-1",
      "met",
      ctx.clock,
      "alice",
    );
    const events = [
      acceptanceVerdictRecorded(ctx, 2, task.id, {
        criterionId: "AC-1",
        from: "pending",
        to: "met",
        verdictBy: "alice",
      }),
      // The domain assesses only `pending` criteria, so this cannot be produced; it is
      // reported, and the established status stands — exactly what the domain does.
      acceptanceAssessed(ctx, 3, task.id, {
        assessed: 1,
        met: 0,
        notMet: 1,
        criteria: ["AC-1:not-met:unit"],
      }),
    ];

    const replay = replayAcceptance(decided, events);
    expect(replay).toMatchObject({ assessments: 1, verdicts: 1 });
    expect(replay.findings).toHaveLength(1);
    expect(replay.findings[0]).toContain(
      "an assessment never overrules an established criterion",
    );
    expect(replay.findings.join("; ")).not.toContain("the log's history says");
  });

  it("never lets a verification event establish a criterion", () => {
    const { task, ctx } = bound();

    // A suite passed and was recorded — and it is not acceptance evidence, because the
    // event carries no criterion for it to be evidence of.
    const events = [
      testCompleted(ctx, 2, task.id, sessionId("ses-1"), "unit", 5, 0),
    ];
    expect(replayAcceptance(task, events)).toMatchObject({
      assessments: 0,
      verdicts: 0,
      findings: [],
    });
    expect(task.acceptanceCriteria[0]?.status).toBe("pending");
  });
});

describe("replay: a record that disagrees with the log is named, never repaired", () => {
  it("reports a machine status the record never took", () => {
    const { task, ctx } = bound();
    const events = [
      acceptanceAssessed(ctx, 2, task.id, {
        assessed: 1,
        met: 0,
        notMet: 1,
        criteria: ["AC-1:not-met:unit"],
      }),
    ];

    const findings = replayAcceptance(task, events).findings.join("; ");
    expect(findings).toContain(
      'the record says "pending", the log\'s history says "not-met"',
    );
    expect(findings).toContain(
      'carries no evidence for the "not-met" assessment the log records',
    );
  });

  it("reports a human verdict the log does not record", () => {
    const { task, ctx } = bound();
    const decided = markAcceptanceCriterion(
      task,
      "AC-1",
      "met",
      ctx.clock,
      "alice",
    );

    const findings = replayAcceptance(decided, []).findings.join("; ");
    expect(findings).toContain(
      'the record says "met", the log\'s history says "pending"',
    );
    expect(findings).toContain(
      'the record names "alice" as its author, and the log records no verdict',
    );
  });

  it("reports evidence the log's history does not support", () => {
    const { task, ctx } = bound();
    const assessed = assessAcceptanceCriteria(
      task,
      [{ suite: "unit", passed: 3, failed: 0 }],
      ctx.clock,
    ).task;
    const events = [
      acceptanceAssessed(ctx, 2, task.id, {
        assessed: 1,
        met: 1,
        notMet: 0,
        criteria: ["AC-1:met:unit"],
      }),
    ];

    const tampered: Task = {
      ...assessed,
      acceptanceCriteria: assessed.acceptanceCriteria.map((criterion) => ({
        ...criterion,
        evidence: ["suite:other", "passed:3", "failed:0"],
      })),
    };
    expect(replayAcceptance(tampered, events).findings.join("; ")).toContain(
      "the record's evidence does not name the evidence the log records (expected suite:unit)",
    );
  });

  it("reports a status its own evidence denies", () => {
    const { task, ctx } = bound();
    const assessed = assessAcceptanceCriteria(
      task,
      [{ suite: "unit", passed: 0, failed: 2 }],
      ctx.clock,
    ).task;
    const events = [
      acceptanceAssessed(ctx, 2, task.id, {
        assessed: 1,
        met: 0,
        notMet: 1,
        criteria: ["AC-1:not-met:unit"],
      }),
    ];

    const tampered: Task = {
      ...assessed,
      acceptanceCriteria: assessed.acceptanceCriteria.map((criterion) => ({
        ...criterion,
        status: "met",
        evidence: ["suite:unit", "passed:0", "failed:2"],
      })),
    };
    const findings = replayAcceptance(tampered, events).findings.join("; ");
    expect(findings).toContain(
      'the record says "met", the log\'s history says "not-met"',
    );
    expect(findings).toContain(
      'the record says "met", but its evidence reports 2 failing check(s)',
    );
  });

  it("reports evidence for a criterion the log never assessed", () => {
    const { task } = bound();
    const tampered: Task = {
      ...task,
      acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({
        ...criterion,
        evidence: ["suite:unit", "passed:1", "failed:0"],
      })),
    };

    const findings = replayAcceptance(tampered, []).findings.join("; ");
    expect(findings).toContain(
      "the record carries machine evidence, and the log records no assessment that produced it",
    );
  });
});

describe("replay: corrupt acceptance events are reported, deterministically", () => {
  it("reports a reference whose status an assessment could not establish", () => {
    const { task, ctx } = bound();
    const events = [
      acceptanceAssessed(ctx, 2, task.id, {
        assessed: 1,
        met: 0,
        notMet: 0,
        criteria: ["AC-1:maybe:unit"],
      }),
    ];

    expect(replayAcceptance(task, events).findings).toEqual([
      `task "${task.id}": AcceptanceAssessed reference "AC-1:maybe:unit" records the status "maybe", but an assessment establishes only "met" or "not-met"`,
    ]);
  });

  it("reports a reference that names no suite", () => {
    const { task, ctx } = bound();
    const events = [
      acceptanceAssessed(ctx, 2, task.id, {
        assessed: 1,
        met: 0,
        notMet: 0,
        criteria: ["AC-1:met"],
      }),
    ];

    expect(replayAcceptance(task, events).findings.join("; ")).toContain(
      '"AC-1:met" is not <criterion-id>:<status>:<suite>[:<check>]',
    );
  });

  it("reports an assessment whose own counts disagree with its list", () => {
    const { task, ctx } = bound();
    const events = [
      acceptanceAssessed(ctx, 2, task.id, {
        assessed: 2,
        met: 1,
        notMet: 0,
        criteria: ["AC-1:met:unit"],
      }),
    ];

    expect(replayAcceptance(task, events).findings.join("; ")).toContain(
      "reports 2 assessment(s) but lists 1",
    );
  });

  it("reports an assessment that names a criterion the task does not declare", () => {
    const { task, ctx } = bound();
    const events = [
      acceptanceAssessed(ctx, 2, task.id, {
        assessed: 1,
        met: 1,
        notMet: 0,
        criteria: ["AC-9:met:unit"],
      }),
    ];

    expect(replayAcceptance(task, events).findings.join("; ")).toContain(
      'AcceptanceAssessed names a criterion the task does not declare ("AC-9")',
    );
  });

  it("reports a verdict whose `from` the log's own history denies", () => {
    const { task, ctx } = bound();
    const decided = markAcceptanceCriterion(
      task,
      "AC-1",
      "met",
      ctx.clock,
      "alice",
    );
    const events = [
      acceptanceVerdictRecorded(ctx, 2, task.id, {
        criterionId: "AC-1",
        from: "not-met",
        to: "met",
        verdictBy: "alice",
      }),
    ];

    const findings = replayAcceptance(decided, events).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('the verdict moved from "not-met"');
  });

  it("reports a verdict that names a criterion the task does not declare", () => {
    const { task, ctx } = bound();
    const events = [
      acceptanceVerdictRecorded(ctx, 2, task.id, {
        criterionId: "AC-9",
        from: "pending",
        to: "met",
        verdictBy: "alice",
      }),
    ];

    expect(replayAcceptance(task, events).findings.join("; ")).toContain(
      'AcceptanceVerdictRecorded names a criterion the task does not declare ("AC-9")',
    );
  });
});

describe("replay: it reads, it does not write", () => {
  it("mutates neither the task nor the events", () => {
    const { task, ctx } = bound();
    const assessed = assessAcceptanceCriteria(
      task,
      [{ suite: "unit", passed: 3, failed: 0 }],
      ctx.clock,
    ).task;
    const events = [
      acceptanceAssessed(ctx, 2, task.id, {
        assessed: 1,
        met: 1,
        notMet: 0,
        criteria: ["AC-1:met:unit"],
      }),
    ];
    const before = JSON.stringify(assessed);
    const eventsBefore = JSON.stringify(events);

    expect(replayAcceptance(assessed, events).findings).toEqual([]);
    expect(JSON.stringify(assessed)).toBe(before);
    expect(JSON.stringify(events)).toBe(eventsBefore);
    expect(assessed.acceptanceCriteria[0]?.status).toBe("met");
  });

  it("is unaffected by events for another task, or for no task at all", () => {
    const { task, ctx } = bound();
    const assessed = assessAcceptanceCriteria(
      task,
      [{ suite: "unit", passed: 3, failed: 0 }],
      ctx.clock,
    ).task;
    const own = [
      acceptanceAssessed(ctx, 5, task.id, {
        assessed: 1,
        met: 1,
        notMet: 0,
        criteria: ["AC-1:met:unit"],
      }),
    ];
    const other: TaskId = taskId("tsk-2");
    const noise: DomainEvent[] = [
      taskCreated(ctx, 1, other, "Another task"),
      acceptanceAssessed(ctx, 2, other, {
        assessed: 1,
        met: 1,
        notMet: 0,
        criteria: ["AC-1:met:unit"],
      }),
      acceptanceVerdictRecorded(ctx, 3, other, {
        criterionId: "AC-1",
        from: "met",
        to: "waived",
        verdictBy: "bob",
      }),
    ];

    expect(replayAcceptance(assessed, [...noise, ...own])).toEqual(
      replayAcceptance(assessed, own),
    );
    expect(replayAcceptance(assessed, [...noise, ...own]).findings).toEqual([]);
  });
});

describe("replay: the production path", () => {
  it("replays a real run's acceptance record without findings", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 3, 0),
    });
    const stored = await subject.runtime.tasks.create(
      {
        title: "Assess acceptance evidence",
        description: "Run the bound suite and record what it decided.",
        acceptanceCriteria: [
          {
            statement: "The bound suite passes",
            verifiedBy: { suite: "bound-suite" },
          },
        ],
      },
      {
        project: subject.runtime.project,
        workspace: subject.runtime.workspace,
      },
    );

    const result = await subject.runtime.runTask.run(stored);
    expect(result.outcome).toBe("awaiting-review");

    const events = await subject.runtime.store.readByTask(
      scopeOf(subject),
      stored.task.id,
    );
    const replay = replayAcceptance(result.task, events);
    expect(replay.findings).toEqual([]);
    expect(replay).toMatchObject({ criteria: 1, assessments: 1, verdicts: 0 });
  });

  it("replays a run plus a human verdict, and notices a record left behind", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 2, 0),
    });
    const stored = await subject.runtime.tasks.create(
      {
        title: "Assess and decide",
        description: "A run establishes one criterion, a person waives it.",
        acceptanceCriteria: [
          {
            statement: "The bound suite passes",
            verifiedBy: { suite: "bound-suite" },
          },
          "The design was reviewed",
        ],
      },
      {
        project: subject.runtime.project,
        workspace: subject.runtime.workspace,
      },
    );

    const run = await subject.runtime.runTask.run(stored);
    expect(run.outcome).toBe("awaiting-review");
    expect(run.task.acceptanceCriteria[0]?.status).toBe("met");

    const afterRun = await subject.runtime.tasks.load(
      scopeOf(subject),
      stored.task.id,
    );
    const decided = await subject.runtime.tasks.recordAcceptanceVerdict(
      afterRun,
      {
        criterionId: "AC-1",
        status: "waived",
        verdictBy: "alice",
      },
    );
    const events = await subject.runtime.store.readByTask(
      scopeOf(subject),
      stored.task.id,
    );

    // The record the platform wrote replays cleanly …
    expect(replayAcceptance(decided.task, events).findings).toEqual([]);
    // … and the record from before the verdict is reported as behind its own log.
    expect(replayAcceptance(run.task, events).findings.join("; ")).toContain(
      'the record says "met", the log\'s history says "waived"',
    );
  });

  it("replays a criterion a person established before a run that cannot decide it", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 4, 0),
    });
    const stored = await subject.runtime.tasks.create(
      {
        title: "Decide first, then run",
        description: "A human verdict must survive the run that follows it.",
        acceptanceCriteria: [
          {
            statement: "The bound suite passes",
            verifiedBy: { suite: "bound-suite" },
          },
        ],
      },
      {
        project: subject.runtime.project,
        workspace: subject.runtime.workspace,
      },
    );

    const decided = await subject.runtime.tasks.recordAcceptanceVerdict(
      stored,
      {
        criterionId: "AC-1",
        status: "waived",
        verdictBy: "carol",
      },
    );
    const run = await subject.runtime.runTask.run(decided);
    expect(run.outcome).toBe("awaiting-review");
    expect(run.task.acceptanceCriteria[0]).toMatchObject({
      status: "waived",
      verdictBy: "carol",
    });
    expect(run.task.acceptanceCriteria[0]?.evidence).toBeUndefined();

    const events = await subject.runtime.store.readByTask(
      scopeOf(subject),
      stored.task.id,
    );
    const replay = replayAcceptance(run.task, events);
    expect(replay.findings).toEqual([]);
    expect(replay).toMatchObject({ assessments: 0, verdicts: 1 });
  });
});
