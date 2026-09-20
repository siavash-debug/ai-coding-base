import { assertNonNegativeInteger } from "../core/validation.js";
import type { ContextExclusionReason } from "./selection.js";

/**
 * The one place that decides whether a candidate fits.
 *
 * Pure arithmetic: no I/O, no clock, no scoring. Ranking lives in `scoring.ts`, so
 * "what is relevant" and "what fits" stay separable — and separately testable,
 * which matters because a budget bug is silent: you get a plausible context and a
 * plausible bill.
 *
 * Four rules the implementation refuses to bend:
 *
 * 1. **The budget is never exceeded.** Not by one token, not "just this once".
 * 2. **Mandatory candidates are never silently dropped.** One that does not fit is
 *    reported as `budget-exceeded`, which the caller turns into a loud refusal
 *    rather than proceeding without the file the task was about.
 * 3. **Nothing is truncated.** A file is selected whole or not at all. Half a source
 *    file reads as valid context and is not, which is worse than having none.
 * 4. **Two phases, two reasons.** Admission is attempted first on a size estimate
 *    (before any read) and then on the measured content. An optional candidate that
 *    misses on the estimate is ordinary `budget-cutoff`; one that misses on content
 *    is `oversize-after-sizing`, because that means the estimate was wrong and a
 *    reader deserves to see which of the two happened.
 *
 * See docs/architecture/V2-ARCHITECTURE.md §36.5 and DECISIONS.md ADR-040.
 */
export type AdmissionPhase = "estimate" | "content";

export type AdmissionDecision =
  | { readonly kind: "select" }
  | { readonly kind: "exclude"; readonly reason: ContextExclusionReason };

export interface AdmissionInput {
  readonly phase: AdmissionPhase;
  readonly budgetTokens: number;
  /** Tokens already committed by admitted candidates, in the same phase's units. */
  readonly usedTokens: number;
  /** Size estimate in the estimate phase, measured content tokens in the content phase. */
  readonly tokens: number;
  readonly mandatory: boolean;
  /** A single file larger than this is never admitted, whatever the budget. */
  readonly maxFileTokens: number;
}

export function fitsWithin(
  budgetTokens: number,
  usedTokens: number,
  candidateTokens: number,
): boolean {
  return usedTokens + candidateTokens <= budgetTokens;
}

export function admitCandidate(input: AdmissionInput): AdmissionDecision {
  const budgetTokens = assertNonNegativeInteger(
    input.budgetTokens,
    "budgetTokens",
  );
  const usedTokens = assertNonNegativeInteger(input.usedTokens, "usedTokens");
  const tokens = assertNonNegativeInteger(input.tokens, "tokens");

  // A single oversized file is refused before the budget is consulted — it is not a
  // budget question. But when the *task itself* required that file, the refusal has
  // to be loud: excluding it quietly would let the run proceed without the file the
  // task named, which reads as a successful answer to the wrong question.
  if (tokens > input.maxFileTokens) {
    return {
      kind: "exclude",
      reason: input.mandatory ? "budget-exceeded" : "oversize-after-sizing",
    };
  }
  if (fitsWithin(budgetTokens, usedTokens, tokens)) {
    return { kind: "select" };
  }
  if (input.mandatory) {
    return { kind: "exclude", reason: "budget-exceeded" };
  }
  return {
    kind: "exclude",
    reason:
      input.phase === "estimate" ? "budget-cutoff" : "oversize-after-sizing",
  };
}
