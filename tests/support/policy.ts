import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type AccessPolicy,
  DEFAULT_ACCESS_POLICY,
} from "../../src/policy/access-policy.js";
import type { Capability } from "../../src/policy/capability.js";
import {
  type LocalSandbox,
  createLocalSandbox,
} from "../../src/adapters/sandbox/local-sandbox.js";
import { createFixedEnvironment } from "../../src/ports/environment.js";
import type { Environment } from "../../src/ports/environment.js";
import { type Clock, createFixedClock } from "../../src/core/clock.js";
import type { HttpTransport } from "../../src/ports/http-transport.js";
import type { LlmProvider } from "../../src/ports/llm-provider.js";
import type { DecisionProvider } from "../../src/decisions/provider.js";
import { createFakeTransport } from "./llm.js";
import { projectId, workspaceId } from "../../src/core/ids.js";
import type { BoundaryScope } from "../../src/ports/operation.js";
import {
  type Runtime,
  initializeProject,
  openRuntime,
} from "../../src/application/runtime.js";
import type { OperationGateway } from "../../src/ports/operation.js";
import type { StoredTask } from "../../src/ports/task-repository.js";
import type { SessionId, TaskId } from "../../src/core/ids.js";

/**
 * Fixtures for the Phase F boundary tests.
 *
 * Everything here builds a *real* boundary over a real temporary directory with a
 * fixed clock and no network, because the properties under test are properties of
 * the adapters: whether a symlink escapes, whether a traversal is refused, whether a
 * child inherits a variable. A fake boundary would only prove that the fake works.
 *
 * The default policy in these fixtures is deliberately not the deny-everything
 * default: a test that has to enable reads to observe a denial would be testing
 * configuration rather than enforcement. Each test narrows or widens this baseline.
 */
export const FIXTURE_INSTANT = "2026-09-20T10:00:00.000Z";

export interface PolicyOverrides {
  readonly allowed?: readonly Capability[];
  readonly denied?: readonly Capability[];
  readonly requireApproval?: readonly Capability[];
  readonly readableRoots?: readonly string[];
  readonly writableRoots?: readonly string[];
  readonly deniedPatterns?: readonly string[];
  readonly allowedCommands?: readonly string[];
  readonly deniedCommands?: readonly string[];
  readonly environmentAllowlist?: readonly string[];
  readonly maxTimeoutMs?: number;
  readonly networkEnabled?: boolean;
  readonly allowedHosts?: readonly string[];
  readonly providerHosts?: readonly string[];
  readonly allowedVariables?: readonly string[];
  readonly envDeniedPatterns?: readonly string[];
  readonly id?: string;
}

/**
 * Builds a policy from the deny-everything default plus explicit overrides.
 *
 * Not validated, on purpose: a test that needs an unsafe policy must be able to
 * construct one, and the validation tests assert what the validator refuses.
 */
export function accessPolicy(overrides: PolicyOverrides = {}): AccessPolicy {
  return {
    id: overrides.id ?? "policy-test",
    version: DEFAULT_ACCESS_POLICY.version,
    capabilities: {
      allowed: overrides.allowed ?? [],
      denied: overrides.denied ?? [],
      requireApproval: overrides.requireApproval ?? [],
    },
    filesystem: {
      readableRoots: overrides.readableRoots ?? [],
      writableRoots: overrides.writableRoots ?? [],
      deniedPatterns: overrides.deniedPatterns ?? [],
    },
    process: {
      allowedCommands: overrides.allowedCommands ?? [],
      deniedCommands: overrides.deniedCommands ?? [],
      maxTimeoutMs: overrides.maxTimeoutMs ?? 5_000,
      environmentAllowlist: overrides.environmentAllowlist ?? [],
    },
    network: {
      enabled: overrides.networkEnabled ?? false,
      allowedHosts: overrides.allowedHosts ?? [],
      providerHosts: overrides.providerHosts ?? [],
    },
    environment: {
      allowedVariables: overrides.allowedVariables ?? [],
      deniedPatterns: overrides.envDeniedPatterns ?? [],
    },
  };
}

/**
 * The same policy with one more provider host reachable.
 *
 * Listing a host in `network.providerHosts` is what makes a configured provider
 * adapter able to reach it at all (ADR-050), and nothing else about the policy is
 * widened by doing so — which is the point of keeping the provider set apart from
 * the operation set.
 */
export function allowingProviderHost(
  policy: AccessPolicy,
  host: string,
): AccessPolicy {
  return {
    ...policy,
    network: {
      ...policy.network,
      providerHosts: [...policy.network.providerHosts, host],
    },
  };
}

/** A policy that can read and write inside the workspace and do nothing else. */
export function readWritePolicy(overrides: PolicyOverrides = {}): AccessPolicy {
  return accessPolicy({
    allowed: ["filesystem.read", "filesystem.write"],
    readableRoots: ["."],
    writableRoots: ["."],
    ...overrides,
  });
}

export interface SandboxFixture {
  readonly projectRoot: string;
  readonly workspaceRoot: string;
  readonly scope: BoundaryScope;
  readonly policy: AccessPolicy;
  readonly sandbox: LocalSandbox;
  /** The host environment a child would be filtered from. Never the real one. */
  readonly hostEnvironment: Readonly<Record<string, string>>;
  /** Reads a file from disk, bypassing the boundary (fixture-only). */
  readFromDisk(ref: string): Promise<string>;
  write(ref: string, content: string): Promise<void>;
  /** Creates a symlink at `ref` pointing at `target`. Returns false if refused. */
  link(ref: string, target: string): Promise<boolean>;
  cleanup(): Promise<void>;
}

export interface SandboxFixtureOptions {
  readonly policy?: AccessPolicy;
  /** Workspace-relative files created before the boundary is constructed. */
  readonly files?: Readonly<Record<string, string>>;
  readonly clock?: Clock;
  readonly environment?: Environment;
  readonly transport?: HttpTransport;
  readonly hostEnvironment?: Readonly<Record<string, string>>;
  readonly maxReadBytes?: number;
  /** Forces the platform the boundary believes it is running on. */
  readonly platform?: string;
}

export const FIXTURE_SECRET_VALUE = "sk-fixture-super-secret-value";

export async function createSandboxFixture(
  options: SandboxFixtureOptions = {},
): Promise<SandboxFixture> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-policy-"));
  const workspaceRoot = join(projectRoot, "ws");
  await mkdir(workspaceRoot, { recursive: true });

  const policy = options.policy ?? readWritePolicy();
  const scope: BoundaryScope = {
    projectId: projectId("prj-fixture"),
    workspaceId: workspaceId("wsp-fixture"),
    workspaceRoot,
    projectRoot,
  };

  const files = options.files ?? {};
  for (const [ref, content] of Object.entries(files)) {
    const path = join(workspaceRoot, ...ref.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  const hostEnvironment = options.hostEnvironment ?? {
    PATH: "/usr/bin",
    HOME: "/home/fixture",
    FIXTURE_ALLOWED: "allowed-value",
    FIXTURE_SECRET: FIXTURE_SECRET_VALUE,
    FIXTURE_API_KEY: FIXTURE_SECRET_VALUE,
  };

  const sandbox = createLocalSandbox({
    scope,
    policy,
    clock: options.clock ?? createFixedClock(FIXTURE_INSTANT),
    environment:
      options.environment ??
      createFixedEnvironment({
        FIXTURE_ALLOWED: "allowed-value",
        FIXTURE_SECRET: FIXTURE_SECRET_VALUE,
        FIXTURE_API_KEY: FIXTURE_SECRET_VALUE,
      }),
    transport: options.transport ?? createFakeTransport([]),
    hostEnvironment,
    ...(options.maxReadBytes === undefined
      ? {}
      : { maxReadBytes: options.maxReadBytes }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });

  return {
    projectRoot,
    workspaceRoot,
    scope,
    policy,
    sandbox,
    hostEnvironment,
    async readFromDisk(ref) {
      return await readFile(join(workspaceRoot, ...ref.split("/")), "utf8");
    },
    async write(ref, content) {
      const path = join(workspaceRoot, ...ref.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    },
    async link(ref, target) {
      const path = join(workspaceRoot, ...ref.split("/"));
      await mkdir(dirname(path), { recursive: true });
      try {
        // Junction/dir or file symlink depending on the target: the boundary must
        // judge the result either way.
        await symlink(target, path, "file");
        return true;
      } catch {
        // Windows without developer mode refuses to create symlinks at all. The
        // caller reports that honestly instead of pretending the case was covered.
        return false;
      }
    },
    async cleanup() {
      await rm(projectRoot, { recursive: true, force: true });
    },
  };
}

/**
 * A real, initialized project with a chosen access policy, plus one task.
 *
 * The enforcement layer is only meaningful in composition: the gateway needs a
 * recorder, a ledger, an approval service and a boundary, and all four are built
 * here exactly as the CLI builds them. A hand-assembled fake would test the fake.
 * Everything is offline, fixed-clock and temporary.
 */
export interface EnforcementFixture {
  readonly root: string;
  readonly runtime: Runtime;
  readonly policy: AccessPolicy;
  readonly task: StoredTask;
  readonly taskId: TaskId;
  /** A gateway for the fixture's task, built from the runtime's own collaborators. */
  gateway(options?: { readonly sessionId?: SessionId }): OperationGateway;
  cleanup(): Promise<void>;
}

export interface EnforcementFixtureOptions {
  readonly policy?: AccessPolicy;
  /** Workspace-relative files created before the runtime opens. */
  readonly files?: Readonly<Record<string, string>>;
  readonly clock?: Clock;
  readonly transport?: HttpTransport;
  readonly environment?: Environment;
  /**
   * Installs a decision layer for the run, so the enforcement tests can prove what a
   * decision layer can and cannot do. Absent means none is installed, which is the
   * platform's default.
   */
  readonly decisionProvider?: DecisionProvider;
  /** Overrides the LLM provider, for runs that must fail in a chosen way. */
  readonly provider?: LlmProvider;
  readonly tasks?: readonly {
    readonly title: string;
    readonly riskLevel?: "low" | "medium" | "high" | "critical";
  }[];
}

export const ENFORCEMENT_FIXTURE_ENVIRONMENT = {
  FIXTURE_ALLOWED: "allowed-value",
  FIXTURE_SECRET: FIXTURE_SECRET_VALUE,
} as const;

export async function createEnforcementFixture(
  options: EnforcementFixtureOptions = {},
): Promise<EnforcementFixture> {
  const root = await mkdtemp(join(tmpdir(), "ai-enforce-"));
  const clock = options.clock ?? createFixedClock(FIXTURE_INSTANT);
  const policy = options.policy ?? readWritePolicy();

  for (const [ref, content] of Object.entries(options.files ?? {})) {
    const path = join(root, ...ref.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  await initializeProject({
    projectRoot: root,
    name: "Enforcement Fixture",
    slug: "enforcement-fixture",
    clock,
    policy,
  });
  const runtime = await openRuntime({
    projectRoot: root,
    clock,
    accessPolicy: policy,
    transport: options.transport ?? createFakeTransport([]),
    environment:
      options.environment ??
      createFixedEnvironment({ ...ENFORCEMENT_FIXTURE_ENVIRONMENT }),
    ...(options.decisionProvider === undefined
      ? {}
      : { decisionProvider: options.decisionProvider }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
  });

  const [firstTask] = options.tasks ?? [{ title: "Enforce the boundary" }];
  const task = await runtime.tasks.create(
    {
      title: firstTask?.title ?? "Enforce the boundary",
      description:
        "Prove that an operation passes through policy and the sandbox.",
      acceptanceCriteria: ["Every operation is evaluated"],
      ...(firstTask?.riskLevel === undefined
        ? {}
        : { riskLevel: firstTask.riskLevel }),
    },
    { project: runtime.project, workspace: runtime.workspace },
  );

  return {
    root,
    runtime,
    policy,
    task,
    taskId: task.task.id,
    gateway(scopeOptions = {}) {
      return runtime.operations.forAttempt({
        projectId: runtime.project.id,
        workspaceId: runtime.workspace.id,
        taskId: task.task.id,
        ...(scopeOptions.sessionId === undefined
          ? {}
          : { sessionId: scopeOptions.sessionId }),
      });
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** True when this platform lets an unprivileged test create a symlink. */
export async function symlinksAvailable(): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "ai-symlink-probe-"));
  try {
    await writeFile(join(root, "target.txt"), "x", "utf8");
    try {
      await symlink(join(root, "target.txt"), join(root, "link.txt"), "file");
      return true;
    } catch {
      return false;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
