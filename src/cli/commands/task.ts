import type { ApprovalState } from "../../application/approval-ledger.js";
import type { TaskTrace } from "../../application/trace.js";
import { toIsoString } from "../../core/clock.js";
import { DomainError } from "../../core/errors.js";
import { isValidId, taskId as toTaskId } from "../../core/ids.js";
import type { TaskId } from "../../core/ids.js";
import { RISK_LEVELS, type RiskLevel } from "../../decisions/risk.js";
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
import { EXIT_FAILURE, EXIT_OK, type CliEnv, type CliIo } from "../io.js";
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
  ...COMMON_SPECS,
];

const COMPLETE_SPECS: readonly FlagSpec[] = [
  {
    name: "reason",
    value: true,
    placeholder: "text",
    description: "why the task is being closed",
  },
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
  ...COMMON_SPECS,
];

const APPROVE_SPECS: readonly FlagSpec[] = [
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

/** Per-subcommand usage and specs, for `--help` and for error messages. */
const SUBCOMMANDS: Readonly<
  Record<
    string,
    { readonly usage: string; readonly specs: readonly FlagSpec[] }
  >
> = {
  create: {
    usage: "ai task create --title <text> --description <text> [options]",
    specs: CREATE_SPECS,
  },
  list: {
    usage: "ai task list [--json] [--workspace <id>]",
    specs: COMMON_SPECS,
  },
  status: { usage: "ai task status <task-id> [--json]", specs: COMMON_SPECS },
  run: { usage: "ai task run <task-id> [--json]", specs: COMMON_SPECS },
  orchestrate: {
    usage:
      "ai task orchestrate <task-id> [--context] [--require <capability>] [--specialize <domain>] [--subtask <instruction>] [--json]",
    specs: ORCHESTRATE_SPECS,
  },
  trace: { usage: "ai task trace <task-id> [--json]", specs: COMMON_SPECS },
  context: {
    usage: "ai task context <task-id> [--select] [--explain] [--json]",
    specs: CONTEXT_SPECS,
  },
  usage: { usage: "ai task usage <task-id> [--json]", specs: COMMON_SPECS },
  decisions: {
    usage: "ai task decisions <task-id> [--json]",
    specs: COMMON_SPECS,
  },
  cost: { usage: "ai task cost <task-id> [--json]", specs: COMMON_SPECS },
  complete: {
    usage: "ai task complete <task-id> [--reason <text>] [--json]",
    specs: COMPLETE_SPECS,
  },
  approve: {
    usage:
      "ai task approve <task-id> --approver <name> [--request <id>] [--expires-in <minutes>] [--resume]",
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

      const stored = await runtime.tasks.create(
        {
          title: requireFlag(args, "title"),
          description: requireFlag(args, "description"),
          ...(risk === undefined ? {} : { riskLevel: risk as RiskLevel }),
          context: flagValues(args, "context"),
          constraints: flagValues(args, "constraint"),
          acceptanceCriteria: flagValues(args, "acceptance"),
          budget,
        },
        { project: runtime.project, workspace: runtime.workspace },
      );
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

      const stored = await runtime.tasks.load(scope, id);
      const selected = await selectContextForTask(
        {
          context: runtime.context,
          contextConfig: runtime.contextConfig,
        },
        stored.task,
      );
      if (json) {
        io.out(JSON.stringify(selected.selection, null, 2));
        return selected.selection.budgetExceeded ? EXIT_FAILURE : EXIT_OK;
      }
      io.out(formatContextSelection(selected.selection, { explain: true }));
      io.out("");
      io.out(
        `Recorded selection ${selected.selection.selectionId} for task ${id}.`,
      );
      return selected.selection.budgetExceeded ? EXIT_FAILURE : EXIT_OK;
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
      requireProviderCredentials(runtime);
      const scope = readScope(runtime, args);
      const id = positionalTaskId(args);
      const stored = await runtime.tasks.load(scope, id);
      const result = await runtime.runTask.run(stored);

      if (json) {
        io.out(JSON.stringify(result, null, 2));
      } else {
        io.out(formatRunResult(result));
        io.out("");
        io.out(formatUsage(await runtime.traces.read(scope, id)));
      }
      // Zero only when the attempt reached review: anything else needs attention.
      return result.outcome === "awaiting-review" ? EXIT_OK : EXIT_FAILURE;
    }

    case "orchestrate": {
      const runtime = await openRuntimeFor(args, env);
      requireProviderCredentials(runtime);
      const scope = readScope(runtime, args);
      const id = positionalTaskId(args);
      const stored = await runtime.tasks.load(scope, id);

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
        return EXIT_FAILURE;
      }

      // Consumption already recorded for this task, so the task budget is a hard
      // bound across runs rather than a per-run limit.
      const prior = await runtime.traces.read(scope, id);
      const requiredCapabilities = flagValues(args, "require");
      const requiredSpecializations = flagValues(args, "specialize");
      const subTasks = flagValues(args, "subtask").map(
        (instruction, index) => ({
          id: `subtask-${index + 1}`,
          instruction,
          requiredCapabilities: ["reasoning"],
        }),
      );

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
        ...(requiredCapabilities.length === 0 &&
        requiredSpecializations.length === 0
          ? {}
          : {
              requirements: {
                ...(requiredCapabilities.length === 0
                  ? {}
                  : { requiredCapabilities }),
                ...(requiredSpecializations.length === 0
                  ? {}
                  : { requiredSpecializations }),
              },
            }),
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
      return result.outcome === "awaiting-review" ? EXIT_OK : EXIT_FAILURE;
    }

    case "complete": {
      const runtime = await openRuntimeFor(args, env);
      const stored = await runtime.tasks.load(
        readScope(runtime, args),
        positionalTaskId(args),
      );
      const reason = flagValue(args, "reason") ?? "completed by human review";
      const completed = await runtime.tasks.complete(stored, reason);
      emit(io, json, completed, formatTask(completed));
      return EXIT_OK;
    }

    default:
      // `specsFor` already rejected unknown subcommands; this is unreachable.
      throw new UsageError(`unhandled subcommand "task ${subcommand}"`);
  }
}
