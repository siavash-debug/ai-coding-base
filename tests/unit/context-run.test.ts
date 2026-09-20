import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { eventsDirectory } from "../../src/adapters/storage/layout.js";
import type { StoredTask } from "../../src/ports/task-repository.js";
import { createFakeProvider } from "../support/llm.js";
import { createTestProject, type TestProject } from "../support/project.js";

/**
 * The Phase E vertical slice: Task → ContextSelection → LLM call → usage.
 *
 * These run against a real project on disk, because the claim being tested is
 * end-to-end: the *selected file's content* has to reach the provider, while the
 * *event log* has to record only the selection's metadata. A fake reader could not
 * prove either half of that.
 */
const projects: TestProject[] = [];

const MARKER = "SELECTED-CONTEXT-MARKER-9f3a";

async function writeFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [ref, content] of Object.entries(files)) {
    const path = join(root, ...ref.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

async function project(options?: {
  readonly provider?: ReturnType<typeof createFakeProvider>;
}): Promise<TestProject> {
  const created = await createTestProject(
    options?.provider === undefined ? {} : { provider: options.provider },
  );
  projects.push(created);
  return created;
}

async function createTask(
  subject: TestProject,
  input: {
    readonly context?: readonly string[];
    readonly maxTokens?: number;
  } = {},
): Promise<StoredTask> {
  return subject.runtime.tasks.create(
    {
      title: "Rework the engine parser",
      description: "Make the engine read the new fixture format.",
      context: input.context ?? [],
      acceptanceCriteria: ["The engine parses the fixture"],
      budget: {
        ...(input.maxTokens === undefined
          ? {}
          : { maxTokens: input.maxTokens }),
      },
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

/** The raw bytes of the workspace's event log, for leak assertions. */
async function rawLog(subject: TestProject): Promise<string> {
  const directory = eventsDirectory(subject.root);
  const files = await readdir(directory);
  const contents = await Promise.all(
    files.map((file) => readFile(join(directory, file), "utf8")),
  );
  return contents.join("\n");
}

afterEach(async () => {
  while (projects.length > 0) {
    await projects.pop()?.cleanup();
  }
});

describe("run: context selection is part of the recorded chain", () => {
  it("selects, records, and passes the selected content to the provider", async () => {
    const provider = createFakeProvider([
      { usage: { inputTokens: 900, outputTokens: 120, cachedInputTokens: 0 } },
    ]);
    const subject = await project({ provider });
    await writeFiles(subject.root, {
      "src/engine.ts": `export const engine = "${MARKER}";\n`,
      "src/engine.test.ts": "import './engine.js';\n",
      ".env": `SECRET=${MARKER}\n`,
    });
    const stored = await createTask(subject, { context: ["src/engine.ts"] });

    const result = await subject.runtime.runTask.run(stored);
    expect(result.outcome).toBe("awaiting-review");
    expect(provider.requests).toHaveLength(1);

    // The content reached the request...
    const prompt = provider.requests[0].messages
      .map((message) => message.content)
      .join("\n");
    expect(prompt).toContain(MARKER);
    expect(prompt).toContain("src/engine.ts");
    // ...and nothing else did: the selection is the only source of file text.
    expect(prompt).not.toContain("SECRET=");

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.integrity.ok, trace.integrity.issues.join("; ")).toBe(true);
    expect(trace.contextSelections).toHaveLength(1);
    const selection = trace.contextSelections[0];
    expect(selection.complete).toBe(true);
    expect(selection.strategy).toBe("deterministic");
    expect(selection.selectionVersion).toBe(1);
    expect(selection.budgetTokens).toBe(8_000);
    expect(selection.selectedTokens).toBeGreaterThan(0);
    expect(selection.remainingTokens).toBe(
      (selection.budgetTokens ?? 0) - (selection.selectedTokens ?? 0),
    );
    expect(selection.selected.map((candidate) => candidate.ref)).toContain(
      "src/engine.ts",
    );
    expect(
      selection.selected.find((candidate) => candidate.ref === "src/engine.ts")
        ?.reasons,
    ).toContain("explicit-path");
    // Secret-shaped paths are excluded by rule, never read.
    for (const candidate of [...selection.selected, ...selection.excluded]) {
      expect(candidate.ref).not.toBe(".env");
    }

    // The session counts the selection, so a per-session view shows context work.
    expect(trace.sessions[0]?.contextSelections).toBe(1);
  });

  it("ties every model call to the selection that built its prompt", async () => {
    const provider = createFakeProvider([
      { usage: { inputTokens: 900, outputTokens: 120, cachedInputTokens: 0 } },
    ]);
    const subject = await project({ provider });
    await writeFiles(subject.root, {
      "src/engine.ts": "export const engine = 1;\n",
    });
    const stored = await createTask(subject, { context: ["src/engine.ts"] });
    await subject.runtime.runTask.run(stored);

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    const selection = trace.contextSelections[0];
    const started = trace.events.find(
      (event) => event.type === "LLMRequestStarted",
    );
    expect(started).toBeDefined();
    if (started?.type !== "LLMRequestStarted") {
      throw new Error("expected an LLMRequestStarted event");
    }
    expect(started.payload.contextSelectionId).toBe(selection.selectionId);
    expect(started.payload.contextSelectionVersion).toBe(
      selection.selectionVersion,
    );
    expect(started.payload.contextSelectedTokens).toBe(
      selection.selectedTokens,
    );
  });

  it("records the two context events against the task and the session", async () => {
    const subject = await project();
    await writeFiles(subject.root, {
      "src/engine.ts": "export const engine = 1;\n",
    });
    const stored = await createTask(subject, { context: ["src/engine.ts"] });
    await subject.runtime.runTask.run(stored);

    const events = await subject.runtime.store.readByTask(
      scopeOf(subject),
      stored.task.id,
    );
    const types = events.map((event) => event.type);
    expect(types.indexOf("ContextSelectionStarted")).toBe(
      types.indexOf("SessionStarted") + 1,
    );
    expect(types.indexOf("ContextSelected")).toBe(
      types.indexOf("ContextSelectionStarted") + 1,
    );
    expect(types.indexOf("ContextSelected")).toBeLessThan(
      types.indexOf("LLMRequestStarted"),
    );

    for (const event of events) {
      if (
        event.type === "ContextSelectionStarted" ||
        event.type === "ContextSelected"
      ) {
        expect(event.taskId).toBe(stored.task.id);
        expect(event.sessionId).toBeDefined();
        expect(event.actor).toEqual({
          type: "system",
          id: "deterministic-context-engine",
        });
      }
    }
  });

  it("never writes selected file content into the event log", async () => {
    const subject = await project();
    await writeFiles(subject.root, {
      "src/engine.ts": `export const engine = "${MARKER}";\n`,
    });
    const stored = await createTask(subject, { context: ["src/engine.ts"] });
    await subject.runtime.runTask.run(stored);

    const log = await rawLog(subject);
    expect(log).toContain("ContextSelected");
    expect(log).toContain("src/engine.ts");
    expect(log).not.toContain(MARKER);
  });
});

describe("run: metrics derived from the context events", () => {
  it("reports selection counts, tokens and ratio without claiming usefulness", async () => {
    const subject = await project();
    await writeFiles(subject.root, {
      "src/engine.ts": "export const engine = 1;\n",
      "src/engine.test.ts": "import './engine.js';\n",
      "src/other.ts": "export const other = 2;\n",
    });
    const stored = await createTask(subject, { context: ["src/engine.ts"] });
    await subject.runtime.runTask.run(stored);

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    const metrics = trace.metrics;
    expect(metrics.contextSelections).toBe(1);
    expect(metrics.contextCandidates).toBeGreaterThan(0);
    // Three files, each for a reason the trace can name: the referenced engine, the
    // test beside it, and the directory neighbour that filled the remaining budget.
    const selection = trace.contextSelections[0];
    expect(
      selection?.selected.map((candidate) => candidate.ref).sort(),
    ).toEqual(["src/engine.test.ts", "src/engine.ts", "src/other.ts"]);
    expect(metrics.contextSelected).toBe(3);
    expect(metrics.contextExcluded).toBe(0);
    expect(metrics.contextSelectedTokens).toBe(selection?.selectedTokens);
    expect(metrics.contextCandidateTokens).toBe(selection?.candidateTokens);
    expect(metrics.contextSelectionRatio).toBeCloseTo(
      (selection?.selectedTokens ?? 0) / (selection?.candidateTokens ?? 1),
      6,
    );
    expect(metrics.contextSelectionRatio).toBeGreaterThan(0);
    expect(metrics.contextSelectionRatio).toBeLessThanOrEqual(1);
    expect(metrics.contextOverBudgetSelections).toBe(0);
    expect(metrics.contextBudgetTokens).toBe(8_000);
    expect(metrics.contextExcludedTokens).toBeGreaterThanOrEqual(0);
  });

  it("derives the numbers from the events, not from a parallel counter", async () => {
    const subject = await project();
    await writeFiles(subject.root, {
      "src/engine.ts": "export const engine = 1;\n",
    });
    const stored = await createTask(subject, { context: ["src/engine.ts"] });
    await subject.runtime.runTask.run(stored);

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    const completed = trace.events.find(
      (event) => event.type === "ContextSelected",
    );
    expect(completed?.type).toBe("ContextSelected");
    if (completed?.type !== "ContextSelected") {
      throw new Error("expected a ContextSelected event");
    }
    expect(trace.metrics.contextSelectedTokens).toBe(
      completed.payload.selectedTokens,
    );
    expect(trace.metrics.contextCandidates).toBe(completed.payload.considered);
    expect(trace.metrics.contextSelected).toBe(
      completed.payload.selectedRefs.length,
    );
  });
});

describe("run: the context budget gate stops the run before money is spent", () => {
  it("fails the task loudly when the referenced file cannot fit", async () => {
    const provider = createFakeProvider([
      { usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 } },
    ]);
    const subject = await project({ provider });
    await writeFiles(subject.root, {
      // ~2,000 tokens by estimate; the task declares a 20-token budget.
      "src/engine.ts": "export const engine = 1;\n".repeat(400),
    });
    const stored = await createTask(subject, {
      context: ["src/engine.ts"],
      maxTokens: 20,
    });

    const result = await subject.runtime.runTask.run(stored);

    expect(result.outcome).toBe("context-budget-exceeded");
    expect(result.task.status).toBe("failed");
    expect(result.session?.status).toBe("aborted");
    expect(result.reason).toContain("context budget exceeded");
    // Nothing was spent: no provider call, and therefore no LLM events.
    expect(provider.requests).toHaveLength(0);

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.llmCalls).toHaveLength(0);
    expect(
      trace.events.some((event) => event.type === "LLMRequestStarted"),
    ).toBe(false);
    expect(trace.contextSelections[0]?.budgetExceeded).toBe(true);
    expect(trace.contextSelections[0]?.overBudgetTokens).toBeGreaterThan(0);
    expect(trace.metrics.contextOverBudgetSelections).toBe(1);
    expect(trace.integrity.ok, trace.integrity.issues.join("; ")).toBe(true);
  });

  it("uses the task's own token budget as the context bound", async () => {
    const subject = await project();
    await writeFiles(subject.root, {
      "src/engine.ts": "export const engine = 1;\n",
    });
    const stored = await createTask(subject, {
      context: ["src/engine.ts"],
      maxTokens: 4_000,
    });
    await subject.runtime.runTask.run(stored);

    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    // The smaller of the project's context budget and the task's own spend budget.
    expect(trace.contextSelections[0]?.budgetTokens).toBe(4_000);
  });

  it("does not fail a run whose task names a file that does not exist", async () => {
    const subject = await project();
    await writeFiles(subject.root, {
      "src/engine.ts": "export const engine = 1;\n",
    });
    const stored = await createTask(subject, { context: ["src/absent.ts"] });

    const result = await subject.runtime.runTask.run(stored);

    // A missing reference is not a budget problem: the selection simply has no
    // candidate for it, and the run proceeds with what it can find.
    expect(result.outcome).toBe("awaiting-review");
    const trace = await subject.runtime.traces.read(
      scopeOf(subject),
      stored.task.id,
    );
    expect(trace.contextSelections).toHaveLength(1);
    expect(trace.contextSelections[0]?.budgetExceeded).toBe(false);
  });
});
