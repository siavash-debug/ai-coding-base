import { createHash } from "node:crypto";

import { DomainError } from "../core/errors.js";

/**
 * A short, stable fingerprint of a value.
 *
 * Used for one job: identifying the *configuration* that produced a context
 * selection, so a later "was this selection reproducible?" question has an answer
 * that does not require storing the configuration itself. It is a hash of the
 * selection-relevant settings, not of the repository — the repository's state is
 * captured by the selection's own refs and scores.
 *
 * Serialisation is canonical (object keys sorted at every depth, arrays kept in
 * order) because `JSON.stringify` depends on insertion order, and a fingerprint
 * that changes when two equivalent configs are written in a different order would
 * be worse than useless: it would make identical selections look different.
 */
function canonicalize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function fingerprint(value: unknown, length = 12): string {
  const hex = createHash("sha256").update(canonicalize(value)).digest("hex");
  if (!Number.isSafeInteger(length) || length < 4 || length > 64) {
    throw new DomainError(
      "VALIDATION",
      "fingerprint length must be an integer between 4 and 64",
      { field: "length" },
    );
  }
  return hex.slice(0, length);
}
