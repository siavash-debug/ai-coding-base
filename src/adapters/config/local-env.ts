import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { isMissingFile } from "./project-config.js";

/**
 * `.env.local`: the developer's own credential file, loaded once, recorded nowhere.
 *
 * Credentials are *references* in this platform (ADR-033): a project configuration
 * names the environment variable that holds a key, and the value is read through the
 * `Environment` port at call time. This module changes none of that. It runs in the
 * CLI entry point *before* a runtime is opened and does one thing: fills the process
 * environment from a gitignored local file. Everything above it — the composition
 * root, the provider adapters, the redaction rules — keeps working exactly as before,
 * because `.env.local` is only another way for `process.env` to be populated
 * (ADR-022).
 *
 * Five rules are enforced here rather than documented as intentions:
 *
 * - **The real environment wins.** A name already set to a non-empty value is never
 *   overwritten, so an explicitly exported credential is authoritative and a stale
 *   file cannot shadow it.
 * - **A placeholder grants nothing.** `TYPESAFE_API_KEY=` declares a name with no
 *   value: it is ignored, so the checked-in template stays empty and an adapter never
 *   has to interpret an empty string as "a credential is present".
 * - **Development only.** `NODE_ENV=production` disables loading entirely. The file is
 *   for a developer's machine, not for a deployed process.
 * - **No aliases, no fallbacks.** Exactly the names the file declares are set. There
 *   is no notion of "the provider credential" here, so `TYPESAFE_API_KEY` can never
 *   satisfy OpenRouter's variable or the reverse: provider credentials stay separate
 *   (ADR-033, ADR-050).
 * - **Names only, never values.** The result reports which *names* were applied, so an
 *   operator could be told what the file did. No value, prefix, suffix, length or
 *   fingerprint is ever returned, logged or recorded.
 *
 * The file is never copied, bundled or read at request time: it is read once per
 * process, and only by the CLI entry point that calls this function.
 */

export const LOCAL_ENV_FILE_NAME = ".env.local";
/** The mode variable that disables local loading. */
export const LOCAL_ENV_MODE_VARIABLE = "NODE_ENV";
/** The mode value that disables local loading. */
export const LOCAL_ENV_DISABLED_MODE = "production";

/**
 * A shell-compatible variable name.
 *
 * Checked here as well as in the parser so that a name the environment cannot express
 * as `VAR=value` is reported as ignored rather than silently set.
 */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What happened to the local file.
 *
 * `invalid` exists so the entry point can stop instead of running with a
 * half-applied configuration: a file the platform could not use is a fact an operator
 * must see, not a silent absence. The status carries no content, because the content
 * is exactly where a credential would be.
 */
export type LocalEnvStatus = "loaded" | "absent" | "disabled" | "invalid";

export interface LocalEnvLoadResult {
  /** Absolute path of the file that was considered. Safe to print. */
  readonly path: string;
  readonly status: LocalEnvStatus;
  /** Names this file supplied a value for, sorted. Never values. */
  readonly applied: readonly string[];
  /** Names this file mentioned but did not win: already set, or left empty. */
  readonly ignored: readonly string[];
}

export interface LocalEnvLoadOptions {
  readonly projectRoot: string;
  /**
   * The environment to fill.
   *
   * Defaults to `process.env`, which is what the CLI uses. Injected by tests so no
   * test can read, write or depend on the machine's real environment.
   */
  readonly target?: Record<string, string | undefined>;
  /** Overrides the file name. Used by tests; the CLI never passes it. */
  readonly fileName?: string;
}

export async function loadLocalEnv(
  options: LocalEnvLoadOptions,
): Promise<LocalEnvLoadResult> {
  const target = options.target ?? process.env;
  const fileName = options.fileName ?? LOCAL_ENV_FILE_NAME;
  const path = join(options.projectRoot, fileName);
  const nothing = { applied: [], ignored: [] } as const;

  if (target[LOCAL_ENV_MODE_VARIABLE] === LOCAL_ENV_DISABLED_MODE) {
    return { path, status: "disabled", ...nothing };
  }

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { path, status: "absent", ...nothing };
    }
    // Unreadable for another reason (permissions, a directory in the way). The file is
    // named; its content is not, and the underlying error is not forwarded because a
    // filesystem error can quote the path's contents in its message.
    return { path, status: "invalid", ...nothing };
  }

  // The parser's values are optional: a name it could not read a value for is the
  // parser's way of saying "nothing usable here", and it is treated as a placeholder.
  let parsed: Record<string, string | undefined>;
  try {
    parsed = parseEnv(text);
  } catch {
    // A parse failure can quote the offending line, and a line in this file is exactly
    // where a credential would be. The status is reported; the words are not.
    return { path, status: "invalid", ...nothing };
  }

  const applied: string[] = [];
  const ignored: string[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (
      !VARIABLE_NAME.test(name) ||
      value === undefined ||
      value.length === 0
    ) {
      // A name the environment cannot express, or a name with no value: the file said
      // nothing usable about either, so neither is applied.
      ignored.push(name);
      continue;
    }
    const current = target[name];
    if (current !== undefined && current.length > 0) {
      ignored.push(name);
      continue;
    }
    target[name] = value;
    applied.push(name);
  }

  return {
    path,
    status: "loaded",
    applied: applied.sort(),
    ignored: ignored.sort(),
  };
}
