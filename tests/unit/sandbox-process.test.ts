import { describe, expect, it } from "vitest";

import { WINDOWS_CHILD_INHERITED_VARIABLES } from "../../src/adapters/sandbox/local-process.js";
import {
  createSandboxFixture,
  type SandboxFixture,
  accessPolicy,
} from "../support/policy.js";

/**
 * The process boundary, exercised with real child processes.
 *
 * `node` is used as the one command in every allowlist because it is guaranteed to
 * be present — the tests already run under it — and because it lets a test assert
 * exactly what a child received without adding a dependency. No test runs anything
 * that touches the network, and every timeout is milliseconds, not seconds.
 */
const NODE = process.platform === "win32" ? "node.exe" : "node";

const fixtures: SandboxFixture[] = [];

async function fixture(
  options: Parameters<typeof createSandboxFixture>[0] = {},
): Promise<SandboxFixture> {
  const created = await createSandboxFixture(options);
  fixtures.push(created);
  return created;
}

async function withFixture<T>(
  options: Parameters<typeof createSandboxFixture>[0],
  body: (subject: SandboxFixture) => Promise<T>,
): Promise<T> {
  const subject = await fixture(options);
  try {
    return await body(subject);
  } finally {
    await subject.cleanup();
    fixtures.splice(fixtures.indexOf(subject), 1);
  }
}

/** A command that prints a value derived from its own argv and environment. */
const PRINT_ENV =
  "process.stdout.write(Object.keys(process.env).sort().join(','))";

describe("sandbox: process boundary", () => {
  it("runs an allowed command with a filtered environment", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["process.execute"],
          allowedCommands: [NODE],
          environmentAllowlist: ["FIXTURE_ALLOWED"],
        }),
      },
      async (subject) => {
        const outcome = await subject.sandbox.perform({
          kind: "process.exec",
          command: NODE,
          args: ["-e", PRINT_ENV],
        });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) {
          return;
        }
        const result = outcome.result as { stdout: string; timedOut: boolean };
        const names = result.stdout
          .split(",")
          .filter((name) => name.length > 0);
        // Exactly what policy allows, and nothing else: no HOME, and no credential
        // the platform can see. Windows adds a fixed set of OS variables that Node
        // needs to start a process at all (`WINDOWS_CHILD_INHERITED_VARIABLES`), so
        // they are excluded from the comparison and asserted separately below.
        const policyControlled = names.filter(
          (name) => !WINDOWS_CHILD_INHERITED_VARIABLES.includes(name),
        );
        expect(policyControlled).toEqual(["FIXTURE_ALLOWED"]);
        expect(names).not.toContain("FIXTURE_SECRET");
        expect(names).not.toContain("FIXTURE_API_KEY");
        expect(names).not.toContain("HOME");
        if (process.platform !== "win32") {
          expect(names).toEqual(["FIXTURE_ALLOWED"]);
        }
        expect(result.timedOut).toBe(false);
      },
    );
  });

  it("never inherits the host environment by default", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["process.execute"],
          allowedCommands: [NODE],
        }),
      },
      async (subject) => {
        const outcome = await subject.sandbox.perform({
          kind: "process.exec",
          command: NODE,
          args: ["-e", PRINT_ENV],
        });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) {
          return;
        }
        const result = outcome.result as { stdout: string };
        const names = result.stdout
          .split(",")
          .filter((name) => name.length > 0);
        expect(
          names.filter(
            (name) => !WINDOWS_CHILD_INHERITED_VARIABLES.includes(name),
          ),
        ).toEqual([]);
        if (process.platform !== "win32") {
          expect(names).toEqual([]);
        }
        // What policy decided to forward, which is what `ai doctor` reports.
        expect(subject.sandbox.childEnvironmentNames).toEqual([]);
      },
    );
  });

  it("passes arguments as argv, so a shell metacharacter is a value", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["process.execute"],
          allowedCommands: [NODE],
        }),
      },
      async (subject) => {
        const hostile = "; rm -rf / && echo pwned";
        const outcome = await subject.sandbox.perform({
          kind: "process.exec",
          command: NODE,
          args: ["-e", "process.stdout.write(process.argv[1])", hostile],
        });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) {
          return;
        }
        // The value came back verbatim: it was never interpreted.
        const result = outcome.result as { stdout: string };
        expect(result.stdout).toBe(hostile);
      },
    );
  });

  it("refuses a command that is not on the allowlist", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["process.execute"],
          allowedCommands: [NODE],
        }),
      },
      async (subject) => {
        const refusal = await subject.sandbox.admit({
          kind: "process.exec",
          command: "definitely-not-allowed",
          args: [],
        });
        expect(refusal?.reasonCode).toBe("TARGET_NOT_ALLOWED");
        const performed = await subject.sandbox.perform({
          kind: "process.exec",
          command: "definitely-not-allowed",
          args: [],
        });
        expect(performed.ok).toBe(false);
      },
    );
  });

  it("lets an explicit denial beat an allowed pattern", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["process.execute"],
          allowedCommands: ["*"],
          deniedCommands: [NODE],
        }),
      },
      async (subject) => {
        const refusal = await subject.sandbox.admit({
          kind: "process.exec",
          command: NODE,
          args: [],
        });
        expect(refusal?.reasonCode).toBe("POLICY_DENIED");
      },
    );
  });

  it("refuses a traversing program name and an unsafe working directory", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["process.execute"],
          allowedCommands: ["*"],
        }),
      },
      async (subject) => {
        const traversing = await subject.sandbox.admit({
          kind: "process.exec",
          command: "../bin/sh",
          args: [],
        });
        expect(traversing?.reasonCode).toBe("TARGET_REFUSED");

        const unsafeCwd = await subject.sandbox.admit({
          kind: "process.exec",
          command: NODE,
          args: [],
          cwdRef: "../outside",
        });
        expect(unsafeCwd?.reasonCode).toBe("TARGET_REFUSED");

        const absoluteCwd = await subject.sandbox.admit({
          kind: "process.exec",
          command: NODE,
          args: [],
          cwdRef: subject.projectRoot,
        });
        expect(absoluteCwd?.reasonCode).toBe("TARGET_REFUSED");
      },
    );
  });

  it("runs inside a workspace-relative working directory", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["process.execute"],
          allowedCommands: [NODE],
        }),
        files: { "src/keep.txt": "x" },
      },
      async (subject) => {
        const outcome = await subject.sandbox.perform({
          kind: "process.exec",
          command: NODE,
          args: [
            "-e",
            "process.stdout.write(process.cwd().split(/[\\\\/]/).pop() ?? '')",
          ],
          cwdRef: "src",
        });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) {
          return;
        }
        const result = outcome.result as { stdout: string };
        expect(result.stdout).toBe("src");
      },
    );
  });

  it("bounded: a command that outlives its timeout is killed and reported", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["process.execute"],
          allowedCommands: [NODE],
          maxTimeoutMs: 1_000,
        }),
      },
      async (subject) => {
        const outcome = await subject.sandbox.perform({
          kind: "process.exec",
          command: NODE,
          args: ["-e", "setTimeout(() => {}, 10_000)"],
          timeoutMs: 300,
        });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) {
          return;
        }
        const result = outcome.result as { timedOut: boolean };
        expect(result.timedOut).toBe(true);
      },
    );
  });

  it("reports a missing program as a failed operation, not as a crash", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["process.execute"],
          allowedCommands: ["*"],
        }),
      },
      async (subject) => {
        const outcome = await subject.sandbox.perform({
          kind: "process.exec",
          command: "definitely-not-installed",
          args: [],
        });
        expect(outcome.ok).toBe(false);
        if (outcome.ok) {
          return;
        }
        expect(outcome.refusal.reasonCode).toBe("OPERATION_FAILED");
        expect(outcome.refusal.reason).not.toContain(subject.workspaceRoot);
      },
    );
  });

  it("records a non-zero exit code without failing the operation", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["process.execute"],
          allowedCommands: [NODE],
        }),
      },
      async (subject) => {
        const outcome = await subject.sandbox.perform({
          kind: "process.exec",
          command: NODE,
          args: ["-e", "process.exit(3)"],
        });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) {
          return;
        }
        expect(outcome.result).toMatchObject({ exitCode: 3 });
      },
    );
  });
});
