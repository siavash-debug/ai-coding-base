import { basename } from "node:path";

import { initializeProject } from "../../application/runtime.js";
import { type FlagSpec, flagBool, flagValue, parseArgv } from "../args.js";
import { EXIT_OK, type CliEnv, type CliIo } from "../io.js";
import { printHelp } from "../help.js";

/**
 * `ai init`: provision a project.
 *
 * Without `--force` this refuses to overwrite an existing configuration, because
 * a project's identity anchors every task recorded under it. The name and slug
 * default to the directory the command runs in, so the common case is a bare
 * `ai init`.
 */
export const INIT_SPECS: readonly FlagSpec[] = [
  {
    name: "name",
    value: true,
    placeholder: "name",
    description: "project display name (default: directory name)",
  },
  {
    name: "slug",
    value: true,
    placeholder: "slug",
    description:
      "project slug, ^[a-z][a-z0-9-]*$ (default: derived from directory)",
  },
  {
    name: "force",
    value: false,
    description:
      "rewrite an existing .ai/project.json (never touches the event log)",
  },
  { name: "json", value: false, description: "emit machine-readable JSON" },
  { name: "help", value: false, aliases: ["h"], description: "show this help" },
];

export const INIT_USAGE =
  "ai init [--name <name>] [--slug <slug>] [--force] [--json]";

/** Derives a legal project slug from a directory name. */
export function deriveSlug(directory: string): string {
  const cleaned = directory
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "");
  return cleaned === "" ? "project" : cleaned;
}

export async function runInit(
  argv: readonly string[],
  io: CliIo,
  env: CliEnv,
): Promise<number> {
  const args = parseArgv(argv, INIT_SPECS);
  if (flagBool(args, "help")) {
    printHelp(io, INIT_USAGE, INIT_SPECS);
    return EXIT_OK;
  }

  const directory = basename(env.cwd) || "project";
  const name = flagValue(args, "name") ?? directory;
  const slug = flagValue(args, "slug") ?? deriveSlug(directory);

  const result = await initializeProject({
    projectRoot: env.cwd,
    name,
    slug,
    clock: env.clock,
    ...(flagBool(args, "force") ? { force: true } : {}),
  });

  if (flagBool(args, "json")) {
    io.out(
      JSON.stringify(
        {
          configPath: result.configPath,
          project: result.config.project,
          workspaces: result.config.workspaces,
          modelRates: result.config.modelRates,
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }

  io.out(`Initialised project "${result.config.project.slug}"`);
  io.out(`  project    ${result.config.project.id}`);
  io.out(`  workspace  ${result.config.workspaces[0].id}`);
  io.out(`  config     ${result.configPath}`);
  io.out("");
  io.out("Next:");
  io.out("  ai doctor");
  io.out('  ai task create --title "My first task" --description "..."');
  return EXIT_OK;
}
