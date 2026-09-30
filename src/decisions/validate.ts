import {
  MAX_DECISION_TOKEN_CHARS,
  type DomainDecisionSpec,
  isReasonCode,
} from "./domains.js";
import type { DecisionResponse } from "./provider.js";

/**
 * Deterministic validation of a decision answer.
 *
 * This module is the boundary where output from a decision engine stops being
 * untrusted. Everything a provider says passes through here before it can affect
 * anything, and the rule is strict: an answer that does not fit the question is
 * *rejected*, not repaired. The engine then falls back deterministically, and the
 * rejection is recorded (ADR-053).
 *
 * What is checked, and why each check exists:
 *
 * - **the option exists** — a provider cannot invent a tool, a route or a risk
 *   level. `selected` must name one of the candidates the caller supplied.
 * - **the outcome is allowed for this question** — `escalated` is meaningful for
 *   retry and escalation and meaningless for risk, so a provider may not use it to
 *   smuggle a different answer shape in.
 * - **orderings are complete and unique** — a ranking must be a permutation of the
 *   candidate set; a partial ordering would let a provider choose a subset.
 * - **explanation codes are from the offered vocabulary** — untrusted prose cannot
 *   enter the event log, and reason codes stay countable.
 * - **confidence is a probability or absent** — absent is recorded as absent, never
 *   defaulted.
 *
 * A rejection carries a short, safe `detail` string that is written to the log. It
 * never contains provider text: the detail is our own sentence about our own check.
 */
export interface ValidatedAnswer {
  readonly outcome: "selected" | "abstained" | "escalated";
  readonly selectedOptionId?: string;
  readonly ranking?: readonly string[];
  readonly reasonCode?: string;
  readonly confidence?: number;
}

export type AnswerValidation =
  | {
      readonly ok: true;
      readonly answer: ValidatedAnswer;
      readonly rationale: string;
    }
  | { readonly ok: false; readonly detail: string };

export function validateProviderAnswer(
  spec: DomainDecisionSpec,
  response: DecisionResponse,
): AnswerValidation {
  switch (response.outcome) {
    case "failed":
      // A provider reporting its own failure is not an answer; the caller treats it
      // as a provider error rather than as a decision.
      return {
        ok: false,
        detail: "the provider reported a failure instead of an answer",
      };
    case "abstained": {
      if (!spec.allowAbstained) {
        return {
          ok: false,
          detail: `abstention is not an allowed answer for "${spec.domain}"`,
        };
      }
      return {
        ok: true,
        answer: { outcome: "abstained" },
        rationale:
          "the decision layer abstained; the deterministic fallback answered",
      };
    }
    case "escalated": {
      if (!spec.allowEscalated) {
        return {
          ok: false,
          detail: `escalation is not an allowed answer for "${spec.domain}"`,
        };
      }
      // `reason` is the provider's own prose for *why* it escalated, and prose never
      // enters the record; `reasonCode` is the token from the offered vocabulary, and
      // that is the only field checked here.
      const reason = checkReasonCode(spec, response.reasonCode, "escalation");
      if (!reason.ok) {
        return reason;
      }
      return {
        ok: true,
        answer: {
          outcome: "escalated",
          ...(reason.value === undefined ? {} : { reasonCode: reason.value }),
        },
        rationale: `the decision layer escalated (${reason.value ?? "no reason code"}); a human owns the outcome`,
      };
    }
    case "selected": {
      const optionId = response.optionId;
      if (
        typeof optionId !== "string" ||
        optionId.length === 0 ||
        optionId.length > MAX_DECISION_TOKEN_CHARS
      ) {
        return {
          ok: false,
          detail: "a selected answer must carry a candidate id",
        };
      }
      if (!spec.options.some((option) => option.id === optionId)) {
        // The extraction of the answer stops here. An unknown option is not
        // "close enough": it is an answer to a different question.
        return {
          ok: false,
          detail: "the answer named a candidate that was not offered",
        };
      }

      const ranking = validateRanking(spec, response);
      if (!ranking.ok) {
        return ranking;
      }

      const reason = checkReasonCode(spec, response.reasonCode, "selection");
      if (!reason.ok) {
        return reason;
      }

      let confidence: number | undefined;
      if (response.confidence !== undefined) {
        if (
          typeof response.confidence !== "number" ||
          !Number.isFinite(response.confidence) ||
          response.confidence < 0 ||
          response.confidence > 1
        ) {
          return {
            ok: false,
            detail: "confidence must be a number between 0 and 1",
          };
        }
        confidence = response.confidence;
      }

      return {
        ok: true,
        answer: {
          outcome: "selected",
          selectedOptionId: optionId,
          ...(ranking.value === undefined ? {} : { ranking: ranking.value }),
          ...(reason.value === undefined ? {} : { reasonCode: reason.value }),
          ...(confidence === undefined ? {} : { confidence }),
        },
        rationale:
          `the decision layer selected "${optionId}"` +
          (reason.value === undefined ? "" : ` (${reason.value})`),
      };
    }
  }
}

type CheckResult<T> =
  | { readonly ok: true; readonly value: T | undefined }
  | { readonly ok: false; readonly detail: string };

function checkReasonCode(
  spec: DomainDecisionSpec,
  value: unknown,
  label: string,
): CheckResult<string> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string" || value.length > MAX_DECISION_TOKEN_CHARS) {
    return {
      ok: false,
      detail: `${label} must carry a short machine-readable reason code, not prose`,
    };
  }
  if (!isReasonCode(value)) {
    return {
      ok: false,
      detail: `${label} carried a reason code outside the platform vocabulary`,
    };
  }
  if (spec.reasonCodes.length > 0 && !spec.reasonCodes.includes(value)) {
    return {
      ok: false,
      detail: `${label} carried a reason code that was not offered for this question`,
    };
  }
  return { ok: true, value };
}

function validateRanking(
  spec: DomainDecisionSpec,
  response: Extract<DecisionResponse, { readonly outcome: "selected" }>,
): CheckResult<readonly string[]> {
  const supplied = response.rankedOptionIds;
  if (!spec.ranked) {
    if (supplied !== undefined) {
      return {
        ok: false,
        detail:
          "an ordering was supplied for a question that does not ask for one",
      };
    }
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(supplied)) {
    return {
      ok: false,
      detail: "a ranking must supply an ordering of every candidate",
    };
  }
  const expected = spec.options.map((option) => option.id);
  if (supplied.length !== expected.length) {
    return {
      ok: false,
      detail: "a ranking must list every candidate exactly once",
    };
  }
  const seen = new Set<string>();
  for (const id of supplied) {
    if (typeof id !== "string" || !expected.includes(id)) {
      return {
        ok: false,
        detail: "a ranking named a candidate that was not offered",
      };
    }
    if (seen.has(id)) {
      return { ok: false, detail: "a ranking listed a candidate twice" };
    }
    seen.add(id);
  }
  return { ok: true, value: [...supplied] };
}
