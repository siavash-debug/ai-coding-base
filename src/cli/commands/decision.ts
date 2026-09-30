import { describeDecisionLayer } from "../../application/decision-coordinator.js";
import { describeFallbacks } from "../../decisions/fallback.js";
import { answerSourceOf } from "../../observability/metrics.js";
import type { FlagSpec } from "../args.js";
import { flagBool, parseArgv } from "../args.js";
import { openRuntimeFor, readScope } from "../context.js";
import { printHelp } from "../help.js";
import { EXIT_OK, type CliEnv, type CliIo } from "../io.js";
import { formatDecisionLayer } from "../render.js";

/**
 * `ai decision`: what the decision layer is and what it has decided here.
 *
 * Offline by construction. It reports configuration, the provider's declared
 * capabilities, the deterministic fallback policy for every question kind, and the
 * decisions already recorded in this scope. It never calls a provider: proving that a
 * decision service *answers* requires spending money and sending data, which is not
 * something an inspection command should do behind an operator's back.
 *
 * Scope is resolved exactly as every other command resolves it, so this command
 * cannot be pointed at another project's decisions.
 */
export const DECISION_SPECS: readonly FlagSpec[] = [
  {
    name: "workspace",
    value: true,
    placeholder: "id",
    description: "workspace whose decision layer and decisions to inspect",
  },
  { name: "json", value: false, description: "emit machine-readable JSON" },
  { name: "help", value: false, aliases: ["h"], description: "show this help" },
];

export const DECISION_USAGE = "ai decision [--json] [--workspace <id>]";

export async function runDecisionCommand(
  argv: readonly string[],
  io: CliIo,
  env: CliEnv,
): Promise<number> {
  const args = parseArgv(argv, DECISION_SPECS);
  if (flagBool(args, "help")) {
    printHelp(io, DECISION_USAGE, DECISION_SPECS);
    return EXIT_OK;
  }

  const runtime = await openRuntimeFor(args, env);
  const scope = readScope(runtime, args);
  const events = await runtime.store.readAll(scope);

  const counts: Record<string, number> = {};
  let decisions = 0;
  let failures = 0;
  let fallbacks = 0;
  let deterministic = 0;
  let providerAnswers = 0;
  for (const event of events) {
    if (event.type === "DecisionFailed") {
      failures += 1;
      continue;
    }
    if (event.type !== "DecisionCompleted") {
      continue;
    }
    decisions += 1;
    counts[event.payload.kind] = (counts[event.payload.kind] ?? 0) + 1;
    // Classified the same way `ai task usage` classifies it, so the two commands
    // cannot report different numbers for the same log. A record from before the
    // answer source was recorded is classified by `decidedBy` rather than dropped.
    switch (answerSourceOf(event.payload)) {
      case "provider":
        providerAnswers += 1;
        break;
      case "fallback":
        fallbacks += 1;
        break;
      case "deterministic":
        deterministic += 1;
        break;
    }
  }

  const summary = {
    provider: {
      configured: runtime.decisionEngine.configured,
      id: runtime.decisionEngine.providerId ?? null,
      family: runtime.decisionEngine.providerFamily ?? null,
      deterministic: runtime.decisionEngine.deterministic ?? null,
      kinds: runtime.decisionEngine.kinds ?? [],
    },
    description: describeDecisionLayer(
      runtime.decisionEngine,
      runtime.decision,
    ),
    config: runtime.decision,
    fallbacks: describeFallbacks(),
    recorded: {
      decisions,
      providerAnswers,
      deterministic,
      fallbacks,
      failures,
      byKind: counts,
    },
    scope: {
      workspaceId: runtime.workspace.id,
      // Counted from the log, so the number is a fact about this scope rather than
      // about the process that happened to run.
      events: events.length,
    },
  };

  io.out(
    flagBool(args, "json")
      ? JSON.stringify(summary, null, 2)
      : formatDecisionLayer({
          config: runtime.decision,
          info: runtime.decisionEngine,
          counts,
          decisions,
          failures,
          fallbacks,
          deterministic,
          providerAnswers,
        }),
  );
  return EXIT_OK;
}
