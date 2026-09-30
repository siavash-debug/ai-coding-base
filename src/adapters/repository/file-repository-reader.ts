import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { DomainError } from "../../core/errors.js";
import { assertSafeAbsolutePath } from "../../core/validation.js";
import {
  DEFAULT_EXCLUDED_DIRECTORIES,
  assertSafeRelativeRef,
} from "../../context/ignore.js";
import type {
  RepositoryEntry,
  RepositoryListing,
  RepositoryReader,
} from "../../ports/repository-reader.js";

/**
 * The default `RepositoryReader`: a bounded, read-only walk of one workspace.
 *
 * Guarantees that matter more than speed:
 *
 * - **Bound to one root.** Every path is resolved against the constructed root and
 *   refused if it escapes, so a `../` in a candidate ref cannot read another
 *   project's file. Isolation is enforced here rather than trusted from above.
 * - **No symlinks followed.** A symlink could point outside the workspace, and
 *   following it would silently widen the boundary the reader exists to enforce.
 * - **Hard-excluded directories are not descended into.** `node_modules`, `.git`
 *   and `.ai` are skipped by name, so their contents are never even enumerated.
 * - **Capped.** Entry count and depth are bounded, and hitting the cap is reported
 *   (`truncated`) rather than hidden, because a selection over a truncated listing
 *   is a different selection.
 *
 * Ignore rules are *not* applied here. Which paths count as source is policy, it
 * must be explainable in a trace, and it must be testable without a filesystem —
 * so it lives in `src/context/ignore.ts` and this adapter only enumerates. Binary
 * and lockfile-shaped names are skipped, which is a text-decoding concern rather
 * than policy: reading them could only ever produce noise.
 *
 * See docs/architecture/V2-ARCHITECTURE.md §36.2 and DECISIONS.md ADR-041.
 */
export const FILE_REPOSITORY_READER_ID = "file-repository-reader";
export const MAX_REPOSITORY_ENTRIES = 20_000;
export const MAX_REPOSITORY_DEPTH = 24;

/**
 * Extensions that are not text. Skipped by name so their bytes are never read.
 * Lockfiles are included because they are large, generated and never useful
 * context — `package.json` remains available.
 */
const NON_TEXT_EXTENSIONS: readonly string[] = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
  ".ico",
  ".svgz",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".jar",
  ".war",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".wav",
  ".ogg",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".class",
  ".o",
  ".a",
  ".wasm",
  ".pyc",
  ".pyo",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".parquet",
  ".arrow",
  ".lock",
  ".map",
];

function isNonTextRef(ref: string): boolean {
  const lower = ref.toLowerCase();
  return NON_TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export interface FileRepositoryReaderOptions {
  /** Absolute workspace root. Must already have been validated by the caller. */
  readonly rootPath: string;
  readonly readerId?: string;
  /**
   * Directory names never descended into. Defaults to the platform's hard
   * exclusions; a caller may pass a superset but not a subset — removing `.git`
   * from the list would only make the walk slower.
   */
  readonly excludedDirectories?: readonly string[];
  readonly maxEntries?: number;
  readonly maxDepth?: number;
}

export function createFileRepositoryReader(
  options: FileRepositoryReaderOptions,
): RepositoryReader {
  const root = resolve(assertSafeAbsolutePath(options.rootPath, "rootPath"));
  const excluded = new Set(
    options.excludedDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES,
  );
  for (const required of DEFAULT_EXCLUDED_DIRECTORIES) {
    excluded.add(required);
  }
  const maxEntries = options.maxEntries ?? MAX_REPOSITORY_ENTRIES;
  const maxDepth = options.maxDepth ?? MAX_REPOSITORY_DEPTH;

  function absoluteFor(ref: string): string {
    const safe = assertSafeRelativeRef(ref, "ref");
    const absolute = resolve(join(root, safe.split("/").join(sep)));
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new DomainError(
        "FORBIDDEN",
        `ref "${ref}" resolves outside the workspace root`,
        { field: "ref" },
      );
    }
    return absolute;
  }

  async function readRef(ref: string): Promise<string> {
    const absolute = absoluteFor(ref);
    try {
      return await readFile(absolute, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        throw new DomainError(
          "NOT_FOUND",
          `no file "${ref}" in the workspace`,
          {
            field: "ref",
          },
        );
      }
      throw error;
    }
  }

  return {
    id: options.readerId ?? FILE_REPOSITORY_READER_ID,

    async list(): Promise<RepositoryListing> {
      const entries: RepositoryEntry[] = [];
      let truncated = false;

      async function walk(
        relativeDirectory: string,
        depth: number,
      ): Promise<void> {
        if (truncated) {
          return;
        }
        if (depth > maxDepth) {
          truncated = true;
          return;
        }
        const absolute =
          relativeDirectory === ""
            ? root
            : join(root, relativeDirectory.split("/").join(sep));
        let dirents;
        try {
          dirents = await readdir(absolute, { withFileTypes: true });
        } catch {
          // An unreadable directory is skipped, not fatal: one permission problem
          // in a vendor tree must not make the whole workspace unselectable.
          return;
        }
        dirents.sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        );

        for (const dirent of dirents) {
          if (entries.length >= maxEntries) {
            truncated = true;
            return;
          }
          const childRef =
            relativeDirectory === ""
              ? dirent.name
              : `${relativeDirectory}/${dirent.name}`;
          // Symlinks are never followed: they can escape the workspace.
          if (dirent.isSymbolicLink()) {
            continue;
          }
          if (dirent.isDirectory()) {
            if (excluded.has(dirent.name)) {
              continue;
            }
            await walk(childRef, depth + 1);
            continue;
          }
          if (!dirent.isFile() || isNonTextRef(childRef)) {
            continue;
          }
          let size: number;
          try {
            const info = await stat(join(root, childRef.split("/").join(sep)));
            if (!info.isFile()) {
              continue;
            }
            size = info.size;
          } catch {
            continue;
          }
          entries.push({ ref: childRef, bytes: size });
        }
      }

      await walk("", 1);
      entries.sort((left, right) =>
        left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0,
      );
      return { entries, truncated };
    },

    read: readRef,

    async tryRead(ref: string): Promise<string | undefined> {
      try {
        return await readRef(ref);
      } catch (error) {
        if (error instanceof DomainError && error.code === "NOT_FOUND") {
          return undefined;
        }
        throw error;
      }
    },
  };
}
