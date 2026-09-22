import type { Clock } from "../core/clock.js";
import { durationMsFrom, toIsoString } from "../core/clock.js";
import { DomainError, hasDomainErrorCode } from "../core/errors.js";
import type { ProjectId, TaskId, WorkspaceId } from "../core/ids.js";
import type { AttemptDecisionCoordinator } from "../application/decision-coordinator.js";
import type { DecisionCoordinatorFactory } from "../application/decision-coordinator.js";
import type { ExecutionStrategyId } from "../decisions/domains.js";
import type { EventRecorder } from "../application/event-recorder.js";
import type { SessionService } from "../application/session-service.js";
import type { TaskService } from "../application/task-service.js";
import type { ModelRegistry } from "../models/registry.js";
import type { ModelRequirements } from "../models/model.js";
import { estimateCost, type ModelRate } from "../observability/cost.js";
import {
  evaluateBudget,
  type BudgetConsumption,
  type BudgetLevel,
} from "../observability/budget.js";

import { emptyUsage, type AIUsage } from "../observability/usage.js";
import type { DomainEvent } from "../observability/events.js";
import type { EventStore } from "../ports/event-store.js";
import type { FrontierExecutor } from "../ports/frontier.js";
import {
  LlmProviderError,
  isLlmProviderError,
  type LlmContentPresence,
  type LlmFailureKind,
  type LlmFinishReason,
} from "../ports/llm-provider.js";
import {
  extractRequirements,
  type ExtractRequirementsOptions,
  type TaskRequirements,
} from "./requirements.js";
import {
  buildPlanVariants,
  scoreCandidates,
  type IndependentSubTask,
  type PlanStep,
  type PlanVariant,
  type RoutingMode,
  type ScoredCandidate,
} from "./plan.js";
import type { Task } from "../tasks/task.js";
import type { Workspace } from "../workspaces/workspace.js";

/**
 * Orchestration: the use case where the decision layer, the model registry, the
 * context engine and Frontier meet.
 *
 * The order of the steps is the architecture (ADR-056):
 *
 * 1. **scope** — the task is loaded through the workspace-bound repository, so a task
 *    id from another project is `NOT_FOUND`, not a trace.
 * 2. **requirements** — deterministic, from the task contract.
 * 3. **filter** — the registry decides which models are *eligible*; rejected models
 *    are recorded with a reason code.
 * 4. **plan** — deterministic plan variants (single, decomposed, parallel).
 * 5. **decide** — the decision layer may *reorder* variants and candidates. Its answer
 *    is validated to be a permutation of what it was handed, so it cannot invent a
 *    model, resurrect a rejected one, or leave the scope.
 * 6. **execute** — Frontier runs the chosen steps, one bounded call each, recorded as
 *    `LLMRequestStarted`/`LLMRequestCompleted`/`LLMRequestFailed` through the session
 *    service, priced through the project rate table.
 * 7. **assess** — retry, completion and escalation questions go back to the decision
 *    layer; every answer is an *assessment*. Nothing here marks a task complete: the
 *    deterministic task state machine and the human remain authoritative (ADR-054).
 *
 * What this module deliberately does not do: reach the filesystem, run a process,
 * approve an operation, or judge whether an answer is correct. Operations that touch
 * the world go through the Phase F operation gateway; orchestration only spends model
 * calls, under a hard budget and a hard call cap.
 */

export const ORCHESTRATION_STRATEGY = "frontier-multi-model";
export const ORCHESTRATOR_AGENT_ID = "orchestrator";

export const ORCHESTRATION_STOP_REASONS = [
  "budget-exceeded",
  "call-bound-reached",
  "step-failed",
  "retry-exhausted",
  "escalation-recommended",
  /** The decision layer chose the human strategy before any call was made. */
  "strategy-human",
] as const;

export type OrchestrationStopReason =
  (typeof ORCHESTRATION_STOP_REASONS)[number];

/**
 * How much of one step's output is carried into the next step.
 *
 * Passing the whole thing forward would multiply the prompt cost of a multi-step plan
 * by its step count. The bound is explicit and applied in code rather than left to the
 * model to summarise, so token use stays predictable.
 */
export const MAX_INTERMEDIATE_CHARS = 4_000;

export interface OrchestrationConfig {
  readonly enabled: boolean;
  readonly mode: RoutingMode;
  readonly allowDecomposition: boolean;
  readonly allowParallel: boolean;
  readonly maxModelCalls: number;
  readonly maxRetriesPerStep: number;
}

export interface OrchestrationRequest {
  readonly workspaceId: WorkspaceId;
  readonly taskId: TaskId;
  readonly requirements?: ExtractRequirementsOptions;
  readonly subTasks?: readonly IndependentSubTask[];
  /** Consumption already recorded for this task, so the budget is a hard bound. */
  readonly priorConsumption?: BudgetConsumption;
  /** Selected context text, supplied by the caller. Never recorded. */
  readonly contextText?: string;
  readonly contextSelectionId?: string;
  readonly contextSelectionVersion?: number;
  readonly contextSelectedTokens?: number;
}

export type StepStatus = "completed" | "failed" | "skipped";

export interface OrchestrationStepReport {
  readonly stepId: string;
  readonly purpose: string;
  readonly status: StepStatus;
  readonly modelId: string;
  readonly providerId: string;
  /** Transport attempts spent, including the successful one. */
  readonly attempts: number;
  /** Retries spent on this step: 0 for a first try. */
  readonly retry: number;
  readonly latencyMs: number;
  readonly usage?: AIUsage;
  readonly usageReported: boolean;
  readonly costMicros?: number;
  readonly finishReason?: LlmFinishReason;
  readonly failureKind?: LlmFailureKind;
  /** Size of the output, never the output. */
  readonly contentChars?: number;
  /** Why this model was chosen, from the decision layer's own record. */
  readonly selectionReasonCode?: string;
  readonly rankedCandidates?: readonly string[];
  readonly answeredBy?: string;
}

export interface OrchestrationResult {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: string;
  readonly strategy: string;
  readonly planId: string;
  readonly planReasonCode: string;
  readonly variantReasonCode?: string;
  readonly variantAnsweredBy?: string;
  readonly variantsOffered: readonly string[];
  readonly parallel: boolean;
  readonly requirements: TaskRequirements;
  /**
   * The brain's first answer: deterministic, model, or human.
   *
   * Recorded on the result as well as in the decision log, because the question "did
   * this task need a model at all?" is the first thing an efficiency review asks, and
   * answering it from the recorded answer is more honest than inferring it from
   * whether calls happen to have been made.
   */
  readonly executionStrategy: ExecutionStrategyId;
  readonly executionStrategyReason?: string;
  readonly executionStrategyAnsweredBy?: string;
  readonly eligibleModelIds: readonly string[];
  readonly rejectedModels: readonly {
    readonly modelId: string;
    readonly reasonCode: string;
    readonly missing: readonly string[];
  }[];
  readonly steps: readonly OrchestrationStepReport[];
  readonly usage: AIUsage;
  readonly costMicros?: number;
  readonly unpricedCalls: number;
  readonly callsSpent: number;
  readonly retriesSpent: number;
  readonly durationMs: number;
  readonly budgetLevel: BudgetLevel;
  readonly stopReason?: OrchestrationStopReason;
  readonly completionAssessment: string;
  readonly escalationRecommendation: string;
  readonly needsHumanReview: boolean;
}

export interface OrchestratorDeps {
  readonly registry: ModelRegistry;
  readonly rates: readonly ModelRate[];
  readonly frontier: FrontierExecutor;
  readonly sessions: SessionService;
  readonly tasks: TaskService;
  readonly recorder: EventRecorder;
  readonly store: EventStore;
  readonly decisions: DecisionCoordinatorFactory;
  readonly clock: Clock;
  readonly projectId: ProjectId;
  readonly workspace: Workspace;
  readonly config: OrchestrationConfig;
}

export interface Orchestrator {
  readonly strategy: string;
  readonly config: OrchestrationConfig;
  run(request: OrchestrationRequest): Promise<OrchestrationResult>;
}

const ORCHESTRATOR_ACTOR = {
  type: "agent",
  id: ORCHESTRATOR_AGENT_ID,
} as const;

/** A failure category for anything the LLM port did not categorise itself. */
function failureKindOf(error: unknown): LlmFailureKind {
  if (isLlmProviderError(error)) {
    return error.failureKind;
  }
  if (hasDomainErrorCode(error, "FORBIDDEN")) {
    // A policy refusal is a refusal, and it is never retryable: repeating it would
    // ask the same boundary the same question.
    return "refused";
  }
  if (
    hasDomainErrorCode(error, "NOT_FOUND") ||
    hasDomainErrorCode(error, "VALIDATION")
  ) {
    // A misconfigured plan is not a transient provider problem.
    return "malformed-response";
  }
  return "unknown";
}

function isSecurityRefusal(error: unknown): boolean {
  return hasDomainErrorCode(error, "FORBIDDEN");
}

/**
 * Forwards the provider's own account of what a 2xx body carried, when it gave
 * one: the adapter's structural classification, never any of the text itself.
 */
function contentPresenceOf(error: unknown): LlmContentPresence | undefined {
  return isLlmProviderError(error) ? error.contentPresence : undefined;
}

function isRetryable(kind: LlmFailureKind): boolean {
  return (
    kind === "rate-limit" ||
    kind === "timeout" ||
    kind === "network" ||
    kind === "server"
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  /**
   * Ranks the eligible models for a requirement set, deterministically first.
   *
   * The decision layer is consulted later, over this bounded list — never before it,
   * because "who is eligible" is not a judgement call (ADR-056).
   */
  function rankFor(
    requirements: ModelRequirements,
  ): readonly ScoredCandidate[] {
    const report = deps.registry.eligible(requirements);
    return scoreCandidates({
      requirements,
      models: report.eligible,
      rates: deps.rates,
      mode: deps.config.mode,
    });
  }

  return {
    strategy: ORCHESTRATION_STRATEGY,
    config: deps.config,

    async run(request) {
      if (!deps.config.enabled) {
        throw new DomainError(
          "CONFLICT",
          "frontier orchestration is not enabled for this project; set frontier.enabled in .ai/project.json to opt in",
          { field: "frontier.enabled" },
        );
      }

      const scope = {
        projectId: deps.projectId,
        workspaceId: request.workspaceId,
      };
      // Scope is enforced by the repository, not by this use case: a task id from
      // another workspace is simply not found here (Phase E isolation).
      const loaded = await deps.tasks.load(scope, request.taskId);
      const loadedStatus = loaded.task.status;
      if (
        loadedStatus === "completed" ||
        loadedStatus === "failed" ||
        loadedStatus === "cancelled"
      ) {
        throw new DomainError(
          "CONFLICT",
          `task "${String(request.taskId)}" is ${loadedStatus} and cannot be orchestrated`,
          { field: "taskId" },
        );
      }
      const task: Task =
        loadedStatus === "created" || loadedStatus === "planning"
          ? (await deps.tasks.start(loaded)).task
          : loaded.task;

      const startedAt = toIsoString(deps.clock.now());
      const requirements = extractRequirements(
        task,
        request.requirements ?? {},
      );
      const report = deps.registry.eligible(requirements.modelRequirements);
      const coordinator: AttemptDecisionCoordinator = deps.decisions.forAttempt(
        {
          workspaceId: task.workspaceId,
          taskId: task.id,
        },
      );
      const session = await deps.sessions.start(task, {
        agentId: ORCHESTRATOR_AGENT_ID,
      });

      // The plan event's `eventSequence` is the number of events already recorded for
      // this task, so a checkpoint points at a real position in the log.
      const existing: readonly DomainEvent[] = await deps.store.readByTask(
        scope,
        task.id,
      );
      let eventsRecorded = existing.length;
      const taskCorrelation = `task:${String(deps.projectId)}:${String(task.workspaceId)}:${String(task.id)}`;

      const variants = buildPlanVariants({
        taskId: String(task.id),
        taskTitle: task.title,
        requirements,
        mode: deps.config.mode,
        allowDecomposition: deps.config.allowDecomposition,
        allowParallel: deps.config.allowParallel,
        maxSteps: deps.config.maxModelCalls,
        rankFor,
        ...(request.subTasks === undefined
          ? {}
          : { subTasks: request.subTasks }),
      });

      /**
       * The brain's first question, and the one that decides whether anything below
       * happens at all: deterministic, model, or human.
       *
       * It is asked after the variants are built (pure, deterministic, spends nothing)
       * and before one is chosen, because the answer can make the choice moot: the
       * `human` strategy performs no model call, so it must not reserve a call, select
       * a variant or spend a context selection.
       *
       * The eligible count is the models reachable by *some viable plan variant*, not
       * the models that satisfy the whole requirement set on their own. The difference
       * is real and was a bug: a task needing `vision` + `coding` has an empty
       * single-model pool but a perfectly good decomposed plan, and asking the brain
       * "is anything eligible?" against the single-model pool would have had it hand
       * runnable work to a human. A plan that exists is the eligibility that matters.
       */
      const strategizeCandidates = new Set(
        variants.flatMap((variant) =>
          variant.steps.flatMap((step) => step.candidateIds),
        ),
      ).size;
      const executionStrategy = await coordinator.strategize({
        modelRequired: requirements.modelRequired,
        eligibleCandidates: strategizeCandidates,
        riskLevel: requirements.risk,
        requiredCapabilities: [
          ...requirements.modelRequirements.requiredCapabilities,
        ],
      });

      if (executionStrategy.strategy === "human") {
        // Nothing is attempted: no step, no model call, no consumption. The task lands
        // in the human gate that already exists (ADR-054) carrying the brain's own
        // reason, so "we did not spend here" is a recorded decision rather than an
        // absence of activity.
        const escalation = await coordinator.recommendEscalation({
          facts: [
            `execution-strategy:${executionStrategy.strategy}`,
            `risk:${requirements.risk}`,
            `model-required:${requirements.modelRequired}`,
            `eligible-models:${report.eligible.length}`,
            ...(executionStrategy.reasonCode === undefined
              ? []
              : [`strategy-reason:${executionStrategy.reasonCode}`]),
          ],
          securityRefusal: false,
        });
        const reason =
          "the decision layer chose the human strategy for this task before any " +
          "model call: nothing was attempted";
        const ended = await deps.sessions.end(session, "aborted", reason);
        eventsRecorded += 1;
        const handoffBudget = evaluateBudget(task.budget, {
          tokens: 0,
          costMicros: 0,
          iterations: 0,
          retries: 0,
        });
        return {
          taskId: task.id,
          workspaceId: task.workspaceId,
          sessionId: String(ended.id),
          strategy: ORCHESTRATION_STRATEGY,
          planId: "plan:none",
          planReasonCode:
            strategizeCandidates === 0 && requirements.modelRequired
              ? "no-eligible-model"
              : "strategy-human",
          variantsOffered: variants.map((variant) => variant.planId),
          parallel: false,
          requirements,
          executionStrategy: executionStrategy.strategy,
          ...(executionStrategy.reasonCode === undefined
            ? {}
            : { executionStrategyReason: executionStrategy.reasonCode }),
          executionStrategyAnsweredBy: executionStrategy.meta.answeredBy,
          eligibleModelIds: report.eligible.map((model) => model.modelId),
          rejectedModels: report.rejected,
          steps: [],
          usage: emptyUsage(),
          unpricedCalls: 0,
          callsSpent: 0,
          retriesSpent: 0,
          durationMs: durationMsFrom(startedAt, toIsoString(deps.clock.now())),
          budgetLevel: handoffBudget.level,
          stopReason: "strategy-human",
          completionAssessment: "incomplete",
          escalationRecommendation: escalation.recommendation,
          needsHumanReview: true,
        };
      }

      // Choosing between plan variants is a bounded judgement, so the decision layer
      // may make it. Its answer is re-checked against the offered ids regardless.
      let chosen = variants[0];
      let variantReasonCode: string | undefined;
      let variantAnsweredBy: string | undefined;
      if (variants.length > 1) {
        const ranking = await coordinator.rank({
          candidates: variants.map((variant) => ({
            id: variant.planId,
            label: describeVariant(variant),
          })),
        });
        variantReasonCode = ranking.reasonCode;
        variantAnsweredBy = ranking.meta.answeredBy;
        chosen =
          variants.find((variant) => variant.planId === ranking.ranking[0]) ??
          chosen;
      }

      const stepReports: OrchestrationStepReport[] = [];
      let usageTotal: AIUsage = emptyUsage();
      let costMicros = 0;
      let pricedCalls = 0;
      let unpricedCalls = 0;
      let retriesSpent = 0;
      let stopped: OrchestrationStopReason | undefined;
      let securityRefusal = false;
      // Mutable by necessity: consumption grows as steps run and is what the
      // *hard* budget check reads before every call.
      const accumulated = {
        tokens: request.priorConsumption?.tokens ?? 0,
        costMicros: request.priorConsumption?.costMicros ?? 0,
        iterations: request.priorConsumption?.iterations ?? 0,
        retries: request.priorConsumption?.retries ?? 0,
      };

      // The plan is recorded before any call, so a run that dies mid-step still
      // explains what it intended to do.
      await deps.recorder.emit({
        type: "OrchestrationPlanned",
        workspaceId: task.workspaceId,
        actor: ORCHESTRATOR_ACTOR,
        taskId: task.id,
        sessionId: session.id,
        correlationId: taskCorrelation,
        payload: {
          planId: chosen.planId,
          strategy: chosen.strategy,
          reasonCode: chosen.reasonCode,
          stepCount: chosen.steps.length,
          // The model each step *would* use by deterministic ranking. Which one
          // actually ran is recorded per call, in `LLMRequestCompleted`.
          modelIds: plannedModels(chosen, rankFor),
          providerIds: [
            ...new Set(
              plannedModels(chosen, rankFor).map(
                (modelId) =>
                  deps.registry.get(modelId)?.providerId ?? "unknown",
              ),
            ),
          ].sort(),
          parallel: chosen.parallel,
          decomposed: chosen.strategy !== "single-model",
          routingMode: deps.config.mode,
          riskLevel: requirements.risk,
          maxModelCalls: chosen.estimate.maxModelCalls,
          candidateModelIds: report.eligible.map((model) => model.modelId),
          rejectedModelIds: report.rejected.map((entry) => entry.modelId),
          priced: chosen.estimate.priced,
          unpricedSteps: chosen.estimate.unpricedSteps,
          ...(chosen.estimate.estimatedReferenceCostMicros === undefined
            ? {}
            : {
                estimatedReferenceCostMicros:
                  chosen.estimate.estimatedReferenceCostMicros,
              }),
          ...(request.contextSelectionId === undefined
            ? {}
            : { contextSelectionId: request.contextSelectionId }),
          ...(variantReasonCode === undefined
            ? {}
            : { selectionReasonCode: variantReasonCode }),
        },
      });
      eventsRecorded += 1;

      const outputs = new Map<string, string>();

      async function executeStep(
        step: PlanStep,
      ): Promise<OrchestrationStepReport> {
        // Deterministic candidates first; the decision layer may reorder them.
        const deterministic = rankFor(step.requirements);
        if (deterministic.length === 0) {
          return {
            stepId: step.stepId,
            purpose: step.purpose,
            status: "failed",
            modelId: "",
            providerId: "",
            attempts: 0,
            retry: 0,
            latencyMs: 0,
            usageReported: false,
            failureKind: "malformed-response",
          };
        }
        const candidates = deterministic.filter((candidate) =>
          step.candidateIds.includes(candidate.model.modelId),
        );
        const pool = candidates.length > 0 ? candidates : deterministic;
        const ranking = await coordinator.rank({
          candidates: pool.map((candidate) => ({
            id: candidate.model.modelId,
            label: `${candidate.model.displayName} (${candidate.model.providerId})`,
          })),
        });
        const offered = pool.map((candidate) => candidate.model.modelId);
        let order = ranking.ranking.filter((id) => offered.includes(id));
        if (order.length !== offered.length) {
          // Belt and braces: a decision may never add or drop a candidate. The
          // engine already rejects unknown ids; this keeps the *ordering* a
          // permutation of the offered set even if one is ever missed.
          order = offered;
        }

        const dependsOnOutput = step.dependsOn
          .map((dependency) => outputs.get(dependency))
          .filter((value): value is string => value !== undefined)
          .join("\n\n");
        const contextText =
          dependsOnOutput.length > 0
            ? truncate(dependsOnOutput, MAX_INTERMEDIATE_CHARS)
            : request.contextText;

        let attempts = 0;
        let lastFailureKind: LlmFailureKind | undefined;
        for (;;) {
          const state = evaluateBudget(task.budget, accumulated);
          if (state.exceeded) {
            stopped = "budget-exceeded";
            await recordCheckpoint("budget-critical");
            return {
              stepId: step.stepId,
              purpose: step.purpose,
              status: "skipped",
              modelId: "",
              providerId: "",
              attempts,
              retry: attempts,
              latencyMs: 0,
              usageReported: false,
              ...(lastFailureKind === undefined
                ? {}
                : { failureKind: lastFailureKind }),
            };
          }
          const modelId = order[0] as string;
          const model = deps.registry.get(modelId);
          if (model === undefined) {
            throw new DomainError(
              "INVARIANT",
              `selected model "${modelId}" is not in the registry`,
              { field: "modelId" },
            );
          }
          const callStartedAt = toIsoString(deps.clock.now());
          try {
            const result = await deps.frontier.executeStep({
              stepId: step.stepId,
              providerId: model.providerId,
              modelId: model.modelId,
              instruction: step.instruction,
              ...(contextText === undefined ? {} : { contextText }),
              correlationId: taskCorrelation,
            });
            // A successful HTTP call is not a usable answer. An empty or
            // whitespace-only completion is classified as a failure here, on the
            // shared failure path, so it reaches the retry and completion decisions as
            // *evidence that nothing was produced* — never as a step that quietly
            // verified itself. The classification is deliberate: the transport did its
            // job, so this is not a network failure, and it is not retryable, because
            // asking the same model the same question again is not a plan.
            if (result.content.trim().length === 0) {
              throw new LlmProviderError(
                {
                  failureKind: "malformed-response",
                  providerId: result.providerId,
                  modelId: result.modelId,
                  attempts: result.attempts ?? 1,
                  retryable: false,
                },
                `provider "${result.providerId}" returned no usable text for model ` +
                  `"${result.modelId}": malformed-response`,
              );
            }
            const callUsage = result.usage;
            const cost =
              callUsage === undefined
                ? undefined
                : estimateCost({
                    usage: callUsage,
                    providerId: result.providerId,
                    modelId: result.modelId,
                    rates: deps.rates,
                  });
            const measured = durationMsFrom(
              callStartedAt,
              toIsoString(deps.clock.now()),
            );
            await deps.sessions.recordLlmCall(session, {
              providerId: result.providerId,
              modelId: result.modelId,
              messageCount: 2,
              usage: callUsage ?? emptyUsage(),
              usageReported: result.usageReported,
              latencyMs: result.latencyMs > 0 ? result.latencyMs : measured,
              retry: attempts,
              escalated: false,
              ...(result.attempts === undefined
                ? {}
                : { attempts: result.attempts }),
              ...(result.requestId === undefined
                ? {}
                : { requestId: result.requestId }),
              ...(request.contextSelectionId === undefined
                ? {}
                : { contextSelectionId: request.contextSelectionId }),
              ...(request.contextSelectionVersion === undefined
                ? {}
                : { contextSelectionVersion: request.contextSelectionVersion }),
              ...(request.contextSelectedTokens === undefined
                ? {}
                : { contextSelectedTokens: request.contextSelectedTokens }),
            });
            eventsRecorded += 2;
            const tokens = callUsage
              ? callUsage.inputTokens +
                callUsage.outputTokens +
                callUsage.cachedInputTokens
              : 0;
            usageTotal = addTo(usageTotal, callUsage);
            accumulated.tokens += tokens;
            accumulated.iterations += 1;
            if (cost === undefined) {
              unpricedCalls += 1;
            } else {
              pricedCalls += 1;
              costMicros += cost.micros;
              accumulated.costMicros += cost.micros;
            }
            outputs.set(step.stepId, result.content);
            deps.registry.noteHealth(model.modelId, "available");
            return {
              stepId: step.stepId,
              purpose: step.purpose,
              status: "completed",
              modelId: result.modelId,
              providerId: result.providerId,
              attempts: result.attempts ?? 1,
              retry: attempts,
              latencyMs: result.latencyMs,
              ...(callUsage === undefined ? {} : { usage: callUsage }),
              usageReported: result.usageReported,
              ...(cost === undefined ? {} : { costMicros: cost.micros }),
              finishReason: result.finishReason,
              contentChars: result.content.length,
              ...(ranking.reasonCode === undefined
                ? {}
                : { selectionReasonCode: ranking.reasonCode }),
              rankedCandidates: order,
              answeredBy: ranking.meta.answeredBy,
            };
          } catch (error) {
            const failureKind = failureKindOf(error);
            lastFailureKind = failureKind;
            const refusal = isSecurityRefusal(error);
            securityRefusal = securityRefusal || refusal;
            const retryable = isRetryable(failureKind);
            await deps.sessions.recordLlmFailure(session, {
              providerId: model.providerId,
              modelId: model.modelId,
              messageCount: 2,
              failureKind,
              attempts: attempts + 1,
              retryable,
              ...(isLlmProviderError(error) && error.statusCode !== undefined
                ? { statusCode: error.statusCode }
                : {}),
              ...(contentPresenceOf(error) === undefined
                ? {}
                : { contentPresence: contentPresenceOf(error) }),
              ...(request.contextSelectionId === undefined
                ? {}
                : { contextSelectionId: request.contextSelectionId }),
              ...(request.contextSelectionVersion === undefined
                ? {}
                : { contextSelectionVersion: request.contextSelectionVersion }),
              ...(request.contextSelectedTokens === undefined
                ? {}
                : { contextSelectedTokens: request.contextSelectedTokens }),
            });
            eventsRecorded += 2;
            deps.registry.noteHealth(model.modelId, healthAfter(failureKind));

            // `attemptsSpent` counts *retries* already spent, which is the meaning
            // the retry domain's own gate reads it with: the first failure of a step
            // has spent none. Two independent caps then bound the answer, and both
            // are hard: the frontier's own per-step cap, and the decision layer's
            // per-task cap inside the coordinator (ADR-056).
            const retriesRemaining = Math.max(
              0,
              deps.config.maxRetriesPerStep - attempts,
            );
            const decision = await coordinator.shouldRetry({
              failureKind,
              retryable,
              attemptsSpent: attempts,
              retriesRemaining,
            });
            if (decision.action !== "retry" || retriesRemaining === 0) {
              if (decision.action === "escalate") {
                stopped = "escalation-recommended";
              } else if (retriesRemaining === 0 && retryable) {
                stopped = "retry-exhausted";
              } else {
                stopped = "step-failed";
              }
              return {
                stepId: step.stepId,
                purpose: step.purpose,
                status: "failed",
                modelId: model.modelId,
                providerId: model.providerId,
                attempts: attempts + 1,
                retry: attempts,
                latencyMs: 0,
                usageReported: false,
                failureKind,
                ...(ranking.reasonCode === undefined
                  ? {}
                  : { selectionReasonCode: ranking.reasonCode }),
                rankedCandidates: order,
                answeredBy: ranking.meta.answeredBy,
              };
            }

            // Retrying with the next eligible model when one exists is a *switch*,
            // not a wider search: the candidate set was fixed before the call, and
            // the retry decision above is what permitted another attempt.
            attempts += 1;
            retriesSpent += 1;
            accumulated.retries += 1;
            if (order.length > 1) {
              order = [...order.slice(1), order[0] as string];
            }
          }
        }
      }

      async function recordCheckpoint(
        reason: "budget-critical" | "iteration-limit",
      ): Promise<void> {
        await deps.recorder.emit({
          type: "CheckpointCreated",
          workspaceId: task.workspaceId,
          actor: ORCHESTRATOR_ACTOR,
          taskId: task.id,
          sessionId: session.id,
          correlationId: taskCorrelation,
          payload: {
            checkpointId: `${chosen.planId}:${reason}`,
            reason,
            eventSequence: eventsRecorded,
          },
        });
        eventsRecorded += 1;
      }

      const callsCap = deps.config.maxModelCalls;

      if (chosen.steps.length > 0) {
        const ordered = [...chosen.steps].sort((a, b) =>
          a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0,
        );
        if (chosen.parallel) {
          const settled = await Promise.all(
            ordered.map((step) => executeStep(step)),
          );
          stepReports.push(...settled);
        } else {
          for (const step of ordered) {
            if (stopped !== undefined) {
              stepReports.push({
                stepId: step.stepId,
                purpose: step.purpose,
                status: "skipped",
                modelId: "",
                providerId: "",
                attempts: 0,
                retry: 0,
                latencyMs: 0,
                usageReported: false,
              });
              continue;
            }
            const report = await executeStep(step);
            stepReports.push(report);
            if (report.status === "failed" && stopped === undefined) {
              stopped = "step-failed";
            }
            if (stepReports.length >= callsCap) {
              break;
            }
          }
        }
      }

      const completedSteps = stepReports.filter(
        (step) => step.status === "completed",
      ).length;
      const failedSteps = stepReports.filter(
        (step) => step.status === "failed",
      ).length;

      const completion = await coordinator.assessCompletion({
        acceptanceCriteriaTotal: task.acceptanceCriteria.length,
        verificationChecks: completedSteps,
        verificationFailures: failedSteps,
      });

      const budgetState = evaluateBudget(task.budget, accumulated);
      const escalation = await coordinator.recommendEscalation({
        securityRefusal,
        facts: [
          `steps-completed:${completedSteps}`,
          `steps-failed:${failedSteps}`,
          `completion:${completion.assessment}`,
          `budget:${budgetState.level}`,
          `unpriced-calls:${unpricedCalls}`,
          ...(stopped === undefined ? [] : [`stop:${stopped}`]),
        ],
      });

      const needsHumanReview =
        escalation.recommendation === "review" ||
        securityRefusal ||
        failedSteps > 0;

      await deps.sessions.end(
        session,
        failedSteps > 0 ? "failed" : "completed",
        failedSteps > 0
          ? "orchestration completed with failed steps"
          : undefined,
      );
      eventsRecorded += 1;

      const durationMs = durationMsFrom(
        startedAt,
        toIsoString(deps.clock.now()),
      );

      return {
        taskId: task.id,
        workspaceId: task.workspaceId,
        sessionId: String(session.id),
        strategy: ORCHESTRATION_STRATEGY,
        planId: chosen.planId,
        planReasonCode: chosen.reasonCode,
        ...(variantReasonCode === undefined ? {} : { variantReasonCode }),
        ...(variantAnsweredBy === undefined ? {} : { variantAnsweredBy }),
        variantsOffered: variants.map((variant) => variant.planId),
        parallel: chosen.parallel,
        requirements,
        executionStrategy: executionStrategy.strategy,
        ...(executionStrategy.reasonCode === undefined
          ? {}
          : { executionStrategyReason: executionStrategy.reasonCode }),
        executionStrategyAnsweredBy: executionStrategy.meta.answeredBy,
        eligibleModelIds: report.eligible.map((model) => model.modelId),
        rejectedModels: report.rejected,
        steps: stepReports,
        usage: usageTotal,
        ...(pricedCalls === 0 ? {} : { costMicros }),
        unpricedCalls,
        callsSpent: completedSteps + failedSteps,
        retriesSpent,
        durationMs,
        budgetLevel: budgetState.level,
        ...(stopped === undefined ? {} : { stopReason: stopped }),
        completionAssessment: completion.assessment,
        escalationRecommendation: escalation.recommendation,
        needsHumanReview,
      };
    },
  };
}

/** Usage accumulation that treats a missing report as a missing report. */
function addTo(current: AIUsage, next: AIUsage | undefined): AIUsage {
  if (next === undefined) {
    return current;
  }
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    cachedInputTokens: current.cachedInputTokens + next.cachedInputTokens,
    ...(current.reasoningTokens === undefined &&
    next.reasoningTokens === undefined
      ? {}
      : {
          reasoningTokens:
            (current.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
        }),
  };
}

/**
 * Health after a failure.
 *
 * Transient transport problems mark a model *degraded* rather than unavailable, so a
 * single timeout cannot permanently remove a model from routing; an authentication or
 * refusal failure marks it unavailable, because repeating it would repeat the same
 * refusal (ADR-056).
 */
function healthAfter(kind: LlmFailureKind): "degraded" | "unavailable" {
  return kind === "auth" || kind === "refused"
    ? "unavailable"
    : kind === "malformed-response"
      ? "degraded"
      : "degraded";
}

/** The deterministically preferred model for each step of a plan. */
function plannedModels(
  variant: PlanVariant,
  rankFor: (requirements: ModelRequirements) => readonly ScoredCandidate[],
): readonly string[] {
  return variant.steps
    .map((step) => rankFor(step.requirements)[0]?.model.modelId)
    .filter((modelId): modelId is string => modelId !== undefined);
}

function describeVariant(variant: PlanVariant): string {
  const steps = variant.steps
    .map(
      (step) =>
        `${step.purpose}[${step.requirements.requiredCapabilities.join("+")}]`,
    )
    .join(" -> ");
  return `${variant.strategy} (${variant.reasonCode}): ${steps || "no model calls"}`;
}
