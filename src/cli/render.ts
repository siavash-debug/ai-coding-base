import type { ApprovalState } from "../application/approval-ledger.js";
import type { DoctorReport } from "../application/doctor.js";
import { formatDoctorReport } from "../application/doctor.js";
import type { RunTaskResult } from "../application/run-task.js";
import type { TaskTrace, TraceContextSelection } from "../application/trace.js";
import type { ContextSelection } from "../context/selection.js";
import { SIGNAL_LABELS as CONTEXT_SIGNAL_LABELS } from "../context/scoring.js";
import { type Cost, formatCost } from "../observability/cost.js";
import type { BudgetEvaluation } from "../observability/budget.js";
import type { TaskMetrics } from "../observability/metrics.js";
import type { StoredTask } from "../ports/task-repository.js";

/**
 * Presentation only.
 *
 * These functions read domain values and turn them into text. They contain no
 * rules, no arithmetic beyond unit formatting, and no access to storage, providers
 * or policy — which is what keeps the CLI from becoming a second implementation of
 * the platform. `--json` emits the same objects serialized, so scripts never have
 * to parse this output.
 */

const COUNTS = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return COUNTS.format(value);
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (hours > 0 || minutes > 0) {
    parts.push(`${minutes % 60}m`);
  }
  parts.push(`${seconds % 60}s`);
  return `${parts.join(" ")} (${formatCount(ms)}ms)`;
}

export function formatBudget(budget: BudgetEvaluation): readonly string[] {
  if (budget.dimensions.length === 0) {
    return ["Budget   unbounded (no limits configured)"];
  }
  const lines = [
    `Budget   ${budget.level}${budget.exceeded ? " (exceeded)" : ""}`,
  ];
  for (const dimension of budget.dimensions) {
    lines.push(
      `         ${dimension.dimension.padEnd(11)}${formatCount(dimension.consumed)}/${formatCount(dimension.limit)}  ${dimension.level}`,
    );
  }
  for (const reason of budget.reasons) {
    lines.push(`         ${reason}`);
  }
  return lines;
}

export function formatTask(stored: StoredTask): string {
  const { task } = stored;
  const met = task.acceptanceCriteria.filter(
    (criterion) => criterion.status === "met" || criterion.status === "waived",
  ).length;
  const lines = [
    `Task ${task.id}`,
    `  title      ${task.title}`,
    `  status     ${task.status}`,
    `  risk       ${task.riskLevel}`,
    `  project    ${task.projectId}`,
    `  workspace  ${task.workspaceId}`,
    `  created    ${task.createdAt}`,
    `  updated    ${task.updatedAt}`,
    ...(task.completedAt === undefined
      ? []
      : [`  completed  ${task.completedAt}`]),
    `  record     version ${stored.version}`,
    `  acceptance ${met}/${task.acceptanceCriteria.length} met`,
  ];
  for (const criterion of task.acceptanceCriteria) {
    lines.push(
      `             [${criterion.status}] ${criterion.id} ${criterion.statement}`,
    );
  }
  return lines.join("\n");
}

export function formatTaskList(tasks: readonly StoredTask[]): string {
  if (tasks.length === 0) {
    return "No tasks recorded in this workspace.";
  }
  const lines = ["ID  STATUS  RISK  TITLE"];
  for (const { task } of tasks) {
    lines.push(`${task.id}  ${task.status}  ${task.riskLevel}  ${task.title}`);
  }
  return lines.join("\n");
}

export function formatRunResult(result: RunTaskResult): string {
  const lines = [
    `Outcome  ${result.outcome}${result.resumed ? " (resumed attempt)" : ""}`,
    `Task     ${result.task.id} (${result.task.status})`,
    ...(result.session === undefined
      ? []
      : [`Session  ${result.session.id} (${result.session.status})`]),
    ...(result.approvalRequestId === undefined
      ? []
      : [`Approval ${result.approvalRequestId}`]),
  ];
  if (result.reason !== undefined) {
    lines.push(`Reason   ${result.reason}`);
  }
  for (const message of result.messages) {
    lines.push(`  - ${message}`);
  }
  return lines.join("\n");
}

function sessionLines(trace: TaskTrace): readonly string[] {
  if (trace.sessions.length === 0) {
    return ["  (none)"];
  }
  const lines: string[] = [];
  for (const session of trace.sessions) {
    lines.push(
      `  ${session.id}  agent ${session.agentId}  ${session.status}` +
        (session.endedAt === undefined ? "" : `  ended ${session.endedAt}`) +
        (session.endReason === undefined ? "" : `  (${session.endReason})`),
    );
    lines.push(
      `    ${formatCount(session.llmCalls)} LLM call(s), ` +
        `${formatCount(session.toolCalls)} tool call(s), ` +
        `${formatCount(session.iterations)} iteration(s)`,
    );
    if (session.providerIds.length > 0) {
      lines.push(
        `    providers: ${session.providerIds.join(", ")}; models: ${session.modelIds.join(", ")}`,
      );
    }
  }
  return lines;
}

function decisionLines(trace: TaskTrace): readonly string[] {
  if (trace.decisions.length === 0) {
    return ["  (none)"];
  }
  return trace.decisions.map((decision) => {
    const by = decision.decidedBy ?? "unresolved";
    const selected =
      decision.selectedOptionId === undefined
        ? ""
        : ` -> ${decision.selectedOptionId}`;
    return (
      `  ${decision.kind.padEnd(20)}${decision.outcome}${selected}  ` +
      `by ${by}\n    ${decision.question ?? "(question not recorded)"}`
    );
  });
}

function llmLines(trace: TaskTrace): readonly string[] {
  if (trace.llmCalls.length === 0) {
    return ["  (none)"];
  }
  return trace.llmCalls.map((call) => {
    const cached =
      call.usage.cachedInputTokens === 0
        ? ""
        : ` (${formatCount(call.usage.cachedInputTokens)} cached)`;
    return (
      `  seq ${call.sequence}  ${call.providerId}/${call.modelId}  ` +
      `${formatCount(call.usage.inputTokens)} in${cached} / ` +
      `${formatCount(call.usage.outputTokens)} out  ` +
      `${formatCount(call.latencyMs)}ms  ` +
      (call.cost === undefined ? "unpriced" : formatCost(call.cost)) +
      (call.retry > 0 ? `  retry ${call.retry}` : "") +
      (call.escalated ? "  escalated" : "") +
      // Absent usage is stated, never rendered as a zero.
      (call.usageReported === false ? "  usage unavailable" : "") +
      (call.attempts === undefined || call.attempts <= 1
        ? ""
        : `  attempts ${formatCount(call.attempts)}`) +
      (call.requestId === undefined ? "" : `  request ${call.requestId}`)
    );
  });
}

function llmFailureLines(trace: TaskTrace): readonly string[] {
  if (trace.llmFailures.length === 0) {
    return ["  (none)"];
  }
  return trace.llmFailures.map(
    (failure) =>
      `  seq ${failure.sequence}  ${failure.providerId}/${failure.modelId}  ` +
      `${failure.failureKind}${failure.retryable ? " (retryable)" : ""}` +
      (failure.statusCode === undefined ? "" : `  HTTP ${failure.statusCode}`) +
      `  after ${formatCount(failure.attempts)} attempt(s)`,
  );
}

function toolLines(trace: TaskTrace): readonly string[] {
  if (trace.toolCalls.length === 0) {
    return ["  (none)"];
  }
  return trace.toolCalls.map(
    (call) =>
      `  ${call.toolId}  ${call.operation ?? "operation unspecified"}  ` +
      `${call.ok ? "ok" : "failed"}` +
      (call.latencyMs === undefined
        ? ""
        : `  ${formatCount(call.latencyMs)}ms`),
  );
}

function testLines(trace: TaskTrace): readonly string[] {
  if (trace.tests.length === 0) {
    return ["  (none)"];
  }
  return trace.tests.map(
    (run) =>
      `  ${run.suite}  passed ${formatCount(run.passed)}  ` +
      `failed ${formatCount(run.failed)}`,
  );
}

/**
 * An approval line, complete enough to audit: what was asked, what was granted,
 * whether it was used, and whether it has expired. A grant that was consumed shows
 * *when*, because a single-use grant is only meaningful if the use is visible.
 */
function approvalLine(approval: {
  readonly requestId: string;
  readonly riskLevel: string;
  readonly operation?: string;
  readonly grantedRiskLevel?: string;
  readonly grantedOperation?: string;
  readonly grantScope?: "task" | "operation";
  readonly requestedAt: string;
  readonly grantedAt?: string;
  readonly approver?: string;
  readonly expiresAt?: string;
  readonly consumedAt?: string;
  readonly status?: string;
}): string {
  const scope =
    approval.grantScope === "task"
      ? "whole task"
      : approval.grantScope === "operation"
        ? `operation ${approval.grantedOperation ?? approval.operation ?? "unspecified"}`
        : approval.operation === undefined
          ? "whole task"
          : `operation ${approval.operation}`;
  const grantedRisk =
    approval.grantedRiskLevel === undefined ||
    approval.grantedRiskLevel === approval.riskLevel
      ? ""
      : ` -> granted ${approval.grantedRiskLevel}`;
  const state =
    approval.status ??
    (approval.grantedAt === undefined ? "pending" : "granted");
  return (
    `  ${approval.requestId}  risk ${approval.riskLevel}${grantedRisk}  ${scope}  [${state}]` +
    `  asked ${approval.requestedAt}` +
    (approval.grantedAt === undefined
      ? ""
      : `  granted by ${approval.approver ?? "unknown"} at ${approval.grantedAt}`) +
    (approval.expiresAt === undefined
      ? ""
      : `  expires ${approval.expiresAt}`) +
    (approval.consumedAt === undefined
      ? ""
      : `  consumed ${approval.consumedAt}`)
  );
}

function approvalLines(trace: TaskTrace): readonly string[] {
  if (trace.approvals.length === 0) {
    return ["  (none)"];
  }
  return trace.approvals.map(approvalLine);
}

/** `ai approvals`: what is pending, granted, consumed or expired in this project. */
export function formatApprovals(
  states: readonly ApprovalState[],
  projectId: string,
): string {
  if (states.length === 0) {
    return `No approvals recorded in project ${projectId}`;
  }
  const pending = states.filter((state) => state.status === "pending").length;
  const granted = states.filter((state) => state.status === "granted").length;
  const lines = [
    `Approvals in project ${projectId}  (${formatCount(states.length)} total: ` +
      `${formatCount(pending)} pending, ${formatCount(granted)} granted and unused)`,
  ];
  for (const state of states) {
    lines.push(approvalLine(state));
    lines.push(`    task ${state.taskId}`);
  }
  return lines.join("\n");
}

export function formatTrace(trace: TaskTrace): string {
  const lines = [
    `Task ${trace.taskId}${trace.title === undefined ? "" : `  "${trace.title}"`}`,
    `  status     ${trace.status}${trace.terminal ? " (terminal)" : ""}`,
    `  risk       ${trace.riskLevel ?? "unknown"}`,
    `  project    ${trace.projectId}`,
    `  workspace  ${trace.workspaceId ?? "unknown"}`,
    `  events     ${formatCount(trace.events.length)}`,
    `  first      ${trace.firstEventAt ?? "no events"}`,
    `  last       ${trace.lastEventAt ?? "no events"}`,
    `  elapsed    ${formatDuration(trace.elapsedMs)}`,
    ...(trace.record === undefined
      ? []
      : [
          `  record     present at version ${trace.record.version} (status ${trace.record.task.status})`,
        ]),
    "",
    "SESSIONS",
    ...sessionLines(trace),
    "",
    "CONTEXT",
    ...contextLines(trace),
    "",
    "DECISIONS",
    ...decisionLines(trace),
    "",
    "APPROVALS",
    ...approvalLines(trace),
    "",
    "LLM CALLS",
    ...llmLines(trace),
    "",
    "LLM FAILURES",
    ...llmFailureLines(trace),
    "",
    "TOOL CALLS",
    ...toolLines(trace),
    "",
    "TESTS",
    ...testLines(trace),
    "",
    "METRICS",
    ...formatMetricsLines(trace.metrics),
    "",
    ...formatBudget(trace.budget),
    "",
    `INTEGRITY ${trace.integrity.ok ? "ok" : "issues"}`,
    ...trace.integrity.issues.map((issue) => `  - ${issue}`),
  ];
  return lines.join("\n");
}

/**
 * The context section of a trace: what was read, and what it was estimated to cost.
 *
 * One line per selection rather than the full candidate list — `ai task context` is
 * where the reasons live. A trace is for seeing the *shape* of a run, and a hundred
 * candidate paths in the middle of it would bury the decisions around them.
 */
function contextLines(trace: TaskTrace): readonly string[] {
  if (trace.contextSelections.length === 0) {
    return ["  (none)"];
  }
  const lines: string[] = [];
  for (const selection of trace.contextSelections) {
    lines.push(
      `  ${selection.selectionId}  ${selection.strategy ?? "unknown"} v${selection.selectionVersion ?? "?"}` +
        `${selection.complete ? "" : " (incomplete)"}`,
    );
    lines.push(
      `    ${selection.selected.length} of ${formatCount(selection.considered ?? 0)} candidate(s), ` +
        `${formatCount(selection.selectedTokens ?? 0)}/${formatCount(selection.budgetTokens ?? 0)} token(s)` +
        (selection.budgetExceeded ? "  OVER BUDGET" : ""),
    );
    lines.push(
      `    refs: ${selection.selected.map((candidate) => candidate.ref).join(", ") || "(none)"}`,
    );
    for (const unavailable of selection.unavailableCapabilities) {
      lines.push(`    unavailable: ${unavailable}`);
    }
  }
  return lines;
}

export function formatMetricsLines(metrics: TaskMetrics): readonly string[] {
  return [
    `  input tokens    ${formatCount(metrics.inputTokens)}`,
    `  cached tokens   ${formatCount(metrics.cachedInputTokens)}`,
    `  output tokens   ${formatCount(metrics.outputTokens)}`,
    `  total tokens    ${formatCount(metrics.totalTokens)}`,
    `  llm calls       ${formatCount(metrics.llmCalls)}`,
    `  llm latency     ${formatCount(metrics.llmLatencyMs)}ms`,
    `  tool calls      ${formatCount(metrics.toolCalls)}`,
    `  context         ${formatCount(metrics.contextSelected)}/${formatCount(metrics.contextCandidates)} file(s), ${formatCount(metrics.contextSelectedTokens)} token(s)`,
    `  iterations      ${formatCount(metrics.iterations)}`,
    `  retries         ${formatCount(metrics.retries)}`,
    `  escalations     ${formatCount(metrics.escalations)}`,
    `  decisions       ${formatCount(metrics.decisions)} (${formatCount(metrics.decisionsByProvider)} by decision provider)`,
    `  duration        ${metrics.open ? "open" : formatDuration(metrics.durationMs)}`,
  ];
}

export function formatUsage(trace: TaskTrace): string {
  const { metrics } = trace;
  const lines = [
    `Task ${trace.taskId}  usage derived from ${formatCount(trace.events.length)} event(s)`,
    `  status          ${trace.status}`,
    ...formatMetricsLines(metrics),
    "",
    `Cost total        ${formatCost(metrics.cost)}` +
      (metrics.costComplete
        ? ""
        : `  (unpriced: ${formatCount(metrics.unpricedCalls)} of ${formatCount(metrics.llmCalls)} call(s))`),
    "",
    ...formatBudget(trace.budget),
  ];
  return lines.join("\n");
}

export function formatTaskCost(trace: TaskTrace): string {
  const { metrics } = trace;
  const lines = [`Task ${trace.taskId}  cost breakdown`];
  if (trace.llmCalls.length === 0) {
    lines.push("  no LLM calls recorded");
  }
  for (const call of trace.llmCalls) {
    const cost: Cost | undefined = call.cost;
    lines.push(
      `  ${call.providerId}/${call.modelId}  ` +
        `${formatCount(call.usage.inputTokens)} in / ${formatCount(call.usage.outputTokens)} out  ` +
        (cost === undefined ? "unpriced" : formatCost(cost)),
    );
  }
  lines.push("");
  lines.push(`Total             ${formatCost(metrics.cost)}`);
  if (metrics.costComplete) {
    lines.push(
      "Pricing           complete (every call matched a configured rate)",
    );
  } else {
    lines.push(
      `Pricing           incomplete: ${formatCount(metrics.unpricedCalls)} of ` +
        `${formatCount(metrics.llmCalls)} call(s) have no configured rate, so the ` +
        "total is a lower bound, not a guess",
    );
  }
  lines.push("");
  lines.push(...formatBudget(trace.budget));
  return lines.join("\n");
}

/**
 * A context selection, for humans.
 *
 * Paths, scores and reason codes only — never file content. `--explain` adds the
 * per-candidate arithmetic, which is the whole point of a deterministic selector:
 * you can check the reason, not just the verdict.
 */
/**
 * One shape for rendering, whichever projection produced it.
 *
 * A freshly computed `ContextSelection` and a trace-reconstructed
 * `TraceContextSelection` differ only in how capabilities and completeness are
 * spelled. Rendering them through one view means `ai task context` and `ai task
 * context --select` print the same layout for the same facts (ADR-039).
 */
export interface ContextSelectionView {
  readonly selectionId: string;
  readonly strategy: string;
  readonly selectionVersion?: number;
  readonly configFingerprint?: string;
  readonly budgetTokens: number;
  readonly selectedTokens: number;
  readonly excludedTokens: number;
  readonly remainingTokens: number;
  readonly considered: number;
  readonly filteredByScore: number;
  readonly excludedByRules: number;
  readonly budgetExceeded: boolean;
  readonly overBudgetTokens: number;
  readonly durationMs: number;
  readonly capabilities: readonly string[];
  readonly unavailableCapabilities: readonly string[];
  readonly selected: readonly {
    readonly ref: string;
    readonly tokens: number;
    readonly score: number;
    readonly reasons: readonly string[];
    readonly mandatory: boolean;
    readonly basis: string;
  }[];
  readonly excluded: readonly {
    readonly ref: string;
    readonly tokens: number;
    readonly score: number;
    readonly reason: string;
  }[];
  readonly refsTruncated: boolean;
  /** Present only on a trace-reconstructed selection. */
  readonly complete?: boolean;
}

export function contextSelectionView(
  selection: ContextSelection | TraceContextSelection,
): ContextSelectionView {
  if ("capabilities" in selection && Array.isArray(selection.capabilities)) {
    const trace = selection as TraceContextSelection;
    return {
      selectionId: trace.selectionId,
      strategy: trace.strategy ?? "unknown",
      ...(trace.selectionVersion === undefined
        ? {}
        : { selectionVersion: trace.selectionVersion }),
      ...(trace.configFingerprint === undefined
        ? {}
        : { configFingerprint: trace.configFingerprint }),
      budgetTokens: trace.budgetTokens ?? 0,
      selectedTokens: trace.selectedTokens ?? 0,
      excludedTokens: trace.excludedTokens ?? 0,
      remainingTokens: trace.remainingTokens ?? 0,
      considered: trace.considered ?? 0,
      filteredByScore: trace.filteredByScore ?? 0,
      excludedByRules: trace.excludedByRules ?? 0,
      budgetExceeded: trace.budgetExceeded,
      overBudgetTokens: trace.overBudgetTokens ?? 0,
      durationMs: trace.durationMs ?? 0,
      capabilities: trace.capabilities,
      unavailableCapabilities: trace.unavailableCapabilities,
      selected: trace.selected,
      excluded: trace.excluded,
      refsTruncated: trace.refsTruncated,
      complete: trace.complete,
    };
  }
  const direct = selection as ContextSelection;
  return {
    selectionId: direct.selectionId,
    strategy: direct.strategy,
    selectionVersion: direct.selectionVersion,
    configFingerprint: direct.configFingerprint,
    budgetTokens: direct.budgetTokens,
    selectedTokens: direct.selectedTokens,
    excludedTokens: direct.excludedTokens,
    remainingTokens: direct.remainingTokens,
    considered: direct.considered,
    filteredByScore: direct.filteredByScore,
    excludedByRules: direct.excludedByRules,
    budgetExceeded: direct.budgetExceeded,
    overBudgetTokens: direct.overBudgetTokens,
    durationMs: direct.durationMs,
    capabilities: direct.capabilities.available,
    unavailableCapabilities: direct.capabilities.unavailable,
    selected: direct.selected,
    excluded: direct.excluded,
    refsTruncated: direct.refsTruncated,
  };
}

export function formatContextSelection(
  selection: ContextSelection | TraceContextSelection,
  options: { readonly explain?: boolean } = {},
): string {
  return renderContextSelection(contextSelectionView(selection), options);
}

function renderContextSelection(
  selection: ContextSelectionView,
  options: { readonly explain?: boolean } = {},
): string {
  const lines = [
    `Context selection ${selection.selectionId}` +
      (selection.complete === false ? " (incomplete)" : ""),
  ];
  lines.push(
    `  strategy        ${selection.strategy} v${selection.selectionVersion ?? "?"}` +
      (selection.configFingerprint === undefined
        ? ""
        : `  config ${selection.configFingerprint}`),
  );
  lines.push(
    `  budget          ${formatCount(selection.selectedTokens)} of ` +
      `${formatCount(selection.budgetTokens)} token(s) used` +
      `, ${formatCount(selection.remainingTokens)} remaining`,
  );
  lines.push(
    `  candidates      ${formatCount(selection.considered)} scored, ` +
      `${formatCount(selection.filteredByScore)} filtered by score, ` +
      `${formatCount(selection.excludedByRules)} excluded by rules`,
  );
  lines.push(
    `  selected        ${selection.selected.length} file(s), ` +
      `${formatCount(selection.selectedTokens)} token(s)`,
  );
  lines.push(
    `  excluded        ${selection.excluded.length} file(s), ` +
      `${formatCount(selection.excludedTokens)} token(s) of candidate context`,
  );
  lines.push(`  duration        ${formatCount(selection.durationMs)}ms`);
  lines.push(
    `  capabilities    ${
      selection.capabilities.length === 0
        ? "(none reported)"
        : selection.capabilities.join(", ")
    }`,
  );
  for (const unavailable of selection.unavailableCapabilities) {
    lines.push(`  unavailable     ${unavailable}`);
  }
  if (selection.budgetExceeded) {
    lines.push(
      `  OVER BUDGET     ${formatCount(selection.overBudgetTokens)} token(s) of explicitly ` +
        "referenced context do not fit; the run refuses to proceed without them",
    );
  }
  if (selection.refsTruncated) {
    lines.push(
      "  note            the recorded ref lists were capped; the counts above are exact",
    );
  }

  lines.push("", "Selected:");
  if (selection.selected.length === 0) {
    lines.push("  (none)");
  }
  for (const candidate of selection.selected) {
    lines.push(
      `  ${candidate.ref}  ${formatCount(candidate.tokens)} tok  score ${candidate.score}` +
        (candidate.mandatory ? "  (required by the task)" : ""),
    );
    if (options.explain === true) {
      for (const reason of candidate.reasons) {
        lines.push(`      - ${describeContextReason(reason)}`);
      }
      lines.push(`      basis: ${candidate.basis} estimate`);
    }
  }

  lines.push("", "Excluded:");
  if (selection.excluded.length === 0) {
    lines.push("  (none)");
  }
  for (const candidate of selection.excluded) {
    const reason =
      options.explain === true
        ? describeContextExclusion(candidate.reason)
        : candidate.reason;
    lines.push(
      `  ${candidate.ref}  ${formatCount(candidate.tokens)} tok  score ${candidate.score}  ${reason}`,
    );
  }
  return lines.join("\n");
}

const SIGNAL_LABEL_BY_CODE: Readonly<Record<string, string>> =
  CONTEXT_SIGNAL_LABELS;

function describeContextReason(code: string): string {
  return SIGNAL_LABEL_BY_CODE[code] ?? code;
}

function describeContextExclusion(reason: string): string {
  switch (reason) {
    case "budget-cutoff":
      return "ranked below the budget cut-off";
    case "oversize-after-sizing":
      return "larger than estimated, so it did not fit";
    case "budget-exceeded":
      return "required by the task, but the budget could not fit it";
    case "unreadable":
      return "could not be read";
    default:
      return reason;
  }
}

/** Renders a task's context selections. Empty means the task was never selected for. */
export function formatTaskContext(
  trace: TaskTrace,
  options: { readonly explain?: boolean } = {},
): string {
  if (trace.contextSelections.length === 0) {
    return [
      `Task ${trace.taskId}  context`,
      "  no context selection recorded; run the task, or record one with `ai task context --select`",
    ].join("\n");
  }
  return trace.contextSelections
    .map((selection) => formatContextSelection(selection, options))
    .join("\n\n");
}

export function formatDoctor(report: DoctorReport): string {
  return formatDoctorReport(report);
}
