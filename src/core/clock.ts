import { DomainError } from "./errors.js";

/**
 * Time is always injected. Domain logic must never call `Date.now()` directly,
 * because replay, checkpointing and deterministic tests all require time to be
 * a parameter. See docs/architecture/DECISIONS.md ADR-013.
 */
export interface Clock {
  now(): Date;
}

/** A clock that can be moved forward deterministically by tests. */
export interface ManualClock extends Clock {
  set(at: string): void;
  advance(ms: number): void;
}

/**
 * Timestamps are ISO-8601 UTC strings, optionally with a numeric offset.
 * `Date` objects are never used in persisted or domain-crossing shapes.
 */
export const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isValidIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_TIMESTAMP_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function toIsoString(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError(
      "VALIDATION",
      "Cannot convert an invalid Date to an ISO-8601 timestamp",
      { field: "date" },
    );
  }
  return value.toISOString();
}

export function createSystemClock(): Clock {
  return { now: () => new Date() };
}

export function createFixedClock(at: string): Clock {
  const instant = requireInstant(at);
  return { now: () => new Date(instant) };
}

export function createManualClock(at: string): ManualClock {
  let current = requireInstant(at);
  return {
    now: () => new Date(current),
    set: (next: string) => {
      current = requireInstant(next);
    },
    advance: (ms: number) => {
      if (!Number.isFinite(ms)) {
        throw new DomainError("VALIDATION", "Clock advance must be finite", {
          field: "ms",
        });
      }
      current += ms;
    },
  };
}

function requireInstant(at: string): number {
  if (!isValidIsoTimestamp(at)) {
    throw new DomainError(
      "VALIDATION",
      "Clock start must be an ISO-8601 UTC timestamp",
      { field: "at" },
    );
  }
  return Date.parse(at);
}

/** Milliseconds between two ISO timestamps. Never negative, never NaN. */
export function durationMsFrom(startedAt: string, endedAt: string): number {
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (Number.isNaN(started) || Number.isNaN(ended)) {
    throw new DomainError(
      "VALIDATION",
      "Cannot compute a duration from invalid timestamps",
      { field: "startedAt" },
    );
  }
  return Math.max(0, ended - started);
}
