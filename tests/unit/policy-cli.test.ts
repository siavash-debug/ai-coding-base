import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/main.js";
import type { CliEnv, CliIo } from "../../src/cli/io.js";
import { createFixedClock } from "../../src/core/clock.js";
import {
  openRuntime,
  initializeProject,
} from "../../src/application/runtime.js";
import {
  accessPolicy,
  readWritePolicy,
  symlinksAvailable,
} from "../support/policy.js";

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
    io: {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    },
    outText: () => out.join("\n"),
    errText: () => err.join("\n"),
    outJson: <T>() => JSON.parse(out.join("\n")) as T,
  };
}

/**
 * A project initialized with a chosen policy.
 *
 * The policy is written through `ai init`'s own path rather than by hand, so the CLI
 * reads exactly what an operator would have written.
 */
async function project(
  policy = readWritePolicy(),
): Promise<{ root: string; env: CliEnv }> {
  const cwd = await mkdtemp(join(tmpdir(), "ai-policy-cli-"));
  roots.push(cwd);
  const env: CliEnv = {
    cwd,
    clock,
    runtimeVersion: "v24.21.0",
    platform: "test/test",
  };
  const cap = capture();
  expect(await main(["init"], cap.io, env)).toBe(0);
  // Rewrite the configuration in place with the policy under test. `--force`
  // rewrites configuration only and never touches the event log.
  await initializeProject({
    projectRoot: cwd,
    name: "Policy CLI",
    slug: "policy-cli",
    clock,
    policy,
    force: true,
  });
  return { root: cwd, env };
}

async function cli(
  argv: readonly string[],
  env: CliEnv,
): Promise<{ code: number; cap: Capture }> {
  const cap = capture();
  const code = await main(argv, cap.io, env);
  return { code, cap };
}

describe("ai policy: showing the boundary", () => {
  it("lists every capability with its effect, and the envelope", async () => {
    const { env } = await project(
      accessPolicy({
        allowed: ["filesystem.read", "filesystem.write"],
        readableRoots: ["src"],
        writableRoots: ["out"],
        requireApproval: ["filesystem.write"],
      }),
    );
    const { code, cap } = await cli(["policy"], env);
    expect(code).toBe(0);
    const text = cap.outText();
    expect(text).toContain("CAPABILITIES");
    expect(text).toContain("filesystem.read");
    expect(text).toContain("allowed");
    expect(text).toContain("approval-required");
    expect(text).toContain("not-allowed");
    expect(text).toContain("readable roots    src");
    expect(text).toContain("writable roots    out");
    expect(text).toContain("ENVELOPE FOR AN ATTEMPT");
    expect(text).not.toContain(env.cwd);
  });

  it("emits machine-readable JSON that names the sandbox guarantee", async () => {
    const { env } = await project();
    const { code, cap } = await cli(["policy", "--json"], env);
    expect(code).toBe(0);
    const payload = cap.outJson<{
      policyId: string;
      policyVersion: number;
      capabilities: readonly { capability: string; effect: string }[];
      envelope: readonly string[];
      sandbox: { id: string; guarantee: string; workspaceId: string };
    }>();
    expect(payload.policyVersion).toBe(1);
    expect(payload.envelope).toEqual(["filesystem.read", "filesystem.write"]);
    expect(payload.sandbox.guarantee).toBe("in-process");
    expect(
      payload.capabilities.find((row) => row.capability === "process.execute")
        ?.effect,
    ).toBe("not-allowed");
  });

  it("prints credentials, headers and variable values nowhere", async () => {
    const { env } = await project(
      accessPolicy({
        allowed: ["environment.read"],
        allowedVariables: ["FIXTURE_SECRET"],
        envDeniedPatterns: ["*_API_KEY"],
      }),
    );
    const { cap } = await cli(["policy"], env);
    // Names are configuration and are shown; values are not read at all.
    expect(cap.outText()).toContain("FIXTURE_SECRET");
    expect(cap.outText()).toContain("*_API_KEY");
    expect(cap.outText()).not.toContain("sk-");
  });
});

describe("ai policy --check: a dry run that performs nothing", () => {
  it("allows a target inside the boundary and exits 0", async () => {
    const { env } = await project(
      accessPolicy({ allowed: ["filesystem.read"], readableRoots: ["src"] }),
    );
    const { code, cap } = await cli(
      [
        "policy",
        "--check",
        "--capability",
        "filesystem.read",
        "--target",
        "src/a.ts",
      ],
      env,
    );
    expect(code).toBe(0);
    expect(cap.outText()).toContain("status         allowed");
    expect(cap.outText()).toContain("ALLOWED");
    expect(cap.outText()).toContain("evaluated by   policy");
  });

  it("denies a target outside the roots and exits non-zero", async () => {
    const { env } = await project(
      accessPolicy({ allowed: ["filesystem.read"], readableRoots: ["src"] }),
    );
    const { code, cap } = await cli(
      [
        "policy",
        "--check",
        "--capability",
        "filesystem.read",
        "--target",
        "docs/notes.md",
      ],
      env,
    );
    expect(code).toBe(1);
    expect(cap.outText()).toContain("RESOURCE_OUTSIDE_BOUNDARY");
    expect(cap.outText()).toContain("status         denied");
  });

  it("refuses to interpret a traversal, and says nothing was evaluated", async () => {
    const { env } = await project();
    const { code, cap } = await cli(
      [
        "policy",
        "--check",
        "--capability",
        "filesystem.read",
        "--target",
        "../escape.txt",
      ],
      env,
    );
    expect(code).toBe(2);
    expect(cap.outText()).toContain("TARGET_REFUSED");
    expect(cap.errText()).toContain("nothing was evaluated");
  });

  it("reports an approval-required capability as not allowed yet", async () => {
    const { env } = await project(
      accessPolicy({
        allowed: ["filesystem.write"],
        writableRoots: ["out"],
        requireApproval: ["filesystem.write"],
      }),
    );
    const { code, cap } = await cli(
      [
        "policy",
        "--check",
        "--capability",
        "filesystem.write",
        "--target",
        "out/result.txt",
      ],
      env,
    );
    expect(code).toBe(1);
    expect(cap.outText()).toContain("status         approval-required");
    expect(cap.outText()).toContain("APPROVAL_REQUIRED");
  });

  it("checks a command against the process policy", async () => {
    const { env } = await project(
      accessPolicy({
        allowed: ["process.execute"],
        allowedCommands: ["node"],
      }),
    );
    const allowed = await cli(
      [
        "policy",
        "--check",
        "--capability",
        "process.execute",
        "--target",
        "node",
      ],
      env,
    );
    expect(allowed.code).toBe(0);
    expect(allowed.cap.outText()).toContain("allowed");

    const denied = await cli(
      [
        "policy",
        "--check",
        "--capability",
        "process.execute",
        "--target",
        "sh",
      ],
      env,
    );
    expect(denied.code).toBe(1);
    expect(denied.cap.outText()).toContain("TARGET_NOT_ALLOWED");
  });

  it("denies the network by default, and a host policy does not list", async () => {
    // With the capability absent from the envelope, the first true answer is that
    // it was never declared: the envelope is evaluated before the target rules.
    const undeclared = await cli(
      [
        "policy",
        "--check",
        "--capability",
        "network.connect",
        "--target",
        "https://api.example.com/v1",
      ],
      (await project()).env,
    );
    expect(undeclared.code).toBe(1);
    expect(undeclared.cap.outText()).toContain("CAPABILITY_NOT_DECLARED");

    // With it declared but the network disabled, the answer is the policy itself.
    const { env } = await project(
      accessPolicy({ allowed: ["network.connect"] }),
    );
    const { code, cap } = await cli(
      [
        "policy",
        "--check",
        "--capability",
        "network.connect",
        "--target",
        "https://api.example.com/v1",
      ],
      env,
    );
    expect(code).toBe(1);
    expect(cap.outText()).toContain("POLICY_DENIED");
    expect(cap.outText()).toContain("network access is disabled by policy");
    // The query string is never part of what is shown.
    const withQuery = await cli(
      [
        "policy",
        "--check",
        "--capability",
        "network.connect",
        "--target",
        "https://api.example.com/v1?token=sk-fixture-super-secret-value",
      ],
      env,
    );
    expect(withQuery.cap.outText()).not.toContain(
      "sk-fixture-super-secret-value",
    );
  });

  it("emits the dry run as JSON, and writes no event", async () => {
    const { root, env } = await project();
    const before = await openRuntime({ projectRoot: root, clock });
    const { code, cap } = await cli(
      [
        "policy",
        "--check",
        "--capability",
        "filesystem.read",
        "--target",
        "src/a.ts",
        "--json",
      ],
      env,
    );
    expect(code).toBe(0);
    const payload = cap.outJson<{
      result: { status: string; reasonCode: string };
      request: { kind: string };
    }>();
    expect(payload.result.status).toBe("allowed");
    expect(payload.request.kind).toBe("fs.read");

    const after = await openRuntime({ projectRoot: root, clock });
    expect(
      await after.store.readAll({
        projectId: after.project.id,
        workspaceId: after.workspace.id,
      }),
    ).toEqual(
      await before.store.readAll({
        projectId: before.project.id,
        workspaceId: before.workspace.id,
      }),
    );
  });

  it("requires both flags, and exits with a usage error otherwise", async () => {
    const { env } = await project();
    const missing = await cli(["policy", "--check"], env);
    expect(missing.code).toBe(2);
    expect(missing.cap.errText()).toContain("--capability");
    const unknown = await cli(
      [
        "policy",
        "--check",
        "--capability",
        "filesystem.chmod",
        "--target",
        "x",
      ],
      env,
    );
    expect(unknown.code).toBe(2);
    expect(unknown.cap.outText()).toContain("MALFORMED_REQUEST");
  });

  it("documents itself", async () => {
    const { env } = await project();
    const { code, cap } = await cli(["policy", "--help"], env);
    expect(code).toBe(0);
    expect(cap.outText()).toContain("ai policy --check");
  });
});

describe("ai doctor: the enforcement check", () => {
  it("passes the refusal probes on a default project, with honest warnings", async () => {
    const { env } = await project();
    const { code, cap } = await cli(["doctor", "--json"], env);
    expect(code).toBe(0);
    const report = cap.outJson<{
      checks: readonly { id: string; status: string; detail?: string }[];
    }>();
    const check = report.checks.find((entry) => entry.id === "enforcement");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("not a container or VM");
    expect(check?.detail).toContain("refusal probes: 4 checked");
  });

  it("reports a read-only boundary without warnings", async () => {
    const { env } = await project(
      accessPolicy({ allowed: ["filesystem.read"], readableRoots: ["."] }),
    );
    const { cap } = await cli(["doctor", "--json"], env);
    const report = cap.outJson<{
      checks: readonly { id: string; status: string; detail?: string }[];
    }>();
    const check = report.checks.find((entry) => entry.id === "enforcement");
    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain("no writable root, no command and no host");
  });

  it("fails when a configured root leaves the workspace through a link", async () => {
    if (!(await symlinksAvailable())) {
      expect(process.platform).toBe("win32");
      return;
    }
    const { root, env } = await project(
      accessPolicy({
        allowed: ["filesystem.write"],
        writableRoots: ["out"],
      }),
    );
    const outside = await mkdtemp(join(tmpdir(), "ai-outside-"));
    roots.push(outside);
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, join(root, "out"), "dir");

    const { code, cap } = await cli(["doctor", "--json"], env);
    const report = cap.outJson<{
      checks: readonly { id: string; status: string; detail?: string }[];
    }>();
    const check = report.checks.find((entry) => entry.id === "enforcement");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("is a link that leaves the workspace");
    expect(code).toBe(1);
  });

  it("never prints a secret, and never contacts the network", async () => {
    const { env } = await project(
      accessPolicy({
        allowed: ["environment.read"],
        allowedVariables: ["FIXTURE_API_KEY"],
      }),
    );
    const { cap } = await cli(["doctor"], env);
    expect(cap.outText()).not.toContain("sk-");
    expect(cap.outText()).not.toContain("Bearer ");
  });
});
