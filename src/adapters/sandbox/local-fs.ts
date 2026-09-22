import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

import { DomainError } from "../../core/errors.js";
import {
  isSecretShapedPath,
  matchesPathPattern,
} from "../../context/ignore.js";
import {
  isWithinRoot,
  isRuntimeStateRef,
  refWithinAnyRoot,
  resolveRef,
} from "../../policy/path-boundary.js";
import { assertWorkspaceRef } from "../../policy/target.js";
import type { PolicyReasonCode } from "../../policy/reason.js";
import type {
  BoundaryScope,
  FsListResult,
  FsReadResult,
  FsWriteResult,
  OperationRefusal,
} from "../../ports/operation.js";

/**
 * The local filesystem boundary.
 *
 * This is where a reference becomes a file, and it is the only module in the
 * platform that opens one on behalf of an operation. Four refusals are decided
 * here, in this order, and each of them is checked twice — once in `admit` (so a
 * human is never asked to approve an impossible operation) and once in `perform`
 * (so the guarantee does not depend on the caller having asked first):
 *
 * 1. **The reference itself.** `..`, an absolute path, a drive letter, a UNC prefix
 *    or a NUL is refused rather than normalised. A reference that needs repairing
 *    was not understood.
 * 2. **Credential shape.** `.env`, `id_rsa`, `*.pem`, `credentials.json` and the
 *    rest of Phase E's secret vocabulary are refused by name, in both directions.
 *    No capability, approval or configuration makes them reachable.
 * 3. **Runtime state.** `.git/` and `.ai/` may not be written: one is history, the
 *    other is the log and the policy that governs this very check.
 * 4. **The fence.** The reference must be under an allowed root *and*, after
 *    `realpath`, still under it — which is what stops a symlink from being a way
 *    out. The workspace root itself is an unconditional fence, so a task in
 *    workspace A can never touch workspace B even if configuration is wrong.
 *
 * Platform note: containment is compared case-insensitively on Windows and macOS,
 * because those filesystems are case-insensitive and a case-only difference must not
 * read as "outside" (or, worse, as "inside" on one path and "outside" on another).
 */
export interface LocalFsBoundaryOptions {
  readonly scope: BoundaryScope;
  readonly readableRoots: readonly string[];
  readonly writableRoots: readonly string[];
  readonly deniedPatterns: readonly string[];
  readonly maxReadBytes?: number;
  readonly maxListEntries?: number;
  readonly platform?: string;
}

export const DEFAULT_MAX_READ_BYTES = 262_144;
export const DEFAULT_MAX_LIST_ENTRIES = 1_000;

export interface LocalFsBoundary {
  readonly id: string;
  admitRef(
    ref: string,
    direction: "read" | "write",
  ): Promise<OperationRefusal | undefined>;
  read(
    ref: string,
  ): Promise<
    | { readonly ok: true; readonly result: FsReadResult }
    | { readonly ok: false; readonly refusal: OperationRefusal }
  >;
  list(
    ref: string,
  ): Promise<
    | { readonly ok: true; readonly result: FsListResult }
    | { readonly ok: false; readonly refusal: OperationRefusal }
  >;
  write(
    ref: string,
    content: string,
  ): Promise<
    | { readonly ok: true; readonly result: FsWriteResult }
    | { readonly ok: false; readonly refusal: OperationRefusal }
  >;
}

const refusal = (
  reasonCode: PolicyReasonCode,
  reason: string,
): OperationRefusal => ({ reasonCode, reason });

export function createLocalFsBoundary(
  options: LocalFsBoundaryOptions,
): LocalFsBoundary {
  const scope = options.scope;
  const platform = options.platform ?? process.platform;
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxListEntries = options.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;
  /** Resolved lazily and cached: one `realpath` per root per boundary instance. */
  const realRoots = new Map<string, string | undefined>();

  async function realRoot(ref: string): Promise<string | undefined> {
    const cached = realRoots.get(ref);
    if (cached !== undefined) {
      return cached;
    }
    let value: string | undefined;
    try {
      value = await realpath(resolveRef(scope.workspaceRoot, ref));
    } catch {
      value = undefined;
    }
    realRoots.set(ref, value);
    return value;
  }

  /**
   * The deepest existing ancestor of a path, and its real location.
   *
   * A path that does not exist yet (a file about to be created) cannot be
   * `realpath`ed, but its nearest existing ancestor can — and if that ancestor is
   * outside the fence, the path it contains is too.
   */
  async function realAncestor(
    absolute: string,
  ): Promise<{ readonly path: string; readonly real: string } | undefined> {
    let current = absolute;
    for (;;) {
      try {
        return { path: current, real: await realpath(current) };
      } catch {
        const parent = dirname(current);
        if (parent === current) {
          return undefined;
        }
        current = parent;
      }
    }
  }

  async function admitRef(
    ref: string,
    direction: "read" | "write",
  ): Promise<OperationRefusal | undefined> {
    let normalized: string;
    try {
      normalized = assertWorkspaceRef(ref, "ref");
    } catch (error) {
      const detail =
        error instanceof DomainError ? error.message : "reference was refused";
      return refusal("TARGET_REFUSED", detail);
    }

    if (isSecretShapedPath(normalized)) {
      return refusal(
        "SECRET_PATH_DENIED",
        `"${normalized}" is credential-shaped; no capability makes it readable or writable`,
      );
    }
    const denied = options.deniedPatterns.find((pattern) =>
      matchesPathPattern(pattern, normalized),
    );
    if (denied !== undefined) {
      return refusal(
        "POLICY_DENIED",
        `"${normalized}" matches denied pattern "${denied}"`,
      );
    }
    if (direction === "write" && isRuntimeStateRef(normalized)) {
      return refusal(
        "RUNTIME_STATE_DENIED",
        `"${normalized}" is platform runtime state and may not be written`,
      );
    }

    const roots =
      direction === "write" ? options.writableRoots : options.readableRoots;
    const matchedRoot = refWithinAnyRoot(normalized, roots);
    if (matchedRoot === undefined) {
      return refusal(
        "RESOURCE_OUTSIDE_BOUNDARY",
        `"${normalized}" is outside the permitted ${direction === "write" ? "writable" : "readable"} roots`,
      );
    }

    const absolute = resolveRef(scope.workspaceRoot, normalized);
    // The fence: always, whatever configuration says.
    if (!isWithinRoot(scope.workspaceRoot, absolute, platform)) {
      return refusal(
        "RESOURCE_OUTSIDE_BOUNDARY",
        `"${normalized}" resolves outside the workspace root`,
      );
    }

    const realWorkspace = await realRoot(".");
    if (
      realWorkspace !== undefined &&
      !isWithinRoot(realWorkspace, absolute, platform)
    ) {
      // The path is under the workspace as written, but not under the workspace as
      // it really is — meaning an ancestor is a link that leads elsewhere.
      return refusal(
        "SYMLINK_ESCAPE",
        `"${normalized}" resolves through a link that leaves the workspace root`,
      );
    }
    const resolvedRoot = await realRoot(matchedRoot);
    /**
     * A *configured root* that is itself a link out of the workspace is refused.
     *
     * Without this, `readableRoots: ["src"]` plus a `src` symlinked to `/etc` would
     * make every read inside `/etc` "contained": the check below compares the target
     * against the root as it really is, and the root as it really is would be the
     * destination. The fence is the workspace, and a root that leaves it is not a
     * narrower permission but a wider one (ADR-048). `ai doctor` reports the same
     * configuration.
     */
    if (
      realWorkspace !== undefined &&
      resolvedRoot !== undefined &&
      !isWithinRoot(realWorkspace, resolvedRoot, platform)
    ) {
      return refusal(
        "SYMLINK_ESCAPE",
        `the root "${matchedRoot}" is a link that leaves the workspace root`,
      );
    }
    /**
     * A root that does not exist yet falls back to the workspace fence.
     *
     * A destination directory is often created by the write itself, and a path that
     * does not exist is a normal thing to ask about — the ancestor check below is
     * what actually proves containment, and it still has to hold. Refusing an
     * unresolvable root outright would make `out/result.txt` unusable as the first
     * write to `out/`, and would make `ai policy --check` unable to answer a
     * question about a file that is about to be created.
     */
    const rootReal = resolvedRoot ?? realWorkspace;
    if (rootReal === undefined) {
      return refusal(
        "UNRESOLVED_TARGET",
        `the root "${matchedRoot}" could not be resolved`,
      );
    }
    const ancestor = await realAncestor(absolute);
    if (ancestor === undefined) {
      return refusal(
        "UNRESOLVED_TARGET",
        `"${normalized}" could not be resolved to a location`,
      );
    }
    if (!isWithinRoot(rootReal, ancestor.real, platform)) {
      return refusal(
        "SYMLINK_ESCAPE",
        `"${normalized}" resolves outside "${matchedRoot}" through a link`,
      );
    }

    // An existing final component that is itself a link must land inside the root.
    try {
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        const target = await realpath(absolute);
        if (!isWithinRoot(rootReal, target, platform)) {
          return refusal(
            "SYMLINK_ESCAPE",
            `"${normalized}" is a link to a location outside the boundary`,
          );
        }
      }
    } catch {
      // Not existing yet is normal for a write, and harmless for a read: the read
      // will report a missing file rather than a boundary problem.
    }
    return undefined;
  }

  return {
    id: "local-fs-boundary",
    admitRef,

    async read(ref) {
      const admitted = await admitRef(ref, "read");
      if (admitted !== undefined) {
        return { ok: false, refusal: admitted };
      }
      const absolute = resolveRef(scope.workspaceRoot, ref);
      try {
        const stats = await stat(absolute);
        if (!stats.isFile()) {
          return {
            ok: false,
            refusal: refusal(
              "OPERATION_FAILED",
              `"${ref}" is not a regular file`,
            ),
          };
        }
        const content = await readFile(absolute, "utf8");
        const truncated = content.length > maxReadBytes;
        const bounded = truncated ? content.slice(0, maxReadBytes) : content;
        return {
          ok: true,
          result: { content: bounded, bytes: bounded.length, truncated },
        };
      } catch (error) {
        return { ok: false, refusal: describeFsFailure(ref, error) };
      }
    },

    async list(ref) {
      const admitted = await admitRef(ref, "read");
      if (admitted !== undefined) {
        return { ok: false, refusal: admitted };
      }
      const absolute = resolveRef(scope.workspaceRoot, ref);
      try {
        const entries = await readdir(absolute, { withFileTypes: true });
        // Deterministic order and no host paths in the result: names only.
        const names = entries
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const truncated = names.length > maxListEntries;
        return {
          ok: true,
          result: {
            entries: truncated ? names.slice(0, maxListEntries) : names,
            truncated,
          },
        };
      } catch (error) {
        return { ok: false, refusal: describeFsFailure(ref, error) };
      }
    },

    async write(ref, content) {
      const admitted = await admitRef(ref, "write");
      if (admitted !== undefined) {
        return { ok: false, refusal: admitted };
      }
      const absolute = resolveRef(scope.workspaceRoot, ref);
      try {
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, content, "utf8");
        return {
          ok: true,
          result: { bytes: Buffer.byteLength(content, "utf8") },
        };
      } catch (error) {
        return { ok: false, refusal: describeFsFailure(ref, error) };
      }
    },
  };
}

/**
 * A failure message that names the reference and a category, never the absolute
 * path and never the errno text verbatim (which can contain the whole path).
 */
function describeFsFailure(ref: string, error: unknown): OperationRefusal {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  const kind =
    code === "ENOENT"
      ? "does not exist"
      : code === "EACCES" || code === "EPERM"
        ? "is not readable with the platform's own permissions"
        : code === "EISDIR"
          ? "is a directory, not a file"
          : code === "EEXIST"
            ? "already exists"
            : code === "ENOTDIR"
              ? "has a non-directory parent"
              : "could not be read or written";
  return refusal("OPERATION_FAILED", `"${ref}" ${kind}`);
}
