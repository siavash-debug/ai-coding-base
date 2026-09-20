import { runDoctor } from "../../application/doctor.js";
import { type FlagSpec, flagBool, parseArgv } from "../args.js";
import { EXIT_OK, type CliEnv, type CliIo } from "../io.js";
import { printHelp } from "../help.js";
import { formatDoctor } from "../render.js";

/**
 * `ai doctor`.
 *
 * Exits non-zero when a check fails, so it can gate CI. Warnings — the simulated
 * agent runtime and the absent vendor provider — are reported but do not fail the
 * command, because they describe the current phase rather than a broken install.
 */
export const DOCTOR_SPECS: readonly FlagSpec[] = [
  { name: "json", value: false, description: "emit machine-readable JSON" },
  { name: "help", value: false, aliases: ["h"], description: "show this help" },
];

export const DOCTOR_USAGE = "ai doctor [--json]";

export async function runDoctorCommand(
  argv: readonly string[],
  io: CliIo,
  env: CliEnv,
): Promise<number> {
  const args = parseArgv(argv, DOCTOR_SPECS);
  if (flagBool(args, "help")) {
    printHelp(io, DOCTOR_USAGE, DOCTOR_SPECS);
    return EXIT_OK;
  }

  const report = await runDoctor({
    projectRoot: env.cwd,
    clock: env.clock,
    runtimeVersion: env.runtimeVersion,
    platform: env.platform,
  });

  io.out(
    flagBool(args, "json")
      ? JSON.stringify(report, null, 2)
      : formatDoctor(report),
  );
  return report.exitCode;
}
