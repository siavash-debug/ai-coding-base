import type { Clock } from "../core/clock.js";
import { DomainError } from "../core/errors.js";
import { assertNonEmptyString } from "../core/validation.js";
import {
  type Decision,
  type DecisionKind,
  type DecisionOption,
  DECISION_KINDS,
  resolveDecision,
} from "./decision.js";

/**
 * The DecisionProvider port.
 *
 * JEV is one implementation of this port, not the platform. Core and domain code
 * never import, name or require a provider: a system with no provider registered
 * still runs, collapsing to deterministic code + policy.
 * See docs/architecture/V2-ARCHITECTURE.md §9 and DECISIONS.md ADR-004.
 */
export const DECISION_PROVIDER_FAMILIES = [
  "jev",
  "rules",
  "heuristic",
  "human",
  "llm",
] as const;

export type DecisionProviderFamily =
  (typeof DECISION_PROVIDER_FAMILIES)[number];

export interface DecisionCapabilities {
  readonly kinds: readonly DecisionKind[];
  /** True when the provider answers deterministically for identical input. */
  readonly deterministic: boolean;
  readonly maxOptions?: number;
}

export interface DecisionRequest {
  readonly kind: DecisionKind;
  readonly question: string;
  readonly options: readonly DecisionOption[];
  /** Already-selected, already-redacted context. Never secret values. */
  readonly context: readonly string[];
  readonly maxLatencyMs?: number;
  readonly maxCostMicros?: number;
  readonly correlationId: string;
}

export type DecisionResponse =
  | {
      readonly outcome: "selected";
      readonly optionId: string;
      readonly rationale?: string;
      readonly confidence?: number;
    }
  | { readonly outcome: "abstained"; readonly reason: string }
  | {
      readonly outcome: "escalated";
      readonly reason: string;
      readonly to?: string;
    }
  | { readonly outcome: "failed"; readonly error: string };

export interface DecisionProvider {
  readonly id: string;
  readonly family: DecisionProviderFamily;
  capabilities(): DecisionCapabilities;
  decide(request: DecisionRequest): Promise<DecisionResponse>;
}

/**
 * Pure capability check: does this provider support this bounded request?
 * Deterministic and total, so routing is reproducible.
 */
export function providerCanHandle(
  provider: DecisionProvider,
  request: DecisionRequest,
): boolean {
  const capabilities = provider.capabilities();
  if (!capabilities.kinds.includes(request.kind)) {
    return false;
  }
  return (
    capabilities.maxOptions === undefined ||
    request.options.length <= capabilities.maxOptions
  );
}

/**
 * A provider that always abstains. Useful as the default wiring and as test
 * infrastructure: it proves the platform works with no decision engine at all.
 */
export function createAbstainingDecisionProvider(options?: {
  readonly id?: string;
  readonly reason?: string;
  readonly family?: DecisionProviderFamily;
  readonly kinds?: readonly DecisionKind[];
}): DecisionProvider {
  const id = options?.id ?? "abstaining-provider";
  const reason =
    options?.reason ?? "no decision engine is configured for this installation";
  const family = options?.family ?? "rules";
  const kinds = options?.kinds ?? DECISION_KINDS;
  return {
    id,
    family,
    capabilities: () => ({ kinds, deterministic: true }),
    decide: async () => ({ outcome: "abstained", reason }),
  };
}

/**
 * Bridges a provider response into the immutable decision record. A failure is
 * attributed to the provider layer, since that layer produced the outcome.
 */
export function resolveDecisionFromProviderResponse(
  decision: Decision,
  response: DecisionResponse,
  options: {
    readonly providerId: string;
    readonly clock: Clock;
    readonly latencyMs?: number;
    readonly costMicros?: number;
  },
): Decision {
  const providerId = assertNonEmptyString(options.providerId, "providerId");
  const base = {
    decidedBy: "decision-provider" as const,
    providerId,
    ...(options.latencyMs === undefined
      ? {}
      : { latencyMs: options.latencyMs }),
    ...(options.costMicros === undefined
      ? {}
      : { costMicros: options.costMicros }),
  };

  switch (response.outcome) {
    case "selected": {
      if (typeof response.optionId !== "string") {
        throw new DomainError(
          "VALIDATION",
          "a selected response must carry an optionId",
          { field: "optionId" },
        );
      }
      return resolveDecision(
        decision,
        {
          ...base,
          outcome: "selected",
          selectedOptionId: response.optionId,
          ...(response.rationale === undefined
            ? {}
            : { rationale: response.rationale }),
          ...(response.confidence === undefined
            ? {}
            : { confidence: response.confidence }),
        },
        options.clock,
      );
    }
    case "abstained":
      return resolveDecision(
        decision,
        { ...base, outcome: "abstained", rationale: response.reason },
        options.clock,
      );
    case "escalated":
      return resolveDecision(
        decision,
        { ...base, outcome: "escalated", rationale: response.reason },
        options.clock,
      );
    case "failed":
      return resolveDecision(
        decision,
        { ...base, outcome: "failed", rationale: response.error },
        options.clock,
      );
  }
}
