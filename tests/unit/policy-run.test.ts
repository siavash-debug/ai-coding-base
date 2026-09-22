import { describe, expect, it } from "vitest";

import { createFixedClock } from "../../src/core/clock.js";
import {
  accessPolicy,
  createEnforcementFixture,
  readWritePolicy,
  type EnforcementFixture,
} from "../support/policy.js";

/**
 * The enforcement boundary inside a real run.
 *
 * These tests exercise the wiring rather than the pieces: the same `runTask` the
 * CLI calls, a real sandbox, a real event log and a real approval ledger. What they
 * establish is that the simulated runtime's one operation is subject to policy, that
 * a refusal stops the attempt instead of being reported as success, and that a
 * suspension raised by an *operation* resumes the way a suspension raised by the
 * risk gate does.
 */
async function fixture(
  options: Parameters<typeof createEnforcementFixture>[0],
): Promise<EnforcementFixture> {
  return await createEnforcementFixture(options);
}

const scopeOf = (subject: EnforcementFixture) => ({
  projectId: subject.runtime.project.id,
  workspaceId: subject.runtime.workspace.id,
});

describe("run: the enforcement boundary is in the execution path", () => {
  it("declares its envelope and performs its operation through the gateway", async () => {
    const subject = await fixture({ policy: readWritePolicy() });
    try {
      const result = await subject.runtime.runTask.run(subject.task);
      expect(result.outcome).toBe("awaiting-review");
      expect(
        result.messages.some((message) =>
          message.includes("capability envelope"),
        ),
      ).toBe(true);

      const trace = await subject.runtime.traces.read(
        scopeOf(subject),
        subject.task.task.id,
      );
      expect(trace.policy.envelopes).toHaveLength(1);
      expect(trace.policy.envelopes[0]?.capabilities).toEqual([
        "filesystem.read",
        "filesystem.write",
      ]);
      expect(trace.policy.operations).toHaveLength(1);
      expect(trace.policy.operations[0]).toMatchObject({
        capability: "filesystem.read",
        outcome: "completed",
        ok: true,
      });
      expect(trace.policy.refusals).toEqual([]);
      expect(trace.integrity.ok).toBe(true);
    } finally {
      await subject.cleanup();
    }
  });

  it("stops the attempt when the operation is denied, instead of reporting success", async () => {
    const subject = await fixture({
      // Every capability allowed except reading, which the runner's operation needs.
      policy: accessPolicy({ allowed: ["git.read"], readableRoots: ["."] }),
    });
    try {
      const result = await subject.runtime.runTask.run(subject.task);
      expect(result.outcome).toBe("policy-denied");
      expect(result.task.status).toBe("failed");

      const trace = await subject.runtime.traces.read(
        scopeOf(subject),
        subject.task.task.id,
      );
      expect(trace.policy.operations).toEqual([]);
      expect(trace.policy.refusals.length).toBeGreaterThan(0);
      expect(trace.integrity.ok).toBe(true);
    } finally {
      await subject.cleanup();
    }
  });

  it("suspends on an operation that needs approval, and resumes once the grant exists", async () => {
    const subject = await fixture({
      policy: accessPolicy({
        allowed: ["filesystem.read"],
        readableRoots: ["."],
        requireApproval: ["filesystem.read"],
      }),
    });
    try {
      const suspended = await subject.runtime.runTask.run(subject.task);
      expect(suspended.outcome).toBe("awaiting-approval");
      expect(suspended.approvalRequestId).toBeDefined();
      // The task is left open, exactly as a risk-gate suspension is.
      expect(suspended.task.status).toBe("in_progress");

      const before = await subject.runtime.ledger.forTask(
        scopeOf(subject),
        subject.task.task.id,
      );
      expect(before.map((state) => state.status)).toContain("pending");

      await subject.runtime.approvals.grant({
        workspaceId: subject.runtime.workspace.id,
        taskId: subject.task.task.id,
        requestId: suspended.approvalRequestId as string,
        riskLevel: "low",
        operation: "read",
        approver: "siavash",
      });

      const resumed = await subject.runtime.runTask.run(
        await subject.runtime.tasks.load(
          scopeOf(subject),
          subject.task.task.id,
        ),
      );
      expect(resumed.outcome).toBe("awaiting-review");
      expect(resumed.resumed).toBe(true);
      expect(resumed.task.status).toBe("review");

      const trace = await subject.runtime.traces.read(
        scopeOf(subject),
        subject.task.task.id,
      );
      expect(trace.policy.operations).toHaveLength(1);
      expect(trace.policy.operations[0]?.outcome).toBe("completed");
      const consumed = trace.events.filter(
        (event) => event.type === "HumanApprovalConsumed",
      );
      expect(consumed).toHaveLength(1);
      // The last word of the trace is a capability check that was answered.
      expect(trace.policy.checks.at(-1)?.decision).toBe("allowed");
    } finally {
      await subject.cleanup();
    }
  });

  it("suspends again rather than reusing the spent grant", async () => {
    const subject = await fixture({
      policy: accessPolicy({
        allowed: ["filesystem.read"],
        readableRoots: ["."],
        requireApproval: ["filesystem.read"],
      }),
    });
    try {
      const first = await subject.runtime.runTask.run(subject.task);
      await subject.runtime.approvals.grant({
        workspaceId: subject.runtime.workspace.id,
        taskId: subject.task.task.id,
        requestId: first.approvalRequestId as string,
        riskLevel: "low",
        operation: "read",
        approver: "siavash",
      });
      const second = await subject.runtime.runTask.run(
        await subject.runtime.tasks.load(
          scopeOf(subject),
          subject.task.task.id,
        ),
      );
      expect(second.outcome).toBe("awaiting-review");

      // A fresh task on the same policy: with the grant spent, the next attempt
      // suspends on a *new* request rather than proceeding on authority that is gone.
      const fresh = await subject.runtime.tasks.create(
        {
          title: "Second task",
          description: "A second attempt under the same policy.",
          acceptanceCriteria: ["its own approval"],
        },
        {
          project: subject.runtime.project,
          workspace: subject.runtime.workspace,
        },
      );
      const third = await subject.runtime.runTask.run(fresh);
      expect(third.outcome).toBe("awaiting-approval");
      expect(third.approvalRequestId).not.toBe(first.approvalRequestId);
    } finally {
      await subject.cleanup();
    }
  });

  it("does not consult the network, the environment or a process for a read-only policy", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      environment: {
        id: "fixed-secret",
        get: () => "sk-fixture-super-secret-value",
      },
    });
    try {
      await subject.runtime.runTask.run(subject.task);
      const events = await subject.runtime.store.readByTask(
        scopeOf(subject),
        subject.task.task.id,
      );
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("sk-fixture-super-secret-value");
      // No operation was performed that policy did not authorise: only the listing.
      const capabilities = events
        .filter((event) => event.type === "OperationStarted")
        .map((event) => (event.payload as { capability: string }).capability);
      expect(capabilities).toEqual(["filesystem.read"]);
    } finally {
      await subject.cleanup();
    }
  });

  it("records a determinate decision for every capability the run declares", async () => {
    const subject = await fixture({ policy: readWritePolicy() });
    try {
      await subject.runtime.runTask.run(subject.task);
      const trace = await subject.runtime.traces.read(
        scopeOf(subject),
        subject.task.task.id,
      );
      const declared = new Set(trace.policy.envelopes[0]?.capabilities ?? []);
      for (const check of trace.policy.checks) {
        expect(declared.has(check.capability)).toBe(true);
      }
      const traceReadAgain = await subject.runtime.traces.read(
        scopeOf(subject),
        subject.task.task.id,
      );
      // Reconstruction is deterministic: the same log gives the same projection.
      expect(traceReadAgain.policy).toEqual(trace.policy);
    } finally {
      await subject.cleanup();
    }
  });
});

describe("run: the boundary is bound to one workspace", () => {
  it("refuses a task from another workspace before anything is recorded", async () => {
    const subject = await fixture({ policy: readWritePolicy() });
    try {
      const foreign = await subject.runtime.tasks.create(
        {
          title: "Foreign task",
          description: "Belongs to another workspace.",
          acceptanceCriteria: ["not this workspace"],
        },
        // The task is written into the same store but names a workspace the runtime
        // is not bound to.
        {
          project: subject.runtime.project,
          workspace: subject.runtime.workspace,
        },
      );
      const tampered = {
        ...foreign,
        task: {
          ...foreign.task,
          workspaceId: "wsp-elsewhere" as typeof foreign.task.workspaceId,
        },
      };
      const before = await subject.runtime.store.readAll(scopeOf(subject));
      await expect(subject.runtime.runTask.run(tampered)).rejects.toThrow();
      const after = await subject.runtime.store.readAll(scopeOf(subject));
      expect(after).toHaveLength(before.length);
    } finally {
      await subject.cleanup();
    }
  });
});

describe("run: the clock is injected, not read", () => {
  it("uses the runtime clock for enforcement events", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      clock: createFixedClock("2026-09-20T10:00:00.000Z"),
    });
    try {
      await subject.runtime.runTask.run(subject.task);
      const events = await subject.runtime.store.readByTask(
        scopeOf(subject),
        subject.task.task.id,
      );
      const enforcement = events.filter(
        (event) =>
          event.type.startsWith("Operation") ||
          event.type.startsWith("Capability"),
      );
      expect(enforcement.length).toBeGreaterThan(0);
      for (const event of enforcement) {
        expect(event.occurredAt).toBe("2026-09-20T10:00:00.000Z");
      }
    } finally {
      await subject.cleanup();
    }
  });
});
