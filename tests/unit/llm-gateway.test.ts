import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertLlmConfig } from "../../src/adapters/config/project-config.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "../../src/adapters/llm/openai-compatible-provider.js";
import { eventsDirectory } from "../../src/adapters/storage/layout.js";
import { createFixedEnvironment } from "../../src/ports/environment.js";
import type { StoredTask } from "../../src/ports/task-repository.js";
import {
  type TestProject,
  createTestProject,
  createTickingClock,
} from "../support/project.js";
import { chatCompletionBody, createFakeTransport } from "../support/llm.js";

/**
 * The LLM gateway: configuration, provider selection, and the real adapter driven
 * end to end.
 *
 * The last test is the one that matters most — a full task run through the *real*
 * OpenAI-compatible adapter, with the transport scripted and the credential read
 * from a fixed environment. It is deterministic and offline, and it asserts both
 * that the accounting is honest (unpriced stays unpriced) and that no credential
 * material reached the event log.
 */
const FIXTURE_KEY = "sk-test-fixture-abcdefghijklmnop";
const BASE_URL = "https://fixture.invalid/v1";
const projects: TestProject[] = [];

afterEach(async () => {
  while (projects.length > 0) {
    await rm((projects.pop() as TestProject).root, {
      recursive: true,
      force: true,
    });
  }
});

function tracked(project: TestProject): TestProject {
  projects.push(project);
  return project;
}

describe("llm configuration validation", () => {
  it("defaults to the offline provider when the block is absent", () => {
    expect(assertLlmConfig(undefined)).toEqual({ provider: "simulated" });
  });

  it("requires a base URL, a model and a credential variable for a real provider", () => {
    for (const missing of ["baseUrl", "modelId", "credentialEnvVar"]) {
      const candidate: Record<string, unknown> = {
        provider: "openai-compatible",
        baseUrl: BASE_URL,
        modelId: "m",
        credentialEnvVar: "SOME_KEY",
      };
      delete candidate[missing];
      expect(() => assertLlmConfig(candidate)).toThrowError(
        new RegExp(`config\\.llm\\.${missing}`),
      );
    }
  });

  it("rejects a base URL that embeds credentials", () => {
    expect(() =>
      assertLlmConfig({
        provider: "openai-compatible",
        baseUrl: "https://user:secret@fixture.invalid/v1",
        modelId: "m",
        credentialEnvVar: "SOME_KEY",
      }),
    ).toThrowError(/must not embed credentials/);
  });

  it("rejects a credential field that holds a value rather than a variable name", () => {
    expect(
      () =>
        assertLlmConfig({
          provider: "openai-compatible",
          baseUrl: BASE_URL,
          modelId: "m",
          credentialEnvVar: FIXTURE_KEY,
        }),
      // Either rejection is correct, and both are loud: a pasted key is caught as
      // secret material, and any other value is caught as not being a variable name.
    ).toThrowError(/secret material|NAME of the environment variable/);
  });

  it("bounds attempts and timeouts so retries stay bounded by construction", () => {
    expect(() =>
      assertLlmConfig({
        provider: "openai-compatible",
        baseUrl: BASE_URL,
        modelId: "m",
        credentialEnvVar: "SOME_KEY",
        maxAttempts: 99,
      }),
    ).toThrowError(/maxAttempts must be at most/);
    expect(() =>
      assertLlmConfig({
        provider: "openai-compatible",
        baseUrl: BASE_URL,
        modelId: "m",
        credentialEnvVar: "SOME_KEY",
        timeoutMs: 0,
      }),
    ).toThrowError(/greater than zero/);
  });

  it("accepts a well-formed real provider configuration", () => {
    const config = assertLlmConfig({
      provider: "openai-compatible",
      baseUrl: BASE_URL,
      modelId: "fixture-model",
      credentialEnvVar: "FIXTURE_API_KEY",
      maxAttempts: 2,
      timeoutMs: 5_000,
    });
    expect(config).toEqual({
      provider: "openai-compatible",
      baseUrl: BASE_URL,
      modelId: "fixture-model",
      credentialEnvVar: "FIXTURE_API_KEY",
      maxAttempts: 2,
      timeoutMs: 5_000,
    });
  });
});

describe("runtime provider selection", () => {
  it("uses the offline provider when nothing is configured", async () => {
    const subject = tracked(await createTestProject());
    expect(subject.runtime.llm.provider).toBe("simulated");
    expect(subject.runtime.providerId).toBe("deterministic");
  });

  it("constructs the configured real provider and fails with auth before any call", async () => {
    const subject = tracked(
      await createTestProject({
        clock: createTickingClock(),
        llm: {
          provider: "openai-compatible",
          baseUrl: BASE_URL,
          modelId: "fixture-model",
          credentialEnvVar: "AI_TEST_UNSET_KEY",
        },
        environment: createFixedEnvironment({}),
        // No transport is needed: the adapter refuses before it would send.
        transport: createFakeTransport([]),
      }),
    );
    expect(subject.runtime.llm.provider).toBe("openai-compatible");
    expect(subject.runtime.providerId).toBe(OPENAI_COMPATIBLE_PROVIDER_ID);

    const stored = await createTask(subject);
    const result = await subject.runtime.runTask.run(stored);
    expect(result.outcome).toBe("provider-failed");
    expect(result.reason).toContain("auth");
    // Bounded: an auth failure is not retried.
    expect(result.reason).toContain("1 attempt");

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.llmFailures[0].failureKind).toBe("auth");
    expect(trace.metrics.llmCalls).toBe(0);
    expect(trace.metrics.failedLlmCalls).toBe(1);

    const raw = await readEventLog(subject);
    expect(raw).not.toContain("AI_TEST_UNSET_KEY");
  });
});

describe("a real provider run, offline and fully accounted", () => {
  it("runs the task through the real adapter and reports everything it measured", async () => {
    const transport = createFakeTransport([jsonBody(), jsonBody(), jsonBody()]);
    const subject = tracked(
      await createTestProject({
        clock: createTickingClock(),
        llm: {
          provider: "openai-compatible",
          baseUrl: BASE_URL,
          modelId: "fixture-model",
          credentialEnvVar: "FIXTURE_API_KEY",
          maxAttempts: 2,
        },
        environment: createFixedEnvironment({ FIXTURE_API_KEY: FIXTURE_KEY }),
        transport,
      }),
    );

    const stored = await createTask(subject);
    const result = await subject.runtime.runTask.run(stored);
    expect(result.outcome, result.reason).toBe("awaiting-review");

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.integrity.ok).toBe(true);
    expect(trace.llmCalls).toHaveLength(1);
    const call = trace.llmCalls[0];
    expect(call.providerId).toBe(OPENAI_COMPATIBLE_PROVIDER_ID);
    expect(call.modelId).toBe("fixture-model");
    expect(call.usage.inputTokens).toBe(1200);
    expect(call.usage.outputTokens).toBe(300);
    expect(call.usageReported).toBe(true);
    expect(call.latencyMs).toBeGreaterThan(0);
    expect(call.requestId).toBe("req-fixture-1");
    expect(trace.metrics.providerAttempts).toBe(1);

    // No rate is configured for this provider, so cost is *unavailable* — never a
    // fabricated zero.
    expect(call.cost).toBeUndefined();
    expect(trace.metrics.unpricedCalls).toBe(1);
    expect(trace.metrics.costComplete).toBe(false);
    expect(trace.metrics.cost.micros).toBe(0);

    // The gateway really sent a request, and really authenticated it.
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0].headers["authorization"]).toBe(
      `Bearer ${FIXTURE_KEY}`,
    );

    // …and none of that material is in the record.
    const raw = await readEventLog(subject);
    expect(raw).not.toContain(FIXTURE_KEY);
    expect(raw.toLowerCase()).not.toContain("bearer");
    expect(raw).not.toContain("authorization");
    expect(raw).not.toContain("fixture.invalid");
    // Prompts and completions are not persisted either.
    expect(raw).not.toContain("bounded engineering agent");
    expect(raw).not.toContain(COMPLETION_SENTINEL);
  });
});

/**
 * A completion whose text is unmistakable, so "was this persisted?" is answerable
 * without matching on generic words.
 */
const COMPLETION_SENTINEL = "COMPLETION-SENTINEL-7f3a";

function jsonBody() {
  return {
    status: 200,
    headers: {},
    body: chatCompletionBody({
      model: "fixture-model",
      content: COMPLETION_SENTINEL,
    }),
  };
}

/** Reads the raw event log for the project's workspace, as text. */
async function readEventLog(subject: TestProject): Promise<string> {
  return readFile(
    join(
      eventsDirectory(subject.root),
      `${subject.runtime.workspace.id}.jsonl`,
    ),
    "utf8",
  );
}

async function createTask(subject: TestProject): Promise<StoredTask> {
  return subject.runtime.tasks.create(
    {
      title: "Add retry to the deploy poller",
      description: "Bound the retries.",
      acceptanceCriteria: ["Retries are bounded"],
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
