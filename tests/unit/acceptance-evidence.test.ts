import { afterEach, describe, expect, it } from "vitest";

import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
} from "../../src/decisions/provider.js";
import { DECISION_KINDS } from "../../src/decisions/decision.js";
import type { AgentRunner } from "../../src/ports/agent-runner.js";
import type { TaskId } from "../../src/core/ids.js";
import {
  acceptanceSummary,
  measuredAcceptanceCriteriaMet,
} from "../../src/tasks/task.js";
import {
  readWritePolicy,
  createEnforcementFixture,
  type EnforcementFixture,
} from "../support/policy.js";

/**
 * Acceptance evidence on the production path.
 *
 * The truthfulness invariant under test: a passing verification command can only
 * establish a criterion when that criterion *explicitly named the suite* the command
 * reported. Everything else stays `pending` — never manufactured into `met` by a
 * passing test, a completed task, or an LLM verdict. These tests drive a *real* run
 * with a real boundary and a chosen runner, because the property is a property of the
 * wiring, not of a pure function.
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

/**
 * A runner that reports the exact test steps given, and nothing else. `check` is the
 * stable named-check identity the change-set runner reports for a declared check; the
 * `stepsRunner` here stands in for it so the assessment wiring can be driven exactly.
 */
function stepsRunner(
  steps: readonly {
    readonly suite: string;
    readonly check?: string;
    readonly passed: number;
    readonly failed: number;
  }[],
): AgentRunner {
  return {
    id: "fixture-steps-runner",
    kind: "simulated",
    async attempt() {
      return {
        steps: steps.map((step) => ({
          kind: "test" as const,
          suite: step.suite,
          ...(step.check === undefined ? {} : { check: step.check }),
          passed: step.passed,
          failed: step.failed,
          durationMs: 1,
        })),
      };
    },
  };
}

/** A decision layer that records every question and picks the first option. */
function recordingProvider(): {
  readonly provider: DecisionProvider;
  readonly asked: readonly DecisionRequest[];
} {
  const asked: DecisionRequest[] = [];
  return {
    asked,
    provider: {
      id: "recording-decisions",
      family: "rules",
      capabilities: () => ({
        kinds: DECISION_KINDS,
        deterministic: false,
        maxOptions: 8,
      }),
      async decide(request: DecisionRequest): Promise<DecisionResponse> {
        asked.push(request);
        const first = request.options[0];
        if (first === undefined) {
          return { outcome: "abstained", reason: "no options offered" };
        }
        return request.ranked === true
          ? {
              outcome: "selected",
              optionId: first.id,
              rankedOptionIds: request.options.map((option) => option.id),
            }
          : { outcome: "selected", optionId: first.id };
      },
    },
  };
}

async function createBoundTask(
  subject: EnforcementFixture,
  acceptanceCriteria: Parameters<
    typeof subject.runtime.tasks.create
  >[0]["acceptanceCriteria"],
) {
  return subject.runtime.tasks.create(
    {
      title: "Assess acceptance evidence",
      description:
        "Prove criteria are assessed only from bound execution evidence.",
      acceptanceCriteria,
    },
    { project: subject.runtime.project, workspace: subject.runtime.workspace },
  );
}

async function eventsOf(subject: EnforcementFixture, taskId: TaskId) {
  return subject.runtime.store.readByTask(scopeOf(subject), taskId);
}

describe("run: acceptance evidence is only ever bound evidence", () => {
  it("assesses a bound criterion as met from recorded verification", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 3, 0),
    });
    const stored = await createBoundTask(subject, [
      {
        statement: "The bound suite passes",
        verifiedBy: { suite: "bound-suite" },
      },
    ]);

    const result = await subject.runtime.runTask.run(stored);
    expect(result.outcome).toBe("awaiting-review");

    const criterion = result.task.acceptanceCriteria[0]!;
    expect(criterion.status).toBe("met");
    // Provenance: the automatic status names the suite and the exact counts.
    expect(criterion.evidence).toEqual([
      "suite:bound-suite",
      "passed:3",
      "failed:0",
    ]);

    const assessed = (await eventsOf(subject, stored.task.id)).find(
      (event) => event.type === "AcceptanceAssessed",
    );
    expect(assessed).toBeDefined();
    expect(assessed!.payload).toMatchObject({
      assessed: 1,
      met: 1,
      notMet: 0,
      criteria: ["AC-1:met:bound-suite"],
    });
  });

  it("leaves an unbound criterion pending however well verification passed", async () => {
    const decision = recordingProvider();
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 4, 0),
      decisionProvider: decision.provider,
    });
    const stored = await createBoundTask(subject, ["Add a friendly greeting"]);

    const result = await subject.runtime.runTask.run(stored);
    expect(result.outcome).toBe("awaiting-review");
    expect(result.task.acceptanceCriteria[0]!.status).toBe("pending");
    expect(measuredAcceptanceCriteriaMet(result.task)).toBeUndefined();

    // No assessment event: nothing was assessed, so nothing was recorded.
    const events = await eventsOf(subject, stored.task.id);
    expect(events.map((event) => event.type)).not.toContain(
      "AcceptanceAssessed",
    );

    // Completion is told the criterion is *unmeasured*, never that it is satisfied
    // and never that it is a failure.
    const completion = decision.asked.find(
      (request) => request.kind === "completion",
    );
    expect(completion?.context).toContain("criteria:unmeasured/1");
  });

  it("leaves a criterion bound to a different suite pending", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("ran-suite", 2, 0),
    });
    const stored = await createBoundTask(subject, [
      {
        statement: "Some other check",
        verifiedBy: { suite: "expected-suite" },
      },
    ]);

    const result = await subject.runtime.runTask.run(stored);
    expect(result.task.acceptanceCriteria[0]!.status).toBe("pending");
    expect(result.task.acceptanceCriteria[0]!.evidence).toBeUndefined();
  });

  it("assesses a bound criterion as not-met when the bound suite failed", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 1, 2),
    });
    const stored = await createBoundTask(subject, [
      {
        statement: "The bound suite passes",
        verifiedBy: { suite: "bound-suite" },
      },
    ]);

    const result = await subject.runtime.runTask.run(stored);
    // The verification failure ends the run, but the criterion's evidence-based
    // status is `not-met` — backed by the same recorded counts, not guessed.
    expect(result.task.acceptanceCriteria[0]!.status).toBe("not-met");
    expect(result.task.acceptanceCriteria[0]!.evidence).toEqual([
      "suite:bound-suite",
      "passed:1",
      "failed:2",
    ]);

    const assessed = (await eventsOf(subject, stored.task.id)).find(
      (event) => event.type === "AcceptanceAssessed",
    );
    expect(assessed!.payload).toMatchObject({ notMet: 1 });
  });

  it("carries the measured count to completion once a criterion is assessed", async () => {
    const decision = recordingProvider();
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 1, 0),
      decisionProvider: decision.provider,
    });
    const stored = await createBoundTask(subject, [
      {
        statement: "The bound suite passes",
        verifiedBy: { suite: "bound-suite" },
      },
    ]);

    await subject.runtime.runTask.run(stored);

    const completion = decision.asked.find(
      (request) => request.kind === "completion",
    );
    expect(completion?.context).toContain("criteria:1/1");
  });

  it("does not imply all criteria are assessed when only one is bound", async () => {
    const decision = recordingProvider();
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 1, 0),
      decisionProvider: decision.provider,
    });
    const stored = await createBoundTask(subject, [
      {
        statement: "The bound suite passes",
        verifiedBy: { suite: "bound-suite" },
      },
      "A human judgement call",
    ]);

    const result = await subject.runtime.runTask.run(stored);
    const summary = acceptanceSummary(result.task);
    expect(summary.met).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.allMet).toBe(false);
    expect(measuredAcceptanceCriteriaMet(result.task)).toBe(1);

    // One assessed, one still pending: completion sees the measured count, and the
    // unmeasured criterion is not reported as a failure.
    const completion = decision.asked.find(
      (request) => request.kind === "completion",
    );
    expect(completion?.context).toContain("criteria:1/2");
  });

  it("never overwrites a status a human already set", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: suiteRunner("bound-suite", 1, 0),
    });
    const stored = await createBoundTask(subject, [
      {
        statement: "The bound suite passes",
        verifiedBy: { suite: "bound-suite" },
      },
    ]);
    // A human waived the criterion before the run.
    const waived = {
      ...stored.task,
      acceptanceCriteria: [
        { ...stored.task.acceptanceCriteria[0]!, status: "waived" as const },
      ],
    };
    const version = await subject.runtime.repository.save(
      scopeOf(subject),
      waived,
      { expectedVersion: stored.version },
    );

    const result = await subject.runtime.runTask.run({ version, task: waived });
    expect(result.task.acceptanceCriteria[0]!.status).toBe("waived");
    expect(result.task.acceptanceCriteria[0]!.evidence).toBeUndefined();
  });
});

describe("run: criterion-specific (named-check) evidence", () => {
  it("assesses a criterion met from its own passing check, with a check join", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: stepsRunner([
        {
          suite: "verification-command",
          check: "check-a",
          passed: 1,
          failed: 0,
        },
      ]),
    });
    const stored = await createBoundTask(subject, [
      {
        statement: "check A passes",
        verifiedBy: { suite: "verification-command", check: "check-a" },
      },
    ]);

    const result = await subject.runtime.runTask.run(stored);
    expect(result.outcome).toBe("awaiting-review");
    const criterion = result.task.acceptanceCriteria[0]!;
    expect(criterion.status).toBe("met");
    // Provenance carries the stable suite and check identity, never a position.
    expect(criterion.evidence).toEqual([
      "suite:verification-command",
      "check:check-a",
      "result:passed",
      "passed:1",
      "failed:0",
    ]);

    const events = await eventsOf(subject, stored.task.id);
    const completed = events.find((event) => event.type === "TestCompleted");
    expect(completed!.payload).toMatchObject({
      suite: "verification-command",
      check: "check-a",
      passed: 1,
      failed: 0,
    });
    const assessed = events.find(
      (event) => event.type === "AcceptanceAssessed",
    );
    expect(assessed!.payload).toMatchObject({
      assessed: 1,
      met: 1,
      criteria: ["AC-1:met:verification-command:check-a"],
    });
  });

  it("assesses a criterion not-met when its own check failed", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: stepsRunner([
        {
          suite: "verification-command",
          check: "check-a",
          passed: 0,
          failed: 1,
        },
      ]),
    });
    const stored = await createBoundTask(subject, [
      {
        statement: "check A passes",
        verifiedBy: { suite: "verification-command", check: "check-a" },
      },
    ]);

    const result = await subject.runtime.runTask.run(stored);
    expect(result.outcome).toBe("verification-failed");
    expect(result.task.acceptanceCriteria[0]!.status).toBe("not-met");
  });

  it("does not let an unrelated failing check invalidate a passing criterion", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: stepsRunner([
        {
          suite: "verification-command",
          check: "check-a",
          passed: 1,
          failed: 0,
        },
        {
          suite: "verification-command",
          check: "check-b",
          passed: 0,
          failed: 1,
        },
        {
          suite: "verification-command",
          check: "check-unrelated",
          passed: 0,
          failed: 1,
        },
      ]),
    });
    const stored = await createBoundTask(subject, [
      {
        statement: "check A passes",
        verifiedBy: { suite: "verification-command", check: "check-a" },
      },
      {
        statement: "check B passes",
        verifiedBy: { suite: "verification-command", check: "check-b" },
      },
    ]);

    const result = await subject.runtime.runTask.run(stored);
    // AC-1 is met on its own passing check; the two failing siblings cannot touch it.
    expect(result.task.acceptanceCriteria[0]!.status).toBe("met");
    expect(result.task.acceptanceCriteria[1]!.status).toBe("not-met");
  });

  it("leaves a criterion pending when its named check never ran", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: stepsRunner([
        {
          suite: "verification-command",
          check: "check-b",
          passed: 1,
          failed: 0,
        },
      ]),
    });
    const stored = await createBoundTask(subject, [
      {
        statement: "check A passes",
        verifiedBy: { suite: "verification-command", check: "check-a" },
      },
    ]);

    const result = await subject.runtime.runTask.run(stored);
    expect(result.task.acceptanceCriteria[0]!.status).toBe("pending");
    expect(result.task.acceptanceCriteria[0]!.evidence).toBeUndefined();
    expect(measuredAcceptanceCriteriaMet(result.task)).toBeUndefined();

    const events = await eventsOf(subject, stored.task.id);
    expect(events.map((event) => event.type)).not.toContain(
      "AcceptanceAssessed",
    );
  });

  it("keeps a suite-only binding on the whole-suite verdict", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: stepsRunner([
        { suite: "verification-command", passed: 2, failed: 0 },
      ]),
    });
    const stored = await createBoundTask(subject, [
      {
        statement: "the whole suite passes",
        verifiedBy: { suite: "verification-command" },
      },
    ]);

    const result = await subject.runtime.runTask.run(stored);
    expect(result.task.acceptanceCriteria[0]!.status).toBe("met");
    expect(result.task.acceptanceCriteria[0]!.evidence).toEqual([
      "suite:verification-command",
      "passed:2",
      "failed:0",
    ]);
  });

  it("never overwrites a waiver even when its bound check fails", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: stepsRunner([
        {
          suite: "verification-command",
          check: "check-a",
          passed: 0,
          failed: 1,
        },
      ]),
    });
    const stored = await createBoundTask(subject, [
      {
        statement: "check A passes",
        verifiedBy: { suite: "verification-command", check: "check-a" },
      },
    ]);
    const waived = {
      ...stored.task,
      acceptanceCriteria: [
        { ...stored.task.acceptanceCriteria[0]!, status: "waived" as const },
      ],
    };
    const version = await subject.runtime.repository.save(
      scopeOf(subject),
      waived,
      { expectedVersion: stored.version },
    );

    const result = await subject.runtime.runTask.run({ version, task: waived });
    expect(result.task.acceptanceCriteria[0]!.status).toBe("waived");
    expect(result.task.acceptanceCriteria[0]!.evidence).toBeUndefined();
  });

  it("carries the measured summary to completion for a passing named check", async () => {
    const decision = recordingProvider();
    const subject = await fixture({
      policy: readWritePolicy(),
      runner: stepsRunner([
        {
          suite: "verification-command",
          check: "check-a",
          passed: 1,
          failed: 0,
        },
      ]),
      decisionProvider: decision.provider,
    });
    const stored = await createBoundTask(subject, [
      {
        statement: "check A passes",
        verifiedBy: { suite: "verification-command", check: "check-a" },
      },
    ]);

    await subject.runtime.runTask.run(stored);

    const completion = decision.asked.find(
      (request) => request.kind === "completion",
    );
    expect(completion?.context).toContain("criteria:1/1");
  });
});
