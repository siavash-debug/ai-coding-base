import { type FlagSpec, flagBool, parseArgv } from "../args.js";
import { openRuntimeFor, readScope } from "../context.js";
import { printHelp } from "../help.js";
import { EXIT_OK, type CliEnv, type CliIo } from "../io.js";
import { formatApprovals } from "../render.js";

/**
 * `ai approvals`: what is waiting on a human, and what has been used.
 *
 * Read-only. Granting is a separate, deliberate act (`ai task approve`) because
 * approving is taking ownership of a risk, and a command that both lists and grants
 * invites approving by accident.
 *
 * Status comes from the ledger, which projects it from the event log — so this
 * command cannot disagree with the trace or with `ai doctor`.
 */
export const APPROVALS_SPECS: readonly FlagSpec[] = [
  {
    name: "workspace",
    value: true,
    placeholder: "id",
    description: "workspace to read (default: all workspaces in this project)",
  },
  { name: "json", value: false, description: "emit machine-readable JSON" },
  { name: "help", value: false, aliases: ["h"], description: "show this help" },
];

export const APPROVALS_USAGE = "ai approvals [--workspace <id>] [--json]";

export async function runApprovalsCommand(
  argv: readonly string[],
  io: CliIo,
  env: CliEnv,
): Promise<number> {
  const args = parseArgv(argv, APPROVALS_SPECS);
  if (flagBool(args, "help")) {
    printHelp(io, APPROVALS_USAGE, APPROVALS_SPECS);
    return EXIT_OK;
  }

  const runtime = await openRuntimeFor(args, env);
  const states = await runtime.ledger.list(readScope(runtime, args));

  io.out(
    flagBool(args, "json")
      ? JSON.stringify(states, null, 2)
      : formatApprovals(states, runtime.project.id),
  );
  return EXIT_OK;
}
