import { isDomainError } from "../core/errors.js";
import { UsageError } from "./args.js";
import { runApprovalsCommand } from "./commands/approvals.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runTaskCommand } from "./commands/task.js";
import { formatHelp } from "./help.js";
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  type CliEnv,
  type CliIo,
} from "./io.js";

/**
 * Command dispatch.
 *
 * `main` is a pure function of `(argv, io, env)` returning an exit code — no
 * `process` access, no `process.exit`, no implicit stdout. The process wiring lives
 * in `run.ts`. That split is what lets the whole CLI be tested in-process against a
 * temporary project, deterministically and offline.
 *
 * Errors are never swallowed into exit code 0. A usage error exits 2 and a domain
 * error exits 1, always with a message on stderr.
 */
export async function main(
  argv: readonly string[],
  io: CliIo,
  env: CliEnv,
): Promise<number> {
  try {
    const [group, ...tail] = argv;

    if (group === undefined) {
      io.out(formatHelp());
      return EXIT_USAGE;
    }
    if (group === "help" || group === "--help" || group === "-h") {
      io.out(formatHelp());
      return EXIT_OK;
    }
    if (group === "init") {
      return await runInit(tail, io, env);
    }
    if (group === "doctor") {
      return await runDoctorCommand(tail, io, env);
    }
    if (group === "task") {
      return await runTaskCommand(tail, io, env);
    }
    if (group === "approvals") {
      return await runApprovalsCommand(tail, io, env);
    }
    if (group.startsWith("-")) {
      // An unknown global flag is a usage error, not an unknown command.
      throw new UsageError(`unknown option "${group}"`);
    }
    throw new UsageError(`unknown command "${group}"; run \`ai help\``);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`error: ${error.message}`);
      io.err("run `ai help` for usage");
      return error.exitCode;
    }
    if (isDomainError(error)) {
      io.err(`error: ${error.code}: ${error.message}`);
      return EXIT_FAILURE;
    }
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  }
}
