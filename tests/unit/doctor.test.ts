import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MINIMUM_NODE_MAJOR,
  formatDoctorReport,
  runDoctor,
  summarize,
} from "../../src/application/doctor.js";
import type { DoctorCheck } from "../../src/application/doctor.js";
import { createFixedClock } from "../../src/core/clock.js";
import { projectConfigPath } from "../../src/adapters/storage/layout.js";
import {
  type Environment,
  createFixedEnvironment,
} from "../../src/ports/environment.js";
import { createTestProject, type TestProject } from "../support/project.js";

const clock = createFixedClock("2026-09-20T10:00:00.000Z");
const RUNTIME_VERSION = `v${MINIMUM_NODE_MAJOR}.21.0`;
const PLATFORM = "test/test";

const projects: TestProject[] = [];
const scratch: string[] = [];

async function project(): Promise<TestProject> {
  const created = await createTestProject();
  projects.push(created);
  return created;
}

const FIXTURE_KEY = "sk-test-fixture-abcdefghijklmnop";

/**
 * A project configured for the real provider, so its doctor checks can be exercised
 * without any network call: doctor verifies that a credential is *present*, never
 * that a vendor accepts it.
 */
async function configuredProject(input: {
  readonly credentialEnvVar: string;
}): Promise<string> {
  const created = await createTestProject({
    llm: {
      provider: "openai-compatible",
      baseUrl: "https://fixture.invalid/v1",
      modelId: "fixture-model",
      credentialEnvVar: input.credentialEnvVar,
    },
  });
  projects.push(created);
  return created.root;
}

async function emptyDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-doctor-test-"));
  scratch.push(root);
  return root;
}

function doctorOn(
  projectRoot: string,
  overrides: {
    readonly runtimeVersion?: string;
    readonly platform?: string;
    readonly environment?: Environment;
  } = {},
) {
  return runDoctor({
    projectRoot,
    clock,
    runtimeVersion: overrides.runtimeVersion ?? RUNTIME_VERSION,
    platform: overrides.platform ?? PLATFORM,
    // Always injected in tests, so no test can read a real credential.
    environment: overrides.environment ?? createFixedEnvironment({}),
  });
}

function checkById(
  report: { readonly checks: readonly DoctorCheck[] },
  id: string,
): DoctorCheck {
  const found = report.checks.find((check) => check.id === id);
  if (found === undefined) {
    throw new Error(
      `no check "${id}" in ${report.checks.map((c) => c.id).join(", ")}`,
    );
  }
  return found;
}

afterEach(async () => {
  while (projects.length > 0) {
    await projects.pop()?.cleanup();
  }
  for (const root of scratch) {
    await rm(root, { recursive: true, force: true });
  }
  scratch.length = 0;
});

describe("ai doctor: a healthy project", () => {
  it("passes, with honest warnings about the current phase", async () => {
    const subject = await project();
    const report = await doctorOn(subject.root);

    expect(report.failures).toBe(0);
    expect(report.exitCode).toBe(0);
    expect(report.checks.map((check) => check.id)).toEqual([
      "runtime",
      "project-config",
      "workspace",
      "layout",
      "event-store",
      "append-lock",
      "llm-provider",
      "approvals",
      "event-log",
      "trace",
      "context-config",
      "context-repository",
      "context-engine",
      "agent-runtime",
      "llm-pricing",
    ]);
  });

  it("proves context selection for real, offline, without touching the project log", async () => {
    const subject = await project();
    const engine = checkById(await doctorOn(subject.root), "context-engine");

    expect(engine.status).toBe("ok");
    expect(engine.detail).toContain("selection ran offline");
    expect(engine.detail).toContain("secrets refused");
    expect(engine.detail).toContain("over-budget refused");

    // The probe must not have appended anything to the project's own log.
    const events = await subject.runtime.store.readAll({
      projectId: subject.runtime.project.id,
      workspaceId: subject.runtime.workspace.id,
    });
    expect(events).toHaveLength(0);
  });

  it("reports the context configuration and rejects a version this build cannot serve", async () => {
    const subject = await project();
    const report = await doctorOn(subject.root);
    const config = checkById(report, "context-config");
    expect(config.status).toBe("ok");
    expect(config.detail).toContain('strategy "deterministic" v1');
    expect(config.detail).toContain("budget 8000 tokens");

    const configPath = projectConfigPath(subject.root);
    const tampered = (await readFile(configPath, "utf8")).replace(
      '"version": 1',
      '"version": 2',
    );
    await writeFile(configPath, tampered, "utf8");
    const broken = await doctorOn(subject.root);
    expect(broken.failures).toBeGreaterThan(0);
    expect(broken.checks.map((check) => check.status)).toContain("fail");
  });

  it("proves append coordination for real, and that the lock is released", async () => {
    const subject = await project();
    const lock = checkById(await doctorOn(subject.root), "append-lock");

    expect(lock.status).toBe("ok");
    expect(lock.detail).toContain("local-process-and-file");
    expect(lock.detail).toContain("concurrent writer was refused");
    // The probe lock file must not survive the check.
    const eventsDir = join(subject.root, ".ai", "runtime", "events");
    expect(await readdir(eventsDir)).toEqual([]);
  });

  it("reports the offline provider as needing no credential", async () => {
    const subject = await project();
    const provider = checkById(await doctorOn(subject.root), "llm-provider");

    expect(provider.status).toBe("ok");
    expect(provider.detail).toContain("offline provider");
    expect(provider.detail).toContain("no credential or network required");
  });

  it("reports the approval ledger as projected from the log", async () => {
    const subject = await project();
    const approvals = checkById(await doctorOn(subject.root), "approvals");

    expect(approvals.status).toBe("ok");
    expect(approvals.detail).toContain("0 approval(s) projected from the log");
  });

  it("stays offline: it never calls a provider", async () => {
    // A configured real provider with credentials present must still be verified
    // without a network call, so doctor can run anywhere.
    const root = await configuredProject({
      credentialEnvVar: "FIXTURE_API_KEY",
    });
    const report = await doctorOn(root, {
      environment: createFixedEnvironment({ FIXTURE_API_KEY: FIXTURE_KEY }),
    });
    const provider = checkById(report, "llm-provider");
    expect(provider.status).toBe("ok");
    expect(provider.detail).toContain("fixture.invalid");
    expect(provider.detail).toContain("FIXTURE_API_KEY is set");
    // The value itself is never in the report.
    expect(JSON.stringify(report)).not.toContain(FIXTURE_KEY);
  });

  it("fails when a configured real provider has no credential", async () => {
    const root = await configuredProject({
      credentialEnvVar: "MISSING_FIXTURE_KEY",
    });
    const report = await doctorOn(root, {
      environment: createFixedEnvironment({}),
    });
    const provider = checkById(report, "llm-provider");

    expect(provider.status).toBe("fail");
    expect(provider.detail).toContain("MISSING_FIXTURE_KEY is not set");
    expect(provider.detail).toContain("auth");
    expect(report.exitCode).toBe(1);
  });

  it("verifies a real append and re-read through the real adapter", async () => {
    const subject = await project();
    const report = await doctorOn(subject.root);
    const store = checkById(report, "event-store");

    expect(store.status).toBe("ok");
    expect(store.detail).toContain("round trip ok");
    expect(store.detail).toContain("foreign workspace scope rejected");
  });

  it("does not write its probe into the project's own log", async () => {
    const subject = await project();
    const eventsDir = join(subject.root, ".ai", "runtime", "events");
    await doctorOn(subject.root);

    expect(await readdir(eventsDir)).toEqual([]);
    const log = checkById(await doctorOn(subject.root), "event-log");
    expect(log.detail).toContain("0 event(s)");
  });

  it("reports the simulated runtime and the configured pricing honestly", async () => {
    const subject = await project();
    const report = await doctorOn(subject.root);

    const runtime = checkById(report, "agent-runtime");
    expect(runtime.status).toBe("warn");
    expect(runtime.detail).toContain("simulated");
    expect(runtime.detail).toContain("no real agent runtime");

    const pricing = checkById(report, "llm-pricing");
    expect(pricing.status).toBe("ok");
    expect(pricing.detail).toContain("rate(s) configured");
  });

  it("reconstructs a trace for a recorded task", async () => {
    const subject = await project();
    const stored = await subject.runtime.tasks.create(
      {
        title: "Recorded task",
        description: "Has events",
        acceptanceCriteria: ["Events are recorded"],
      },
      {
        project: subject.runtime.project,
        workspace: subject.runtime.workspace,
      },
    );
    await subject.runtime.runTask.run(stored);

    const report = await doctorOn(subject.root);
    const trace = checkById(report, "trace");
    expect(trace.status).toBe("ok");
    expect(trace.detail).toContain(stored.task.id);
    expect(trace.detail).toContain('status "review"');
  });

  it("flags an inconsistent log rather than printing a green tick", async () => {
    const subject = await project();
    const stored = await subject.runtime.tasks.create(
      { title: "Recorded task", description: "Has events" },
      {
        project: subject.runtime.project,
        workspace: subject.runtime.workspace,
      },
    );
    // A model request that never completed: a torn write.
    await subject.runtime.sessions.start(
      (
        await subject.runtime.tasks.load(
          { projectId: subject.runtime.project.id },
          stored.task.id,
        )
      ).task,
    );

    const report = await doctorOn(subject.root);
    expect(checkById(report, "trace").status).toBe("fail");
    expect(report.exitCode).toBe(1);
  });
});

describe("ai doctor: a broken foundation", () => {
  it("fails and points at `ai init` when there is no project configuration", async () => {
    const root = await emptyDirectory();
    const report = await doctorOn(root);

    expect(report.exitCode).toBe(1);
    expect(report.status).toBe("fail");
    const config = checkById(report, "project-config");
    expect(config.status).toBe("fail");
    expect(config.detail).toContain("ai init");
    // Nothing else is claimed once the project cannot be opened.
    expect(report.checks.map((check) => check.id)).toEqual([
      "runtime",
      "project-config",
    ]);
  });

  it("fails on a project configuration that is not valid JSON", async () => {
    const subject = await project();
    await writeFile(projectConfigPath(subject.root), "{ not json", "utf8");

    const report = await doctorOn(subject.root);
    expect(report.exitCode).toBe(1);
    expect(checkById(report, "project-config").detail).toContain(
      "not valid JSON",
    );
  });

  it("fails on a configuration whose workspace belongs to another project", async () => {
    const subject = await project();
    const path = projectConfigPath(subject.root);
    const config = JSON.parse(await readFile(path, "utf8"));
    config.workspaces[0].projectId = "prj-somewhere-else";
    await writeFile(path, JSON.stringify(config, null, 2), "utf8");

    const report = await doctorOn(subject.root);
    expect(report.exitCode).toBe(1);
    expect(checkById(report, "project-config").status).toBe("fail");
  });

  it("fails on a runtime older than the platform baseline", async () => {
    const subject = await project();
    const report = await doctorOn(subject.root, {
      runtimeVersion: `v${MINIMUM_NODE_MAJOR - 4}.0.0`,
    });

    expect(report.exitCode).toBe(1);
    const runtime = checkById(report, "runtime");
    expect(runtime.status).toBe("fail");
    expect(runtime.detail).toContain(
      `upgrade to Node >= ${MINIMUM_NODE_MAJOR}`,
    );
  });

  it("warns but still passes on a runtime below the pinned patch line", async () => {
    const subject = await project();
    const report = await doctorOn(subject.root, {
      runtimeVersion: `v${MINIMUM_NODE_MAJOR}.0.0`,
    });

    expect(report.exitCode).toBe(0);
    const runtime = checkById(report, "runtime");
    expect(runtime.status).toBe("warn");
    expect(runtime.detail).toContain("pins");
  });

  it("warns when the runtime version cannot be parsed", async () => {
    const subject = await project();
    const report = await doctorOn(subject.root, {
      runtimeVersion: "who knows",
    });

    expect(checkById(report, "runtime").status).toBe("warn");
    expect(report.exitCode).toBe(0);
  });
});

describe("ai doctor: summary and rendering", () => {
  it("takes the worst status and counts failures and warnings", () => {
    const report = summarize("/srv/demo", [
      { id: "a", title: "A", status: "ok" },
      { id: "b", title: "B", status: "warn" },
      { id: "c", title: "C", status: "fail" },
    ]);

    expect(report.status).toBe("fail");
    expect(report.failures).toBe(1);
    expect(report.warnings).toBe(1);
    expect(report.exitCode).toBe(1);
    expect(report.projectRoot).toBe("/srv/demo");
  });

  it("passes with warnings alone", () => {
    const report = summarize("/srv/demo", [
      { id: "a", title: "A", status: "warn" },
    ]);
    expect(report.status).toBe("warn");
    expect(report.exitCode).toBe(0);
  });

  it("renders a deterministic report", async () => {
    const subject = await project();
    const report = await doctorOn(subject.root);
    const text = formatDoctorReport(report);

    expect(text).toContain(`ai doctor — ${subject.root}`);
    expect(text).toContain("[ok] Event store append/read");
    expect(text).toContain("[warn] Agent runtime");
    // Two honest warnings on a fresh project: no real agent runtime is installed,
    // and the workspace has no readable file yet, so every selection would be empty.
    expect(text).toContain("[warn] Context discovery");
    expect(text).toContain("0 failed, 2 warning(s)");
    expect(text).toContain("[ok] Context selection");
    expect(formatDoctorReport(report)).toBe(text);
  });
});
