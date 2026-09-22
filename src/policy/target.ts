import { DomainError } from "../core/errors.js";
import {
  assertNonEmptyString,
  containsSecretLikeValue,
  redactSecretLikeValues,
} from "../core/validation.js";

/**
 * Operation targets: what an operation acts on, described safely.
 *
 * A target is the *only* place a caller says where an operation points, and it is
 * deliberately not a filesystem path. Every target carries a workspace-relative
 * reference, because:
 *
 * - an absolute path is a fact about the host, not about the task — recording one
 *   would leak a username into the event log, and accepting one would move
 *   boundary enforcement into string comparison at the call site;
 * - a reference resolves *against the workspace root* inside the boundary, so the
 *   same request cannot mean different things in different processes (ADR-047).
 *
 * `describeTarget` produces the recordable form. It drops anything that could
 * carry a secret: query strings and fragment (a signed URL is a credential), raw
 * argument vectors, and any path that traverses.
 */
export const TARGET_KINDS = ["path", "command", "url", "variable"] as const;

export type TargetKind = (typeof TARGET_KINDS)[number];

/** A workspace-relative file or directory reference, e.g. `src/index.ts`. */
export interface PathTarget {
  readonly kind: "path";
  readonly ref: string;
}

/**
 * A program invocation. Only the program name and an argument *count* are carried,
 * so an argument list (which routinely contains a token) can never reach an event.
 */
export interface CommandTarget {
  readonly kind: "command";
  readonly command: string;
  readonly argumentCount: number;
}

/** An outbound HTTP target. The query string is never recorded. */
export interface UrlTarget {
  readonly kind: "url";
  readonly url: string;
}

/** The *name* of an environment variable. Never its value. */
export interface VariableTarget {
  readonly kind: "variable";
  readonly name: string;
}

export type OperationTarget =
  PathTarget | CommandTarget | UrlTarget | VariableTarget;

/** The recordable, redacted projection of a target. */
export interface SafeTarget {
  readonly kind: TargetKind;
  /** Workspace-relative ref, program basename, `origin/path`, or variable name. */
  readonly target: string;
}

/**
 * Refuses a reference that cannot be interpreted safely.
 *
 * Fail-closed: a NUL, an absolute path, a Windows drive or UNC prefix, or any `..`
 * segment is refused here rather than normalised away. Phase E made the same
 * choice for context references for the same reason — a reference that needs
 * repairing is a reference that was not understood.
 */
export function assertWorkspaceRef(value: unknown, field = "ref"): string {
  const ref = assertNonEmptyString(value, field);
  if (ref.includes("\0")) {
    throw new DomainError("VALIDATION", `${field} must not contain NUL`, {
      field,
    });
  }
  // Accept `/` and `\` as separators, then judge the segments.
  const normalized = ref.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw new DomainError(
      "VALIDATION",
      `${field} must be a workspace-relative reference, not an absolute path`,
      { field },
    );
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new DomainError(
      "VALIDATION",
      `${field} must not carry a drive letter; use a workspace-relative reference`,
      { field },
    );
  }
  if (normalized.startsWith("//")) {
    throw new DomainError(
      "VALIDATION",
      `${field} must not be a UNC path; use a workspace-relative reference`,
      { field },
    );
  }
  const segments = normalized
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new DomainError("VALIDATION", `${field} must name a path`, { field });
  }
  if (segments.includes("..")) {
    throw new DomainError(
      "VALIDATION",
      `${field} must not contain parent-directory traversal`,
      { field },
    );
  }
  if (segments.includes(".")) {
    // `./x` is harmless but ambiguous; only a bare `.` is meaningful (the root).
    if (!(segments.length === 1 && segments[0] === ".")) {
      throw new DomainError(
        "VALIDATION",
        `${field} must not contain "." segments`,
        { field },
      );
    }
  }
  return segments.join("/");
}

export function pathTarget(value: unknown, field = "target.ref"): PathTarget {
  return { kind: "path", ref: assertWorkspaceRef(value, field) };
}

/**
 * Validates a program name.
 *
 * A path is accepted (a project may legitimately run `node_modules/.bin/tsc`) but
 * it must be workspace-relative, and a directory-traversing command is refused.
 * Nothing here decides *whether* the command is allowed — that is policy.
 */
export function commandTarget(
  command: unknown,
  argumentCount: unknown,
  field = "target.command",
): CommandTarget {
  const name = assertWorkspaceRef(command, field);
  const count = argumentCount;
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > 1_024
  ) {
    throw new DomainError(
      "VALIDATION",
      `${field} arguments must be a count between 0 and 1024`,
      { field: `${field}.argumentCount` },
    );
  }
  return { kind: "command", command: name, argumentCount: count };
}

export function urlTarget(value: unknown, field = "target.url"): UrlTarget {
  const text = assertNonEmptyString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new DomainError("VALIDATION", `${field} must be an absolute URL`, {
      field,
    });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new DomainError(
      "VALIDATION",
      `${field} must use http or https (got "${parsed.protocol}")`,
      { field },
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new DomainError("VALIDATION", `${field} must not embed credentials`, {
      field,
    });
  }
  return { kind: "url", url: text };
}

/** Environment variable names follow the platform's own identifier rules. */
export function variableTarget(
  value: unknown,
  field = "target.name",
): VariableTarget {
  const name = assertNonEmptyString(value, field);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new DomainError(
      "VALIDATION",
      `${field} must be an environment variable NAME, not a value`,
      { field },
    );
  }
  return { kind: "variable", name };
}

/**
 * `origin` + `pathname`, with the query string and fragment dropped.
 *
 * A query string is where signed URLs, tokens and PII live; the trace needs to
 * know *which endpoint* was called, never what was passed to it.
 */
export function safeUrl(value: string): string {
  const parsed = new URL(value);
  return `${parsed.origin}${parsed.pathname}`;
}

/** The program's basename, lower-cased, without a directory or extension shift. */
export function safeCommandName(command: string): string {
  const segments = command.split("/");
  return segments[segments.length - 1] ?? command;
}

/**
 * The recordable form of a target.
 *
 * Every branch passes through `redactSecretLikeValues`, which is what makes the
 * *description* safe even when the request itself was not: a caller that builds a
 * command out of a credential gets `[redacted]` in the log rather than a refusal to
 * record anything at all. Two things follow, and both matter:
 *
 * - the trace stays complete — a decision is always recorded, so no operation can
 *   escape the audit trail by carrying a secret;
 * - the event layer's own secret-shape check remains a backstop rather than the
 *   mechanism, because a description that already contains a secret would make the
 *   log itself the leak.
 */
export function describeTarget(target: OperationTarget): SafeTarget {
  switch (target.kind) {
    case "path":
      return { kind: "path", target: recordable(target.ref) };
    case "command":
      return {
        kind: "command",
        target: recordable(safeCommandName(target.command)),
      };
    case "url":
      return { kind: "url", target: recordable(safeUrl(target.url)) };
    case "variable":
      return { kind: "variable", target: recordable(target.name) };
  }
}

/** Ceiling for a recorded target, so a huge string cannot bloat the log. */
const MAX_RECORDED_TARGET_CHARS = 200;

function recordable(text: string): string {
  return redactSecretLikeValues(text, MAX_RECORDED_TARGET_CHARS);
}

/**
 * Final guard before a target description is written to the log.
 *
 * `assertNoSecretLikeValue` already runs inside event validation; this is the
 * earlier, better-placed refusal, because the caller is the layer that still knows
 * which input produced the string.
 */
export function assertSafeTarget(target: SafeTarget, field = "target"): void {
  if (containsSecretLikeValue(target.target)) {
    throw new DomainError(
      "VALIDATION",
      `${field} appears to contain credential material; targets are recorded as references`,
      { field },
    );
  }
}
