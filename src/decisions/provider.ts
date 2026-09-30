import type { Clock } from "../core/clock.js";
import { DomainError } from "../core/errors.js";
import { assertNonEmptyString } from "../core/validation.js";
import type { AIUsage } from "../observability/usage.js";
import {
  type Decision,
  type DecisionKind,
  type DecisionOption,
  DECISION_KINDS,
  resolveDecision,
} from "./decision.js";
import type {
  DecisionFallbackReason,
  DecisionProviderExecutionSourceValue,
} from "./domains.js";

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
  "local",
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
  /**
   * The closed explanation vocabulary this question may be answered with.
   *
   * A provider answers with one of these codes instead of prose, so nothing it says
   * can put free text into the event log. Absent means no code is expected.
   */
  readonly reasonCodes?: readonly string[];
  /** True when the answer must order every option rather than choose one. */
  readonly ranked?: boolean;
  readonly maxLatencyMs?: number;
  readonly maxCostMicros?: number;
  readonly correlationId: string;
}

export type DecisionResponse =
  | {
      readonly outcome: "selected";
      readonly optionId: string;
      /** Present only for a ranked question: every option, in rank order. */
      readonly rankedOptionIds?: readonly string[];
      /** One of `DecisionRequest.reasonCodes`, when codes were offered. */
      readonly reasonCode?: string;
      /**
       * Free text from the provider. Deliberately never recorded: the platform
       * records the reason *code*, and prose from an untrusted answer is dropped.
       */
      readonly rationale?: string;
      readonly confidence?: number;
    }
  | { readonly outcome: "abstained"; readonly reason: string }
  | {
      readonly outcome: "escalated";
      readonly reason: string;
      readonly reasonCode?: string;
      readonly to?: string;
    }
  | { readonly outcome: "failed"; readonly error: string };

/**
 * The answer plus what it cost to obtain.
 *
 * Split out from `DecisionResponse` so the port stays backward compatible: a
 * provider that can report usage implements `decideWithMetadata`, and one that
 * cannot (a rules table, a test double) still satisfies `DecisionProvider`. The
 * engine measures latency itself when a provider does not report it, so an absent
 * `latencyMs` is never zero-by-omission.
 */
export interface DecisionProviderResult {
  readonly response: DecisionResponse;
  readonly modelId?: string;
  readonly usage?: AIUsage;
  readonly latencyMs?: number;
  readonly requestId?: string;
  /**
   * How this response was produced, when the provider can attest its own execution.
   *
   * Absent by default. The only trusted value is the sealed `TrustedLiveSdkExecution`
   * marker, and only `attestLiveSdkExecution()` — called by the TypeSafe adapter at
   * its actual SDK call site — constructs it. Every other provider, rules table and
   * test double leaves it absent or sets it to `"test-double"`.
   */
  readonly executionSource?: DecisionProviderExecutionSource;
}

/**
 * The module-private seal behind the live-SDK provenance marker.
 *
 * Because this symbol is never exported, no other module can construct a value of
 * `TrustedLiveSdkExecution`: they would need this exact symbol as the property key.
 * That is the whole trust boundary — the marker is minted in exactly one place, and
 * structurally cannot be faked by a generic test double that merely declares a
 * matching-looking object.
 */
const LIVE_SDK_SEAL: unique symbol = Symbol("decision-provider.live-sdk");

/**
 * Proof that a real remote SDK call produced a provider answer.
 *
 * Carried inside `DecisionProviderResult.executionSource` alongside `"test-double"`.
 * See `attestLiveSdkExecution` for the only constructor.
 */
export interface TrustedLiveSdkExecution {
  readonly [LIVE_SDK_SEAL]: true;
}

/**
 * The provider-side execution-source vocabulary: the sealed live-SDK marker, or the
 * explicit "test-double" admission a scripted provider makes about itself.
 */
export type DecisionProviderExecutionSource =
  TrustedLiveSdkExecution | "test-double";

/**
 * Mints the sealed live-SDK provenance marker.
 *
 * Called only by the TypeSafe adapter, immediately after the actual
 * `TypeSafeClient.systemOne(...).withResponse()` call resolves. Anywhere else it is
 * imported from is a lie in the code, not in a log — which is what makes the lie
 * greppable and reviewable rather than emergent.
 */
export function attestLiveSdkExecution(): TrustedLiveSdkExecution {
  return { [LIVE_SDK_SEAL]: true };
}

/**
 * Flattens a provider-side provenance value into the closed vocabulary that records
 * and events may carry (`"live-sdk" | "test-double"`).
 *
 * The engine is the single conversion point: downstream of it, nothing sees the
 * sealed marker, so no record or event can be constructed from a marker somebody
 * smuggled past validation.
 */
export function flattenDecisionProviderExecutionSource(
  value: DecisionProviderExecutionSource,
): DecisionProviderExecutionSourceValue {
  if (value === "test-double") {
    return "test-double";
  }
  return "live-sdk";
}

export interface DecisionProvider {
  readonly id: string;
  readonly family: DecisionProviderFamily;
  capabilities(): DecisionCapabilities;
  decide(request: DecisionRequest): Promise<DecisionResponse>;
}

/**
 * A provider that reports usage and provider-side timing.
 *
 * Optional capability rather than a required method, because "this provider has no
 * accounting" is a legitimate state and should not force every implementation to
 * fabricate numbers.
 *
 * Implementations that perform a real remote decision call may return a trusted
 * provider-execution provenance via `result.executionSource`. Deterministic, local or
 * test double providers must not manufacture the trusted value: the only constructor
 * of the sealed marker is `attestLiveSdkExecution`, and it belongs to the TypeSafe
 * adapter's `decideDetailed` boundary.
 */
export interface UsageReportingDecisionProvider extends DecisionProvider {
  decideWithMetadata(request: DecisionRequest): Promise<DecisionProviderResult>;
}

export function isUsageReportingDecisionProvider(
  provider: DecisionProvider,
): provider is UsageReportingDecisionProvider {
  return (
    typeof (provider as { decideWithMetadata?: unknown }).decideWithMetadata ===
    "function"
  );
}

/**
 * Provider failure taxonomy for decisions.
 *
 * The categories mirror the ones the LLM port already uses (`LlmFailureKind`)
 * because they describe the same transport and protocol problems, plus
 * `unavailable`, which is what "the decision layer is not configured or cannot be
 * reached at all" genuinely is. One taxonomy, extended rather than duplicated; a
 * test asserts the shared members still agree.
 */
export const DECISION_FAILURE_KINDS = [
  "auth",
  "rate-limit",
  "timeout",
  "network",
  "server",
  "malformed-response",
  "refused",
  "unavailable",
  "unknown",
] as const;

export type DecisionFailureKind = (typeof DECISION_FAILURE_KINDS)[number];

export interface DecisionFailureDetails {
  readonly failureKind: DecisionFailureKind;
  readonly providerId: string;
  readonly attempts: number;
  readonly retryable: boolean;
  readonly statusCode?: number;
}

/**
 * A categorised decision-provider failure.
 *
 * Never carries the provider's own message, an authorization header or a request
 * body: the category and, at most, the status code are the whole content.
 */
export class DecisionProviderError extends DomainError {
  readonly failureKind: DecisionFailureKind;
  readonly providerId: string;
  readonly attempts: number;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(details: DecisionFailureDetails, message: string) {
    super("PROVIDER_FAILURE", message, {
      providerId: details.providerId,
      failureKind: details.failureKind,
      attempts: details.attempts,
      retryable: details.retryable,
      stage: "decision",
      ...(details.statusCode === undefined
        ? {}
        : { statusCode: details.statusCode }),
    });
    this.name = "DecisionProviderError";
    this.failureKind = details.failureKind;
    this.providerId = details.providerId;
    this.attempts = details.attempts;
    this.retryable = details.retryable;
    if (details.statusCode !== undefined) {
      this.statusCode = details.statusCode;
    }
  }
}

export function isDecisionProviderError(
  value: unknown,
): value is DecisionProviderError {
  return value instanceof DecisionProviderError;
}

/**
 * Which deterministic fallback reason a failure maps to.
 *
 * A total function over the taxonomy, so no failure can reach the engine without an
 * explicit, recorded reason for the answer that replaced it.
 */
export function fallbackReasonForFailure(
  failureKind: DecisionFailureKind,
): DecisionFallbackReason {
  switch (failureKind) {
    case "auth":
      return "provider-auth";
    case "rate-limit":
      return "provider-rate-limit";
    case "timeout":
      return "provider-timeout";
    case "malformed-response":
      return "provider-malformed-response";
    case "refused":
      return "provider-refused";
    case "network":
    case "unavailable":
      return "provider-unavailable";
    case "server":
    case "unknown":
      return "provider-error";
  }
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
    readonly usage?: AIUsage;
    readonly usageReported?: boolean;
    readonly fallback?: Decision["fallback"];
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
    ...(options.usage === undefined ? {} : { usage: options.usage }),
    ...(options.usageReported === undefined
      ? {}
      : { usageReported: options.usageReported }),
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
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
          ...(response.rankedOptionIds === undefined
            ? {}
            : { ranking: response.rankedOptionIds }),
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
