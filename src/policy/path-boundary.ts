import { isAbsolute, relative, resolve, sep } from "node:path";

import { assertWorkspaceRef } from "./target.js";

/**
 * Pure path-boundary arithmetic.
 *
 * Two questions are answered here and nowhere else, because both are easy to get
 * subtly wrong and both are security-relevant:
 *
 * 1. **Is this absolute path inside that root?** Answered with `path.relative`,
 *    never with a string prefix. `startsWith("/srv/app")` also accepts
 *    `/srv/app-evil`, which is the classic boundary bug; `relative()` cannot make
 *    that mistake, because it compares path *segments*. On a platform whose
 *    filesystem is case-insensitive the two paths are case-folded first, since there
 *    `/Srv/App/x` and `/srv/app/x` really are the same file (ADR-048).
 * 2. **Does this reference fall under that root reference?** The same containment
 *    question asked at the *reference* level, so policy can be evaluated without
 *    touching the filesystem.
 *
 * Nothing here performs I/O. Symlinks and reparse points cannot be judged from a
 * string, so real-path resolution lives in the sandbox adapter — and until it has
 * run, a path is treated as unproven rather than as safe.
 */

/** `/srv/app-evil` is not inside `/srv/app`. `relative` knows that; prefixes do not. */
/**
 * Whether `target` is `root` or inside it.
 *
 * Both sides are case-folded first on a platform whose filesystem does not
 * distinguish case, because there `/Srv/App/x` and `/srv/app/x` are the same file
 * and a comparison that disagreed would refuse real work. Node's own `relative`
 * folds on win32 but not on darwin, so doing it here is what makes the two
 * platforms behave the same way (ADR-048).
 *
 * The failure direction is deliberate: a case variant that is judged *outside* is a
 * refused operation, while one judged *inside* when it is not would be a boundary
 * escape — so the comparison is only ever loosened by the platform's own rules.
 */
export function isWithinRoot(
  root: string,
  target: string,
  platform: string = process.platform,
): boolean {
  const rel = relative(
    normalizeForCompare(resolve(root), platform),
    normalizeForCompare(resolve(target), platform),
  );
  if (rel === "") {
    return true;
  }
  if (rel.startsWith(`..${sep}`) || rel === "..") {
    return false;
  }
  if (isAbsolute(rel)) {
    // Different volume or drive letter: `relative` returns the target unchanged.
    return false;
  }
  return true;
}

export function isCaseInsensitivePlatform(platform: string): boolean {
  return platform === "win32" || platform === "darwin";
}

/** Case-folds a path for comparison on platforms whose filesystems do not. */
export function normalizeForCompare(
  path: string,
  platform: string = process.platform,
): string {
  return isCaseInsensitivePlatform(platform) ? path.toLowerCase() : path;
}

/** Absolute path an operation targets, resolved against the workspace root. */
export function resolveRef(workspaceRoot: string, ref: string): string {
  return resolve(workspaceRoot, assertWorkspaceRef(ref, "ref"));
}

/**
 * Workspace-relative form of an absolute path, or `undefined` when it is outside.
 *
 * What gets recorded is always this, never the absolute path: the log is shared,
 * and a host path is a fact about one machine (and often carries a username).
 */
export function toWorkspaceRef(
  workspaceRoot: string,
  absolutePath: string,
  platform: string = process.platform,
): string | undefined {
  if (!isWithinRoot(workspaceRoot, absolutePath, platform)) {
    return undefined;
  }
  const rel = relative(resolve(workspaceRoot), resolve(absolutePath));
  if (rel === "") {
    return ".";
  }
  return rel.split(sep).join("/");
}

/**
 * Whether a reference falls under a root reference.
 *
 * `"."` is the workspace root itself. A root is matched on segment boundaries, so
 * root `"src"` covers `src/a.ts` but never `src-evil/a.ts`.
 */
export function refWithinRoot(ref: string, root: string): boolean {
  const target = assertWorkspaceRef(ref, "ref");
  const base = assertWorkspaceRef(root, "root");
  if (base === ".") {
    return true;
  }
  return target === base || target.startsWith(`${base}/`);
}

export function refWithinAnyRoot(
  ref: string,
  roots: readonly string[],
): string | undefined {
  return roots.find((root) => refWithinRoot(ref, root));
}

/**
 * The platform's own state, which an agent may never write.
 *
 * `.git/` is history and `hooks/` inside it is executable; `.ai/` is the append-only
 * log, the task records and the configuration this enforcement is built from. A
 * write there is not "a file change", it is tampering with the audit trail or with
 * policy itself (ADR-047).
 */
export const RUNTIME_STATE_PREFIXES: readonly string[] = [".git", ".ai"];

export function isRuntimeStateRef(ref: string): boolean {
  const segments = ref.split("/");
  return segments.some((segment) =>
    RUNTIME_STATE_PREFIXES.includes(segment.toLowerCase()),
  );
}
