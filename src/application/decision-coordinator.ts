import type { DecisionConfig } from "../adapters/config/project-config.js";
import type { Clock } from "../core/clock.js";
import type { ProjectId, SessionId, TaskId, WorkspaceId } from "../core/ids.js";
import type { OperationKind, RiskLevel } from "../decisions/risk.js";
import {
  DECISION_DOMAIN_KINDS,
  type CompletionDecisionResult,
  type DecisionOutcomeMeta,
  type EscalationDecisionResult,
  type ExecutionStrategyDecision,
  type RankingDecisionResult,
  type RelevanceDecisionResult,
  type RiskAssessmentDecision,
  type RouteDecision,
  type RetryDecisionResult,
  type ToolCandidate,
  type ToolSelectionDecision,
  buildCompletionSpec,
  buildEscalationSpec,
  buildExecutionStrategySpec,
  buildRankingSpec,
  buildRelevanceSpec,
  buildRiskAssessmentSpec,
  buildRetrySpec,
  buildRoutingSpec,
  buildToolSelectionSpec,
  interpretCompletion,
  interpretEscalation,
  interpretExecutionStrategy,
  interpretRanking,
  interpretRelevance,
  interpretRiskAssessment,
  interpretRoute,
  interpretRetry,
  interpretToolSelection,
  MAX_DECISION_OPTIONS,
} from "../decisions/domains.js";
import type {
  DecisionEngine,
  DecisionEngineInfo,
} from "../decisions/engine.js";
import type { Decision } from "../decisions/decision.js";
import {
  type DecisionFallbackReason,
  type DomainDecisionOutcome,
  type DomainDecisionSpec,
} from "../decisions/domains.js";
import type { DecisionFailureKind } from "../decisions/provider.js";
import { type ModelRate, estimateCost } from "../observability/cost.js";
import type { DomainEvent } from "../observability/events.js";
import { totalTokens } from "../observability/usage.js";
import type { EventStore } from "../ports/event-store.js";
import type { EventRecorder } from "./event-recorder.js";
import { taskCorrelationId } from "./event-recorder.js";
import type { DecisionService } from "./decision-service.js";

/**
 * The decision coordinator: where a bounded question becomes a recorded decision.
 *
 * The engine decides *how* a question is answered; this module decides *what that
 * means*, and it is the only place a decision becomes part of the log. Three
 * responsibilities, and deliberately only three:
 *
 * 1. **Budget.** Consultations are counted from the log, not from memory, so the cap
 *    stated in `.ai/project.json` is enforced against recorded fact. When the budget
 *    is exhausted the decision layer is not consulted again: the question is answered
 *    deterministically and *recorded* as a fallback, because silently skipping the
 *    question would hide the degradation (ADR-052).
 * 2. **Recording.** Ask, then answer: `DecisionRequested` before the provider is
 *    consulted, `DecisionFailed` when a provider failed, `DecisionFallbackUsed` when
 *    the deterministic answer replaced one, and `DecisionCompleted` with the answer,
 *    its layer, its reason code and what it cost.
 * 3. **Scope.** Every decision is bound to the workspace it was asked in and, when
 *    there is one, to the task and session. The coordinator cannot be pointed at
 *    another workspace: scope is fixed when it is created, exactly as the operation
 *    gateway's is (ADR-048, ADR-055).
 *
 * What it never does: decide policy, consult the enforcement layer, grant anything,
 * or interpret a provider answer itself. It hands candidates in and takes an answer
 * out of the same candidate set.
 */
export interface DecisionCoordinatorFactoryDeps {
  readonly engine: DecisionEngine;
  readonly decisions: DecisionService;
  readonly recorder: EventRecorder;
  /** The log is the budget's source of truth, exactly as it is for the trace. */
  readonly store: EventStore;
  readonly clock: Clock;
  readonly config: DecisionConfig;
  readonly rates: readonly ModelRate[];
  readonly projectId: ProjectId;
}

/**
 * The scope a coordinator is bound to.
 *
 * `taskId` is optional because a question can be asked about the workspace itself;
 * when it is absent no per-task budget can apply, so the budget check treats the
 * consultation count as 0 and the configured cap as the only bound.
 */
export interface DecisionScope {
  readonly workspaceId: WorkspaceId;
  readonly taskId?: TaskId;
  readonly sessionId?: SessionId;
  readonly correlationId?: string;
}

export interface DecisionBudgetState {
  readonly limit: number;
  /** Consultations already recorded for this task. */
  readonly consultations: number;
  readonly remaining: number;
  readonly costCapMicros?: number;
  /** Cost of recorded consultations that had a known price. */
  readonly knownCostMicros: number;
  readonly exhausted: boolean;
}

export interface ToolSelectionRequest {
  readonly candidates: readonly ToolCandidate[];
  readonly defaultToolId: string;
}

export interface CompletionDecisionRequest {
  readonly acceptanceCriteriaTotal: number;
  /**
   * Absent when no criterion-level verification was performed.
   *
   * "Not measured" is a different fact from "zero met", and the assessment is
   * allowed to see the difference.
   */
  readonly acceptanceCriteriaMet?: number;
  readonly verificationChecks: number;
  readonly verificationFailures: number;
}

export interface ExecutionStrategyRequest {
  readonly modelRequired: boolean;
  readonly eligibleCandidates: number;
  readonly riskLevel: RiskLevel;
  readonly requiredCapabilities: readonly string[];
}

export interface AttemptDecisionCoordinator {
  readonly providerConfigured: boolean;
  readonly providerId?: string;
  readonly budget: () => Promise<DecisionBudgetState>;
  /**
   * Whether this task should run deterministically, with a model, or by a human.
   *
   * Asked before the plan is chosen, because a task that code can finish must not
   * reserve a model call — and because the answer is what makes "we did not spend a
   * call here" an explained decision instead of an emergent behaviour.
   */
  strategize(
    input: ExecutionStrategyRequest,
  ): Promise<ExecutionStrategyDecision>;
  route(input: {
    readonly taskRiskLevel: RiskLevel;
    readonly routes: readonly string[];
  }): Promise<RouteDecision>;
  selectTool(input: ToolSelectionRequest): Promise<ToolSelectionDecision>;
  assessRisk(input: {
    readonly operation: OperationKind;
    readonly baselineRisk: RiskLevel;
  }): Promise<RiskAssessmentDecision>;
  shouldRetry(input: {
    readonly failureKind: string;
    readonly retryable: boolean;
    readonly attemptsSpent: number;
    /** Retries the task's own budget still allows; a hard input, not a hint. */
    readonly retriesRemaining: number;
  }): Promise<RetryDecisionResult>;
  assessCompletion(
    input: CompletionDecisionRequest,
  ): Promise<CompletionDecisionResult>;
  recommendEscalation(input: {
    readonly facts: readonly string[];
    readonly securityRefusal: boolean;
  }): Promise<EscalationDecisionResult>;
  rank(input: {
    readonly candidates: readonly {
      readonly id: string;
      readonly label: string;
    }[];
  }): Promise<RankingDecisionResult>;
  assessRelevance(input: {
    readonly candidateRefs: readonly string[];
  }): Promise<RelevanceDecisionResult>;
}

export interface DecisionCoordinatorFactory {
  readonly info: DecisionEngineInfo;
  readonly config: DecisionConfig;
  forAttempt(scope: DecisionScope): AttemptDecisionCoordinator;
}

/** Who is recorded as having produced each kind of decision event. */
const COORDINATOR_ACTOR = { type: "code", id: "decision-coordinator" } as const;

function consultationsIn(events: readonly DomainEvent[]): {
  readonly consultations: number;
  readonly knownCostMicros: number;
} {
  let consultations = 0;
  let knownCostMicros = 0;
  for (const event of events) {
    if (event.type === "DecisionFailed") {
      // A failed consultation still spent a round trip and still costs money.
      consultations += 1;
      continue;
    }
    if (event.type !== "DecisionCompleted") {
      continue;
    }
    if (event.payload.answeredBy !== "provider") {
      continue;
    }
    consultations += 1;
    knownCostMicros += event.payload.costMicros ?? 0;
  }
  return { consultations, knownCostMicros };
}

export function createDecisionCoordinatorFactory(
  deps: DecisionCoordinatorFactoryDeps,
): DecisionCoordinatorFactory {
  return {
    info: deps.engine.info,
    config: deps.config,

    forAttempt(scope: DecisionScope): AttemptDecisionCoordinator {
      function correlationId(): string {
        if (scope.correlationId !== undefined) {
          return scope.correlationId;
        }
        if (scope.taskId === undefined) {
          return `workspace:${scope.workspaceId}`;
        }
        return taskCorrelationId(
          deps.projectId,
          scope.workspaceId,
          scope.taskId,
        );
      }

      const decisionContext = () => ({
        workspaceId: scope.workspaceId,
        ...(scope.taskId === undefined ? {} : { taskId: scope.taskId }),
        ...(scope.sessionId === undefined
          ? {}
          : { sessionId: scope.sessionId }),
        correlationId: correlationId(),
      });

      async function state(): Promise<DecisionBudgetState> {
        const limit = deps.config.maxDecisionsPerTask;
        const costCap = deps.config.maxDecisionCostMicrosPerTask;
        if (scope.taskId === undefined) {
          return {
            limit,
            consultations: 0,
            remaining: limit,
            ...(costCap === undefined ? {} : { costCapMicros: costCap }),
            knownCostMicros: 0,
            exhausted: false,
          };
        }
        const events = await deps.store.readByTask(
          { projectId: deps.projectId, workspaceId: scope.workspaceId },
          scope.taskId,
        );
        const { consultations, knownCostMicros } = consultationsIn(events);
        const overCost = costCap !== undefined && knownCostMicros >= costCap;
        return {
          limit,
          consultations,
          remaining: Math.max(0, limit - consultations),
          ...(costCap === undefined ? {} : { costCapMicros: costCap }),
          knownCostMicros,
          exhausted: consultations >= limit || overCost,
        };
      }

      /**
       * Prices a provider-reported usage with the project's rate table.
       *
       * `undefined` means unpriced, and unpriced is recorded as unpriced — never as
       * zero. The same function the LLM path uses, so the two cannot diverge.
       */
      function priceDecision(
        outcome: DomainDecisionOutcome,
      ): number | undefined {
        if (outcome.usage === undefined || outcome.providerId === undefined) {
          return undefined;
        }
        const modelId =
          outcome.modelId ??
          (deps.config.provider === "jev-http"
            ? (deps.config.modelId ?? deps.config.provider)
            : outcome.providerId);
        const cost = estimateCost({
          usage: outcome.usage,
          providerId: outcome.providerId,
          modelId,
          rates: deps.rates,
        });
        return cost?.micros;
      }

      async function emitDecisionFailure(
        outcome: DomainDecisionOutcome,
        decision: Decision,
      ) {
        if (outcome.providerFailure === undefined) {
          return;
        }
        await deps.recorder.emit({
          type: "DecisionFailed",
          workspaceId: scope.workspaceId,
          actor: {
            type: "decision-provider",
            id: outcome.providerId ?? "unknown",
          },
          ...(scope.taskId === undefined ? {} : { taskId: scope.taskId }),
          ...(scope.sessionId === undefined
            ? {}
            : { sessionId: scope.sessionId }),
          correlationId: correlationId(),
          payload: {
            decisionId: decision.id,
            kind: outcome.kind,
            providerId: outcome.providerId ?? "unknown",
            failureKind: outcome.providerFailure as DecisionFailureKind,
            attempts: outcome.providerCalls,
          },
        });
      }

      async function emitFallbackUsed(
        outcome: DomainDecisionOutcome,
        decision: Decision,
      ) {
        if (
          outcome.answeredBy !== "fallback" ||
          outcome.fallbackReason === undefined
        ) {
          return;
        }
        await deps.recorder.emit({
          type: "DecisionFallbackUsed",
          workspaceId: scope.workspaceId,
          actor: COORDINATOR_ACTOR,
          ...(scope.taskId === undefined ? {} : { taskId: scope.taskId }),
          ...(scope.sessionId === undefined
            ? {}
            : { sessionId: scope.sessionId }),
          correlationId: correlationId(),
          payload: {
            decisionId: decision.id,
            kind: outcome.kind,
            reason: outcome.fallbackReason,
            ...(outcome.selectedOptionId === undefined
              ? {}
              : { selectedOptionId: outcome.selectedOptionId }),
          },
        });
      }

      /**
       * The one path every bounded question takes: ask, evaluate, record, answer.
       *
       * The budget is consulted *before* the question is asked, because the point of
       * a hard budget is that the provider is not called — asking first and then
       * discarding the answer would spend exactly what the budget exists to bound.
       */
      async function evaluateSpec(spec: DomainDecisionSpec): Promise<{
        readonly outcome: DomainDecisionOutcome;
        readonly decision: Decision;
      }> {
        const budget = await state();
        const skipReason: DecisionFallbackReason | undefined = budget.exhausted
          ? "budget-exhausted"
          : undefined;
        const decision = await deps.decisions.ask(
          {
            kind: DECISION_DOMAIN_KINDS[spec.domain],
            question: spec.question,
            options: spec.options,
            ...(spec.reasonCodes.length === 0
              ? {}
              : { reasonCodes: spec.reasonCodes }),
          },
          decisionContext(),
        );

        const outcome = await deps.engine.evaluate(spec, {
          correlationId: correlationId(),
          ...(skipReason === undefined ? {} : { skipProviderWith: skipReason }),
        });
        const answeredByProvider = outcome.answeredBy === "provider";
        const decidedBy = answeredByProvider ? "decision-provider" : "code";
        // The provider's own execution-path attestation, already flattened by the
        // engine to the closed vocabulary. Forwarded only on the genuine provider
        // branch: a deterministic or fallback answer never carries provenance.
        const executionSource = answeredByProvider
          ? outcome.executionSource
          : undefined;
        // A provider is named as the *decider* only when it answered. A fallback that
        // replaced a failed provider names it in `fallback.providerId` instead, which
        // is where "which layer was asked and did not answer" belongs — and it means a
        // failure can always be recorded, rather than being refused by the record for
        // attributing an answer to a layer that did not give one.
        const attributedProviderId = answeredByProvider
          ? outcome.providerId
          : undefined;
        const rationale =
          outcome.reasonCode === undefined
            ? (outcome.rationale ?? spec.domain)
            : `${spec.domain}: ${outcome.reasonCode}`;

        await emitDecisionFailure(outcome, decision);
        await emitFallbackUsed(outcome, decision);

        const costMicros = priceDecision(outcome);
        const resolved = await deps.decisions.resolve(
          decision,
          {
            outcome: outcome.outcome,
            decidedBy,
            ...(outcome.selectedOptionId === undefined
              ? {}
              : { selectedOptionId: outcome.selectedOptionId }),
            ...(outcome.ranking === undefined
              ? {}
              : { ranking: outcome.ranking }),
            rationale,
            ...(outcome.confidence === undefined
              ? {}
              : { confidence: outcome.confidence }),
            ...(attributedProviderId === undefined
              ? {}
              : { providerId: attributedProviderId }),
            latencyMs: outcome.latencyMs,
            ...(costMicros === undefined ? {} : { costMicros }),
            ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
            usageReported: outcome.usageReported,
            ...(outcome.fallbackReason === undefined
              ? {}
              : {
                  fallback: {
                    reason: outcome.fallbackReason,
                    ...(outcome.providerId === undefined
                      ? {}
                      : { providerId: outcome.providerId }),
                    ...(outcome.providerFailure === undefined
                      ? {}
                      : { failureKind: outcome.providerFailure }),
                  },
                }),
            answeredBy: outcome.answeredBy,
            ...(outcome.reasonCode === undefined
              ? {}
              : { reasonCode: outcome.reasonCode }),
            ...(attributedProviderId === undefined ||
            outcome.modelId === undefined
              ? {}
              : { modelId: outcome.modelId }),
            ...(executionSource === undefined ? {} : { executionSource }),
          },
          decisionContext(),
        );

        // `DecisionService.resolve` writes the one and only `DecisionCompleted` for
        // this question, from the record above. Nothing else in the platform writes
        // one, so a decision cannot appear twice in the log.

        return { outcome, decision: resolved };
      }

      function metaFor(
        outcome: DomainDecisionOutcome,
        decision: Decision,
      ): DecisionOutcomeMeta {
        const usageTokens =
          outcome.usage === undefined ? undefined : totalTokens(outcome.usage);
        return {
          decisionId: decision.id,
          answeredBy: outcome.answeredBy,
          ...(outcome.providerId === undefined
            ? {}
            : { providerId: outcome.providerId }),
          ...(outcome.fallbackReason === undefined
            ? {}
            : { fallbackReason: outcome.fallbackReason }),
          ...(usageTokens === undefined ? {} : { usageTokens }),
          latencyMs: outcome.latencyMs,
          ...(outcome.executionSource === undefined
            ? {}
            : { executionSource: outcome.executionSource }),
        };
      }

      /** Scope facts a decision may consider. References only, never content. */
      function baseContext(): readonly string[] {
        return [
          ...(scope.sessionId === undefined
            ? []
            : [`session:${scope.sessionId}`]),
        ];
      }

      return {
        providerConfigured: deps.engine.info.configured,
        ...(deps.engine.info.providerId === undefined
          ? {}
          : { providerId: deps.engine.info.providerId }),

        budget: state,

        async strategize(input) {
          const spec = buildExecutionStrategySpec({
            modelRequired: input.modelRequired,
            eligibleCandidates: input.eligibleCandidates,
            riskLevel: input.riskLevel,
            requiredCapabilities: input.requiredCapabilities,
            context: baseContext(),
          });
          const { outcome, decision } = await evaluateSpec(spec);
          // The fallback agrees with the spec's own conservative default, so a
          // failure and an abstention land on the same recorded answer.
          return interpretExecutionStrategy(
            outcome,
            metaFor(outcome, decision),
            "human",
          );
        },

        async route(input) {
          const spec = buildRoutingSpec({
            taskRiskLevel: input.taskRiskLevel,
            routes: input.routes,
            context: [
              ...baseContext(),
              `risk:${input.taskRiskLevel}`,
              `routes:${input.routes.length}`,
            ],
          });
          const { outcome, decision } = await evaluateSpec(spec);
          return interpretRoute(outcome, metaFor(outcome, decision));
        },

        async selectTool(input) {
          const spec = buildToolSelectionSpec({
            candidates: input.candidates,
            defaultToolId: input.defaultToolId,
            context: [
              ...baseContext(),
              ...input.candidates.map(
                (candidate) =>
                  `tool:${candidate.toolId}:${candidate.operation}`,
              ),
            ],
          });
          const { outcome, decision } = await evaluateSpec(spec);
          return interpretToolSelection(
            outcome,
            metaFor(outcome, decision),
            input.defaultToolId,
          );
        },

        async assessRisk(input) {
          const spec = buildRiskAssessmentSpec({
            operation: input.operation,
            baselineRisk: input.baselineRisk,
            context: [
              ...baseContext(),
              `operation:${input.operation}`,
              `baseline:${input.baselineRisk}`,
            ],
          });
          const { outcome, decision } = await evaluateSpec(spec);
          return interpretRiskAssessment(
            outcome,
            metaFor(outcome, decision),
            input.baselineRisk,
          );
        },

        async shouldRetry(input) {
          const spec = buildRetrySpec({
            failureKind: input.failureKind,
            retryable: input.retryable,
            attemptsSpent: input.attemptsSpent,
            maxRetries: deps.config.maxRetriesPerTask,
            retriesRemaining: input.retriesRemaining,
            context: [...baseContext(), `failure:${input.failureKind}`],
          });
          const { outcome, decision } = await evaluateSpec(spec);
          return interpretRetry(outcome, metaFor(outcome, decision));
        },

        async assessCompletion(input) {
          const spec = buildCompletionSpec({
            acceptanceCriteriaTotal: input.acceptanceCriteriaTotal,
            acceptanceCriteriaMet: input.acceptanceCriteriaMet,
            verificationChecks: input.verificationChecks,
            verificationFailures: input.verificationFailures,
            context: baseContext(),
          });
          const { outcome, decision } = await evaluateSpec(spec);
          return interpretCompletion(outcome, metaFor(outcome, decision));
        },

        async recommendEscalation(input) {
          const spec = buildEscalationSpec({
            facts: input.facts,
            securityRefusal: input.securityRefusal,
            context: baseContext(),
          });
          const { outcome, decision } = await evaluateSpec(spec);
          return interpretEscalation(outcome, metaFor(outcome, decision));
        },

        async rank(input) {
          // JEV's decision contract bounds a single question to
          // MAX_DECISION_OPTIONS options. A pool larger than that is narrowed
          // *mechanically* to the contract bound — the caller's deterministic
          // pre-order decides who makes the field — and the un-asked tail is
          // appended behind JEV's ranked subset, so the composed order stays a
          // permutation of the full pool. The provider still owns the order of
          // every candidate it was shown; nothing about ranking semantics
          // changes for pools within the contract.
          const field = input.candidates.slice(0, MAX_DECISION_OPTIONS);
          const tail = input.candidates.slice(MAX_DECISION_OPTIONS);
          const spec = buildRankingSpec({
            candidates: field.map((candidate) => ({
              id: candidate.id,
              label: candidate.label,
            })),
            context: baseContext(),
          });
          const { outcome, decision } = await evaluateSpec(spec);
          const interpreted = interpretRanking(
            outcome,
            metaFor(outcome, decision),
            field.map((candidate) => ({
              id: candidate.id,
              label: candidate.label,
            })),
          );
          return {
            ...interpreted,
            ranking: [...interpreted.ranking, ...tail.map((c) => c.id)],
          };
        },

        async assessRelevance(input) {
          const spec = buildRelevanceSpec({
            candidateRefs: input.candidateRefs,
            context: baseContext(),
          });
          const { outcome, decision } = await evaluateSpec(spec);
          return interpretRelevance(outcome, metaFor(outcome, decision));
        },
      };
    },
  };
}

/**
 * A decision answered by the deterministic gate with no provider configured is
 * still a decision. This helper exists so `ai decision` can describe the state
 * without guessing.
 */
export function describeDecisionLayer(
  info: DecisionEngineInfo,
  config: DecisionConfig,
): string {
  if (!info.configured) {
    return `disabled (${config.provider}); bounded questions are answered deterministically and recorded`;
  }
  return `"${info.providerId}" (${info.providerFamily ?? "unknown"}); up to ${config.maxDecisionsPerTask} consultation(s) per task`;
}
