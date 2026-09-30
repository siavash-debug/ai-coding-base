import { relative, resolve, sep } from "node:path";

import { assertSafeAbsolutePath } from "../../core/validation.js";
import { normalizeRef } from "../../context/matching.js";
import type {
  ChangeProvider,
  ChangedPaths,
  ChangeUnavailableReason,
} from "../../ports/change-provider.js";
import type { ProcessRunner } from "../../ports/process-runner.js";

/**
 * Git-backed change detection, with an honest "I cannot tell" answer.
 *
 * The reason this adapter exists rather than a bare `git diff` call is the failure
 * path. A workspace that is not a repository, a container with no `git` on `PATH`,
 * a shallow CI clone with a corrupt index — all of them must produce
 * `available: false` with a category, never an empty change set. "Nothing changed"
 * and "I could not look" lead to different context, and only one of them is a fact.
 *
 * Porcelain output is parsed rather than human output, and with `-z` so that a path
 * containing a newline cannot be confused for a second entry. Both sides of a
 * rename are recorded: a task is often *about* the file that moved.
 *
 * Paths are returned workspace-relative. Git reports them relative to the
 * repository root, so when the workspace is a subdirectory of its repository the
 * prefix is stripped — otherwise every ref would silently fail to match a listing.
 *
 * See docs/architecture/V2-ARCHITECTURE.md §36.7 and DECISIONS.md ADR-042.
 */
export const GIT_CHANGE_PROVIDER_ID = "git-working-tree";
export const GIT_QUERY_TIMEOUT_MS = 5_000;

export interface GitChangeProviderOptions {
  readonly runner: ProcessRunner;
  /** Absolute workspace root. Must be inside the repository for results to apply. */
  readonly workspaceRoot: string;
  readonly providerId?: string;
  readonly timeoutMs?: number;
}

/** One `git status --porcelain -z` entry: two status letters and a path. */
function parsePorcelainZ(stdout: string): readonly string[] {
  const refs: string[] = [];
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.length < 4) {
      continue;
    }
    const status = token.slice(0, 2);
    const path = token.slice(3);
    if (path.length > 0) {
      refs.push(path);
    }
    // A rename or copy emits the original path as the next NUL-separated token;
    // it is consumed here so it is not mistaken for a status entry.
    if (status.startsWith("R") || status.startsWith("C")) {
      const original = tokens[index + 1];
      if (original !== undefined && original.length > 0) {
        refs.push(original);
        index += 1;
      }
    }
  }
  return refs;
}

export function createGitChangeProvider(
  options: GitChangeProviderOptions,
): ChangeProvider {
  const workspaceRoot = resolve(
    assertSafeAbsolutePath(options.workspaceRoot, "workspaceRoot"),
  );
  const timeoutMs = options.timeoutMs ?? GIT_QUERY_TIMEOUT_MS;

  async function git(
    args: readonly string[],
  ): Promise<
    | { readonly ok: true; readonly stdout: string }
    | { readonly ok: false; readonly reason: ChangeUnavailableReason }
  > {
    const result = await options.runner.run({
      command: "git",
      args: ["-C", workspaceRoot, ...args],
      cwd: workspaceRoot,
      timeoutMs,
    });
    if (result.spawnFailed) {
      return { ok: false, reason: "no-vcs" };
    }
    if (!result.ok) {
      return { ok: false, reason: "not-a-repository" };
    }
    return { ok: true, stdout: result.stdout };
  }

  return {
    id: options.providerId ?? GIT_CHANGE_PROVIDER_ID,

    async changedRefs(): Promise<ChangedPaths> {
      const inside = await git(["rev-parse", "--is-inside-work-tree"]);
      if (!inside.ok) {
        return { available: false, reason: inside.reason };
      }
      if (inside.stdout.trim() !== "true") {
        return { available: false, reason: "not-a-repository" };
      }

      const toplevel = await git(["rev-parse", "--show-toplevel"]);
      if (!toplevel.ok || toplevel.stdout.trim().length === 0) {
        return { available: false, reason: "not-a-repository" };
      }
      const repositoryRoot = resolve(toplevel.stdout.trim());
      const prefix = relative(repositoryRoot, workspaceRoot)
        .split(sep)
        .filter((segment) => segment !== "" && segment !== ".");
      if (prefix.length > 0 && prefix[0] === "..") {
        // The workspace is *above* its repository root, so repository-relative
        // paths cannot be mapped onto workspace refs without guessing.
        return { available: false, reason: "not-a-repository" };
      }

      const head = await git(["rev-parse", "--verify", "--short", "HEAD"]);
      const revision = head.ok ? head.stdout.trim() : undefined;

      const status = await git([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      if (!status.ok) {
        return {
          available: false,
          reason: "query-failed",
          ...(revision === undefined || revision === "" ? {} : { revision }),
        };
      }

      const refs: string[] = [];
      for (const raw of parsePorcelainZ(status.stdout)) {
        const stripped =
          prefix.length === 0
            ? raw
            : raw.split("/").slice(prefix.length).join("/");
        const ref = normalizeRef(stripped);
        if (ref !== undefined && !refs.includes(ref)) {
          refs.push(ref);
        }
      }
      refs.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

      return {
        available: true,
        refs,
        ...(revision === undefined || revision === "" ? {} : { revision }),
      };
    },
  };
}

/**
 * The provider used when change detection is switched off by configuration.
 *
 * It reports the same shape as a real one, so no caller needs a branch — and it
 * reports `disabled` rather than an empty change set, so the trace says why the
 * selection had no change information.
 */
export function createDisabledChangeProvider(
  providerId = "change-detection-disabled",
): ChangeProvider {
  return {
    id: providerId,
    async changedRefs(): Promise<ChangedPaths> {
      return { available: false, reason: "disabled" };
    },
  };
}
