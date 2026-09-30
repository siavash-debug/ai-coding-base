import type { ApprovalState } from "../../application/approval-ledger.js";
import type { RunOutcome, RunPlan } from "../../application/run-task.js";
import type { OrchestrationPlan } from "../../orchestration/orchestrator.js";
import type { TaskTrace } from "../../application/trace.js";
import { toIsoString } from "../../core/clock.js";
import { DomainError } from "../../core/errors.js";
import { isValidId, taskId as toTaskId } from "../../core/ids.js";
import type { TaskId } from "../../core/ids.js";
import { RISK_LEVELS, type RiskLevel } from "../../decisions/risk.js";
import {
  ACCEPTANCE_VERDICT_STATUSES,
  type AcceptanceCriterionEvidenceBinding,
  type AcceptanceCriterionInput,
  type AcceptanceVerdictStatus,
  type Task,
} from "../../tasks/task.js";
import { microsFromDollars } from "../../observability/cost.js";
import {
  type FlagSpec,
  type ParsedArgs,
  UsageError,
  flagBool,
  flagNumber,
  flagValue,
  flagValues,
  parseArgv,
  requireFlag,
  requirePositional,
} from "../args.js";
import {
  EXIT_APPROVAL_REQUIRED,
  EXIT_BUDGET_EXCEEDED,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_POLICY_DENIED,
  type CliEnv,
  type CliIo,
} from "../io.js";
import {
  openRuntimeFor,
  readScope,
  requireProviderCredentials,
} from "../context.js";
import { printHelp } from "../help.js";
import { selectContextForTask } from "../../application/context-service.js";
import {
  formatContextSelection,
  formatOrchestration,
  formatRunResult,
  formatTask,
  formatTaskContext,
  formatTaskCost,
  formatTaskDecisions,
  formatTaskList,
  formatTrace,
  formatUsage,
} from "../render.js";

/**
 * `ai task …`: the task-facing commands.
 *
 * Each subcommand is a thin shell: parse flags, ask the composition root for a
 * runtime, call one application service, render the result. No lifecycle rules, no
 * accounting and no storage decisions live here — which is why the same behaviour
 * is reachable from a dashboard later without going through a terminal.
 */
const COMMON_SPECS: readonly FlagSpec[] = [
  {
    name: "workspace",
    value: true,
    placeholder: "id",
    description:
      "workspace to act on (default: the first configured workspace)",
  },
  { name: "json", value: false, description: "emit machine-readable JSON" },
  { name: "help", value: false, aliases: ["h"], description: "show this help" },
];

/**
 * The `--dry-run` spec, shared by every mutating subcommand.
 *
 * A dry run validates, resolves and reports what *would* happen and performs
 * nothing. It is never "do it, then throw the result away": each command's dry-run
 * branch calls a planning seam that stops before the first write (or provider or
 * agent call), so no side effect exists to discard.
 */
const DRY_RUN_SPEC: FlagSpec = {
  name: "dry-run",
  value: false,
  description: "validate and report what would happen, without performing it",
};

const CREATE_SPECS: readonly FlagSpec[] = [
  {
    name: "title",
    value: true,
    placeholder: "text",
    description: "task title (required)",
  },
  {
    name: "description",
    value: true,
    placeholder: "text",
    description: "task description (required)",
  },
  {
    name: "risk",
    value: true,
    placeholder: "level",
    description: `one of ${RISK_LEVELS.join(" | ")} (default: medium)`,
  },
  {
    name: "acceptance",
    value: true,
    multiple: true,
    placeholder: "text",
    description: "acceptance criterion (repeatable)",
  },
  {
    name: "acceptance-verified-by",
    value: true,
    multiple: true,
    placeholder: "<criterion-id>=<suite>[#<check>]",
    description:
      "bind a criterion (AC-1, AC-2, …) to the verification suite — or one named check inside it — that assesses it (repeatable)",
  },
  {
    name: "constraint",
    value: true,
    multiple: true,
    placeholder: "text",
    description: "constraint (repeatable)",
  },
  {
    name: "context",
    value: true,
    multiple: true,
    placeholder: "text",
    description: "context note (repeatable)",
  },
  {
    name: "max-tokens",
    value: true,
    placeholder: "n",
    description: "token budget",
  },
  {
    name: "max-cost-usd",
    value: true,
    placeholder: "usd",
    description: "cost budget in USD",
  },
  {
    name: "max-iterations",
    value: true,
    placeholder: "n",
    description: "iteration budget",
  },
  {
    name: "max-duration-min",
    value: true,
    placeholder: "minutes",
    description: "wall-clock budget in minutes",
  },
  DRY_RUN_SPEC,
  ...COMMON_SPECS,
];

const COMPLETE_SPECS: readonly FlagSpec[] = [
  {
    name: "reason",
    value: true,
    placeholder: "text",
    description: "why the task is being closed",
  },
  DRY_RUN_SPEC,
  ...COMMON_SPECS,
];

/**
 * `ai task verdict` — the one command that asserts a criterion as a human.
 *
 * `--by` is required for the same reason `--approver` is: a criterion a person decides
 * must name the person, or the record would claim an authority with nobody behind it.
 */
const VERDICT_SPECS: readonly FlagSpec[] = [
  {
    name: "criterion",
    value: true,
    placeholder: "AC-n",
    description: "acceptance criterion to decide (required)",
  },
  {
    name: "status",
    value: true,
    placeholder: ACCEPTANCE_VERDICT_STATUSES.join(" | "),
    description: `what the criterion becomes (required; one of ${ACCEPTANCE_VERDICT_STATUSES.join(", ")})`,
  },
  {
    name: "by",
    value: true,
    placeholder: "name",
    description: "who is taking responsibility for the verdict (required)",
  },
  {
    name: "note",
    value: true,
    placeholder: "text",
    description: "why — recorded in the output only, never in the log",
  },
  DRY_RUN_SPEC,
  ...COMMON_SPECS,
];

const CONTEXT_SPECS: readonly FlagSpec[] = [
  {
    name: "select",
    value: false,
    description:
      "perform and record a fresh selection now (by default the recorded ones are shown)",
  },
  {
    name: "explain",
    value: false,
    description: "show why each candidate was selected or excluded",
  },
  DRY_RUN_SPEC,
  ...COMMON_SPECS,
];

const ORCHESTRATE_SPECS: readonly FlagSpec[] = [
  {
    name: "context",
    value: false,
    description:
      "select task context and send it to the model (recorded as a reference; the content is never recorded)",
  },
  {
    name: "require",
    value: true,
    multiple: true,
    placeholder: "capability",
    description: "declare a required model capability (repeatable)",
  },
  {
    name: "specialize",
    value: true,
    multiple: true,
    placeholder: "domain",
    description: "declare a required model specialization (repeatable)",
  },
  {
    name: "subtask",
    value: true,
    multiple: true,
    placeholder: "instruction",
    description:
      "declare an independent sub-task, enabling parallel execution (repeatable)",
  },
  DRY_RUN_SPEC,
  ...COMMON_SPECS,
];

/** `ai task run` can plan without executing, so it accepts `--dry-run`. */
const RUN_SPECS: readonly FlagSpec[] = [DRY_RUN_SPEC, ...COMMON_SPECS];

const APPROVE_SPECS: readonly FlagSpec[] = [
  DRY_RUN_SPEC,
  {
    name: "approver",
    value: true,
    placeholder: "name",
    description: "who is taking ownership (required)",
  },
  {
    name: "request",
    value: true,
    placeholder: "id",
    description:
      "approval request to grant (default: the task's only pending one)",
  },
  {
    name: "expires-in",
    value: true,
    placeholder: "minutes",
    description: "grant expiry in minutes (default: does not expire)",
  },
  {
    name: "resume",
    value: false,
    description: "continue the suspended attempt with this grant",
  },
  ...COMMON_SPECS,
];

/**
 * Maps a task execution outcome to its exit code (V2-ARCHITECTURE §25.2).
 *
 * The mapping is total over `RunOutcome`, so a new outcome cannot be added without
 * deciding its exit code here. `provider-failed` and `verification-failed` are
 * ordinary failures (`1`): nothing about them is a policy refusal, a budget stop or
 * a pending human decision.
 */
function runOutcomeExitCode(outcome: RunOutcome): number {
  switch (outcome) {
    case "awaiting-review":
      return EXIT_OK;
    case "policy-denied":
      return EXIT_POLICY_DENIED;
    case "budget-exceeded":
    case "context-budget-exceeded":
      return EXIT_BUDGET_EXCEEDED;
    case "awaiting-approval":
      return EXIT_APPROVAL_REQUIRED;
    case "provider-failed":
    case "verification-failed":
      return EXIT_FAILURE;
  }
}

/** Per-subcommand usage and specs, for `--help` and for error messages. */
const SUBCOMMANDS: Readonly<
  Record<
    string,
    { readonly usage: string; readonly specs: readonly FlagSpec[] }
  >
> = {
  create: {
    usage:
      "ai task create --title <text> --description <text> [--dry-run] [options]",
    specs: CREATE_SPECS,
  },
  list: {
    usage: "ai task list [--json] [--workspace <id>]",
    specs: COMMON_SPECS,
  },
  status: { usage: "ai task status <task-id> [--json]", specs: COMMON_SPECS },
  run: {
    usage: "ai task run <task-id> [--dry-run] [--json]",
    specs: RUN_SPECS,
  },
  orchestrate: {
    usage:
      "ai task orchestrate <task-id> [--context] [--require <capability>] [--specialize <domain>] [--subtask <instruction>] [--dry-run] [--json]",
    specs: ORCHESTRATE_SPECS,
  },
  trace: { usage: "ai task trace <task-id> [--json]", specs: COMMON_SPECS },
  context: {
    usage:
      "ai task context <task-id> [--select] [--explain] [--dry-run] [--json]",
    specs: CONTEXT_SPECS,
  },
  usage: { usage: "ai task usage <task-id> [--json]", specs: COMMON_SPECS },
  decisions: {
    usage: "ai task decisions <task-id> [--json]",
    specs: COMMON_SPECS,
  },
  cost: { usage: "ai task cost <task-id> [--json]", specs: COMMON_SPECS },
  complete: {
    usage: "ai task complete <task-id> [--reason <text>] [--dry-run] [--json]",
    specs: COMPLETE_SPECS,
  },
  verdict: {
    usage:
      "ai task verdict <task-id> --criterion <AC-n> --status <met|not-met|waived> --by <name> [--note <text>] [--dry-run]",
    specs: VERDICT_SPECS,
  },
  approve: {
    usage:
      "ai task approve <task-id> --approver <name> [--request <id>] [--expires-in <minutes>] [--resume] [--dry-run]",
    specs: APPROVE_SPECS,
  },
};

export const TASK_USAGE = [
  "Usage: ai task <subcommand> [options]",
  "",
  "Subcommands:",
  ...Object.entries(SUBCOMMANDS).map(
    ([name, definition]) =>
      `  ${name.padEnd(10)}${definition.usage.replace("ai task ", "")}`,
  ),
].join("\n");

function specsFor(subcommand: string): readonly FlagSpec[] {
  const definition = SUBCOMMANDS[subcommand];
  if (definition === undefined) {
    throw new UsageError(
      `unknown subcommand "task ${subcommand}"; expected one of: ${Object.keys(SUBCOMMANDS).join(", ")}`,
    );
  }
  return definition.specs;
}

function requireInteger(args: ParsedArgs, name: string): number | undefined {
  const value = flagNumber(args, name);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UsageError(
      `option "--${name}" must be a non-negative whole number`,
    );
  }
  return value;
}

function positionalTaskId(args: ParsedArgs): TaskId {
  const raw = requirePositional(args, 0, "<task-id>");
  if (!isValidId(raw)) {
    throw new UsageError(`"${raw}" is not a valid task id`);
  }
  return toTaskId(raw);
}

/**
 * Refuses to report on a task this scope does not know about.
 *
 * A projection of zero events is indistinguishable from a real task whose run has
 * not started, so printing one for an arbitrary id would assert that a task exists
 * when nothing in this scope says so. The message is deliberately generic: it names
 * the scope and the id, never whether the id exists somewhere else, because
 * `found` is scope-scoped and "not here" is all this layer is allowed to know.
 */
function requireKnownTask(trace: TaskTrace, id: TaskId): TaskTrace {
  if (!trace.found) {
    throw new DomainError(
      "NOT_FOUND",
      `task "${id}" was not found in the current scope`,
      { field: "taskId" },
    );
  }
  return trace;
}

function emit(io: CliIo, json: boolean, value: unknown, text: string): void {
  io.out(json ? JSON.stringify(value, null, 2) : text);
}

/**
 * Renders the task a dry run *would* produce, without pretending it exists.
 *
 * The wording is deliberate: "would create" describes a plan, not a fact. Nothing
 * was written, and the trailing line says so, because a dry run that looked like a
 * real result would be worse than no dry run at all.
 */
/**
 * Reads `--status` as one of the verdicts a human may assert.
 *
 * Refused rather than defaulted: a typo that silently became a different verdict would
 * put a decision in the record that nobody made.
 */
function verdictStatus(value: string): AcceptanceVerdictStatus {
  if (!ACCEPTANCE_VERDICT_STATUSES.includes(value as AcceptanceVerdictStatus)) {
    throw new UsageError(
      `option "--status" must be one of: ${ACCEPTANCE_VERDICT_STATUSES.join(", ")} (got "${value}")`,
    );
  }
  return value as AcceptanceVerdictStatus;
}

/** Renders the criterion a `--dry-run` verdict *would* produce, and says it did not. */
function formatVerdictPlan(
  planned: Task,
  criterionId: string,
  status: AcceptanceVerdictStatus,
  verdictBy: string,
): string {
  const criterion = planned.acceptanceCriteria.find(
    (entry) => entry.id === criterionId,
  );
  return [
    `Dry run: would record "${status}" for ${criterionId} on task ${planned.id}, by ${verdictBy}.`,
    ...(criterion === undefined
      ? []
      : [
          `  criterion  ${criterion.statement}`,
          `  becomes    ${status}  (recorded as a human verdict by ${verdictBy})`,
        ]),
    "No event was written and no task projection was changed (dry run).",
  ].join("\n");
}

function formatDryRunTask(task: Task, action: "create" | "complete"): string {
  return [
    `Dry run: would ${action} task ${task.id}`,
    `  title      ${task.title}`,
    `  status     ${task.status}`,
    `  risk       ${task.riskLevel}`,
    "No event was written and no task projection was changed (dry run).",
  ].join("\n");
}

/** Renders the plan `ai task orchestrate --dry-run` produced: a plan, not a run. */
function formatOrchestrationPlan(plan: OrchestrationPlan): string {
  return [
    `Dry run: plan only — task ${plan.taskId} was not orchestrated`,
    `  status     ${plan.taskStatus}`,
    `  eligible   ${plan.eligibleModelIds.length === 0 ? "(none)" : plan.eligibleModelIds.join(", ")}`,
    `  variants   ${plan.variants.map((variant) => variant.planId).join(", ")}`,
    "No provider, decision-layer or agent call was made, and no session or event was recorded (dry run).",
  ].join("\n");
}

/** Renders the plan `ai task run --dry-run` produced: a plan, not a result. */
function formatRunPlan(plan: RunPlan): string {
  return [
    `Dry run: plan only — task ${plan.taskId} was not run`,
    `  status     ${plan.taskStatus}`,
    `  risk       ${plan.riskLevel}`,
    `  approval   ${plan.requiresHumanApproval ? "required before any work" : "not required"}`,
    `  envelope   ${plan.capabilityEnvelope.length === 0 ? "none" : plan.capabilityEnvelope.join(", ")}`,
    "  steps:",
    ...plan.steps.map((step) => `    - ${step}`),
    "No provider, decision-layer or agent call was made, and nothing was recorded (dry run).",
  ].join("\n");
}

/**
 * Picks the pending request a human is answering.
 *
 * Refusing an ambiguous choice is deliberate: a command that silently approves
 * whichever request happens to be first would make the log say a human accepted a
 * risk they were never shown.
 */
/**
 * Why there is nothing to answer, phrased so the reader knows what to do next.
 *
 * "No pending approval" alone is unhelpful when an unconsumed grant is sitting
 * there: the difference between "nothing to do" and "one step left" is exactly what
 * a human needs to be told.
 */
function noPendingMessage(
  taskRef: string,
  states: readonly ApprovalState[],
): string {
  const usable = states.filter((state) => state.status === "granted");
  if (usable.length > 0) {
    return (
      `task "${taskRef}" has no pending approval request, but ` +
      `${usable.length} unused grant(s) are recorded ` +
      `(${usable.map((state) => state.requestId).join(", ")}); ` +
      `continue it with: ai task run ${taskRef}`
    );
  }
  if (states.length > 0) {
    return (
      `task "${taskRef}" has no pending approval request; its recorded approvals ` +
      `are ${[...new Set(states.map((state) => state.status))].join(", ")}`
    );
  }
  return `task "${taskRef}" has no pending approval request; nothing is waiting on a human`;
}

function resolveApprovalTarget(
  states: readonly ApprovalState[],
  explicit: string | undefined,
  taskRef: string,
): ApprovalState {
  if (explicit !== undefined) {
    const found = states.find((state) => state.requestId === explicit);
    if (found === undefined) {
      throw new UsageError(
        `no approval request "${explicit}" is recorded for task "${taskRef}"`,
      );
    }
    if (found.status !== "pending") {
      throw new UsageError(
        `approval "${explicit}" is already ${found.status}; a grant cannot be reissued for it`,
      );
    }
    return found;
  }
  const pending = states.filter((state) => state.status === "pending");
  const first = pending[0];
  if (first === undefined) {
    throw new UsageError(
      `task "${taskRef}" has no pending approval request; nothing is waiting on a human`,
    );
  }
  if (pending.length > 1) {
    throw new UsageError(
      `task "${taskRef}" has ${pending.length} pending approval requests ` +
        `(${pending.map((state) => state.requestId).join(", ")}); ` +
        "pass --request <id> to say which one you are answering",
    );
  }
  return first;
}

/**
 * Builds the acceptance-criteria input from `--acceptance` and `--acceptance-verified-by`.
 *
 * Criteria are numbered `AC-1`, `AC-2`, … in the order the `--acceptance` flags appear,
 * the same deterministic numbering the task domain applies. A binding names an id and a
 * verification suite — the name the runtime records for one verification it performed,
 * e.g. `verification-command` for the configured verification command — optionally
 * narrowed to one named check with `#<check>`, the operator-declared id reported for an
 * individual check. An unknown id or a malformed binding is refused rather than dropped,
 * because a criterion that looked bound but was not would be a false assurance.
 */
function acceptanceCriteriaInput(
  args: ParsedArgs,
): readonly AcceptanceCriterionInput[] {
  const statements = flagValues(args, "acceptance");
  const bound = new Map<string, AcceptanceCriterionEvidenceBinding>();
  for (const entry of flagValues(args, "acceptance-verified-by")) {
    const separator = entry.indexOf("=");
    const id = separator === -1 ? "" : entry.slice(0, separator).trim();
    const target = separator === -1 ? "" : entry.slice(separator + 1).trim();
    const hash = target.indexOf("#");
    const suite = (hash === -1 ? target : target.slice(0, hash)).trim();
    const check = hash === -1 ? undefined : target.slice(hash + 1).trim();
    if (id === "" || suite === "" || (check !== undefined && check === "")) {
      throw new UsageError(
        `option "--acceptance-verified-by" expects <criterion-id>=<suite>[#<check>] (got "${entry}")`,
      );
    }
    if (bound.has(id)) {
      throw new UsageError(`criterion "${id}" is bound more than once`);
    }
    bound.set(id, {
      suite,
      ...(check === undefined ? {} : { check }),
    });
  }
  const known = statements.map((_, index) => `AC-${index + 1}`);
  for (const id of bound.keys()) {
    if (!known.includes(id)) {
      throw new UsageError(
        `option "--acceptance-verified-by" names "${id}", but the task declares ` +
          `${statements.length} criterion(s) (${known.join(", ") || "none"})`,
      );
    }
  }
  return statements.map((statement, index) => {
    const verifiedBy = bound.get(`AC-${index + 1}`);
    return verifiedBy === undefined ? { statement } : { statement, verifiedBy };
  });
}

export async function runTaskCommand(
  argv: readonly string[],
  io: CliIo,
  env: CliEnv,
): Promise<number> {
  const [subcommand, ...tail] = argv;
  if (subcommand === undefined) {
    io.out(TASK_USAGE);
    return EXIT_FAILURE;
  }
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    io.out(TASK_USAGE);
    return EXIT_OK;
  }

  const args = parseArgv(tail, specsFor(subcommand));
  if (flagBool(args, "help")) {
    printHelp(io, SUBCOMMANDS[subcommand].usage, SUBCOMMANDS[subcommand].specs);
    return EXIT_OK;
  }
  const json = flagBool(args, "json");

  switch (subcommand) {
    case "create": {
      const runtime = await openRuntimeFor(args, env);
      const risk = flagValue(args, "risk");
      if (risk !== undefined && !RISK_LEVELS.includes(risk as RiskLevel)) {
        throw new UsageError(
          `option "--risk" must be one of: ${RISK_LEVELS.join(", ")}`,
        );
      }
      const budget: {
        maxTokens?: number;
        maxCostMicros?: number;
        maxDurationMs?: number;
        maxIterations?: number;
      } = {};
      const maxTokens = requireInteger(args, "max-tokens");
      if (maxTokens !== undefined) {
        budget.maxTokens = maxTokens;
      }
      const maxCostUsd = flagNumber(args, "max-cost-usd");
      if (maxCostUsd !== undefined) {
        if (maxCostUsd < 0) {
          throw new UsageError(`option "--max-cost-usd" must not be negative`);
        }
        budget.maxCostMicros = microsFromDollars(maxCostUsd);
      }
      const maxIterations = requireInteger(args, "max-iterations");
      if (maxIterations !== undefined) {
        budget.maxIterations = maxIterations;
      }
      const maxDurationMin = requireInteger(args, "max-duration-min");
      if (maxDurationMin !== undefined) {
        budget.maxDurationMs = maxDurationMin * 60_000;
      }

      const input = {
        title: requireFlag(args, "title"),
        description: requireFlag(args, "description"),
        ...(risk === undefined ? {} : { riskLevel: risk as RiskLevel }),
        context: flagValues(args, "context"),
        constraints: flagValues(args, "constraint"),
        acceptanceCriteria: acceptanceCriteriaInput(args),
        budget,
      };
      const context = {
        project: runtime.project,
        workspace: runtime.workspace,
      };

      // Dry run: the same domain constructor and validation, none of the writing.
      if (flagBool(args, "dry-run")) {
        const planned = runtime.tasks.planCreate(input, context);
        emit(
          io,
          json,
          { dryRun: true, wouldCreate: planned },
          formatDryRunTask(planned, "create"),
        );
        return EXIT_OK;
      }

      const stored = await runtime.tasks.create(input, context);
      emit(io, json, stored, formatTask(stored));
      return EXIT_OK;
    }

    case "list": {
      const runtime = await openRuntimeFor(args, env);
      const tasks = await runtime.tasks.list(readScope(runtime, args));
      emit(io, json, tasks, formatTaskList(tasks));
      return EXIT_OK;
    }

    case "status": {
      const runtime = await openRuntimeFor(args, env);
      const stored = await runtime.tasks.load(
        readScope(runtime, args),
        positionalTaskId(args),
      );
      emit(io, json, stored, formatTask(stored));
      return EXIT_OK;
    }

    case "trace": {
      const runtime = await openRuntimeFor(args, env);
      const trace = requireKnownTask(
        await runtime.traces.read(
          readScope(runtime, args),
          positionalTaskId(args),
        ),
        positionalTaskId(args),
      );
      emit(io, json, trace, formatTrace(trace));
      return EXIT_OK;
    }

    case "usage": {
      const runtime = await openRuntimeFor(args, env);
      const trace = requireKnownTask(
        await runtime.traces.read(
          readScope(runtime, args),
          positionalTaskId(args),
        ),
        positionalTaskId(args),
      );
      emit(io, json, trace, formatUsage(trace));
      return EXIT_OK;
    }

    case "decisions": {
      // Scope-safe by construction: a task outside this scope returns `found: false`
      // and is reported as a missing task, without revealing whether it exists
      // somewhere else.
      const runtime = await openRuntimeFor(args, env);
      const trace = requireKnownTask(
        await runtime.traces.read(
          readScope(runtime, args),
          positionalTaskId(args),
        ),
        positionalTaskId(args),
      );
      emit(
        io,
        json,
        { decisions: trace.decisions, failures: trace.decisionFailures },
        formatTaskDecisions(trace),
      );
      return EXIT_OK;
    }

    case "context": {
      const runtime = await openRuntimeFor(args, env);
      const scope = readScope(runtime, args);
      const id = positionalTaskId(args);
      const explain = flagBool(args, "explain");

      // Two honest modes. Reading shows what a previous run actually selected.
      // `--select` performs a new selection and *records* it, because a selection
      // nobody can audit is not evidence — the flag exists so that writing to the
      // log is never something a plain read command does by surprise.
      if (!flagBool(args, "select")) {
        const trace = requireKnownTask(
          await runtime.traces.read(scope, id),
          id,
        );
        emit(
          io,
          json,
          trace.contextSelections,
          formatTaskContext(trace, { explain }),
        );
        return EXIT_OK;
      }

      const dryRun = flagBool(args, "dry-run");
      const stored = await runtime.tasks.load(scope, id);
      // A dry run computes the identical selection and records nothing, so the
      // engine is asked not to write the two events a real `--select` would emit.
      const selected = await selectContextForTask(
        {
          context: runtime.context,
          contextConfig: runtime.contextConfig,
        },
        stored.task,
        dryRun ? { record: false } : undefined,
      );
      if (json) {
        io.out(JSON.stringify(selected.selection, null, 2));
        return selected.selection.budgetExceeded
          ? EXIT_BUDGET_EXCEEDED
          : EXIT_OK;
      }
      io.out(formatContextSelection(selected.selection, { explain: true }));
      io.out("");
      io.out(
        dryRun
          ? `Dry run: selection ${selected.selection.selectionId} was computed but not recorded for task ${id}.`
          : `Recorded selection ${selected.selection.selectionId} for task ${id}.`,
      );
      return selected.selection.budgetExceeded ? EXIT_BUDGET_EXCEEDED : EXIT_OK;
    }

    case "cost": {
      const runtime = await openRuntimeFor(args, env);
      const trace = requireKnownTask(
        await runtime.traces.read(
          readScope(runtime, args),
          positionalTaskId(args),
        ),
        positionalTaskId(args),
      );
      emit(io, json, trace, formatTaskCost(trace));
      return EXIT_OK;
    }

    case "run": {
      const runtime = await openRuntimeFor(args, env);
      const scope = readScope(runtime, args);
      const id = positionalTaskId(args);
      const stored = await runtime.tasks.load(scope, id);

      // Dry run: plan only. It makes no provider call, so it needs no credential,
      // and it opens no session and writes no event (see `RunTask.plan`).
      if (flagBool(args, "dry-run")) {
        const plan = await runtime.runTask.plan(stored);
        emit(io, json, { dryRun: true, plan }, formatRunPlan(plan));
        return EXIT_OK;
      }

      requireProviderCredentials(runtime);
      const result = await runtime.runTask.run(stored);

      if (json) {
        io.out(JSON.stringify(result, null, 2));
      } else {
        io.out(formatRunResult(result));
        io.out("");
        io.out(formatUsage(await runtime.traces.read(scope, id)));
      }
      // The outcome carries the domain meaning: a denial, a budget stop or a
      // suspension is not an ordinary failure.
      return runOutcomeExitCode(result.outcome);
    }

    case "orchestrate": {
      const runtime = await openRuntimeFor(args, env);
      const scope = readScope(runtime, args);
      const id = positionalTaskId(args);
      const stored = await runtime.tasks.load(scope, id);

      const requiredCapabilities = flagValues(args, "require");
      const requiredSpecializations = flagValues(args, "specialize");
      const subTasks = flagValues(args, "subtask").map(
        (instruction, index) => ({
          id: `subtask-${index + 1}`,
          instruction,
          requiredCapabilities: ["reasoning"],
        }),
      );
      const requirements =
        requiredCapabilities.length === 0 &&
        requiredSpecializations.length === 0
          ? undefined
          : {
              ...(requiredCapabilities.length === 0
                ? {}
                : { requiredCapabilities }),
              ...(requiredSpecializations.length === 0
                ? {}
                : { requiredSpecializations }),
            };

      // Dry run: build the deterministic plan and stop. No credential is required
      // because no model is called, and no context is selected because selecting it
      // records events (see `Orchestrator.plan`).
      if (flagBool(args, "dry-run")) {
        const plan = await runtime.orchestrator.plan({
          workspaceId: runtime.workspace.id,
          taskId: id,
          ...(requirements === undefined ? {} : { requirements }),
          ...(subTasks.length === 0 ? {} : { subTasks }),
        });
        emit(io, json, { dryRun: true, plan }, formatOrchestrationPlan(plan));
        return EXIT_OK;
      }

      requireProviderCredentials(runtime);

      // Context is *selected* here and passed to the model; what is recorded is the
      // selection reference and its token count, never the file contents.
      const selection = flagBool(args, "context")
        ? await selectContextForTask(
            {
              context: runtime.context,
              contextConfig: runtime.contextConfig,
            },
            stored.task,
          )
        : undefined;
      if (selection?.selection.budgetExceeded === true) {
        // Hard budget: mandatory context did not fit, so nothing is sent. Refusing
        // here rather than trimming is the Phase E rule, and it means an over-budget
        // selection can never turn into a model call.
        io.err(
          `error: context selection ${selection.selection.selectionId} exceeded its budget ` +
            `(${selection.selection.selectedTokens}/${selection.selection.budgetTokens} tokens); ` +
            `no model call was made`,
        );
        return EXIT_BUDGET_EXCEEDED;
      }

      // Consumption already recorded for this task, so the task budget is a hard
      // bound across runs rather than a per-run limit.
      const prior = await runtime.traces.read(scope, id);

      const result = await runtime.orchestrator.run({
        workspaceId: runtime.workspace.id,
        taskId: id,
        priorConsumption: {
          tokens: prior.metrics.totalTokens,
          costMicros: prior.metrics.cost.micros,
          iterations: prior.metrics.llmCalls,
        },
        ...(selection === undefined
          ? {}
          : {
              contextText: selection.bundle.items
                .map((item) => item.content)
                .join("\n\n"),
              contextSelectionId: selection.selection.selectionId,
              contextSelectionVersion: selection.selection.selectionVersion,
              contextSelectedTokens: selection.selection.selectedTokens,
            }),
        ...(requirements === undefined ? {} : { requirements }),
        ...(subTasks.length === 0 ? {} : { subTasks }),
      });

      if (json) {
        io.out(JSON.stringify(result, null, 2));
      } else {
        io.out(formatOrchestration(result));
      }
      // A run that stopped early or recommends review needs attention; a completed
      // run that recommends none is a success.
      return result.needsHumanReview || result.stopReason !== undefined
        ? EXIT_FAILURE
        : EXIT_OK;
    }

    case "approve": {
      const runtime = await openRuntimeFor(args, env);
      const scope = readScope(runtime, args);
      const id = positionalTaskId(args);
      const stored = await runtime.tasks.load(scope, id);
      const states = await runtime.ledger.forTask(scope, id);
      const resume = flagBool(args, "resume");

      // Which request is being answered? An explicit id always wins; otherwise the
      // choice must be unambiguous, because guessing which of two risks a human
      // accepted is exactly the kind of silent assumption this system avoids.
      const explicit = flagValue(args, "request");
      const pending = states.filter((state) => state.status === "pending");
      const usable = states.filter((state) => state.status === "granted");

      // `--resume` continues an attempt that already has an unused grant; it does
      // not need — and must not be given — a second, redundant grant.
      const answerable = explicit !== undefined || pending.length > 0;
      const dryRun = flagBool(args, "dry-run");
      let target: ApprovalState | undefined;
      if (answerable) {
        target = resolveApprovalTarget(states, explicit, id);
        const expiresIn = requireInteger(args, "expires-in");
        if (expiresIn !== undefined && expiresIn <= 0) {
          throw new UsageError(
            `option "--expires-in" must be at least 1 minute`,
          );
        }
        const expiresAt =
          expiresIn === undefined
            ? undefined
            : toIsoString(
                new Date(env.clock.now().getTime() + expiresIn * 60_000),
              );

        // Dry run: validate the same target and report the grant that *would* be
        // recorded — without recording it, and without resuming anything. The
        // required `--approver` is still checked, so a dry run refuses what a real
        // run would refuse.
        if (dryRun) {
          const approver = requireFlag(args, "approver");
          io.out(
            json
              ? JSON.stringify(
                  {
                    dryRun: true,
                    wouldGrantApproval: {
                      requestId: target.requestId,
                      riskLevel: target.riskLevel,
                      approver,
                      ...(expiresAt === undefined ? {} : { expiresAt }),
                    },
                    wouldResume: resume,
                  },
                  null,
                  2,
                )
              : [
                  `Dry run: would grant approval ${target.requestId} to ${approver} for task ${id}.`,
                  resume
                    ? "Dry run: the suspended attempt would then be resumed; nothing was run."
                    : "Nothing was recorded (dry run).",
                ].join("\n"),
          );
          return EXIT_OK;
        }

        await runtime.approvals.grant({
          workspaceId: stored.task.workspaceId,
          taskId: stored.task.id,
          requestId: target.requestId,
          riskLevel: target.riskLevel,
          ...(target.operation === undefined
            ? {}
            : { operation: target.operation }),
          approver: requireFlag(args, "approver"),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        });
      } else if (!(resume && usable.length > 0)) {
        throw new UsageError(noPendingMessage(id, states));
      }

      // Resuming an existing grant needs no new approval: a dry run reports that
      // the attempt would continue and stops before the run use case is reached.
      if (dryRun) {
        io.out(
          json
            ? JSON.stringify(
                { dryRun: true, wouldGrantApproval: null, wouldResume: resume },
                null,
                2,
              )
            : [
                `Dry run: no new approval would be granted for task ${id}.`,
                resume
                  ? `Dry run: the suspended attempt would be resumed with the existing grant; nothing was run.`
                  : "Nothing was recorded (dry run).",
              ].join("\n"),
        );
        return EXIT_OK;
      }

      if (!resume) {
        const granted = states.find(
          (state) => state.requestId === target?.requestId,
        );
        const current = (await runtime.ledger.forTask(scope, id)).find(
          (state) => state.requestId === target?.requestId,
        );
        io.out(
          json
            ? JSON.stringify(current ?? granted ?? null, null, 2)
            : [
                `Granted approval ${target?.requestId ?? ""} for task ${id}.`,
                `Continue the suspended attempt with: ai task run ${id}`,
              ].join("\n"),
        );
        return EXIT_OK;
      }

      // Whether this task may be attempted at all is the run use case's decision,
      // not the CLI's: a task-level suspension leaves the task at `created`, so a
      // status check here would refuse exactly the case `--resume` exists for.
      const result = await runtime.runTask.run(stored);
      if (json) {
        io.out(JSON.stringify(result, null, 2));
      } else {
        io.out(formatRunResult(result));
        io.out("");
        io.out(formatUsage(await runtime.traces.read(scope, id)));
      }
      return runOutcomeExitCode(result.outcome);
    }

    case "complete": {
      const runtime = await openRuntimeFor(args, env);
      const stored = await runtime.tasks.load(
        readScope(runtime, args),
        positionalTaskId(args),
      );
      const reason = flagValue(args, "reason") ?? "completed by human review";

      // Dry run: compute the transition (so an illegal close still refuses) without
      // recording the event or rewriting the projection.
      if (flagBool(args, "dry-run")) {
        const planned = runtime.tasks.planComplete(stored);
        emit(
          io,
          json,
          { dryRun: true, wouldComplete: planned },
          formatDryRunTask(planned, "complete"),
        );
        return EXIT_OK;
      }

      const completed = await runtime.tasks.complete(stored, reason);
      emit(io, json, completed, formatTask(completed));
      return EXIT_OK;
    }

    case "verdict": {
      const runtime = await openRuntimeFor(args, env);
      const stored = await runtime.tasks.load(
        readScope(runtime, args),
        positionalTaskId(args),
      );
      const criterionId = requireFlag(args, "criterion");
      const status = verdictStatus(requireFlag(args, "status"));
      const verdictBy = requireFlag(args, "by");
      const verdict = { criterionId, status, verdictBy };

      // Dry run: the same domain mutation (so an unknown criterion or a terminal task
      // still refuses), with no event and no save.
      if (flagBool(args, "dry-run")) {
        const planned = runtime.tasks.planAcceptanceVerdict(stored, verdict);
        emit(
          io,
          json,
          { dryRun: true, wouldRecordVerdict: verdict, task: planned },
          formatVerdictPlan(planned, criterionId, status, verdictBy),
        );
        return EXIT_OK;
      }

      const recorded = await runtime.tasks.recordAcceptanceVerdict(
        stored,
        verdict,
      );
      // The task is printed afterwards so the operator sees the criterion's new state
      // and its provenance in one place. `--note` is for the terminal only: the log
      // carries the decision, never the prose someone attached to it.
      const note = flagValue(args, "note");
      emit(
        io,
        json,
        recorded,
        [
          `Recorded "${status}" for ${criterionId} on task ${recorded.task.id}, by ${verdictBy}.`,
          ...(note === undefined ? [] : [`Note: ${note}`]),
          "",
          formatTask(recorded),
        ].join("\n"),
      );
      return EXIT_OK;
    }

    default:
      // `specsFor` already rejected unknown subcommands; this is unreachable.
      throw new UsageError(`unhandled subcommand "task ${subcommand}"`);
  }
}
