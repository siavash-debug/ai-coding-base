import { describe, expect, it } from "vitest";

import {
  OPERATION_GATEWAY_ACTOR,
  type OperationGatewayScope,
  capabilityEnvelope,
  createOperationGateway,
  declareCapabilities,
} from "../../src/application/operation-gateway.js";
import { type Capability } from "../../src/policy/capability.js";
import type { SandboxBoundary } from "../../src/ports/operation.js";
import { createSimulatedAgentRunner } from "../../src/adapters/agent/simulated-agent-runner.js";
import { createFixedClock } from "../../src/core/clock.js";
import {
  accessPolicy,
  createEnforcementFixture,
  FIXTURE_INSTANT,
  FIXTURE_SECRET_VALUE,
  readWritePolicy,
  type EnforcementFixture,
} from "../support/policy.js";
import { expectDomainError } from "../support/errors.js";

const fixtures: EnforcementFixture[] = [];

async function fixture(
  options: Parameters<typeof createEnforcementFixture>[0] = {},
): Promise<EnforcementFixture> {
  const created = await createEnforcementFixture(options);
  fixtures.push(created);
  return created;
}

async function withFixture<T>(
  options: Parameters<typeof createEnforcementFixture>[0],
  body: (subject: EnforcementFixture) => Promise<T>,
): Promise<T> {
  const subject = await fixture(options);
  try {
    return await body(subject);
  } finally {
    await subject.cleanup();
    fixtures.splice(fixtures.indexOf(subject), 1);
  }
}

async function eventsOf(subject: EnforcementFixture) {
  return await subject.runtime.store.readByTask(
    {
      projectId: subject.runtime.project.id,
      workspaceId: subject.runtime.workspace.id,
    },
    subject.task.task.id,
  );
}

async function ledgerOf(subject: EnforcementFixture) {
  return await subject.runtime.ledger.forTask(
    {
      projectId: subject.runtime.project.id,
      workspaceId: subject.runtime.workspace.id,
    },
    subject.task.task.id,
  );
}

/**
 * Declares the attempt's envelope, as the run use case does before any operation.
 *
 * `gateway` defaults to the runtime's factory; a test that narrows the envelope
 * declares the narrowed one, which is what makes the declared-vs-evaluated
 * comparison meaningful.
 */
async function declare(
  subject: EnforcementFixture,
  gateway = subject.runtime.operations,
) {
  await declareCapabilities({
    recorder: subject.runtime.recorder,
    gateway,
    actor: OPERATION_GATEWAY_ACTOR,
    workspaceId: subject.runtime.workspace.id,
    taskId: subject.task.task.id,
  });
}

describe("gateway: every operation is evaluated", () => {
  it("performs an allowed operation and records the whole lifecycle", async () => {
    await withFixture(
      {
        policy: readWritePolicy(),
        files: { "src/a.ts": "export const a = 1;" },
      },
      async (subject) => {
        const gateway = subject.gateway();
        await declare(subject);
        const outcome = await gateway.execute({
          kind: "fs.read",
          ref: "src/a.ts",
        });

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) {
          return;
        }
        expect(outcome.capability).toBe("filesystem.read");
        expect(outcome.operation).toBe("read");
        expect(outcome.result).toMatchObject({
          content: "export const a = 1;",
        });

        // `TaskCreated` comes from the fixture's own task; everything after it is
        // the enforcement lifecycle, in order.
        const events = await eventsOf(subject);
        expect(events.map((event) => event.type)).toEqual([
          "TaskCreated",
          "CapabilitiesDeclared",
          "CapabilityCheckRequested",
          "CapabilityCheckCompleted",
          "OperationStarted",
          "OperationCompleted",
        ]);
        expect(events.at(-1)?.payload).toMatchObject({
          ok: true,
          resultSize: 19,
        });
      },
    );
  });

  it("denies a capability that was never declared, and performs nothing", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["filesystem.read"],
          readableRoots: ["."],
        }),
        files: { "src/a.ts": "x" },
      },
      async (subject) => {
        // An envelope narrowed to nothing: the policy allows the read, the attempt
        // does not.
        const narrowed = gatewayWith(subject, []);
        const outcome = await narrowed.execute({
          kind: "fs.read",
          ref: "src/a.ts",
        });
        expect(outcome.ok).toBe(false);
        if (outcome.ok) {
          return;
        }
        expect(outcome.decision.reasonCode).toBe("CAPABILITY_NOT_DECLARED");

        const types = (await eventsOf(subject)).map((event) => event.type);
        expect(types).toContain("OperationDenied");
        expect(types).not.toContain("OperationStarted");
        expect(types).not.toContain("OperationCompleted");
        expect(types).toContain("CapabilityCheckCompleted");
      },
    );
  });

  it("denies a capability the project does not allow", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["filesystem.read", "filesystem.write"],
          writableRoots: ["."],
        }),
      },
      async (subject) => {
        // The envelope is the policy's own, so `process.execute` is not in it either
        // way; the denial is the same shape the real runtime would produce.
        const gateway = subject.gateway();
        await declare(subject);
        const outcome = await gateway.execute({
          kind: "process.exec",
          command: "node",
          args: [],
        });
        expect(outcome.ok).toBe(false);
        if (outcome.ok) {
          return;
        }
        expect(outcome.decision.reasonCode).toBe("CAPABILITY_NOT_DECLARED");
        expect(outcome.decision.riskLevel).toBeDefined();
      },
    );
  });

  it("refuses a target outside the boundary and never starts the operation", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["filesystem.read"],
          readableRoots: ["src"],
        }),
        files: { "docs/a.md": "notes", "src/a.ts": "ok" },
      },
      async (subject) => {
        const gateway = subject.gateway();
        await declare(subject);
        const outcome = await gateway.execute({
          kind: "fs.read",
          ref: "docs/a.md",
        });
        expect(outcome.ok).toBe(false);
        if (outcome.ok) {
          return;
        }
        expect(outcome.decision.allowed).toBe(false);
        expect(outcome.decision.reasonCode).toBe("RESOURCE_OUTSIDE_BOUNDARY");

        const events = await eventsOf(subject);
        expect(events.map((event) => event.type)).toContain("OperationDenied");
        expect(events.map((event) => event.type)).not.toContain(
          "OperationStarted",
        );
        // A root-level denial is decided by policy, before the boundary is asked, so
        // it is a denial rather than a violation.
        expect(events.map((event) => event.type)).not.toContain(
          "SandboxViolation",
        );
      },
    );
  });

  it("refuses traversal before anything else, with a stable reason code", async () => {
    await withFixture({ policy: readWritePolicy() }, async (subject) => {
      const gateway = subject.gateway();
      await declare(subject);
      for (const ref of [
        "../escape.txt",
        "/etc/passwd",
        "C:/Windows/win.ini",
      ]) {
        const outcome = await gateway.execute({
          kind: "fs.write",
          ref,
          content: "x",
        });
        expect(outcome.ok, ref).toBe(false);
        if (outcome.ok) {
          continue;
        }
        expect(outcome.decision.reasonCode, ref).toBe("TARGET_REFUSED");
      }
    });
  });

  it("derives the capability from the operation, never from the caller", async () => {
    await withFixture({ policy: readWritePolicy() }, async (subject) => {
      const gateway = subject.gateway();
      await declare(subject);
      // A write carrying a "read" label is still a write: there is no field a caller
      // could set to claim a cheaper capability, and this request type proves it.
      const outcome = await gateway.execute({
        kind: "fs.write",
        ref: "out.txt",
        content: "written",
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }
      expect(outcome.capability).toBe("filesystem.write");
      expect(outcome.operation).toBe("write");
    });
  });

  it("exposes no method that skips a step", async () => {
    await withFixture({ policy: readWritePolicy() }, async (subject) => {
      const gateway = subject.gateway();
      // The surface is the guarantee: there is no `executeUnchecked`, no `grant`,
      // no `force` and no way to reach the boundary through it.
      expect(Object.keys(gateway).sort()).toEqual([
        "envelope",
        "execute",
        "guarantee",
        "id",
        "policyId",
        "scope",
      ]);
      expect(gateway.guarantee).toBe("in-process");
      expect(subject.runtime.operations.envelope).toEqual(
        capabilityEnvelope(subject.runtime.accessPolicy),
      );
    });
  });

  it("refuses to be built against a boundary for another scope", async () => {
    await withFixture({ policy: readWritePolicy() }, async (subject) => {
      // A gateway describing one workspace while holding another workspace's
      // boundary is exactly the shape of a cross-scope leak.
      const otherBoundary = subject.runtime.sandbox;
      expect(otherBoundary.scope.workspaceId).toBe(
        subject.runtime.workspace.id,
      );
      expectDomainError(
        () =>
          createGatewayForScope(subject, {
            projectId: subject.runtime.project.id,
            workspaceId: "wsp-somewhere-else" as never,
            taskId: subject.task.task.id,
          }),
        "FORBIDDEN",
      );
    });
  });
});

describe("gateway: the envelope cannot be widened", () => {
  it("an empty envelope authorises nothing at all", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["filesystem.read", "filesystem.write"],
          readableRoots: ["."],
          writableRoots: ["."],
        }),
        files: { "src/a.ts": "x" },
      },
      async (subject) => {
        const gateway = gatewayWith(subject, []);
        for (const request of [
          { kind: "fs.read", ref: "src/a.ts" } as const,
          { kind: "fs.write", ref: "out.txt", content: "x" } as const,
          { kind: "process.exec", command: "node", args: [] } as const,
          {
            kind: "network.request",
            url: "https://example.com",
            method: "GET",
          } as const,
          { kind: "env.read", name: "FIXTURE_ALLOWED" } as const,
        ]) {
          const outcome = await gateway.execute(request);
          expect(outcome.ok, request.kind).toBe(false);
        }
        const events = await eventsOf(subject);
        expect(events.map((event) => event.type)).not.toContain(
          "OperationStarted",
        );
      },
    );
  });

  it("a narrowed envelope is the intersection with policy, never a widening", () => {
    const policy = accessPolicy({
      allowed: ["filesystem.read"],
      readableRoots: ["."],
    });
    expect(
      capabilityEnvelope(policy, {
        requested: ["filesystem.write", "filesystem.read"],
      }),
    ).toEqual(["filesystem.read"]);
    expect(capabilityEnvelope(policy, { requested: [] })).toEqual([]);
    expect(capabilityEnvelope(policy)).toEqual(["filesystem.read"]);
  });

  it("a denied capability stays denied even if it is also allowed", () => {
    const policy = {
      ...accessPolicy({ allowed: ["filesystem.read"], readableRoots: ["."] }),
      capabilities: {
        allowed: ["filesystem.read" as const],
        denied: ["filesystem.read" as const],
        requireApproval: [],
      },
    };
    expect(capabilityEnvelope(policy)).toEqual([]);
  });
});

describe("gateway: approval no longer grants permission, it confirms it", () => {
  const approvable = (overrides: Parameters<typeof accessPolicy>[0] = {}) =>
    accessPolicy({
      allowed: ["filesystem.write", "filesystem.read"],
      readableRoots: ["."],
      writableRoots: ["."],
      requireApproval: ["filesystem.write"],
      ...overrides,
    });

  it("suspends a write that needs approval, and performs nothing", async () => {
    await withFixture({ policy: approvable() }, async (subject) => {
      const gateway = subject.gateway();
      await declare(subject);
      const outcome = await gateway.execute({
        kind: "fs.write",
        ref: "out.txt",
        content: "x",
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        return;
      }
      expect(outcome.approvalRequestId).toBeDefined();
      expect(outcome.decision.requiresApproval).toBe(true);

      const events = await eventsOf(subject);
      expect(events.map((event) => event.type)).toContain(
        "HumanApprovalRequested",
      );
      expect(events.map((event) => event.type)).not.toContain(
        "OperationStarted",
      );
      const states = await ledgerOf(subject);
      expect(states).toHaveLength(1);
      expect(states[0]?.status).toBe("pending");
    });
  });

  it("performs the operation once the grant exists, and consumes it exactly once", async () => {
    await withFixture({ policy: approvable() }, async (subject) => {
      const first = subject.gateway();
      await declare(subject);
      const suspended = await first.execute({
        kind: "fs.write",
        ref: "out.txt",
        content: "x",
      });
      const requestId =
        suspended.ok === false ? suspended.approvalRequestId : undefined;
      expect(requestId).toBeDefined();

      await subject.runtime.approvals.grant({
        workspaceId: subject.runtime.workspace.id,
        taskId: subject.task.task.id,
        requestId: requestId as string,
        riskLevel: "medium",
        operation: "write",
        approver: "siavash",
      });

      // A new attempt, as a resumed run would be.
      const second = subject.gateway();
      const outcome = await second.execute({
        kind: "fs.write",
        ref: "out.txt",
        content: "approved",
      });
      expect(outcome.ok).toBe(true);

      const events = await eventsOf(subject);
      const consumed = events.filter(
        (event) => event.type === "HumanApprovalConsumed",
      );
      expect(consumed).toHaveLength(1);
      const states = await ledgerOf(subject);
      expect(states[0]?.status).toBe("consumed");

      // A single grant authorises one attempt: a third attempt suspends again.
      const third = subject.gateway();
      const again = await third.execute({
        kind: "fs.write",
        ref: "out2.txt",
        content: "again",
      });
      expect(again.ok).toBe(false);
      if (again.ok) {
        return;
      }
      expect(again.approvalRequestId).not.toBe(requestId);
    });
  });

  it("reuses a grant within one attempt but never across capabilities", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["filesystem.write", "process.execute"],
          writableRoots: ["."],
          allowedCommands: ["node"],
          requireApproval: ["filesystem.write", "process.execute"],
        }),
      },
      async (subject) => {
        const gateway = subject.gateway();
        await declare(subject);
        const suspended = await gateway.execute({
          kind: "fs.write",
          ref: "out.txt",
          content: "x",
        });
        const requestId =
          suspended.ok === false ? suspended.approvalRequestId : undefined;
        await subject.runtime.approvals.grant({
          workspaceId: subject.runtime.workspace.id,
          taskId: subject.task.task.id,
          requestId: requestId as string,
          riskLevel: "medium",
          operation: "write",
          approver: "siavash",
        });

        // The same attempt, granted for `write`: the write is authorised…
        expect(
          (
            await gateway.execute({
              kind: "fs.write",
              ref: "out.txt",
              content: "x",
            })
          ).ok,
        ).toBe(true);
        // …and the execute is not: authority is scoped to one operation kind.
        const execute = await gateway.execute({
          kind: "process.exec",
          command: "node",
          args: ["-e", "0"],
        });
        expect(execute.ok).toBe(false);
        if (execute.ok) {
          return;
        }
        expect(execute.decision.requiresApproval).toBe(true);
      },
    );
  });

  it("does not honour an expired grant, and does not perform the operation", async () => {
    await withFixture({ policy: approvable() }, async (subject) => {
      const gateway = subject.gateway();
      await declare(subject);
      const suspended = await gateway.execute({
        kind: "fs.write",
        ref: "out.txt",
        content: "x",
      });
      const requestId =
        suspended.ok === false ? suspended.approvalRequestId : undefined;
      await subject.runtime.approvals.grant({
        workspaceId: subject.runtime.workspace.id,
        taskId: subject.task.task.id,
        requestId: requestId as string,
        riskLevel: "medium",
        operation: "write",
        approver: "siavash",
        // Before the fixed clock's instant: already expired.
        expiresAt: "2026-09-20T09:00:00.000Z",
      });

      const outcome = await subject.gateway().execute({
        kind: "fs.write",
        ref: "out.txt",
        content: "x",
      });
      expect(outcome.ok).toBe(false);
      const events = await eventsOf(subject);
      expect(events.map((event) => event.type)).not.toContain(
        "OperationStarted",
      );
      const states = await ledgerOf(subject);
      // Two requests now — the expired one and the fresh one the gateway raised —
      // and the fixed clock gives them the same timestamp, so the assertion is on
      // statuses rather than on an order the log does not define.
      expect(states.map((state) => state.status)).toContain("expired");
      expect(states.filter((state) => state.status === "pending")).toHaveLength(
        1,
      );
    });
  });

  it("does not honour a grant issued for another task", async () => {
    await withFixture(
      {
        policy: approvable(),
        tasks: [{ title: "Task A" }, { title: "Task B" }],
      },
      async (subject) => {
        const other = await subject.runtime.tasks.create(
          {
            title: "Another task",
            description: "A different task in the same workspace.",
            acceptanceCriteria: ["its own approval"],
          },
          {
            project: subject.runtime.project,
            workspace: subject.runtime.workspace,
          },
        );
        // A grant for the *other* task's request.
        const otherRequest = await subject.runtime.approvals.request({
          workspaceId: subject.runtime.workspace.id,
          taskId: other.task.id,
          riskLevel: "medium",
          operation: "write",
        });
        await subject.runtime.approvals.grant({
          workspaceId: subject.runtime.workspace.id,
          taskId: other.task.id,
          requestId: otherRequest.requestId,
          riskLevel: "medium",
          operation: "write",
          approver: "siavash",
        });

        const outcome = await subject.gateway().execute({
          kind: "fs.write",
          ref: "out.txt",
          content: "x",
        });
        expect(outcome.ok).toBe(false);
        const events = await eventsOf(subject);
        expect(events.map((event) => event.type)).not.toContain(
          "OperationStarted",
        );
        // The other task's grant is untouched: nothing consumed it.
        const otherStates = await subject.runtime.ledger.forTask(
          {
            projectId: subject.runtime.project.id,
            workspaceId: subject.runtime.workspace.id,
          },
          other.task.id,
        );
        expect(otherStates[0]?.status).toBe("granted");
      },
    );
  });

  it("cannot be reached by an approval: a capability policy denies stays denied", async () => {
    await withFixture({ policy: readWritePolicy() }, async (subject) => {
      const grant = await subject.runtime.approvals.request({
        workspaceId: subject.runtime.workspace.id,
        taskId: subject.task.task.id,
        riskLevel: "low",
        operation: "read",
      });
      await subject.runtime.approvals.grant({
        workspaceId: subject.runtime.workspace.id,
        taskId: subject.task.task.id,
        requestId: grant.requestId,
        riskLevel: "low",
        operation: "read",
        approver: "siavash",
      });

      const narrowed = gatewayWith(
        subject,
        ["filesystem.read"],
        contradictoryPolicy,
      );
      await declare(subject, narrowedFactory(subject, ["filesystem.read"]));
      const outcome = await narrowed.execute({ kind: "fs.read", ref: "." });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        return;
      }
      expect(outcome.decision.reasonCode).toBe("CAPABILITY_DENIED");
      const events = await eventsOf(subject);
      expect(events.map((event) => event.type)).not.toContain(
        "OperationStarted",
      );
    });
  });

  it("cannot escape the filesystem boundary, and does not even ask for approval", async () => {
    await withFixture(
      {
        policy: approvable({ writableRoots: ["out"] }),
      },
      async (subject) => {
        const outcome = await subject.gateway().execute({
          kind: "fs.write",
          ref: "../outside.txt",
          content: "escape",
        });
        expect(outcome.ok).toBe(false);
        if (outcome.ok) {
          return;
        }
        expect(outcome.decision.reasonCode).toBe("TARGET_REFUSED");
        if ("approvalRequestId" in outcome) {
          expect(outcome.approvalRequestId).toBeUndefined();
        }
        const events = await eventsOf(subject);
        const types = events.map((event) => event.type);
        // The refusal is a traversal, decided before a human is involved: asking for
        // approval of something that can never be allowed would be noise at best.
        expect(types).toContain("OperationDenied");
        expect(types).not.toContain("HumanApprovalRequested");
        expect(types).not.toContain("OperationStarted");
      },
    );
  });
});

describe("gateway: audit events answer who, what, where, why and what happened", () => {
  it("scopes every event to the project, workspace and task", async () => {
    await withFixture(
      { policy: readWritePolicy(), files: { "src/a.ts": "hello" } },
      async (subject) => {
        await declare(subject);
        await subject.gateway().execute({ kind: "fs.read", ref: "src/a.ts" });
        await subject.gateway().execute({ kind: "fs.read", ref: "../escape" });

        for (const event of await eventsOf(subject)) {
          expect(event.projectId).toBe(subject.runtime.project.id);
          expect(event.workspaceId).toBe(subject.runtime.workspace.id);
          expect(event.taskId).toBe(subject.task.task.id);
        }
        // Every enforcement event carries the enforcement actor and a correlation
        // id in the project:workspace:task form, so a log can be grouped by attempt.
        for (const event of (await eventsOf(subject)).filter(
          (candidate) => candidate.type !== "TaskCreated",
        )) {
          expect(event.actor).toEqual(OPERATION_GATEWAY_ACTOR);
        }
      },
    );
  });

  it("pairs every requested check with one completed check", async () => {
    await withFixture({ policy: readWritePolicy() }, async (subject) => {
      await declare(subject);
      await subject.gateway().execute({ kind: "fs.read", ref: "../escape" });
      await subject
        .gateway()
        .execute({ kind: "fs.write", ref: "out.txt", content: "x" });

      const events = await eventsOf(subject);
      const requested = events
        .filter((event) => event.type === "CapabilityCheckRequested")
        .map((event) => (event.payload as { checkId: string }).checkId);
      const completed = events
        .filter((event) => event.type === "CapabilityCheckCompleted")
        .map((event) => (event.payload as { checkId: string }).checkId);
      expect(requested).toHaveLength(2);
      expect(completed).toEqual(requested);

      const trace = await subject.runtime.traces.read(
        {
          projectId: subject.runtime.project.id,
          workspaceId: subject.runtime.workspace.id,
        },
        subject.task.task.id,
      );
      expect(trace.integrity.ok).toBe(true);
      expect(trace.policy.envelopes).toHaveLength(1);
      expect(trace.policy.checks).toHaveLength(2);
      expect(trace.policy.operations).toHaveLength(1);
      expect(trace.policy.operations[0]?.outcome).toBe("completed");
      expect(trace.policy.refusals).toHaveLength(1);
      expect(trace.policy.refusals[0]?.reasonCode).toBe("TARGET_REFUSED");
    });
  });

  it("records a denial with a reason code and nothing else about the target", async () => {
    await withFixture({ policy: readWritePolicy() }, async (subject) => {
      await declare(subject);
      await subject
        .gateway()
        .execute({ kind: "fs.read", ref: "../outside.txt" });
      const denial = (await eventsOf(subject)).find(
        (event) => event.type === "OperationDenied",
      );
      expect(denial?.payload).toEqual({
        capability: "filesystem.read",
        operation: "read",
        targetKind: "path",
        target: "../outside.txt",
        reasonCode: "TARGET_REFUSED",
      });
    });
  });

  it("never records a secret value, a prompt or an absolute host path", async () => {
    await withFixture(
      {
        policy: readWritePolicy({
          allowed: ["filesystem.read", "environment.read"],
          allowedVariables: ["FIXTURE_SECRET"],
        }),
        files: {
          // The *content* is secret-shaped; the path deliberately is not, so this
          // tests what is recorded rather than the credential-name exclusion.
          "src/data.txt": `token=${FIXTURE_SECRET_VALUE}`,
          ".env": `API_KEY=${FIXTURE_SECRET_VALUE}`,
        },
      },
      async (subject) => {
        await declare(subject);
        const gateway = subject.gateway();
        // A read of a file whose *content* is a secret: the content is returned in
        // memory and recorded nowhere.
        const read = await gateway.execute({
          kind: "fs.read",
          ref: "src/data.txt",
        });
        expect(read.ok).toBe(true);
        // A read of an allowlisted variable whose *value* is a secret: only the name
        // is recorded.
        const variable = await gateway.execute({
          kind: "env.read",
          name: "FIXTURE_SECRET",
        });
        expect(variable.ok).toBe(true);
        // A refusal of the credential file itself.
        await gateway.execute({ kind: "fs.read", ref: ".env" });
        // A hostile command line, as a value.
        await gateway.execute({
          kind: "process.exec",
          command: `node ${FIXTURE_SECRET_VALUE}`,
          args: ["--token", FIXTURE_SECRET_VALUE],
        });

        const serialized = JSON.stringify(await eventsOf(subject));
        expect(serialized).not.toContain(FIXTURE_SECRET_VALUE);
        expect(serialized).not.toContain(subject.root);
        expect(serialized).not.toContain("authorization");
        expect(serialized).toContain("FIXTURE_SECRET");
      },
    );
  });

  it("keeps a foreign task's trace out of scope, with no data leakage", async () => {
    await withFixture({ policy: readWritePolicy() }, async (subject) => {
      await declare(subject);
      await subject
        .gateway()
        .execute({ kind: "fs.write", ref: "out.txt", content: "x" });
      const trace = await subject.runtime.traces.read(
        {
          projectId: subject.runtime.project.id,
          workspaceId: subject.runtime.workspace.id,
        },
        "task-somebody-else" as never,
      );
      expect(trace.found).toBe(false);
      expect(trace.policy.checks).toEqual([]);
      expect(trace.policy.operations).toEqual([]);
      expect(trace.events).toEqual([]);
    });
  });
});

describe("gateway: nothing below the boundary can be reached around it", () => {
  it("the boundary refuses a denied target even when called directly", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["filesystem.read"],
          readableRoots: ["src"],
          allowedCommands: ["node"],
        }),
        files: { "docs/a.md": "notes" },
      },
      async (subject) => {
        // A caller that skipped the policy layer still cannot read outside the roots:
        // the boundary holds the same lists.
        const read = await subject.runtime.sandbox.perform({
          kind: "fs.read",
          ref: "docs/a.md",
        });
        expect(read.ok).toBe(false);

        // Nor run a program the policy does not list.
        const exec = await subject.runtime.sandbox.perform({
          kind: "process.exec",
          command: "definitely-not-listed",
          args: [],
        });
        expect(exec.ok).toBe(false);

        // Nor read an environment variable policy does not allow.
        const variable = await subject.runtime.sandbox.perform({
          kind: "env.read",
          name: "PATH",
        });
        expect(variable.ok).toBe(false);
      },
    );
  });

  it("a runner with no gateway performs no operation and says so", async () => {
    await withFixture({ policy: readWritePolicy() }, async (subject) => {
      const runner = createSimulatedAgentRunner({
        provider: subject.runtime.provider,
        modelId: subject.runtime.modelId,
        clock: createFixedClock(FIXTURE_INSTANT),
      });
      const attempt = await runner.attempt({
        task: subject.task.task,
        workspace: subject.runtime.workspace,
        providerId: subject.runtime.providerId,
        modelId: subject.runtime.modelId,
        correlationId: "test",
        // No `operations`: the runtime has no authority at all.
      });
      const tool = attempt.steps.find((step) => step.kind === "tool");
      expect(tool).toMatchObject({
        kind: "tool",
        ok: false,
        refusal: {
          reasonCode: "CAPABILITY_NOT_DECLARED",
          requiresApproval: false,
        },
      });
      // Nothing was performed, and nothing was recorded: there is no boundary to
      // record it.
      expect((await eventsOf(subject)).map((event) => event.type)).toEqual([
        "TaskCreated",
      ]);
    });
  });

  it("a runner that is given a gateway is refused when the capability is denied", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["filesystem.read"],
          readableRoots: ["src"],
        }),
      },
      async (subject) => {
        const runner = createSimulatedAgentRunner({
          provider: subject.runtime.provider,
          modelId: subject.runtime.modelId,
          clock: createFixedClock(FIXTURE_INSTANT),
        });
        const attempt = await runner.attempt({
          task: subject.task.task,
          workspace: subject.runtime.workspace,
          providerId: subject.runtime.providerId,
          modelId: subject.runtime.modelId,
          correlationId: "test",
          // The runner asks to list the workspace root; policy only allows `src`.
          operations: subject.gateway(),
        });
        const tool = attempt.steps.find((step) => step.kind === "tool");
        expect(tool).toMatchObject({
          kind: "tool",
          capability: "filesystem.read",
          ok: false,
          refusal: { reasonCode: "RESOURCE_OUTSIDE_BOUNDARY" },
        });
        const types = (await eventsOf(subject)).map((event) => event.type);
        expect(types).toContain("OperationDenied");
        expect(types).not.toContain("OperationStarted");
      },
    );
  });

  it("an unexpected boundary refusal is recorded as a violation, not swallowed", async () => {
    await withFixture({ policy: readWritePolicy() }, async (subject) => {
      await declare(subject);
      // A boundary that admits everything but refuses to perform: the shape a race
      // or a link appearing mid-operation would produce.
      const lying = {
        id: "lying-boundary",
        scope: subject.runtime.sandbox.scope,
        admit: async () => undefined,
        perform: async () => ({
          ok: false as const,
          refusal: {
            reasonCode: "SYMLINK_ESCAPE" as const,
            reason: "the target changed under the operation",
          },
        }),
      };
      const gateway = createGatewayForScope(
        subject,
        fixtureScope(subject),
        subject.runtime.operations.envelope,
        lying,
      );

      const outcome = await gateway.execute({
        kind: "fs.read",
        ref: "src/a.ts",
      });
      expect(outcome.ok).toBe(false);
      const types = (await eventsOf(subject)).map((event) => event.type);
      expect(types).toContain("SandboxViolation");
      expect(types).toContain("OperationDenied");
    });
  });

  it("an operation failure is not reported as a violation", async () => {
    await withFixture({ policy: readWritePolicy() }, async (subject) => {
      await declare(subject);
      const failed = {
        id: "failing-boundary",
        scope: subject.runtime.sandbox.scope,
        admit: async () => undefined,
        perform: async () => ({
          ok: false as const,
          refusal: {
            reasonCode: "OPERATION_FAILED" as const,
            reason: "the file could not be read",
          },
        }),
      };
      const gateway = createGatewayForScope(
        subject,
        fixtureScope(subject),
        ["filesystem.read"],
        failed,
      );
      const outcome = await gateway.execute({
        kind: "fs.read",
        ref: "src/a.ts",
      });
      expect(outcome.ok).toBe(false);
      const types = (await eventsOf(subject)).map((event) => event.type);
      expect(types).toContain("OperationFailed");
      expect(types).not.toContain("SandboxViolation");
      expect(types).not.toContain("OperationDenied");
    });
  });

  it("a tampered log is reported as an integrity issue rather than repaired", async () => {
    await withFixture({ policy: readWritePolicy() }, async (subject) => {
      // A verdict with no question: only something other than the gateway could
      // write this, which is exactly what the trace must surface.
      await subject.runtime.recorder.emit({
        type: "CapabilityCheckCompleted",
        actor: OPERATION_GATEWAY_ACTOR,
        payload: {
          checkId: "forged-check",
          capability: "filesystem.read",
          decision: "allowed",
          reasonCode: "ALLOWED",
          requiresApproval: false,
          riskLevel: "low",
        },
        workspaceId: subject.runtime.workspace.id,
        taskId: subject.task.task.id,
      });
      const trace = await subject.runtime.traces.read(
        {
          projectId: subject.runtime.project.id,
          workspaceId: subject.runtime.workspace.id,
        },
        subject.task.task.id,
      );
      expect(trace.integrity.ok).toBe(false);
      expect(trace.integrity.issues.join(" ")).toContain("forged-check");
    });
  });
});

function fixtureScope(subject: EnforcementFixture): OperationGatewayScope {
  return {
    projectId: subject.runtime.project.id,
    workspaceId: subject.runtime.workspace.id,
    taskId: subject.task.task.id,
  };
}

let nextId = 1;
const nextIdFactory = {
  name: "gateway-test-ids",
  next: (): string => `op-${nextId++}`,
};

/** A gateway over the fixture's scope, with a chosen envelope and boundary. */
function createGatewayForScope(
  subject: EnforcementFixture,
  scope: OperationGatewayScope,
  envelope: readonly Capability[] = subject.runtime.operations.envelope,
  boundary: SandboxBoundary = subject.runtime.sandbox,
  policy: typeof subject.runtime.accessPolicy = subject.runtime.accessPolicy,
) {
  return createOperationGateway({
    policy,
    envelope,
    boundary,
    ledger: subject.runtime.ledger,
    approvals: subject.runtime.approvals,
    recorder: subject.runtime.recorder,
    clock: createFixedClock(FIXTURE_INSTANT),
    scope,
    ids: nextIdFactory,
    actor: OPERATION_GATEWAY_ACTOR,
  });
}

/** A gateway whose envelope is exactly `envelope`. */
function gatewayWith(
  subject: EnforcementFixture,
  envelope: readonly Capability[],
  policy = subject.runtime.accessPolicy,
) {
  return createGatewayForScope(
    subject,
    fixtureScope(subject),
    envelope,
    subject.runtime.sandbox,
    policy,
  );
}

/**
 * A policy that lists a capability under `requireApproval` without allowing it.
 *
 * Configuration validation refuses this shape — approval cannot open a boundary, so
 * the entry is a contradiction — which is why it is built directly here: the test is
 * about what the *evaluation* does if such a policy ever exists, and the answer has
 * to be "deny", never "ask a human to approve it".
 */
const contradictoryPolicy = {
  ...accessPolicy({ readableRoots: ["."] }),
  capabilities: {
    allowed: [] as const,
    denied: [] as const,
    requireApproval: ["filesystem.read"] as const,
  },
} as unknown as ReturnType<typeof accessPolicy>;

/**
 * A factory-shaped declaration target for a narrowed envelope.
 *
 * `declareCapabilities` records what the *gateway* was given, so a test that
 * narrows the envelope must declare the narrowed set — which is the point: the
 * declaration and the evaluation have to agree, and a log where they disagree is
 * exactly what the trace's integrity check reports.
 */
function narrowedFactory(
  subject: EnforcementFixture,
  envelope: readonly Capability[],
) {
  return { ...subject.runtime.operations, envelope };
}
