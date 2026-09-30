import { afterEach, describe, expect, it } from "vitest";

import { createRunTask } from "../../src/application/run-task.js";
import type { RunTask } from "../../src/application/run-task.js";
import { createManualClock } from "../../src/core/clock.js";
import { hasDomainErrorCode } from "../../src/core/errors.js";
import type { Policy } from "../../src/decisions/policy.js";
import type { StoredTask } from "../../src/ports/task-repository.js";
import {
  type TestProject,
  createTestProject,
  createTickingClock,
} from "../support/project.js";
import { createFakeProvider, providerFailure } from "../support/llm.js";

/**
 * The approval lifecycle, end to end.
 *
 * Phase C could ask for approval and suspend; Phase D must be able to *act* on an
 * answer. These tests drive the whole sequence through the real application layer
 * and the real event log — ask, grant, consume, resume, finish — plus every way it
 * must refuse: an expired grant, a grant that is too narrow, a task that is not
 * actually suspended, and a provider that fails after the human said yes.
 */
const projects: TestProject[] = [];

async function project(options?: {
  readonly includeRetry?: boolean;
}): Promise<TestProject> {
  const created = await createTestProject({
    clock: createTickingClock(),
    ...(options?.includeRetry === undefined
      ? {}
      : { includeRetry: options.includeRetry }),
  });
  projects.push(created);
  return created;
}

async function createTask(
  subject: TestProject,
  input: { readonly riskLevel?: "low" | "medium" | "high" | "critical" } = {},
): Promise<StoredTask> {
  return subject.runtime.tasks.create(
    {
      title: "Rotate the production signing key",
      description: "Replace the key used to sign release artifacts.",
      acceptanceCriteria: ["The new key signs a release"],
      ...(input.riskLevel === undefined ? {} : { riskLevel: input.riskLevel }),
    },
    { project: subject.runtime.project, workspace: subject.runtime.workspace },
  );
}

function scopeOf(subject: TestProject) {
  return {
    projectId: subject.runtime.project.id,
    workspaceId: subject.runtime.workspace.id,
  };
}

/** A policy that makes every operation need a human answer. */
function cautiousPolicy(): Policy {
  return {
    id: "policy-approve-all",
    name: "Approve every operation",
    version: 1,
    defaultEffect: "require-approval",
    rules: [],
  };
}

/**
 * A run use case with a policy of this test's choosing, built from the runtime's own
 * collaborators so the event log stays the single source of truth.
 */
function runWithPolicy(subject: TestProject, policy: Policy): RunTask {
  return createRunTask({
    tasks: subject.runtime.tasks,
    sessions: subject.runtime.sessions,
    decisions: subject.runtime.decisions,
    approvals: subject.runtime.approvals,
    ledger: subject.runtime.ledger,
    context: subject.runtime.context,
    contextConfig: subject.runtime.contextConfig,
    runner: subject.runtime.runner,
    policy,
    workspace: subject.runtime.workspace,
    rates: subject.runtime.modelRates,
    clock: createManualClock("2026-09-20T10:00:00.000Z"),
    providerId: subject.runtime.providerId,
    modelId: subject.runtime.modelId,
    operations: subject.runtime.operations,
    recorder: subject.runtime.recorder,
    decisionLayer: subject.runtime.decisionLayer,
  });
}

afterEach(async () => {
  while (projects.length > 0) {
    await projects.pop()?.cleanup();
  }
});

describe("approval: suspension before any work", () => {
  it("suspends a high-risk task without opening a session or spending a token", async () => {
    const subject = await project();
    const stored = await createTask(subject, { riskLevel: "high" });

    const result = await subject.runtime.runTask.run(stored);
    expect(result.outcome).toBe("awaiting-approval");
    expect(result.task.status).toBe("created");
    expect(result.session).toBeUndefined();
    expect(result.approvalRequestId).toBeDefined();

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.metrics.llmCalls).toBe(0);
    expect(trace.sessions).toHaveLength(0);
    expect(trace.approvals).toHaveLength(1);
    expect(trace.approvals[0].status).toBe("pending");
    expect(trace.integrity.ok).toBe(true);
  });

  it("re-states the same request instead of asking again", async () => {
    const subject = await project();
    const stored = await createTask(subject, { riskLevel: "high" });

    const first = await subject.runtime.runTask.run(stored);
    const second = await subject.runtime.runTask.run(stored);

    expect(second.approvalRequestId).toBe(first.approvalRequestId);
    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.approvals).toHaveLength(1);
    expect(
      trace.events.filter((event) => event.type === "HumanApprovalRequested"),
    ).toHaveLength(1);
  });
});

describe("approval: grant, consume and resume", () => {
  it("continues a suspended task after a human grant and finishes it", async () => {
    const subject = await project();
    const stored = await createTask(subject, { riskLevel: "high" });
    const suspended = await subject.runtime.runTask.run(stored);
    const requestId = suspended.approvalRequestId as string;

    await subject.runtime.approvals.grant({
      workspaceId: stored.task.workspaceId,
      taskId: stored.task.id,
      requestId,
      riskLevel: "high",
      approver: "maintainer",
    });

    const ledgerBefore = await subject.runtime.ledger.forTask(
      scopeOf(subject),
      stored.task.id,
    );
    expect(ledgerBefore[0].status).toBe("granted");

    const resumed = await subject.runtime.runTask.run(stored);
    expect(resumed.resumed).toBe(true);
    expect(resumed.outcome).toBe("awaiting-review");
    expect(resumed.task.status).toBe("review");

    const ledgerAfter = await subject.runtime.ledger.forTask(
      scopeOf(subject),
      stored.task.id,
    );
    expect(ledgerAfter[0].status).toBe("consumed");
    expect(ledgerAfter[0].approver).toBe("maintainer");

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.approvals[0].consumedAt).toBeDefined();
    expect(trace.approvals[0].status).toBe("consumed");
    expect(trace.status).toBe("review");
    expect(trace.metrics.llmCalls).toBeGreaterThan(0);
    expect(trace.integrity.ok).toBe(true);
    // The full sequence is traceable: asked, granted, consumed.
    const types = trace.events.map((event) => event.type);
    expect(types).toContain("HumanApprovalRequested");
    expect(types).toContain("HumanApprovalGranted");
    expect(types).toContain("HumanApprovalConsumed");
  });

  it("consumes a grant at a mid-attempt policy gate and carries on", async () => {
    const subject = await project();
    const stored = await createTask(subject);
    const runTask = runWithPolicy(subject, cautiousPolicy());

    const suspended = await runTask.run(stored);
    expect(suspended.outcome).toBe("awaiting-approval");
    expect(suspended.task.status).toBe("in_progress");
    const requestId = suspended.approvalRequestId as string;
    const pending = await subject.runtime.ledger.forTask(
      scopeOf(subject),
      stored.task.id,
    );
    expect(pending[0].operation).toBe("read");
    expect(pending[0].riskLevel).toBe("medium");

    await subject.runtime.approvals.grant({
      workspaceId: stored.task.workspaceId,
      taskId: stored.task.id,
      requestId,
      riskLevel: "medium",
      operation: "read",
      approver: "maintainer",
    });

    // Re-read before resuming, exactly as the CLI does: the first attempt moved the
    // record on, and an attempt refuses to act on a stale projection.
    const refreshed = await subject.runtime.tasks.load(
      scopeOf(subject),
      stored.task.id,
    );
    const resumed = await runTask.run(refreshed);
    expect(resumed.resumed).toBe(true);
    expect(resumed.outcome).toBe("awaiting-review");

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.approvals).toHaveLength(1);
    expect(trace.approvals[0].consumedAt).toBeDefined();
    // The tool step the gate protected actually ran after the grant.
    expect(trace.metrics.toolCalls).toBeGreaterThan(0);
  });

  it("refuses to reuse a consumed grant for a fresh attempt", async () => {
    const subject = await project();
    const stored = await createTask(subject, { riskLevel: "high" });
    const suspended = await subject.runtime.runTask.run(stored);
    const requestId = suspended.approvalRequestId as string;
    await subject.runtime.approvals.grant({
      workspaceId: stored.task.workspaceId,
      taskId: stored.task.id,
      requestId,
      riskLevel: "high",
      approver: "maintainer",
    });
    const resumed = await subject.runtime.runTask.run(stored);
    expect(resumed.outcome).toBe("awaiting-review");
    expect(resumed.resumed).toBe(true);

    // The task is no longer runnable at all, so the spent grant cannot be replayed.
    const finished = await subject.runtime.tasks.load(
      scopeOf(subject),
      stored.task.id,
    );
    await expect(subject.runtime.runTask.run(finished)).rejects.toSatisfy(
      (error: unknown) => hasDomainErrorCode(error, "TRANSITION"),
    );
  });
});

describe("approval: a grant never widens permission", () => {
  it("ignores an operation-scoped grant at a task-wide gate", async () => {
    const subject = await project();
    const stored = await createTask(subject, { riskLevel: "high" });
    const suspended = await subject.runtime.runTask.run(stored);
    const requestId = suspended.approvalRequestId as string;

    // Narrower than the question being asked: this must not authorise the task.
    await subject.runtime.approvals.grant({
      workspaceId: stored.task.workspaceId,
      taskId: stored.task.id,
      requestId,
      riskLevel: "high",
      operation: "read",
      approver: "maintainer",
    });

    const again = await subject.runtime.runTask.run(stored);
    expect(again.outcome).toBe("awaiting-approval");
    expect(again.approvalRequestId).not.toBe(requestId);

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.approvals).toHaveLength(2);
    expect(trace.metrics.llmCalls).toBe(0);
  });

  it("ignores a grant issued at a lower risk level than the requirement", async () => {
    const subject = await project();
    const stored = await createTask(subject, { riskLevel: "critical" });
    const suspended = await subject.runtime.runTask.run(stored);

    await subject.runtime.approvals.grant({
      workspaceId: stored.task.workspaceId,
      taskId: stored.task.id,
      requestId: suspended.approvalRequestId as string,
      riskLevel: "low",
      approver: "maintainer",
    });

    const again = await subject.runtime.runTask.run(stored);
    expect(again.outcome).toBe("awaiting-approval");
  });
});

describe("approval: expiry", () => {
  it("does not consume an expired grant, and asks again", async () => {
    const subject = await project();
    const stored = await createTask(subject, { riskLevel: "high" });
    const suspended = await subject.runtime.runTask.run(stored);

    await subject.runtime.approvals.grant({
      workspaceId: stored.task.workspaceId,
      taskId: stored.task.id,
      requestId: suspended.approvalRequestId as string,
      riskLevel: "high",
      approver: "maintainer",
      // The runtime's clock is a ticking clock starting at 2026-09-20T10:00:00Z,
      // so this is already in the past by the time it is read.
      expiresAt: "2026-09-20T09:00:00.000Z",
    });

    const ledger = await subject.runtime.ledger.forTask(
      scopeOf(subject),
      stored.task.id,
    );
    expect(ledger[0].status).toBe("expired");

    const again = await subject.runtime.runTask.run(stored);
    expect(again.outcome).toBe("awaiting-approval");
    expect(again.approvalRequestId).not.toBe(suspended.approvalRequestId);

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.approvals[0].status).toBe("expired");
  });
});

describe("approval: refusing to act on a stale projection", () => {
  it("rejects an attempt handed a stale task record before doing any work", async () => {
    const subject = await project();
    const stored = await createTask(subject);
    const runTask = runWithPolicy(subject, cautiousPolicy());

    // This attempt moved the record on (it reached in_progress) before suspending.
    const suspended = await runTask.run(stored);
    expect(suspended.outcome).toBe("awaiting-approval");

    await subject.runtime.approvals.grant({
      workspaceId: stored.task.workspaceId,
      taskId: stored.task.id,
      requestId: suspended.approvalRequestId as string,
      riskLevel: "medium",
      operation: "read",
      approver: "maintainer",
    });

    // The pre-suspension record is now stale, and is refused up front rather than
    // failing halfway through a real, paid attempt.
    await expect(runTask.run(stored)).rejects.toSatisfy((error: unknown) =>
      hasDomainErrorCode(error, "CONFLICT"),
    );

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    // Only the first attempt's single model turn exists; the refused attempt spent
    // nothing.
    expect(trace.metrics.llmCalls).toBe(1);
    const ledger = await subject.runtime.ledger.forTask(
      scopeOf(subject),
      stored.task.id,
    );
    expect(ledger[0].status).toBe("granted");
  });
});

describe("approval: resuming only what was actually suspended", () => {
  it("refuses to resume a task that is in_progress with no approval history", async () => {
    const subject = await project();
    const stored = await createTask(subject, { riskLevel: "high" });
    // Force the task into in_progress without the approval gate ever running.
    const started = await subject.runtime.tasks.start(stored);
    const inProgress = await subject.runtime.tasks.transition(
      started,
      "in_progress",
    );

    await expect(subject.runtime.runTask.run(inProgress)).rejects.toSatisfy(
      (error: unknown) => hasDomainErrorCode(error, "INVARIANT"),
    );
  });
});

describe("provider failures are trace facts", () => {
  it("records a categorised failure, fails the task and keeps the reason visible", async () => {
    const provider = createFakeProvider([
      { error: providerFailure({ failureKind: "auth", statusCode: 401 }) },
    ]);
    const subject = await project();
    const stored = await createTask(subject);
    const runTask = createRunTask({
      tasks: subject.runtime.tasks,
      sessions: subject.runtime.sessions,
      decisions: subject.runtime.decisions,
      approvals: subject.runtime.approvals,
      ledger: subject.runtime.ledger,
      context: subject.runtime.context,
      contextConfig: subject.runtime.contextConfig,
      runner: createRunnerWithProvider(subject, provider),
      policy: subject.runtime.policy,
      workspace: subject.runtime.workspace,
      rates: subject.runtime.modelRates,
      clock: createManualClock("2026-09-20T10:00:00.000Z"),
      providerId: provider.id,
      modelId: provider.models[0],
      operations: subject.runtime.operations,
      recorder: subject.runtime.recorder,
      decisionLayer: subject.runtime.decisionLayer,
    });

    const result = await runTask.run(stored);
    expect(result.outcome).toBe("provider-failed");
    expect(result.task.status).toBe("failed");
    expect(result.session?.status).toBe("failed");
    expect(result.reason).toContain("auth");
    expect(result.reason).toContain("401");

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.llmFailures).toHaveLength(1);
    expect(trace.llmFailures[0].failureKind).toBe("auth");
    expect(trace.llmFailures[0].attempts).toBe(1);
    expect(trace.metrics.failedLlmCalls).toBe(1);
    expect(trace.metrics.llmCalls).toBe(0);
    expect(trace.status).toBe("failed");
    // A failed request still pairs with its start event.
    expect(trace.integrity.ok).toBe(true);
  });
});

/** Builds an agent runtime bound to a specific provider, without touching storage. */
function createRunnerWithProvider(
  subject: TestProject,
  provider: ReturnType<typeof createFakeProvider>,
) {
  return {
    id: subject.runtime.runner.id,
    kind: "simulated" as const,
    attempt: async (
      request: Parameters<typeof subject.runtime.runner.attempt>[0],
    ) => {
      const response = await provider
        .complete({
          modelId: provider.models[0],
          messages: [
            { role: "user" as const, content: `Task ${request.task.id}` },
          ],
          correlationId: request.correlationId,
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      if (!response.ok) {
        const failure = response.error;
        if (
          typeof failure === "object" &&
          failure !== null &&
          "failureKind" in failure
        ) {
          const categorised = failure as {
            failureKind: "auth";
            attempts: number;
            retryable: boolean;
            statusCode?: number;
          };
          return {
            steps: [
              {
                kind: "llm-failure" as const,
                messageCount: 1,
                failureKind: categorised.failureKind,
                attempts: categorised.attempts,
                retryable: categorised.retryable,
                ...(categorised.statusCode === undefined
                  ? {}
                  : { statusCode: categorised.statusCode }),
              },
            ],
          };
        }
        throw failure;
      }
      return {
        steps: [
          {
            kind: "llm" as const,
            messageCount: 1,
            usage: response.value.usage ?? {
              inputTokens: 0,
              outputTokens: 0,
              cachedInputTokens: 0,
            },
            usageReported: response.value.usage !== undefined,
            latencyMs: response.value.latencyMs,
            retry: 0,
            escalated: false,
          },
        ],
      };
    },
  };
}
