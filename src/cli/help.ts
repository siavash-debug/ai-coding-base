import { type FlagSpec, formatFlagHelp } from "./args.js";
import type { CliIo } from "./io.js";

/**
 * Help text.
 *
 * Static and deterministic: the same invocation always prints the same bytes, so
 * help output can be asserted in tests and diffed in review.
 */
export const COMMANDS: readonly {
  readonly name: string;
  readonly summary: string;
}[] = [
  {
    name: "ai init",
    summary: "provision the project configuration and runtime layout",
  },
  {
    name: "ai doctor",
    summary: "verify the local foundation and report honestly",
  },
  { name: "ai task create", summary: "record a new task" },
  { name: "ai task list", summary: "list recorded tasks" },
  {
    name: "ai task status <task-id>",
    summary: "show a task's lifecycle state and contract",
  },
  {
    name: "ai task run <task-id>",
    summary: "run one bounded attempt and record every step",
  },
  {
    name: "ai task orchestrate <task-id>",
    summary:
      "plan across the model registry, decide with the decision layer and execute through Frontier",
  },
  {
    name: "ai task trace <task-id>",
    summary: "reconstruct the task trace from the event log",
  },
  {
    name: "ai task context <task-id>",
    summary:
      "show the context selected for a task (--select to record a new one)",
  },
  {
    name: "ai task usage <task-id>",
    summary: "show token, call and iteration usage",
  },
  {
    name: "ai task decisions <task-id>",
    summary:
      "show every bounded question this task asked and how it was answered",
  },
  {
    name: "ai task cost <task-id>",
    summary: "show estimated cost and what is unpriced",
  },
  {
    name: "ai task complete <task-id>",
    summary: "close a reviewed task (a human act)",
  },
  {
    name: "ai task approve <task-id>",
    summary: "grant a pending approval, optionally resuming the task",
  },
  {
    name: "ai approvals",
    summary: "list pending, granted, consumed and expired approvals",
  },
  {
    name: "ai policy",
    summary:
      "show the enforcement policy and capabilities (--check to evaluate one operation)",
  },
  {
    name: "ai decision",
    summary:
      "show the decision layer, its budget and what it has decided here (offline)",
  },
  {
    name: "ai models",
    summary:
      "show the model catalog, declared capabilities and provider reachability (offline)",
  },
];

export function formatHelp(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length)) + 2;
  return [
    "ai — AI-native software engineering foundation",
    "",
    "Usage:",
    ...COMMANDS.map(
      (command) => `  ${command.name.padEnd(width)}${command.summary}`,
    ),
    "",
    "Common options: --json, --workspace <id>, --help",
    "Add --help to any command for its options.",
    "",
    "Exit codes: 0 ok, 1 failure, 2 usage error.",
  ].join("\n");
}

export function formatCommandHelp(
  usage: string,
  specs: readonly FlagSpec[],
): string {
  return [`Usage: ${usage}`, "", "Options:", formatFlagHelp(specs)].join("\n");
}

export function printHelp(
  io: CliIo,
  usage: string,
  specs: readonly FlagSpec[],
): void {
  io.out(formatCommandHelp(usage, specs));
}
