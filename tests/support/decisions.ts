import type { Clock } from "../../src/core/clock.js";
import type {
  DecisionOption,
  DecisionKind,
} from "../../src/decisions/decision.js";
import type { ToolCandidate } from "../../src/decisions/domains.js";
import { durationMsFrom, toIsoString } from "../../src/core/clock.js";
import {
  DECISION_FAILURE_KINDS,
  type DecisionCapabilities,
  type DecisionFailureKind,
  type DecisionProvider,
  type DecisionProviderResult,
  type DecisionRequest,
  type DecisionResponse,
  type UsageReportingDecisionProvider,
  DecisionProviderError,
} from "../../src/decisions/provider.js";
import { DECISION_KINDS } from "../../src/decisions/decision.js";
import { DECISION_DOMAIN_KINDS } from "../../src/decisions/domains.js";
import {
  type DecisionDomain,
  type DomainDecisionSpec,
  buildCompletionSpec,
  buildContextSelectionSpec,
  buildEscalationSpec,
  buildExecutionStrategySpec,
  buildRankingSpec,
  buildRelevanceSpec,
  buildSkillSelectionSpec,
  buildRetrySpec,
  buildRiskAssessmentSpec,
  buildRoutingSpec,
  buildToolSelectionSpec,
} from "../../src/decisions/domains.js";
import { emptyUsage, type AIUsage } from "../../src/observability/usage.js";

/**
 * Offline fixtures for the decision layer.
 *
 * A decision provider is a *network* dependency in production and a port in tests, so
 * every test below drives one of these: scripted answers, scripted failures, and a
 * precise record of what was asked. Nothing here reaches JEV, and nothing depends on
 * wall-clock time — the same discipline the LLM fakes follow, for the same reason.
 *
 * The fakes are deliberately *adversarial by default* in the sense that matters: they
 * can return anything, including an invented candidate or a candidate from another
 * scope, because the platform's validation has to hold against exactly that.
 */

export type ScriptedStep =
  | { readonly response: DecisionResponse }
  | { readonly error: Error }
  | {
      readonly metadata: {
        readonly response: DecisionResponse;
        readonly usage?: AIUsage;
        readonly latencyMs?: number;
        readonly modelId?: string;
        readonly requestId?: string;
      };
    };

export interface ScriptedDecisionProvider extends DecisionProvider {
  readonly requests: readonly DecisionRequest[];
  /** Calls the provider received, whether they answered or failed. */
  readonly calls: number;
}

/**
 * The same provider, additionally able to report usage and provider-side timing.
 *
 * Kept as a separate factory rather than an option, because "this provider reports
 * no accounting" is a *capability* difference the engine detects structurally. A
 * provider whose method exists but is never meaningfully used would test the
 * opposite of what it claims.
 */
export interface MetadataScriptedDecisionProvider
  extends ScriptedDecisionProvider, UsageReportingDecisionProvider {}

export interface ScriptedProviderOptions {
  readonly id?: string;
  readonly family?: DecisionProvider["family"];
  readonly kinds?: DecisionCapabilities["kinds"];
  readonly maxOptions?: number;
}

/**
 * A provider that replays scripted steps in order and records every request.
 *
 * Exhausting the script is a test bug, not a provider behaviour, so it throws: a
 * silently repeated answer would make a "the layer was consulted once" assertion
 * meaningless.
 */
interface ScriptRunner {
  readonly requests: DecisionRequest[];
  readonly calls: number;
  nextStep(request: DecisionRequest): ScriptedStep;
  responseOf(step: ScriptedStep): DecisionResponse;
  resultOf(step: ScriptedStep): DecisionProviderResult;
}

/**
 * The scripted behaviour two providers share: record the request, take the next step,
 * and fail loudly when the script runs out. Exhausting the script is a test bug, so it
 * throws rather than repeating an answer — a silently repeated answer would make any
 * "the layer was consulted once" assertion meaningless.
 */
function scriptedRunner(steps: readonly ScriptedStep[]): ScriptRunner {
  const requests: DecisionRequest[] = [];
  let index = 0;
  return {
    requests,
    get calls(): number {
      return requests.length;
    },
    nextStep(request) {
      requests.push(request);
      const step = steps[index];
      index += 1;
      if (step === undefined) {
        throw new Error(
          `scripted decision provider received call #${index} with no scripted step`,
        );
      }
      return step;
    },
    responseOf(step) {
      if ("error" in step) {
        throw step.error;
      }
      return "metadata" in step ? step.metadata.response : step.response;
    },
    resultOf(step) {
      if ("error" in step) {
        throw step.error;
      }
      const metadata =
        "metadata" in step ? step.metadata : { response: step.response };
      return {
        response: metadata.response,
        ...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
        ...(metadata.latencyMs === undefined
          ? {}
          : { latencyMs: metadata.latencyMs }),
        ...(metadata.modelId === undefined
          ? {}
          : { modelId: metadata.modelId }),
        ...("requestId" in metadata && metadata.requestId !== undefined
          ? { requestId: metadata.requestId }
          : {}),
        // A scripted provider attests its own nature: it is not the real SDK, and
        // it must never be able to pass for one in a recorded decision.
        executionSource: "test-double" as const,
      };
    },
  };
}

function scriptedIdentity(options: ScriptedProviderOptions): {
  readonly id: string;
  readonly family: DecisionProvider["family"];
  readonly capabilities: () => DecisionCapabilities;
} {
  return {
    id: options.id ?? "scripted-decision-provider",
    family: options.family ?? "rules",
    capabilities: () => ({
      kinds: options.kinds ?? DECISION_KINDS,
      deterministic: true,
      ...(options.maxOptions === undefined
        ? {}
        : { maxOptions: options.maxOptions }),
    }),
  };
}

export function createScriptedDecisionProvider(
  steps: readonly ScriptedStep[],
  options: ScriptedProviderOptions = {},
): ScriptedDecisionProvider {
  const runner = scriptedRunner(steps);
  return {
    ...scriptedIdentity(options),
    requests: runner.requests,
    get calls(): number {
      return runner.calls;
    },
    async decide(request: DecisionRequest): Promise<DecisionResponse> {
      return runner.responseOf(runner.nextStep(request));
    },
  };
}

/** The same script, reporting usage and provider-side timing when it has them. */
export function createMetadataDecisionProvider(
  steps: readonly ScriptedStep[],
  options: ScriptedProviderOptions = {},
): MetadataScriptedDecisionProvider {
  const runner = scriptedRunner(steps);
  return {
    ...scriptedIdentity(options),
    requests: runner.requests,
    get calls(): number {
      return runner.calls;
    },
    async decide(request: DecisionRequest): Promise<DecisionResponse> {
      return runner.responseOf(runner.nextStep(request));
    },
    async decideWithMetadata(
      request: DecisionRequest,
    ): Promise<DecisionProviderResult> {
      return runner.resultOf(runner.nextStep(request));
    },
  };
}

/**
 * A categorised decision-provider failure, built the way the adapter builds one.
 *
 * The message names the category and nothing else, which is what makes "a provider
 * failure never leaks its own words" testable rather than aspirational.
 */
export function decisionProviderFailure(input: {
  readonly failureKind: DecisionFailureKind;
  readonly providerId?: string;
  readonly attempts?: number;
  readonly retryable?: boolean;
  readonly statusCode?: number;
}): DecisionProviderError {
  return new DecisionProviderError(
    {
      failureKind: input.failureKind,
      providerId: input.providerId ?? "scripted-decision-provider",
      attempts: input.attempts ?? 1,
      retryable: input.retryable ?? false,
      ...(input.statusCode === undefined
        ? {}
        : { statusCode: input.statusCode }),
    },
    `scripted ${input.failureKind} decision failure`,
  );
}

/** Every failure category, so a suite can assert a total mapping covers them all. */
export const ALL_DECISION_FAILURE_KINDS = DECISION_FAILURE_KINDS;

/** The recorded kind for a domain, for assertions against event payloads. */
export function kindForDomain(domain: DecisionDomain): DecisionKind {
  return DECISION_DOMAIN_KINDS[domain];
}

export const DECISION_USAGE: AIUsage = {
  inputTokens: 900,
  outputTokens: 120,
  cachedInputTokens: 0,
};

export const ZERO_DECISION_USAGE = emptyUsage();

/** Milliseconds the clock advanced across a call, for latency assertions. */
export function decisionLatencyOf(clock: Clock, from: Date): number {
  return durationMsFrom(toIsoString(from), toIsoString(clock.now()));
}

/** The candidates a tool-selection question may offer, in a fixed order. */
export const SCRIPTED_TOOLS: readonly ToolCandidate[] = [
  {
    toolId: "list-workspace-files",
    label: "List workspace files",
    operation: "read",
  },
  {
    toolId: "read-selected-file",
    label: "Read the selected context file",
    operation: "read",
    ref: "src/a.ts",
  },
];

/**
 * One valid spec per domain, with a real candidate set and no deterministic gate
 * unless the question genuinely has only one defensible answer.
 *
 * Shared so the fallback, engine and coordinator suites all ask about the same
 * questions: a suite that invented its own spec per test could assert a shape the
 * platform never builds in production.
 */
export function specForDomain(
  domain: DecisionDomain,
  options: { readonly candidates?: readonly DecisionOption[] } = {},
): DomainDecisionSpec {
  switch (domain) {
    case "routing":
      return buildRoutingSpec({
        taskRiskLevel: "low",
        routes: ["standard", "minimal"],
        context: ["risk:low"],
      });
    case "tool-selection":
      return buildToolSelectionSpec({
        candidates: SCRIPTED_TOOLS,
        defaultToolId: SCRIPTED_TOOLS[0]!.toolId,
        context: [],
      });
    case "risk-assessment":
      return buildRiskAssessmentSpec({
        operation: "write",
        baselineRisk: "medium",
        context: [],
      });
    case "retry":
      return buildRetrySpec({
        failureKind: "server",
        retryable: true,
        attemptsSpent: 0,
        maxRetries: 2,
        retriesRemaining: 2,
        context: [],
      });
    case "completion":
      return buildCompletionSpec({
        acceptanceCriteriaTotal: 2,
        acceptanceCriteriaMet: 2,
        verificationChecks: 2,
        verificationFailures: 0,
        context: [],
      });
    case "ranking":
      return buildRankingSpec({
        candidates: options.candidates ?? [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        context: [],
      });
    case "relevance":
      return buildRelevanceSpec({
        candidateRefs: ["src/a.ts", "tests/a.test.ts"],
        context: [],
      });
    case "human-escalation":
      return buildEscalationSpec({
        facts: ["verification-failed"],
        securityRefusal: false,
        context: [],
      });
    case "execution-strategy":
      return buildExecutionStrategySpec({
        modelRequired: true,
        eligibleCandidates: 2,
        riskLevel: "medium",
        requiredCapabilities: ["reasoning", "coding"],
        context: [],
      });
    case "skill-selection":
      return buildSkillSelectionSpec({
        skillIds: ["code-review"],
        context: [],
      });
    case "context-selection":
      return buildContextSelectionSpec({
        candidateRefs: ["src/a.ts"],
        context: [],
      });
  }
}
