import type { AIUsage } from "../observability/usage.js";
import type { LlmFinishReason } from "./llm-provider.js";

/**
 * Frontier: the execution layer.
 *
 * Frontier *executes a step* — one model, one instruction, bounded context — and
 * reports what happened. It does not choose the model, decide whether to decompose a
 * task, retry a failure or judge a result: those are decisions, and decisions belong
 * to the decision layer. This port exists so that the boundary is structural rather
 * than a convention: an executor has no way to express "try a different model",
 * because a different model is a different request.
 *
 * The port is provider-agnostic on purpose. `FrontierStepRequest` names a
 * `providerId` and a `modelId`; nothing here knows what OpenRouter is, and adding a
 * provider is an adapter-level change (ADR-056).
 */
export interface FrontierStepRequest {
  readonly stepId: string;
  readonly providerId: string;
  readonly modelId: string;
  /** What to do. Code-owned text, never repository content promoted to policy. */
  readonly instruction: string;
  /**
   * Selected context, already bounded by the context engine.
   *
   * Passed through to the model and **never recorded**: the trace keeps references
   * (selection id, refs, token counts), not content (ADR-039, ADR-056).
   */
  readonly contextText?: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /** Correlates the call with the task/session that caused it. */
  readonly correlationId: string;
}

export interface FrontierStepResult {
  readonly stepId: string;
  readonly providerId: string;
  /**
   * The model that was **requested**, by the id the registry and configuration know.
   *
   * Deliberately not the name the provider reports back. A gateway may normalise an id
   * in its response, and downstream identity-keyed work — cost rates, event records,
   * traces — must key on what this platform asked for, or a normalised reply would make
   * a priced model look unpriced and a trace unsearchable. Use `reportedModelId` for the
   * provider's own name.
   */
  readonly modelId: string;
  /** The provider's own name for the model, when it differs from what was requested. */
  readonly reportedModelId?: string;
  readonly content: string;
  readonly finishReason: LlmFinishReason;
  /**
   * Absent when the provider reported no usage. Callers record the absence rather
   * than substituting zeroes: unpriced is not free (ADR-035).
   */
  readonly usage?: AIUsage;
  readonly usageReported: boolean;
  readonly latencyMs: number;
  readonly attempts?: number;
  readonly requestId?: string;
}

export interface FrontierExecutor {
  readonly id: string;
  /** Provider ids this executor can actually reach. */
  providers(): readonly string[];
  /** Model ids it can actually execute, given the registry and its providers. */
  models(): readonly string[];
  executeStep(request: FrontierStepRequest): Promise<FrontierStepResult>;
}
