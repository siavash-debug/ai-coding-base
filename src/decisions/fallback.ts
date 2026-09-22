import { DomainError } from "../core/errors.js";
import {
  DECISION_DOMAINS,
  type DecisionDomain,
  type DecisionFallbackReason,
  type DomainDecisionSpec,
} from "./domains.js";

/**
 * Deterministic fallbacks: what the platform does when a decision layer cannot
 * answer.
 *
 * The registry exists so fallback behaviour is *one table* an operator can read,
 * not a scattering of `?? "stop"` at call sites. Every strategy below is
 * deterministic, bounded and recorded: an answer produced here is logged with
 * `answeredBy: "fallback"` and the reason it was used, so "the decision layer was
 * down and we assumed X" is a fact in the trace rather than a reconstruction
 * (ADR-052).
 *
 * Two rules constrain the table:
 *
 * - **A fallback never widens authority.** No strategy can grant a capability,
 *   approve an operation, raise a route, or mark a task complete. Where a fallback
 *   has to choose, it chooses the narrower or more conservative answer.
 * - **A fallback never fabricates a judgement.** `risk-assessment` falls back to the
 *   deterministic baseline rather than guessing "high"; `completion` falls back to
 *   `uncertain` rather than asserting completion. Unknown stays unknown.
 */
export const DECISION_FALLBACK_STRATEGIES = [
  /** Assume the option the caller declared as safe. */
  "declared-default",
  /** Assume the deterministic floor the question started from. */
  "deterministic-floor",
  /** Preserve the caller's deterministic ordering. */
  "stable-order",
  /** Recommend human review when a judgement cannot be made. */
  "conservative-review",
  /** Assert nothing that was not established. */
  "conservative-negative",
  /** Do not proceed. */
  "stop",
] as const;

export type DecisionFallbackStrategy =
  (typeof DECISION_FALLBACK_STRATEGIES)[number];

export interface FallbackRegistration {
  readonly domain: DecisionDomain;
  readonly strategy: DecisionFallbackStrategy;
  /** What the fallback assumes, in one line, for humans and for `ai decision`. */
  readonly description: string;
}

export const DOMAIN_FALLBACKS: Readonly<
  Record<DecisionDomain, FallbackRegistration>
> = {
  routing: {
    domain: "routing",
    strategy: "declared-default",
    description:
      "run the attempt as configured (the standard route); a decision layer may narrow the route but is never required to",
  },
  "tool-selection": {
    domain: "tool-selection",
    strategy: "declared-default",
    description:
      "use the caller's declared default tool, which is the narrowest permitted operation",
  },
  "risk-assessment": {
    domain: "risk-assessment",
    strategy: "deterministic-floor",
    description:
      "keep the deterministic baseline risk; an unavailable assessment never raises or lowers enforcement",
  },
  retry: {
    domain: "retry",
    strategy: "stop",
    description:
      "stop rather than retry; retries are not assumed to be justified",
  },
  completion: {
    domain: "completion",
    strategy: "conservative-negative",
    description:
      "report the assessment as uncertain; nothing marks a task complete but a human",
  },
  ranking: {
    domain: "ranking",
    strategy: "stable-order",
    description: "preserve the caller's deterministic candidate order",
  },
  relevance: {
    domain: "relevance",
    strategy: "conservative-negative",
    description:
      "treat relevance as unestablished; nothing is asserted to be relevant",
  },
  "human-escalation": {
    domain: "human-escalation",
    strategy: "conservative-review",
    description:
      "recommend human review; the cost of a needless review is lower than the cost of an unreviewed outcome",
  },
  "execution-strategy": {
    domain: "execution-strategy",
    strategy: "conservative-review",
    description:
      "hand the task to a human rather than spend a model call or complete it silently; an unavailable strategy judgement is not a licence to execute",
  },
  "skill-selection": {
    domain: "skill-selection",
    strategy: "declared-default",
    description:
      "use no skill; running without a skill is the narrowest permitted behaviour, and an unavailable judgement never invents one",
  },
  "context-selection": {
    domain: "context-selection",
    strategy: "conservative-negative",
    description:
      "drop the candidate rather than keep or compress what was never established as relevant",
  },
};

/** The answer a fallback produces for one question. */
export interface FallbackAnswer {
  readonly optionId: string;
  readonly ranking?: readonly string[];
  readonly rationale: string;
}

export function describeFallbacks(): readonly FallbackRegistration[] {
  return DECISION_DOMAINS.map((domain) => DOMAIN_FALLBACKS[domain]);
}

/**
 * Produces the deterministic answer for a question the decision layer could not
 * answer. `optionId` is always the spec's own declared default, which
 * `assertDomainDecisionSpec` has already proven to be one of the options — so a
 * fallback can never name a candidate that does not exist.
 */
export function deterministicFallbackFor(
  spec: DomainDecisionSpec,
  reason: DecisionFallbackReason,
): FallbackAnswer {
  const fallback = DOMAIN_FALLBACKS[spec.domain];
  if (fallback === undefined) {
    throw new DomainError(
      "INVARIANT",
      `no fallback strategy is registered for decision domain "${spec.domain}"`,
      { field: "spec.domain" },
    );
  }
  const rationale =
    spec.domain === "risk-assessment"
      ? `fallback (${reason}): keeping the deterministic baseline risk`
      : `fallback (${reason}): ${fallback.description}`;
  return {
    optionId: spec.defaultOptionId,
    ...(spec.ranked
      ? { ranking: spec.options.map((option) => option.id) }
      : {}),
    rationale,
  };
}
