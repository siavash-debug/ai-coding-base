import { durationMsFrom } from "../core/clock.js";
import type { TaskId } from "../core/ids.js";
import { assertNonNegativeInteger } from "../core/validation.js";
import type { DecidedBy, DecisionOutcome } from "../decisions/decision.js";
import type { DecisionAnswerSource } from "../decisions/domains.js";
import { type Cost, addCost, formatCost, zeroCost } from "./cost.js";
import { type AIUsage, addUsage, emptyUsage, totalTokens } from "./usage.js";

/**
 * Task metrics, projected from per-call records.
 *
 * These numbers are generated from real events, never hand-entered.
 * See docs/architecture/V2-ARCHITECTURE.md §13.
 */
export interface LlmCallRecord {
  readonly providerId: string;
  readonly modelId: string;
  readonly usage: AIUsage;
  /**
   * False when the provider reported no usage. Defaults to true. A call with no
   * reported usage makes the cost incomplete; it is never counted as free.
   */
  readonly usageReported?: boolean;
  /** Absent when the model has no known rate: cost is unavailable, not zero. */
  readonly cost?: Cost;
  readonly latencyMs: number;
  /** 0 for the first attempt, 1 for the first retry, and so on. */
  readonly retry: number;
  /** Transport attempts spent on this call, including the successful one. */
  readonly attempts?: number;
  readonly escalated: boolean;
}

export interface DecisionRecordSummary {
  readonly decidedBy: DecidedBy;
  readonly outcome: DecisionOutcome;
  /** The bounded question that was answered, when the record knows it. */
  readonly kind?: string;
  readonly answeredBy?: DecisionAnswerSource;
  readonly fallbackReason?: string;
  /**
   * Tokens a decision provider reported for this decision.
   *
   * Absent when no usage was reported — which is the normal case for a decision
   * answered by code. Decision usage is reported separately from model-turn usage
   * rather than folded into it, so "what did the reasoning cost?" and "what did the
   * deciding cost?" stay different questions.
   */
  readonly usage?: AIUsage;
  readonly usageReported?: boolean;
  /** Absent when the decision has no known rate. Never a fabricated zero. */
  readonly cost?: Cost;
  readonly latencyMs?: number;
}

/**
 * One context selection, reduced to its counters.
 *
 * Deliberately does not carry the candidate list: metrics are aggregates, and a
 * metric that embedded a hundred paths would make every report a copy of the trace.
 * The per-candidate detail belongs to the trace, which is where someone actually
 * asks "why this file?".
 */
export interface ContextSelectionRecord {
  readonly budgetTokens: number;
  /** Size-estimated tokens over everything scored: "what was on the table". */
  readonly candidateTokens: number;
  /** Content-estimated tokens over what was selected: what was actually paid for. */
  readonly selectedTokens: number;
  readonly excludedTokens: number;
  readonly considered: number;
  readonly selected: number;
  readonly excluded: number;
  readonly durationMs: number;
  readonly budgetExceeded: boolean;
  /** Tokens of mandatory context the budget could not fit. */
  readonly overBudgetTokens: number;
}

export interface TaskMetricsInput {
  readonly taskId: TaskId;
  readonly llmCalls: readonly LlmCallRecord[];
  /** Model requests that produced a categorised failure instead of a response. */
  readonly llmFailures?: number;
  readonly toolCalls: number;
  readonly iterations: number;
  readonly decisions: readonly DecisionRecordSummary[];
  /** Decision consultations that failed, whether or not a fallback answered. */
  readonly decisionFailures?: number;
  readonly contextSelections?: readonly ContextSelectionRecord[];
  readonly startedAt: string;
  readonly endedAt?: string;
}

export interface TaskMetrics {
  readonly taskId: TaskId;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly totalTokens: number;
  readonly cost: Cost;
  /**
   * False when any call was unpriced or reported no usage. Incomplete means the
   * total is a lower bound: it is never presented as the whole truth.
   */
  readonly costComplete: boolean;
  readonly unpricedCalls: number;
  /** Calls whose provider reported no usage at all. */
  readonly usageUnavailableCalls: number;
  readonly llmCalls: number;
  /** Model requests that failed, by category. Never silently dropped. */
  readonly failedLlmCalls: number;
  /** Sum of transport attempts across successful calls, including the first. */
  readonly providerAttempts: number;
  /** Sum of per-call latencies for every LLM request in the task. */
  readonly llmLatencyMs: number;
  readonly toolCalls: number;
  /** Distinct context selections performed for this task. */
  readonly contextSelections: number;
  /** Files considered by the context engine across all selections. */
  readonly contextCandidates: number;
  readonly contextSelected: number;
  readonly contextExcluded: number;
  /** Tokens that were candidates: the denominator of the selection ratio. */
  readonly contextCandidateTokens: number;
  /** Tokens actually selected, as estimated from content. */
  readonly contextSelectedTokens: number;
  readonly contextExcludedTokens: number;
  /** Sum of the budgets the selections ran under. */
  readonly contextBudgetTokens: number;
  readonly contextSelectionLatencyMs: number;
  /** Selections where mandatory context did not fit — always needs attention. */
  readonly contextOverBudgetSelections: number;
  /**
   * `selectedTokens / candidateTokens`, or 0 when nothing was considered.
   *
   * Named for what it measures, not for what it hopes to imply: it says how much of
   * the considered context survived, which is *not* the same as usefulness. Nothing
   * here claims a file that was selected was needed.
   */
  readonly contextSelectionRatio: number;
  /** Model turns: LLM requests that were not retries. */
  readonly iterations: number;
  readonly retries: number;
  /**
   * Distinct escalation events: decisions resolved as `escalated` plus LLM calls
   * marked escalated.
   */
  readonly escalations: number;
  readonly decisions: number;
  readonly decisionsByProvider: number;
  /** Answers that came from the deterministic gate rather than from a provider. */
  readonly decisionsDeterministic: number;
  /** Answers that came from the deterministic fallback. */
  readonly decisionFallbacks: number;
  /** Consultations that failed. Kept apart from fallbacks on purpose. */
  readonly decisionFailures: number;
  /** Counts per decision kind, keys sorted so reports are comparable diff-to-diff. */
  readonly decisionsByKind: Readonly<Record<string, number>>;
  /** Sum of measured decision latency, including failed consultations. */
  readonly decisionLatencyMs: number;
  /** Tokens decisions reported. Separate from model-turn tokens. */
  readonly decisionUsage: AIUsage;
  readonly decisionTokens: number;
  /** Cost of decisions that could be priced. */
  readonly decisionCost: Cost;
  /** False when any consultation was unpriced or reported no usage. */
  readonly decisionCostComplete: boolean;
  readonly decisionUnpricedCalls: number;
  readonly decisionUsageUnavailableCalls: number;
  readonly open: boolean;
  readonly durationMs: number;
}

export function computeTaskMetrics(input: TaskMetricsInput): TaskMetrics {
  let usage = emptyUsage();
  let cost = zeroCost();
  let unpricedCalls = 0;
  let usageUnavailableCalls = 0;
  let retries = 0;
  let escalations = 0;
  let llmLatencyMs = 0;
  let providerAttempts = 0;

  for (const call of input.llmCalls) {
    usage = addUsage(usage, call.usage);
    if (call.cost === undefined) {
      unpricedCalls += 1;
    } else {
      cost = addCost(cost, call.cost);
    }
    if (call.usageReported === false) {
      usageUnavailableCalls += 1;
    }
    retries += assertNonNegativeInteger(call.retry, "llmCall.retry");
    llmLatencyMs += assertNonNegativeInteger(
      call.latencyMs,
      "llmCall.latencyMs",
    );
    providerAttempts += assertNonNegativeInteger(
      call.attempts ?? 1,
      "llmCall.attempts",
    );
    if (call.escalated) {
      escalations += 1;
    }
  }

  const selections = input.contextSelections ?? [];
  let contextCandidates = 0;
  let contextSelected = 0;
  let contextExcluded = 0;
  let contextCandidateTokens = 0;
  let contextSelectedTokens = 0;
  let contextExcludedTokens = 0;
  let contextBudgetTokens = 0;
  let contextSelectionLatencyMs = 0;
  let contextOverBudgetSelections = 0;
  for (const selection of selections) {
    contextCandidates += selection.considered;
    contextSelected += selection.selected;
    contextExcluded += selection.excluded;
    contextCandidateTokens += selection.candidateTokens;
    contextSelectedTokens += selection.selectedTokens;
    contextExcludedTokens += selection.excludedTokens;
    contextBudgetTokens += selection.budgetTokens;
    contextSelectionLatencyMs += selection.durationMs;
    if (selection.budgetExceeded) {
      contextOverBudgetSelections += 1;
    }
  }

  let decisionsByProvider = 0;
  let decisionsDeterministic = 0;
  let decisionFallbacks = 0;
  let decisionLatencyMs = 0;
  let decisionUsage = emptyUsage();
  let decisionCost = zeroCost();
  let decisionUnpricedCalls = 0;
  let decisionUsageUnavailableCalls = 0;
  const decisionsByKind = new Map<string, number>();
  for (const decision of input.decisions) {
    if (decision.outcome === "escalated") {
      escalations += 1;
    }
    if (decision.kind !== undefined) {
      decisionsByKind.set(
        decision.kind,
        (decisionsByKind.get(decision.kind) ?? 0) + 1,
      );
    }
    decisionLatencyMs += assertNonNegativeInteger(
      decision.latencyMs ?? 0,
      "decision.latencyMs",
    );
    const answeredBy: DecisionAnswerSource = answerSourceOf(decision);
    switch (answeredBy) {
      case "provider":
        decisionsByProvider += 1;
        if (decision.usage !== undefined) {
          decisionUsage = addUsage(decisionUsage, decision.usage);
        }
        if (decision.usageReported !== true) {
          // No usage was reported, so this consultation's token count is unknown
          // rather than zero — the same honesty rule as an unpriced call (ADR-035).
          decisionUsageUnavailableCalls += 1;
        }
        if (decision.cost === undefined) {
          // Usage that could not be priced is reported as unpriced, never as free.
          decisionUnpricedCalls += 1;
        } else {
          decisionCost = addCost(decisionCost, decision.cost);
        }
        break;
      case "fallback":
        decisionFallbacks += 1;
        break;
      case "deterministic":
        decisionsDeterministic += 1;
        break;
    }
  }

  const toolCalls = assertNonNegativeInteger(input.toolCalls, "toolCalls");
  const iterations = assertNonNegativeInteger(input.iterations, "iterations");
  const failedLlmCalls = assertNonNegativeInteger(
    input.llmFailures ?? 0,
    "llmFailures",
  );
  const endedAt = input.endedAt;
  const open = endedAt === undefined;

  return {
    taskId: input.taskId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    totalTokens: totalTokens(usage),
    cost,
    costComplete: unpricedCalls === 0 && usageUnavailableCalls === 0,
    unpricedCalls,
    usageUnavailableCalls,
    failedLlmCalls,
    providerAttempts,
    llmCalls: input.llmCalls.length,
    llmLatencyMs,
    toolCalls,
    contextSelections: selections.length,
    contextCandidates,
    contextSelected,
    contextExcluded,
    contextCandidateTokens,
    contextSelectedTokens,
    contextExcludedTokens,
    contextBudgetTokens,
    contextSelectionLatencyMs,
    contextOverBudgetSelections,
    contextSelectionRatio:
      contextCandidateTokens === 0
        ? 0
        : contextSelectedTokens / contextCandidateTokens,
    iterations,
    retries,
    escalations,
    decisions: input.decisions.length,
    decisionsByProvider,
    decisionsDeterministic,
    decisionFallbacks,
    decisionFailures: assertNonNegativeInteger(
      input.decisionFailures ?? 0,
      "decisionFailures",
    ),
    decisionsByKind: Object.fromEntries(
      [...decisionsByKind.entries()].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      ),
    ),
    decisionLatencyMs,
    decisionUsage,
    decisionTokens: totalTokens(decisionUsage),
    decisionCost,
    decisionCostComplete:
      decisionUnpricedCalls === 0 && decisionUsageUnavailableCalls === 0,
    decisionUnpricedCalls,
    decisionUsageUnavailableCalls,
    open,
    durationMs:
      endedAt === undefined ? 0 : durationMsFrom(input.startedAt, endedAt),
  };
}

/**
 * Which layer answered a recorded decision.
 *
 * A record written before the answer source was recorded names the same thing in the
 * older vocabulary (`decidedBy`), so it is classified rather than dropped: a report
 * whose parts do not add up to its own total is a report nobody can trust. Exported
 * because the task report and `ai decision` count the same log, and counting it two
 * ways is how two commands start disagreeing about the same facts.
 */
export function answerSourceOf(decision: {
  readonly answeredBy?: DecisionAnswerSource;
  readonly decidedBy?: DecidedBy;
}): DecisionAnswerSource {
  return (
    decision.answeredBy ??
    (decision.decidedBy === "decision-provider" ? "provider" : "deterministic")
  );
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

function formatCount(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Decision cost, with an honest note about what it leaves out.
 *
 * Exported because `ai task usage` and `ai task decisions` both report it: one place
 * decides how incompleteness is phrased, so the two commands cannot describe the same
 * number two different ways.
 */
export function formatDecisionCost(metrics: TaskMetrics): string {
  const incomplete: string[] = [];
  if (metrics.decisionUnpricedCalls > 0) {
    incomplete.push(`${metrics.decisionUnpricedCalls} unpriced`);
  }
  if (metrics.decisionUsageUnavailableCalls > 0) {
    incomplete.push(`${metrics.decisionUsageUnavailableCalls} without usage`);
  }
  return incomplete.length === 0
    ? formatCost(metrics.decisionCost)
    : `${formatCost(metrics.decisionCost)} (lower bound; ${incomplete.join("; ")})`;
}

/** Human-readable report. Presentation only; `--json` is the stable contract. */
export function formatTaskMetrics(metrics: TaskMetrics): string {
  const incomplete: string[] = [];
  if (metrics.unpricedCalls > 0) {
    incomplete.push(
      `${metrics.unpricedCalls} of ${metrics.llmCalls} calls unpriced`,
    );
  }
  if (metrics.usageUnavailableCalls > 0) {
    incomplete.push(
      `${metrics.usageUnavailableCalls} call(s) reported no usage`,
    );
  }
  const costLine =
    incomplete.length === 0
      ? formatCost(metrics.cost)
      : `${formatCost(metrics.cost)} (lower bound; ${incomplete.join("; ")})`;

  return [
    `Task: ${metrics.taskId}`,
    `Input tokens: ${formatCount(metrics.inputTokens)}`,
    `Output tokens: ${formatCount(metrics.outputTokens)}`,
    `Cached input tokens: ${formatCount(metrics.cachedInputTokens)}`,
    `Total tokens: ${formatCount(metrics.totalTokens)}`,
    `LLM cost: ${costLine}`,
    `LLM calls: ${formatCount(metrics.llmCalls)}`,
    `LLM failures: ${formatCount(metrics.failedLlmCalls)}`,
    `Provider attempts: ${formatCount(metrics.providerAttempts)}`,
    `LLM latency: ${formatCount(metrics.llmLatencyMs)}ms`,
    `Tool calls: ${formatCount(metrics.toolCalls)}`,
    `Context selections: ${formatCount(metrics.contextSelections)}`,
    `Context candidates: ${formatCount(metrics.contextCandidates)} ` +
      `(selected ${formatCount(metrics.contextSelected)}, excluded ${formatCount(metrics.contextExcluded)})`,
    `Context tokens: ${formatCount(metrics.contextSelectedTokens)} selected of ` +
      `${formatCount(metrics.contextCandidateTokens)} candidate tokens ` +
      `(selection ratio ${(metrics.contextSelectionRatio * 100).toFixed(1)}%)`,
    `Context budget: ${formatCount(metrics.contextBudgetTokens)} tokens`,
    `Context selection latency: ${formatCount(metrics.contextSelectionLatencyMs)}ms`,
    ...(metrics.contextOverBudgetSelections === 0
      ? []
      : [
          `Context budget exceeded in ${formatCount(metrics.contextOverBudgetSelections)} selection(s)`,
        ]),
    `Iterations: ${formatCount(metrics.iterations)}`,
    `Retries: ${formatCount(metrics.retries)}`,
    `Escalations: ${formatCount(metrics.escalations)}`,
    `Decisions: ${formatCount(metrics.decisions)} ` +
      `(${formatCount(metrics.decisionsByProvider)} by decision provider, ` +
      `${formatCount(metrics.decisionsDeterministic)} deterministic, ` +
      `${formatCount(metrics.decisionFallbacks)} fallback)`,
    ...(metrics.decisionFailures === 0
      ? []
      : [`Decision failures: ${formatCount(metrics.decisionFailures)}`]),
    ...(metrics.decisions === 0
      ? []
      : [
          `Decision latency: ${formatCount(metrics.decisionLatencyMs)}ms`,
          `Decision tokens: ${formatCount(metrics.decisionTokens)}`,
          `Decision cost: ${formatDecisionCost(metrics)}`,
        ]),
    `Duration: ${metrics.open ? "open" : formatDuration(metrics.durationMs)}`,
  ].join("\n");
}
