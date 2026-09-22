import {
  runPolicyCheck,
  policyCheckExitCode,
} from "../../application/policy-check.js";
import { describePolicyCapabilities } from "../../policy/access-policy.js";
import { type FlagSpec, flagBool, flagValue, parseArgv } from "../args.js";
import { openRuntimeFor, readScope } from "../context.js";
import { printHelp } from "../help.js";
import { EXIT_OK, EXIT_USAGE, type CliEnv, type CliIo } from "../io.js";
import { formatAccessCheck, formatAccessPolicy } from "../render.js";

/**
 * `ai policy`: inspect the enforcement boundary, and dry-run a decision.
 *
 * Read-only in both modes. Listing prints what policy permits; `check` answers what
 * *would* happen to one operation, using the same evaluation the gateway uses and
 * performing nothing. Neither mode writes an event or consults a grant, so an
 * operator can inspect the boundary as often as they like without changing it.
 */
export const POLICY_SPECS: readonly FlagSpec[] = [
  {
    name: "check",
    value: false,
    description: "evaluate one operation instead of listing the policy",
  },
  {
    name: "capability",
    value: true,
    placeholder: "name",
    description: "capability to evaluate, e.g. filesystem.read",
  },
  {
    name: "target",
    value: true,
    placeholder: "value",
    description: "path, program, URL or variable name for --check",
  },
  {
    name: "workspace",
    value: true,
    placeholder: "id",
    description: "workspace whose policy and boundary to read",
  },
  { name: "json", value: false, description: "emit machine-readable JSON" },
  { name: "help", value: false, aliases: ["h"], description: "show this help" },
];

export const POLICY_USAGE =
  "ai policy [--json]\n" +
  "ai policy --check --capability <name> --target <value> [--json]";

export async function runPolicyCommand(
  argv: readonly string[],
  io: CliIo,
  env: CliEnv,
): Promise<number> {
  const args = parseArgv(argv, POLICY_SPECS);
  if (flagBool(args, "help")) {
    printHelp(io, POLICY_USAGE, POLICY_SPECS);
    return EXIT_OK;
  }

  const runtime = await openRuntimeFor(args, env);
  // Read-only, and it resolves the workspace the same way every other command does
  // so a policy question cannot be asked about a scope this invocation is not in.
  readScope(runtime, args);

  if (!flagBool(args, "check")) {
    const rows = describePolicyCapabilities(runtime.accessPolicy);
    io.out(
      flagBool(args, "json")
        ? JSON.stringify(
            {
              policyId: runtime.accessPolicy.id,
              policyVersion: runtime.accessPolicy.version,
              capabilities: rows,
              envelope: runtime.operations.envelope,
              filesystem: runtime.accessPolicy.filesystem,
              process: runtime.accessPolicy.process,
              network: runtime.accessPolicy.network,
              environment: runtime.accessPolicy.environment,
              sandbox: {
                id: runtime.sandbox.id,
                // What the enforcement layer claims, in one word, so a reader knows
                // this is an in-process boundary and not a container.
                guarantee: runtime.operations.guarantee,
                workspaceId: runtime.sandbox.scope.workspaceId,
              },
            },
            null,
            2,
          )
        : formatAccessPolicy(
            runtime.accessPolicy,
            runtime.operations.envelope,
            runtime.sandbox.id,
          ),
    );
    return EXIT_OK;
  }

  const capability = flagValue(args, "capability");
  const target = flagValue(args, "target");
  if (capability === undefined || target === undefined) {
    io.err("error: --check requires --capability <name> and --target <value>");
    io.err("run `ai help policy` for usage");
    return EXIT_USAGE;
  }

  const outcome = await runPolicyCheck({
    policy: runtime.accessPolicy,
    envelope: runtime.operations.envelope,
    boundary: runtime.sandbox,
    check: { capability, target },
  });

  io.out(
    flagBool(args, "json")
      ? JSON.stringify(outcome, null, 2)
      : formatAccessCheck(outcome, capability, target),
  );

  // A target that cannot be interpreted is a usage error (2); a decision that is
  // refused is a failure (1). Both are non-zero, and distinguishable.
  const code = policyCheckExitCode(outcome);
  if (code === EXIT_USAGE) {
    io.err("error: the target could not be interpreted; nothing was evaluated");
  }
  return code;
}
