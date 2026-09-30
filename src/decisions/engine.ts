import { type Clock, durationMsFrom, toIsoString } from "../core/clock.js";
import { DomainError } from "../core/errors.js";
import {
  DECISION_DOMAIN_KINDS,
  DECISION_LAYER_DISABLED_REASON,
  type DecisionFallbackReason,
  type DomainDecisionOutcome,
  type DomainDecisionSpec,
  assertDomainDecisionSpec,
} from "./domains.js";
import { DOMAIN_FALLBACKS, deterministicFallbackFor } from "./fallback.js";
import {
  type DecisionProvider,
  type DecisionProviderFamily,
  type DecisionProviderResult,
  type DecisionRequest,
  DECISION_FAILURE_KINDS,
  fallbackReasonForFailure,
  flattenDecisionProviderExecutionSource,
  isDecisionProviderError,
  isUsageReportingDecisionProvider,
  providerCanHandle,
} from "./provider.js";
import { validateProviderAnswer } from "./validate.js";

/**
 * The decision engine: one bounded question in, one recorded answer out.
 *
 * The engine is intentionally small. It owns exactly one responsibility — deciding
 * *how* a question gets answered — and it delegates everything else: candidates come
 * from the caller, validation from `./validate.ts`, fallback from `./fallback.ts`,
 * and the provider from the `DecisionProvider` port. It performs I/O only through
 * that port, and it records nothing: recording is the application layer's job, so
 * the engine stays testable and the event log stays the single source of truth
 * (ADR-051).
 *
 * The order of the steps is the architecture:
 *
 * 1. **deterministic gate** — if code can answer the question, the provider is never
 *    consulted. This is why JEV is not a mandatory round-trip for every step
 *    (ADR-052).
 * 2. **capability gate** — a provider that cannot handle the kind or the candidate
 *    count is treated as unavailable rather than called and hoped for.
 * 3. **provider** — one call, with a closed answer vocabulary.
 * 4. **validation** — an answer that does not fit the question is rejected, never
 *    repaired (`./validate.ts`).
 * 5. **fallback** — the deterministic, per-domain answer, recorded with the reason
 *    it was needed.
 *
 * Nothing above this module can observe an unvalidated provider answer: the only way
 * out is a `DomainDecisionOutcome` whose `selectedOptionId` came from the caller's
 * own candidate list.
 */
export interface DecisionEngineDeps {
  readonly clock: Clock;
  /**
   * The decision layer. Absent means "no decision engine is configured", which is a
   * supported, fully functional state: every question is then answered by code and
   * recorded as such.
   */
  readonly provider?: DecisionProvider;
}

export interface DecisionEvaluationContext {
  readonly correlationId: string;
  /**
   * The provider is not consulted; the deterministic fallback answers with this
   * reason instead.
   *
   * Exists so an exhausted decision budget is enforced *before* a provider is
   * reached, which is the only way a budget can actually bound what is spent. The
   * question is still recorded, so the degradation is visible in the trace.
   */
  readonly skipProviderWith?: DecisionFallbackReason;
}

export interface DecisionEngineInfo {
  /** True when a decision provider is configured at all. */
  readonly configured: boolean;
  readonly providerId?: string;
  readonly providerFamily?: DecisionProviderFamily;
  /** True when the provider answers deterministically for identical input. */
  readonly deterministic?: boolean;
  readonly kinds?: readonly string[];
}

export interface DecisionEngine {
  readonly info: DecisionEngineInfo;
  evaluate(
    spec: DomainDecisionSpec,
    context: DecisionEvaluationContext,
  ): Promise<DomainDecisionOutcome>;
}

/** Provider ids that mean "no decision layer is installed". */
export const DISABLED_PROVIDER_IDS: readonly string[] = ["abstaining-provider"];

export function createDecisionEngine(deps: DecisionEngineDeps): DecisionEngine {
  const provider = deps.provider;
  const info: DecisionEngineInfo = {
    configured: provider !== undefined,
    ...(provider === undefined
      ? {}
      : {
          providerId: provider.id,
          providerFamily: provider.family,
          deterministic: provider.capabilities().deterministic,
          kinds: provider.capabilities().kinds,
        }),
  };

  function elapsedSince(startedAt: string): number {
    return durationMsFrom(startedAt, toIsoString(deps.clock.now()));
  }

  function base(
    spec: DomainDecisionSpec,
  ): Pick<
    DomainDecisionOutcome,
    "domain" | "kind" | "providerCalls" | "usageReported"
  > {
    return {
      domain: spec.domain,
      kind: DECISION_DOMAIN_KINDS[spec.domain],
      providerCalls: 0,
      usageReported: false,
    };
  }

  function deterministicOutcome(
    spec: DomainDecisionSpec,
    startedAt: string,
  ): DomainDecisionOutcome {
    const answer = spec.deterministic;
    if (answer === undefined) {
      // Unreachable by construction: this function is only called when the gate
      // answered. Failing loudly beats inventing an answer.
      throw new DomainError(
        "INVARIANT",
        "the deterministic gate produced no answer for this decision",
        { field: "spec.deterministic" },
      );
    }
    return {
      ...base(spec),
      answeredBy: "deterministic",
      outcome: "selected",
      selectedOptionId: answer.optionId,
      reasonCode: answer.reasonCode,
      rationale: answer.rationale,
      latencyMs: elapsedSince(startedAt),
      ...(spec.ranked
        ? { ranking: spec.options.map((option) => option.id) }
        : {}),
    };
  }

  function fallbackOutcome(
    spec: DomainDecisionSpec,
    reason: DecisionFallbackReason,
    startedAt: string,
    extra: {
      readonly providerFailure?: string;
      readonly providerCalls?: number;
      readonly usage?: DomainDecisionOutcome["usage"];
      readonly requestId?: string;
      readonly providerId?: string;
      readonly modelId?: string;
      readonly latencyMs?: number;
    } = {},
  ): DomainDecisionOutcome {
    const answer = deterministicFallbackFor(spec, reason);
    return {
      ...base(spec),
      answeredBy: "fallback",
      outcome: "selected",
      selectedOptionId: answer.optionId,
      ...(answer.ranking === undefined ? {} : { ranking: answer.ranking }),
      reasonCode: reason,
      rationale: answer.rationale,
      fallbackReason: reason,
      latencyMs: extra.latencyMs ?? elapsedSince(startedAt),
      providerCalls: extra.providerCalls ?? 0,
      ...(extra.providerId === undefined
        ? {}
        : { providerId: extra.providerId }),
      ...(extra.modelId === undefined ? {} : { modelId: extra.modelId }),
      ...(extra.providerFailure === undefined
        ? {}
        : { providerFailure: extra.providerFailure }),
      ...(extra.usage === undefined ? {} : { usage: extra.usage }),
      ...(extra.requestId === undefined ? {} : { requestId: extra.requestId }),
    };
  }

  /**
   * The answer when no decision layer is installed at all.
   *
   * Not an error and not a fallback: nothing was expected and nothing failed. The
   * declared default answers, attributed to code, with a reason code that says why no
   * provider was consulted — so a trace never has to guess whether the decision layer
   * was missing or merely broken, and an operator is not shown a degradation that did
   * not happen (ADR-052).
   */
  function decisionLayerDisabledOutcome(
    spec: DomainDecisionSpec,
    startedAt: string,
  ): DomainDecisionOutcome {
    const answer = deterministicFallbackFor(spec, "provider-disabled");
    return {
      ...base(spec),
      answeredBy: "deterministic",
      outcome: "selected",
      selectedOptionId: answer.optionId,
      ...(answer.ranking === undefined ? {} : { ranking: answer.ranking }),
      reasonCode: DECISION_LAYER_DISABLED_REASON,
      rationale: `no decision layer is configured; ${DOMAIN_FALLBACKS[spec.domain].description}`,
      latencyMs: elapsedSince(startedAt),
    };
  }

  return {
    info,

    async evaluate(spec, context): Promise<DomainDecisionOutcome> {
      // Validate before anything else: a malformed question must never reach a
      // provider, and must never be "fixed" into a different question.
      assertDomainDecisionSpec(spec);
      const startedAt = toIsoString(deps.clock.now());

      // 1. Certainty lives in code.
      if (spec.deterministic !== undefined) {
        return deterministicOutcome(spec, startedAt);
      }

      // 1a. No decision layer is installed: the question is answered by code and
      // recorded as such, without pretending a provider failed.
      if (provider === undefined) {
        return decisionLayerDisabledOutcome(spec, startedAt);
      }

      // 1b. A caller that already knows the provider must not be consulted (an
      // exhausted budget) is honoured before anything else could reach it.
      if (context.skipProviderWith !== undefined) {
        return fallbackOutcome(spec, context.skipProviderWith, startedAt);
      }

      // 2. A provider that cannot handle this question is not asked. "Cannot" is
      // decided by the provider's declared capabilities, not by its behaviour.
      const request: DecisionRequest = {
        kind: DECISION_DOMAIN_KINDS[spec.domain],
        question: spec.question,
        options: spec.options,
        context: spec.context,
        ...(spec.reasonCodes.length === 0
          ? {}
          : { reasonCodes: [...spec.reasonCodes] }),
        ...(spec.ranked ? { ranked: true } : {}),
        ...(spec.maxLatencyMs === undefined
          ? {}
          : { maxLatencyMs: spec.maxLatencyMs }),
        ...(spec.maxCostMicros === undefined
          ? {}
          : { maxCostMicros: spec.maxCostMicros }),
        correlationId: context.correlationId,
      };

      if (provider === undefined) {
        return decisionLayerDisabledOutcome(spec, startedAt);
      }
      if (!providerCanHandle(provider, request)) {
        return fallbackOutcome(spec, "provider-unavailable", startedAt, {
          providerFailure: "unavailable",
        });
      }

      // 3. One call. Exactly one: retrying belongs to the layer that owns retry
      // policy, not to a decision engine that has no budget of its own.
      let result: DecisionProviderResult;
      try {
        result = isUsageReportingDecisionProvider(provider)
          ? await provider.decideWithMetadata(request)
          : { response: await provider.decide(request) };
      } catch (error) {
        if (isDecisionProviderError(error)) {
          return fallbackOutcome(
            spec,
            fallbackReasonForFailure(error.failureKind),
            startedAt,
            {
              providerFailure: error.failureKind,
              providerCalls: 1,
              providerId: error.providerId,
            },
          );
        }
        // An unrecognised error is attributed to the provider layer and never
        // assumed to be a benign state.
        return fallbackOutcome(spec, "provider-error", startedAt, {
          providerFailure: "unknown",
          providerCalls: 1,
          providerId: provider.id,
        });
      }

      const latencyMs = result.latencyMs ?? elapsedSince(startedAt);
      const usage = result.usage;
      const usageReported = usage !== undefined;

      if (result.response.outcome === "failed") {
        // A provider reporting its own failure is a provider failure, categorised as
        // such. It is never treated as an answer, and never as an abstention — the
        // difference between "I decline" and "I am broken" matters to an operator.
        return fallbackOutcome(spec, "provider-error", startedAt, {
          providerFailure: "unknown",
          providerCalls: 1,
          providerId: provider.id,
          latencyMs,
          ...(usage === undefined ? {} : { usage }),
          ...(result.requestId === undefined
            ? {}
            : { requestId: result.requestId }),
        });
      }

      // Provenance flattening happens once, here. Downstream of the engine, records
      // and events carry only the closed string vocabulary, so a sealed marker can
      // never be smuggled into a log entry from outside this conversion point. A
      // fallback answer below (failed/invalid/abstained) deliberately drops it: the
      // fallback answered, not the provider.
      const executionSource =
        result.executionSource === undefined
          ? undefined
          : flattenDecisionProviderExecutionSource(result.executionSource);

      // 4. Untrusted until validated.
      const validation = validateProviderAnswer(spec, result.response);
      if (!validation.ok) {
        return fallbackOutcome(spec, "invalid-answer", startedAt, {
          providerFailure: "malformed-response",
          providerCalls: 1,
          providerId: provider.id,
          ...(usage === undefined ? {} : { usage }),
          ...(result.requestId === undefined
            ? {}
            : { requestId: result.requestId }),
          latencyMs,
        });
      }

      // 5. An abstention is not an answer: the deterministic fallback answers, and
      // the record says the provider was asked and declined.
      if (validation.answer.outcome === "abstained") {
        return fallbackOutcome(spec, "provider-abstained", startedAt, {
          providerCalls: 1,
          providerId: provider.id,
          ...(usage === undefined ? {} : { usage }),
          ...(result.requestId === undefined
            ? {}
            : { requestId: result.requestId }),
          latencyMs,
        });
      }

      if (validation.answer.outcome === "escalated") {
        return {
          ...base(spec),
          answeredBy: "provider",
          outcome: "escalated",
          providerId: provider.id,
          latencyMs,
          usageReported,
          providerCalls: 1,
          ...(validation.answer.reasonCode === undefined
            ? {}
            : { reasonCode: validation.answer.reasonCode }),
          rationale: validation.rationale,
          ...(usage === undefined ? {} : { usage }),
          ...(result.requestId === undefined
            ? {}
            : { requestId: result.requestId }),
          ...(executionSource === undefined ? {} : { executionSource }),
        };
      }

      return {
        ...base(spec),
        answeredBy: "provider",
        outcome: "selected",
        selectedOptionId: validation.answer.selectedOptionId as string,
        ...(validation.answer.ranking === undefined
          ? {}
          : { ranking: validation.answer.ranking }),
        ...(validation.answer.reasonCode === undefined
          ? {}
          : { reasonCode: validation.answer.reasonCode }),
        ...(validation.answer.confidence === undefined
          ? {}
          : { confidence: validation.answer.confidence }),
        rationale: validation.rationale,
        providerId: provider.id,
        ...(result.modelId === undefined ? {} : { modelId: result.modelId }),
        latencyMs,
        usageReported,
        ...(executionSource === undefined ? {} : { executionSource }),
        providerCalls: 1,
        ...(usage === undefined ? {} : { usage }),
        ...(result.requestId === undefined
          ? {}
          : { requestId: result.requestId }),
      };
    },
  };
}

/** Exported for tests that want to assert the taxonomy is still the shared one. */
export const DECISION_FAILURE_KIND_VALUES: readonly string[] =
  DECISION_FAILURE_KINDS;
