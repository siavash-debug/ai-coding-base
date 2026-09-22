import type { Runtime } from "../application/runtime.js";
import { openRuntime } from "../application/runtime.js";
import {
  assertProviderCredentials,
  credentialReport,
} from "../application/credential-preflight.js";
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

/**
 * Where a developer is most likely to have put the credential.
 *
 * Kept in the CLI rather than in the preflight module: an embedding that calls the
 * application layer has its own way of providing a credential, and the preflight
 * should not presume one.
 */
export const PROVIDER_CREDENTIAL_HINT =
  "add them to .env.local (gitignored) or export them in the environment that " +
  "launches the CLI";

/**
 * Refuses to start provider work when a provider's credential variable is not set.
 *
 * Called by the commands that can reach a provider (`ai task run`, `ai task
 * orchestrate`) before the task is claimed, a session is opened or a decision is
 * asked. The message names providers and variables only — never a value, a length or
 * a fingerprint — so it is safe to print, safe to paste into an issue and safe to
 * record (ADR-033).
 */
export function requireProviderCredentials(runtime: Runtime): void {
  assertProviderCredentials(
    credentialReport(runtime.credentialRequirements, runtime.environment),
    { hint: PROVIDER_CREDENTIAL_HINT },
  );
}
