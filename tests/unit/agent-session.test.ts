import { describe, expect, it } from "vitest";
import { sessionId } from "../../src/core/ids.js";
import {
  createAgentSession,
  endAgentSession,
  isSessionActive,
  recordIteration,
  recordLlmCall,
  recordToolCall,
} from "../../src/sessions/agent-session.js";
import { expectDomainError } from "../support/errors.js";
import { createHarness } from "../support/harness.js";

function makeSession() {
  const { task, clock } = createHarness();
  return {
    session: createAgentSession(
      { agentId: "codebuff" },
      { id: sessionId("ses-1"), task, clock },
    ),
    task,
    clock,
  };
}

describe("createAgentSession", () => {
  it("is scoped to exactly one task and project", () => {
    const { session, task } = makeSession();
    expect(session).toEqual({
      id: "ses-1",
      taskId: task.id,
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      agentId: "codebuff",
      providerIds: [],
      modelIds: [],
      status: "active",
      iteration: 0,
      llmCalls: 0,
      toolCalls: 0,
      startedAt: task.createdAt,
    });
    expect(isSessionActive(session)).toBe(true);
  });

  it("requires an identified agent", () => {
    const { task, clock } = createHarness();
    expectDomainError(
      () =>
        createAgentSession(
          { agentId: "   " },
          { id: sessionId("ses-2"), task, clock },
        ),
      "VALIDATION",
    );
  });
});

describe("session counters", () => {
  it("counts iterations, llm calls and tool calls", () => {
    const { session } = makeSession();
    const counted = recordToolCall(
      recordLlmCall(
        recordLlmCall(recordIteration(session), {
          providerId: "anthropic",
          modelId: "claude-x",
        }),
        { providerId: "openai", modelId: "gpt-y" },
      ),
    );
    expect(counted.iteration).toBe(1);
    expect(counted.llmCalls).toBe(2);
    expect(counted.toolCalls).toBe(1);
  });

  it("registers used providers and models once, in order", () => {
    const { session } = makeSession();
    const call = { providerId: "anthropic", modelId: "claude-x" };
    const once = recordLlmCall(session, call);
    const twice = recordLlmCall(once, call);
    expect(twice.providerIds).toEqual(["anthropic"]);
    expect(twice.modelIds).toEqual(["claude-x"]);
    expect(twice.llmCalls).toBe(2);

    const switched = recordLlmCall(twice, {
      providerId: "openai",
      modelId: "gpt-y",
    });
    expect(switched.providerIds).toEqual(["anthropic", "openai"]);
    expect(switched.modelIds).toEqual(["claude-x", "gpt-y"]);
  });

  it("does not mutate the previous session value", () => {
    const { session } = makeSession();
    const next = recordIteration(session);
    expect(session.iteration).toBe(0);
    expect(next).not.toBe(session);
  });

  it("rejects an unidentified provider or model", () => {
    const { session } = makeSession();
    expectDomainError(
      () => recordLlmCall(session, { providerId: "", modelId: "m" }),
      "VALIDATION",
    );
    expectDomainError(
      () => recordLlmCall(session, { providerId: "p", modelId: "  " }),
      "VALIDATION",
    );
  });
});

describe("ending a session", () => {
  it("stamps the end time and terminal status", () => {
    const { session, clock } = makeSession();
    clock.advance(60_000);
    const ended = endAgentSession(session, "completed", clock);
    expect(ended.status).toBe("completed");
    expect(ended.endedAt).toBe("2026-09-20T10:01:00.000Z");
    expect(isSessionActive(ended)).toBe(false);
  });

  it("refuses further activity once ended", () => {
    const { session, clock } = makeSession();
    const ended = endAgentSession(session, "failed", clock);
    expectDomainError(() => recordIteration(ended), "INVARIANT");
    expectDomainError(() => recordToolCall(ended), "INVARIANT");
    expectDomainError(
      () => recordLlmCall(ended, { providerId: "p", modelId: "m" }),
      "INVARIANT",
    );
    expectDomainError(
      () => endAgentSession(ended, "aborted", clock),
      "INVARIANT",
    );
  });

  it("rejects a non-terminal status", () => {
    const { session, clock } = makeSession();
    expectDomainError(
      () => endAgentSession(session, "active" as unknown as "completed", clock),
      "VALIDATION",
    );
  });
});
