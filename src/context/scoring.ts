import { matchesPathPattern } from "./ignore.js";
import type {
  ContextCandidate,
  ContextReason,
  ContextSignal,
  ScoredCandidate,
} from "./selection.js";

/**
 * Deterministic relevance scoring.
 *
 * Every signal that fired contributes a fixed number of points and produces a
 * reason, so a selected candidate can always answer "why was I included?" with
 * arithmetic rather than a verdict. No model is consulted, no embedding is
 * compared and no weight is learned: two runs over the same repository state
 * produce byte-identical scores, which is what makes a selection reviewable.
 *
 * Weights are ordered by how *explicit* the evidence is — a path the task names
 * outranks a path that merely changed, which outranks a name that resembles a
 * word in the task text. There is no tuning history behind these numbers and the
 * module does not pretend otherwise: they are starting points to be measured
 * against task outcomes (§36.9), not empirical optima.
 *
 * See docs/architecture/V2-ARCHITECTURE.md §36.4 and DECISIONS.md ADR-039/ADR-040.
 */
export const SIGNAL_POINTS: Readonly<Record<ContextSignal, number>> = {
  "explicit-path": 100,
  "path-token": 45,
  changed: 30,
  "filename-token": 24,
  "test-relationship": 20,
  "direct-dependency": 15,
  adr: 12,
  documentation: 10,
  "same-directory": 8,
  "verification-config": 6,
  "configured-priority": 0,
};

/** Human-readable phrasing, kept out of event payloads (which carry codes). */
export const SIGNAL_LABELS: Readonly<Record<ContextSignal, string>> = {
  "explicit-path": "explicitly referenced by the task",
  "path-token": "path-shaped token from the task text",
  changed: "changed in the working tree",
  "filename-token": "filename matches a task token",
  "test-relationship": "linked to a relevant file by the test convention",
  "direct-dependency": "imported by a relevant file",
  adr: "architecture decision record",
  documentation: "documentation that matches task tokens",
  "same-directory": "shares a directory with a relevant file",
  "verification-config": "build or verification configuration",
  "configured-priority": "matched an operator priority rule",
};

/**
 * The only way a candidate becomes mandatory.
 *
 * A path the task itself named must be honoured or the selection is wrong in a way
 * the operator would never forgive — and mandatory items are the reason the engine
 * can report "the budget was too small" instead of quietly omitting the file the
 * task was about.
 */
export function isMandatoryCandidate(candidate: ContextCandidate): boolean {
  return candidate.signals.includes("explicit-path");
}

function reasonFor(
  signal: ContextSignal,
  points: number,
  detail?: string,
): ContextReason {
  return {
    code: signal,
    points,
    ...(detail === undefined ? {} : { detail }),
  };
}

export interface ScoringContext {
  /** Lower-cased, stopword-stripped tokens from the task's own text. */
  readonly taskTokens: ReadonlySet<string>;
  /** Pattern -> points, from `context.priority` in the project configuration. */
  readonly priorityRules: readonly {
    readonly pattern: string;
    readonly points: number;
  }[];
}

/**
 * Scores one candidate.
 *
 * `configured-priority` is additive on top of the observed signals rather than a
 * filter: an operator can raise a file's standing but cannot drop it below zero,
 * and a priority rule can never make an unreferenced file mandatory. Configuration
 * influences ranking; it does not create authority.
 */
export function scoreCandidate(
  candidate: ContextCandidate,
  context: ScoringContext,
): ScoredCandidate {
  const reasons: ContextReason[] = [];
  for (const signal of candidate.signals) {
    const points = SIGNAL_POINTS[signal];
    reasons.push(reasonFor(signal, points));
  }

  for (const rule of context.priorityRules) {
    if (matchesPathPattern(rule.pattern, candidate.ref)) {
      reasons.push(reasonFor("configured-priority", rule.points, rule.pattern));
    }
  }

  return {
    ...candidate,
    score: reasons.reduce((total, reason) => total + reason.points, 0),
    reasons,
  };
}

/**
 * Total order over candidates: mandatory first, then higher score, then kind, then
 * path.
 *
 * The score alone is not a total order — ties are common and a tie broken by
 * discovery order would make a selection depend on filesystem enumeration, which
 * differs between machines and even between runs. Sorting by `(ref, kind, tokens)`
 * after the score makes the result reproducible everywhere, which is the property
 * the determinism test asserts.
 */
export function orderCandidates(
  candidates: readonly ScoredCandidate[],
): readonly ScoredCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftMandatory = isMandatoryCandidate(left) ? 0 : 1;
    const rightMandatory = isMandatoryCandidate(right) ? 0 : 1;
    if (leftMandatory !== rightMandatory) {
      return leftMandatory - rightMandatory;
    }
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    if (left.ref !== right.ref) {
      return left.ref < right.ref ? -1 : 1;
    }
    if (left.kind !== right.kind) {
      return left.kind < right.kind ? -1 : 1;
    }
    return left.tokens - right.tokens;
  });
}

/** Stable candidate id: `<kind>:<ref>`, never a hash, never positional. */
export function candidateIdOf(
  candidate: Pick<ContextCandidate, "kind" | "ref">,
): string {
  return `${candidate.kind}:${candidate.ref}`;
}
