import type { ContextBundle } from "../context/selection.js";
import type { DecisionId } from "../core/ids.js";
import type { AIUsage } from "../observability/usage.js";
import type {
  LlmContentPresence,
  LlmFailureKind,
} from "./llm-provider.js";
import type { OperationKind } from "../decisions/risk.js";
import type {
  DecisionAnswerSource,
  ToolCandidate,
} from "../decisions/domains.js";
import type { Capability } from "../policy/capability.js";
import type { PolicyReasonCode } from "../policy/reason.js";
import type { OperationGateway } from "./operation.js";
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
/**
 * The tool identities this platform's runtimes use.
 *
 * Declared here rather than in an adapter because they are part of the runner
 * contract: a decision layer chooses among tools by id, and the id has to mean the
 * same thing to whoever executes it.
 */
export const LIST_WORKSPACE_TOOL = "list-workspace-files";
export const READ_SELECTED_FILE_TOOL = "read-selected-file";

/**
 * The deterministic tool set for one attempt.
 *
 * Produced by the application from the capability envelope and the selected context,
 * and handed to the runner. The runner executes from this set and cannot extend it.
 */
export interface AgentToolPlan {
  readonly candidates: readonly ToolCandidate[];
  /** Assumed when no decision layer answers; must be one of the candidates. */
  readonly defaultToolId: string;
}

/** One tool selection, as answered and recorded. */
export interface AgentToolSelection {
  readonly toolId: string;
  readonly source: DecisionAnswerSource;
  readonly decisionId: DecisionId;
  readonly reasonCode?: string;
}

/**
 * The only decision question a runner may ask on its own.
 *
 * Deliberately narrow: routing, risk, retry, completion and escalation are
 * *attempt-level* questions owned by the use case, which knows the budget and the
 * task state. A runner that could ask those would be a runner that decides its own
 * retries and completion, which is exactly the autonomy this architecture refuses
 * (ADR-055).
 */
export interface AgentDecisionPort {
  selectTool(plan: AgentToolPlan): Promise<AgentToolSelection>;
}

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
  /**
   * The enforcement boundary for this attempt: the runner's only way to touch the
   * world.
   *
   * A runner must not hold `fs`, `child_process`, `fetch` or `process.env`. It
   * requests an operation, the gateway evaluates policy against it, and only then
   * does the sandbox act (ADR-045). When this is absent, a runner performs **no**
   * operation at all: a runtime without a gateway is a runtime with no authority,
   * which is the fail-closed reading of a missing boundary rather than a licence to
   * reach the host directly.
   */
  readonly operations?: OperationGateway;
  /**
   * The tools this attempt may use, when the application computed a tool set.
   *
   * Absent means "use the runtime's own default operation", which is what a runner
   * constructed without an application-level plan does.
   */
  readonly tools?: AgentToolPlan;
  /**
   * Where to ask which allowed tool to use.
   *
   * Absent means the runner uses `tools.defaultToolId` and records no decision. A
   * runner cannot answer this question itself: it has no policy, no envelope and no
   * budget, so its own answer would be an unchecked guess.
   */
  readonly decisions?: AgentDecisionPort;
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
  /** What a 2xx body carried, for `malformed-response` (structure only). */
  readonly contentPresence?: LlmContentPresence;
  readonly latencyMs?: number;
}

/** One tool invocation reported by the runtime. */
export interface AgentToolStep {
  readonly kind: "tool";
  readonly toolId: string;
  readonly operation: OperationKind;
  readonly ok: boolean;
  readonly latencyMs: number;
  /** Which layer chose this tool, when a decision was recorded for it. */
  readonly selectionSource?: DecisionAnswerSource;
  readonly decisionId?: DecisionId;
  readonly reasonCode?: string;
  /** The capability the operation was evaluated under, when it went through one. */
  readonly capability?: Capability;
  /** The gateway's operation id for an operation that was authorised. */
  readonly operationId?: string;
  /**
   * Why the enforcement layer refused, when it did.
   *
   * A refusal is reported as part of the step rather than thrown, for the same
   * reason a provider failure is: the attempt keeps a truthful record of what it
   * asked for and what the boundary answered. `requiresApproval` distinguishes a
   * suspension (a human can unblock it) from a denial (nothing can).
   */
  readonly refusal?: AgentToolRefusal;
}

export interface AgentToolRefusal {
  readonly reasonCode: PolicyReasonCode;
  readonly requiresApproval: boolean;
  /** The grant a human must issue, when the refusal is a suspension. */
  readonly approvalRequestId?: string;
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
