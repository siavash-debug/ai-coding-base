import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertProviderCredentials,
  credentialReport,
  missingCredentialMessage,
  providerCredentialRequirements,
} from "../../src/application/credential-preflight.js";
import {
  DEFAULT_DECISION_CONFIG,
  DEFAULT_FRONTIER_CONFIG,
  type DecisionConfig,
  type FrontierConfig,
  type LlmConfig,
} from "../../src/adapters/config/project-config.js";
import { eventsDirectory } from "../../src/adapters/storage/layout.js";
import { main } from "../../src/cli/main.js";
import { createFixedClock } from "../../src/core/clock.js";
import type { CliEnv, CliIo } from "../../src/cli/io.js";
import { createFixedEnvironment } from "../../src/ports/environment.js";
import { createTestProject, type TestProject } from "../support/project.js";

/**
 * The credential preflight: what a runtime needs, and how it says so.
 *
 * Every credential name used here is invented and absent from any real environment,
 * and every host is a reserved non-resolving name. A test in this file therefore
 * cannot reach a provider even if the preflight were broken — the failure would be a
 * categorised `auth` or `network` error, not a live call with someone's key.
 */

const ABSENT_LLM_VARIABLE = "AI_PREFLIGHT_ABSENT_LLM_KEY";
const ABSENT_FRONTIER_VARIABLE = "AI_PREFLIGHT_ABSENT_FRONTIER_KEY";
const FIXTURE_BASE_URL = "https://fixture.invalid/v1";

const REAL_LLM: LlmConfig = {
  provider: "openai-compatible",
  baseUrl: FIXTURE_BASE_URL,
  modelId: "fixture-model",
  credentialEnvVar: ABSENT_LLM_VARIABLE,
  maxAttempts: 1,
  timeoutMs: 1_000,
};

const ROUTING_FRONTIER: FrontierConfig = {
  enabled: true,
  providers: [
    {
      id: "fixture-provider",
      kind: "openai-compatible",
      baseUrl: FIXTURE_BASE_URL,
      credentialEnvVar: ABSENT_FRONTIER_VARIABLE,
      maxAttempts: 1,
      timeoutMs: 1_000,
    },
  ],
  models: [
    {
      modelId: "fixture/text-model",
      providerId: "fixture-provider",
      displayName: "Fixture text model",
      capabilities: ["general", "reasoning"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      toolCalling: false,
      structuredOutput: false,
      latencyClass: "fast",
      priority: 1,
      enabled: true,
      userOwned: false,
      health: "unknown",
    },
  ],
  routing: {
    mode: "balanced",
    allowDecomposition: false,
    allowParallel: false,
    maxModelCalls: 1,
    maxRetriesPerStep: 0,
  },
};

const OFFLINE_LLM: LlmConfig = { provider: "simulated" };

const TYPESAFE_DECISION: DecisionConfig = {
  provider: "typesafe",
  credentialEnvVar: "AI_PREFLIGHT_ABSENT_DECISION_KEY",
  maxDecisionsPerTask: 4,
  maxRetriesPerTask: 0,
};

const projects: TestProject[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) {
    await project.cleanup();
  }
});

async function testProject(options: {
  readonly llm?: LlmConfig;
  readonly frontier?: FrontierConfig;
}): Promise<TestProject> {
  const project = await createTestProject({
    ...(options.llm === undefined ? {} : { llm: options.llm }),
    ...(options.frontier === undefined
      ? {}
      : { frontierConfig: options.frontier }),
  });
  projects.push(project);
  return project;
}

interface Capture {
  readonly io: CliIo;
  readonly outText: () => string;
  readonly errText: () => string;
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    outText: () => out.join("\n"),
    errText: () => err.join("\n"),
  };
}

function cliEnv(root: string): CliEnv {
  return {
    cwd: root,
    clock: createFixedClock("2026-09-20T10:00:00.000Z"),
    runtimeVersion: "v24.21.0",
    platform: "test/test",
  };
}

/** Every recorded event, as text: what the log contains before and after a run. */
async function recordedEvents(root: string): Promise<string> {
  const directory = eventsDirectory(root);
  const files = (await readdir(directory)).sort();
  const contents = await Promise.all(
    files.map((file) => readFile(join(directory, file), "utf8")),
  );
  return contents.join("\n");
}

describe("credential requirements", () => {
  const base = {
    decision: DEFAULT_DECISION_CONFIG,
    frontier: DEFAULT_FRONTIER_CONFIG,
    frontierProviderIds: ["openrouter"],
  } as const;

  it("requires nothing from a project that calls nothing", () => {
    expect(
      providerCredentialRequirements({ ...base, llm: OFFLINE_LLM }),
    ).toEqual([]);
  });

  it("requires the LLM credential from a real provider", () => {
    expect(providerCredentialRequirements({ ...base, llm: REAL_LLM })).toEqual([
      {
        role: "llm",
        providerId: "openai-compatible",
        variable: ABSENT_LLM_VARIABLE,
      },
    ]);
  });

  it("requires the decision credential only when a layer is installed", () => {
    expect(
      providerCredentialRequirements({
        ...base,
        llm: OFFLINE_LLM,
        decision: TYPESAFE_DECISION,
        decisionProviderId: "typesafe",
      }),
    ).toEqual([
      {
        role: "decision",
        providerId: "typesafe",
        variable: "AI_PREFLIGHT_ABSENT_DECISION_KEY",
      },
    ]);

    // Configured, but nothing installed: the engine answers deterministically.
    expect(
      providerCredentialRequirements({
        ...base,
        llm: OFFLINE_LLM,
        decision: TYPESAFE_DECISION,
      }),
    ).toEqual([]);

    // Installed, but configuration says disabled: an embedding, not a credential.
    expect(
      providerCredentialRequirements({
        ...base,
        llm: OFFLINE_LLM,
        decision: DEFAULT_DECISION_CONFIG,
        decisionProviderId: "typesafe",
      }),
    ).toEqual([]);
  });

  it("requires a frontier credential only for a provider it could actually call", () => {
    const requirement = {
      role: "frontier",
      providerId: "fixture-provider",
      variable: ABSENT_FRONTIER_VARIABLE,
    };

    expect(
      providerCredentialRequirements({
        llm: OFFLINE_LLM,
        decision: DEFAULT_DECISION_CONFIG,
        frontier: ROUTING_FRONTIER,
        frontierProviderIds: ["fixture-provider"],
      }),
    ).toEqual([requirement]);

    // Routing enabled, but no adapter was built for that provider.
    expect(
      providerCredentialRequirements({
        llm: OFFLINE_LLM,
        decision: DEFAULT_DECISION_CONFIG,
        frontier: ROUTING_FRONTIER,
        frontierProviderIds: [],
      }),
    ).toEqual([]);

    // Routing enabled and wired, but nothing enabled to run: no requirement.
    expect(
      providerCredentialRequirements({
        llm: OFFLINE_LLM,
        decision: DEFAULT_DECISION_CONFIG,
        frontier: {
          ...ROUTING_FRONTIER,
          models: ROUTING_FRONTIER.models.map((model) => ({
            ...model,
            enabled: false,
          })),
        },
        frontierProviderIds: ["fixture-provider"],
      }),
    ).toEqual([]);

    // Routing disabled: a credential would pay for nothing.
    expect(
      providerCredentialRequirements({
        ...base,
        llm: OFFLINE_LLM,
        frontier: { ...ROUTING_FRONTIER, enabled: false },
      }),
    ).toEqual([]);
  });
});

describe("credential presence", () => {
  it("reports set or not set, and treats an empty value as not set", () => {
    const requirements = [
      { role: "llm" as const, providerId: "fixture", variable: "PRESENT_VAR" },
      { role: "llm" as const, providerId: "fixture", variable: "EMPTY_VAR" },
      { role: "llm" as const, providerId: "fixture", variable: "ABSENT_VAR" },
    ];
    const report = credentialReport(
      requirements,
      createFixedEnvironment({ PRESENT_VAR: "value", EMPTY_VAR: "" }),
    );

    expect(report.ok).toBe(false);
    expect(report.requirements.map((status) => status.present)).toEqual([
      true,
      false,
      false,
    ]);
    expect(report.missing.map((status) => status.variable)).toEqual([
      "EMPTY_VAR",
      "ABSENT_VAR",
    ]);
  });

  it("is ok when every requirement is present", () => {
    const report = credentialReport(
      [{ role: "frontier", providerId: "openrouter", variable: "ANY_VAR" }],
      createFixedEnvironment({ ANY_VAR: "value" }),
    );
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });
});

describe("the failure", () => {
  it("names providers and variables, and nothing else", () => {
    const report = credentialReport(
      [
        {
          role: "frontier",
          providerId: "openrouter",
          variable: ABSENT_FRONTIER_VARIABLE,
        },
      ],
      createFixedEnvironment({}),
    );

    expect(() => assertProviderCredentials(report)).toThrowError(
      new RegExp(`${ABSENT_FRONTIER_VARIABLE}, which is not set`),
    );

    const error = (() => {
      try {
        assertProviderCredentials(report, { hint: "see .env.local" });
      } catch (caught) {
        return caught as { code: string; message: string; details: unknown };
      }
      throw new Error("expected the preflight to refuse");
    })();

    expect(error.code).toBe("VALIDATION");
    expect(error.message).toContain('provider "openrouter" (frontier)');
    expect(error.message).toContain(ABSENT_FRONTIER_VARIABLE);
    expect(error.message).toContain("see .env.local");
    // No length, no fingerprint, no value: the message is safe to print anywhere.
    expect(error.message).not.toMatch(/character|length|ending|fingerprint/);
    expect(error.details).toEqual({
      field: "credentialEnvVar",
      variables: [ABSENT_FRONTIER_VARIABLE],
      providers: ["openrouter"],
    });
    expect(JSON.stringify(error.details)).not.toContain("value");
  });

  it("mentions the hint once, after the facts", () => {
    const missing = [
      {
        role: "llm" as const,
        providerId: "a",
        variable: "VAR_A",
        present: false,
      },
      {
        role: "frontier" as const,
        providerId: "b",
        variable: "VAR_B",
        present: false,
      },
    ];
    const message = missingCredentialMessage(missing, { hint: "set them" });
    expect(message.endsWith("set them")).toBe(true);
    expect(message.match(/set them/g)).toHaveLength(1);
    expect(message).toContain("VAR_A");
    expect(message).toContain("VAR_B");
  });

  it("passes when nothing is missing", () => {
    expect(() =>
      assertProviderCredentials(
        credentialReport(
          [{ role: "llm", providerId: "fixture", variable: "ANY_VAR" }],
          createFixedEnvironment({ ANY_VAR: "value" }),
        ),
      ),
    ).not.toThrow();
  });
});

describe("runtime wiring", () => {
  it("derives requirements from what the runtime actually built", async () => {
    const offline = await testProject({});
    expect(offline.runtime.credentialRequirements).toEqual([]);

    const real = await testProject({ llm: REAL_LLM });
    expect(real.runtime.credentialRequirements).toEqual([
      {
        role: "llm",
        providerId: "openai-compatible",
        variable: ABSENT_LLM_VARIABLE,
      },
    ]);

    const routing = await testProject({
      llm: OFFLINE_LLM,
      frontier: ROUTING_FRONTIER,
    });
    expect(routing.runtime.credentialRequirements).toEqual([
      {
        role: "frontier",
        providerId: "fixture-provider",
        variable: ABSENT_FRONTIER_VARIABLE,
      },
    ]);
    expect(routing.runtime.frontierProviders).toEqual(["fixture-provider"]);
  });
});

describe("cli fail-fast", () => {
  async function createTask(project: TestProject): Promise<string> {
    const io = capture();
    const exit = await main(
      ["task", "create", "--title", "Preflight", "--description", "nothing"],
      io.io,
      cliEnv(project.root),
    );
    expect(exit).toBe(0);
    const tasks = await project.runtime.repository.list({
      projectId: project.runtime.project.id,
    });
    return String(tasks[0]?.task.id);
  }

  it("refuses `ai task run` before the task is touched", async () => {
    const project = await testProject({ llm: REAL_LLM });
    const taskId = await createTask(project);
    const before = await recordedEvents(project.root);

    const io = capture();
    const exit = await main(
      ["task", "run", taskId],
      io.io,
      cliEnv(project.root),
    );

    expect(exit).toBe(1);
    expect(io.errText()).toContain(ABSENT_LLM_VARIABLE);
    expect(io.errText()).toContain("which is not set");
    expect(io.errText()).toContain(".env.local");
    expect(io.errText()).not.toMatch(/character|ending/);
    // Nothing ran: no session, no attempt, no model call was recorded.
    expect(await recordedEvents(project.root)).toBe(before);
  });

  it("refuses `ai task orchestrate` when the frontier credential is missing", async () => {
    const project = await testProject({
      llm: OFFLINE_LLM,
      frontier: ROUTING_FRONTIER,
    });
    const taskId = await createTask(project);
    const before = await recordedEvents(project.root);

    const io = capture();
    const exit = await main(
      ["task", "orchestrate", taskId],
      io.io,
      cliEnv(project.root),
    );

    expect(exit).toBe(1);
    expect(io.errText()).toContain(ABSENT_FRONTIER_VARIABLE);
    expect(io.errText()).toContain('provider "fixture-provider" (frontier)');
    expect(await recordedEvents(project.root)).toBe(before);
  });
});
