import { toIsoString } from "../../core/clock.js";
import { modelAvailabilityAt } from "../../models/model.js";
import type { FlagSpec } from "../args.js";
import { flagBool, parseArgv } from "../args.js";
import { openRuntimeFor } from "../context.js";
import { printHelp } from "../help.js";
import { EXIT_OK, type CliEnv, type CliIo } from "../io.js";
import { formatFrontierModels } from "../render.js";

/**
 * `ai models`: the model catalog and what it would take to reach it.
 *
 * The two questions are reported separately because they are separate facts:
 *
 * - **What can a model do?** Declared capabilities, modalities, latency class and
 *   priority, straight from configuration.
 * - **Can it be reached?** Whether a provider adapter exists for it (which requires
 *   the provider to be configured *and* a policy host allowlist entry).
 *
 * Read-only and offline. It never calls a provider and never prints a credential —
 * the credential *variable name* is metadata the operator wrote themselves, and its
 * value is never read by this command at all.
 *
 * Scope is resolved the same way every other command resolves it, so the catalog this
 * prints is this workspace's own.
 */
export const MODELS_SPECS: readonly FlagSpec[] = [
  {
    name: "workspace",
    value: true,
    placeholder: "id",
    description: "workspace whose model catalog to inspect",
  },
  { name: "json", value: false, description: "emit machine-readable JSON" },
  { name: "help", value: false, aliases: ["h"], description: "show this help" },
];

export const MODELS_USAGE = "ai models [--json] [--workspace <id>]";

export async function runModelsCommand(
  argv: readonly string[],
  io: CliIo,
  env: CliEnv,
): Promise<number> {
  const args = parseArgv(argv, MODELS_SPECS);
  if (flagBool(args, "help")) {
    printHelp(io, MODELS_USAGE, MODELS_SPECS);
    return EXIT_OK;
  }

  const runtime = await openRuntimeFor(args, env);
  const reachable = new Set(runtime.frontierProviders);
  const catalog = runtime.registry.list();
  // One instant for the whole catalog, read from the runtime's own clock, so this
  // listing cannot straddle a window that opens while it is being printed.
  const availability = modelAvailabilityAt(
    catalog,
    toIsoString(runtime.clock.now()),
  );
  const models = catalog.map((model) => ({
    ...model,
    providerConfigured: reachable.has(model.providerId),
    availability: availability.get(model.modelId),
  }));

  io.out(
    flagBool(args, "json")
      ? JSON.stringify(
          {
            routing: runtime.frontierConfig.routing,
            enabled: runtime.frontierConfig.enabled,
            models,
            providers: runtime.frontierConfig.providers.map((provider) => ({
              ...provider,
              adapterBuilt: reachable.has(provider.id),
            })),
            reachableModels: runtime.frontier.models(),
          },
          null,
          2,
        )
      : formatFrontierModels({
          registry: runtime.registry,
          config: runtime.frontierConfig,
          providers: runtime.frontierProviders,
          availability,
        }),
  );
  return EXIT_OK;
}
