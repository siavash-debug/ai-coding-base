import { Buffer } from "node:buffer";

import { assertWorkspaceRef } from "../../policy/target.js";

/**
 * The change set: a bounded, ordered list of file writes a model proposed.
 *
 * This is the only place a model's prose becomes something the runtime will act
 * on, and the parsing is deliberately structural. It extracts one JSON value,
 * checks its *shape*, checks that each reference is a well-formed
 * workspace-relative path, and enforces deterministic size bounds.
 *
 * It is **not** an enforcement layer. It decides nothing about permission: a
 * reference the shape check accepts may still be outside the writable roots,
 * credential-shaped, or runtime state, and only the `OperationGateway` decides
 * those. The two are complementary and both must run — this module answers "is
 * this a well-formed, bounded change set?", the boundary answers "may this
 * operation happen at all?" (ADR-045). Re-implementing the boundary's checks
 * here would be the mistake this split exists to prevent.
 *
 * Bounds are structural and fail-closed: a change set that is too large, names a
 * file twice, or traverses is refused *before* any operation is requested, so a
 * malformed proposal can never produce a partial write.
 */
export interface FileChange {
  /** Workspace-relative reference, e.g. `src/text/normalize.ts`. */
  readonly ref: string;
  /** The full file content to write. Travels in memory, recorded nowhere. */
  readonly content: string;
}

export interface ChangeSetLimits {
  /** Largest single file the model may propose. */
  readonly maxWriteBytes: number;
  /** Largest total change set. */
  readonly maxChangeSetBytes: number;
  /** Largest number of files one change set may name. */
  readonly maxChangeSetFiles: number;
}

export const DEFAULT_CHANGE_SET_LIMITS: ChangeSetLimits = {
  maxWriteBytes: 262_144,
  maxChangeSetBytes: 1_048_576,
  maxChangeSetFiles: 24,
};

/** Every way a proposal can be refused, as a stable code rather than prose. */
export const CHANGE_SET_REJECTION_CODES = [
  /** No JSON value could be found in the model's output. */
  "malformed-output",
  /** JSON was found but is not a change set of the expected shape. */
  "malformed-change",
  /** A `ref` is missing, empty, absolute, traversing, or otherwise unshaped. */
  "invalid-ref",
  /** Two entries name the same file. */
  "duplicate-ref",
  /** The change set was empty: nothing to do. */
  "empty-change-set",
  /** One entry exceeds `maxWriteBytes`. */
  "write-too-large",
  /** The whole change set exceeds `maxChangeSetBytes`. */
  "change-set-too-large",
  /** More than `maxChangeSetFiles` entries were proposed. */
  "too-many-files",
] as const;

export type ChangeSetRejectionCode =
  (typeof CHANGE_SET_REJECTION_CODES)[number];

export type ChangeSetParseResult =
  | { readonly ok: true; readonly changes: readonly FileChange[] }
  | {
      readonly ok: false;
      readonly reasonCode: ChangeSetRejectionCode;
      readonly reason: string;
    };

function reject(
  reasonCode: ChangeSetRejectionCode,
  reason: string,
): ChangeSetParseResult {
  return { ok: false, reasonCode, reason };
}

/**
 * Extracts the first JSON value from a model's output.
 *
 * A model frequently wraps JSON in prose or a fenced code block, so requiring
 * the whole response to be JSON would reject reasonable answers. The rule is
 * deterministic and bounded: from the first `{` or `[` to the last `}` or `]`.
 * If that is not valid JSON, the proposal is refused rather than repaired — a
 * value that needs guesswork was not understood.
 */
export function extractJsonValue(text: string): unknown | undefined {
  const trimmed = text.trim();
  const firstObject = trimmed.indexOf("{");
  const firstArray = trimmed.indexOf("[");
  const starts = [firstObject, firstArray].filter((index) => index >= 0);
  if (starts.length === 0) {
    return undefined;
  }
  const lastObject = trimmed.lastIndexOf("}");
  const lastArray = trimmed.lastIndexOf("]");
  const end = Math.max(lastObject, lastArray);
  const start = Math.min(...starts);
  if (end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

function entriesOf(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const changes = (value as Record<string, unknown>)["changes"];
    if (Array.isArray(changes)) {
      return changes;
    }
  }
  return undefined;
}

/**
 * Parses and validates a model's proposed change set.
 *
 * Total: a malformed input is a refusal value, never a thrown error, because a
 * thrown parse failure would become an unhandled crash rather than a recorded,
 * actionable outcome.
 */
export function parseChangeSet(
  text: string,
  limits: ChangeSetLimits = DEFAULT_CHANGE_SET_LIMITS,
): ChangeSetParseResult {
  const raw = extractJsonValue(text);
  if (raw === undefined) {
    return reject(
      "malformed-output",
      "the response did not contain a JSON change set",
    );
  }
  const entries = entriesOf(raw);
  if (entries === undefined) {
    return reject(
      "malformed-output",
      'the response must be a JSON array of file changes or an object with a "changes" array',
    );
  }
  if (entries.length === 0) {
    return reject(
      "empty-change-set",
      "the change set contained no file changes",
    );
  }
  if (entries.length > limits.maxChangeSetFiles) {
    return reject(
      "too-many-files",
      `the change set names ${entries.length} files, over the ${limits.maxChangeSetFiles}-file limit`,
    );
  }

  const changes: FileChange[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return reject(
        "malformed-change",
        'each change must be an object with a "ref" and a "content"',
      );
    }
    const record = entry as Record<string, unknown>;
    const rawRef = record["ref"];
    const rawContent = record["content"];
    if (typeof rawRef !== "string" || rawRef.length === 0) {
      return reject(
        "malformed-change",
        'each change needs a non-empty string "ref"',
      );
    }
    if (typeof rawContent !== "string") {
      return reject(
        "malformed-change",
        `change "${rawRef}" needs a string "content"`,
      );
    }
    let ref: string;
    try {
      ref = assertWorkspaceRef(rawRef, "ref");
    } catch {
      return reject(
        "invalid-ref",
        `"${rawRef}" is not a workspace-relative reference`,
      );
    }
    if (seen.has(ref)) {
      return reject("duplicate-ref", `"${ref}" appears more than once`);
    }
    seen.add(ref);

    const bytes = Buffer.byteLength(rawContent, "utf8");
    if (bytes > limits.maxWriteBytes) {
      return reject(
        "write-too-large",
        `"${ref}" is ${bytes} bytes, over the ${limits.maxWriteBytes}-byte per-file limit`,
      );
    }
    total += bytes;
    if (total > limits.maxChangeSetBytes) {
      return reject(
        "change-set-too-large",
        `the change set is ${total} bytes, over the ${limits.maxChangeSetBytes}-byte limit`,
      );
    }
    changes.push({ ref, content: rawContent });
  }

  return { ok: true, changes };
}
