import type { Runtime } from "../application/runtime.js";
import { openRuntime } from "../application/runtime.js";
import { workspaceId as toWorkspaceId } from "../core/ids.js";
import type { ProjectScope } from "../ports/scope.js";
import { type ParsedArgs, flagValue } from "./args.js";
import type { CliEnv } from "./io.js";

/**
 * Shared CLI plumbing.
 *
 * The CLI never touches an adapter directly: it asks the composition root for a
 * `Runtime` and calls application services. That keeps adapter selection, id
 * generation and clock injection in exactly one place.
 */
export async function openRuntimeFor(
  args: ParsedArgs,
  env: CliEnv,
): Promise<Runtime> {
  const workspace = flagValue(args, "workspace");
  return openRuntime({
    projectRoot: env.cwd,
    clock: env.clock,
    ...(workspace === undefined
      ? {}
      : { workspaceId: toWorkspaceId(workspace) }),
  });
}

/**
 * Reads are project-scoped unless the caller narrows them with `--workspace`.
 *
 * The project is the isolation boundary (V2-ARCHITECTURE §19), so resolving a task
 * across the workspaces of *this* project is legitimate; reaching another project's
 * data is not, and the store and repository refuse it regardless of what the caller
 * asks for.
 */
export function readScope(runtime: Runtime, args: ParsedArgs): ProjectScope {
  return flagValue(args, "workspace") === undefined
    ? { projectId: runtime.project.id }
    : { projectId: runtime.project.id, workspaceId: runtime.workspace.id };
}
