import type { ContextBundle } from "../context/selection.js";
import type { AIUsage } from "../observability/usage.js";
import type { LlmFailureKind } from "./llm-provider.js";
import type { OperationKind } from "../decisions/risk.js";
import type { Task } from "../tasks/task.js";
import type { Workspace } from "../workspaces/workspace.js";

/**
 * AgentRunner port: one bounded attempt at a task, reported as observable steps.
 *
 * This is the seam between the platform and whatever actually does the work. A
 * real agent loop, a coding CLI, or a remote service can implement it later; the
 * application layer only needs the step report, because its job is to record what
 * happened and to gate each step through policy and budgets.
 *
 * Phase C ships one implementation: a deterministic, offline, clearly-labelled
 * simulated runtime (see `adapters/agent/simulated-agent-runner.ts`). There is no
 * agent framework here and no vendor coupling.
 */
export interface AgentAttemptRequest {
  readonly task: Task;
  readonly workspace: Workspace;
  readonly providerId: string;
  readonly modelId: string;
  readonly correlationId: string;
  /**
   * The context selected for this attempt, when a context engine produced one.
   *
   * A runner builds its prompt from this and reports the selection id back on every
   * model turn, so the log can join *which files were chosen* to *what that call
   * cost* without either side storing prompt text. Content is passed in memory and
   * is never recorded (ADR-039).
   */
  readonly context?: ContextBundle;
  /** Free-text instruction the runner should treat as the task statement. */
  readonly instruction?: string;
}

export interface AgentContextReference {
  readonly contextSelectionId?: string;
  readonly contextSelectionVersion?: number;
  readonly contextSelectedTokens?: number;
}

/** One model turn. `retry` is 0 for the first attempt. */
export interface AgentLlmStep extends AgentContextReference {
  readonly kind: "llm";
  readonly messageCount: number;
  /** Zeroes when `usageReported` is false. */
  readonly usage: AIUsage;
  readonly usageReported: boolean;
  readonly latencyMs: number;
  readonly retry: number;
  readonly escalated: boolean;
  /** Transport attempts spent on this turn, including the successful one. */
  readonly attempts?: number;
  readonly requestId?: string;
}

/**
 * A model turn the provider did not complete.
 *
 * The runtime reports the failure as a *step* rather than throwing, so the
 * attempt keeps a truthful record of what it tried, how many attempts it spent and
 * why it stopped. A categorised failure is all that is recorded: the vendor's own
 * message never reaches an event (ADR-035).
 */
export interface AgentLlmFailureStep extends AgentContextReference {
  readonly kind: "llm-failure";
  readonly messageCount: number;
  readonly failureKind: LlmFailureKind;
  readonly attempts: number;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly latencyMs?: number;
}

/** One tool invocation reported by the runtime. */
export interface AgentToolStep {
  readonly kind: "tool";
  readonly toolId: string;
  readonly operation: OperationKind;
  readonly ok: boolean;
  readonly latencyMs: number;
}

/** One verification result reported by the runtime. */
export interface AgentTestStep {
  readonly kind: "test";
  readonly suite: string;
  readonly passed: number;
  readonly failed: number;
  readonly durationMs: number;
}

export type AgentStep =
  AgentLlmStep | AgentLlmFailureStep | AgentToolStep | AgentTestStep;

export interface AgentAttempt {
  readonly steps: readonly AgentStep[];
}

export interface AgentRunner {
  readonly id: string;
  /**
   * How much autonomy the runtime has. `simulated` means the steps describe a
   * deterministic offline stand-in, not real engineering work. `ai doctor`
   * reports this honestly.
   */
  readonly kind: "simulated" | "in-process" | "external";
  attempt(request: AgentAttemptRequest): Promise<AgentAttempt>;
}
