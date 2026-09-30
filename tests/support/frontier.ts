import type { FrontierConfig } from "../../src/adapters/config/project-config.js";
import type { ModelProfile } from "../../src/models/model.js";
import type { ModelRate } from "../../src/observability/cost.js";
import type { AIUsage } from "../../src/observability/usage.js";
import {
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "../../src/ports/llm-provider.js";
import type {
  FrontierExecutor,
  FrontierStepRequest,
  FrontierStepResult,
} from "../../src/ports/frontier.js";

/**
 * Offline fixtures for the multi-model layer.
 *
 * Frontier is a port, so a scripted executor is enough to test planning, candidate
 * filtering, decision-layer interaction, retries, budget stops and accounting for
 * real — with no network, no credential and no wall-clock dependence.
 *
 * The provider fake advertises *several* models, because "one adapter serves many
 * models" is precisely the property a multi-model path depends on.
 */

export function frontierModel(
  overrides: Partial<ModelProfile> & {
    readonly modelId: string;
    readonly providerId: string;
  },
): ModelProfile {
  return {
    displayName: overrides.modelId,
    capabilities: ["general"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolCalling: false,
    structuredOutput: false,
    latencyClass: "standard",
    priority: 0,
    enabled: true,
    userOwned: false,
    health: "unknown",
    ...overrides,
  };
}

/** A catalog with a text model, a vision model and a coding model. */
export const TEXT_MODEL = frontierModel({
  modelId: "vendor/text-fast:free",
  providerId: "openrouter",
  displayName: "Text Fast",
  capabilities: ["general", "reasoning", "coding"],
  latencyClass: "fast",
  priority: 10,
});

export const VISION_MODEL = frontierModel({
  modelId: "vendor/vision-flash:free",
  providerId: "openrouter",
  displayName: "Vision Flash",
  capabilities: ["vision", "reasoning"],
  inputModalities: ["text", "image"],
  latencyClass: "fast",
  priority: 5,
});

export const SLOW_STRONG_MODEL = frontierModel({
  modelId: "vendor/strong-slow",
  providerId: "openrouter",
  displayName: "Strong Slow",
  capabilities: ["general", "reasoning", "coding", "architecture"],
  latencyClass: "slow",
  priority: 50,
});

export const ANY_PROVIDER = frontierModel({
  modelId: "other/provider-model",
  providerId: "other",
  displayName: "Other Provider Model",
  capabilities: ["general", "reasoning", "coding"],
});

export function frontierConfig(
  overrides: Partial<FrontierConfig> = {},
): FrontierConfig {
  const models = overrides.models ?? [TEXT_MODEL, VISION_MODEL];
  const providers =
    overrides.providers ??
    [...new Set(models.map((model) => model.providerId))].map((id) => ({
      id,
      kind: "openai-compatible" as const,
      baseUrl: `https://${id}.invalid/v1`,
      credentialEnvVar: "FIXTURE_API_KEY",
    }));
  return {
    enabled: true,
    providers,
    models,
    routing: {
      mode: "balanced",
      allowDecomposition: true,
      allowParallel: true,
      maxModelCalls: 4,
      maxRetriesPerStep: 1,
      ...(overrides.routing ?? {}),
    },
    ...(overrides.enabled === undefined ? {} : { enabled: overrides.enabled }),
  };
}

/** A rate table that prices exactly the models it is given. */
export function ratesFor(
  models: readonly ModelProfile[],
  micros: { readonly input: number; readonly output: number } = {
    input: 1_000,
    output: 2_000,
  },
): readonly ModelRate[] {
  return models.map((model) => ({
    providerId: model.providerId,
    modelId: model.modelId,
    currency: "USD" as const,
    inputMicrosPerMillionTokens: micros.input,
    outputMicrosPerMillionTokens: micros.output,
    cachedInputMicrosPerMillionTokens: micros.input,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
  }));
}

export interface ScriptedFrontierStep {
  readonly content?: string;
  readonly usage?: AIUsage;
  readonly omitUsage?: boolean;
  readonly latencyMs?: number;
  readonly attempts?: number;
  readonly requestId?: string;
  /** Any error a real executor could throw, including a policy refusal. */
  readonly error?: Error;
}

export interface ScriptedFrontier extends FrontierExecutor {
  readonly requests: readonly FrontierStepRequest[];
  readonly calls: number;
}

/** Replays scripted steps in order and records every step request it received. */
export function createScriptedFrontier(
  steps: readonly ScriptedFrontierStep[],
  options: {
    readonly models?: readonly string[];
    readonly providers?: readonly string[];
  } = {},
): ScriptedFrontier {
  const requests: FrontierStepRequest[] = [];
  let index = 0;
  return {
    id: "scripted-frontier",
    requests,
    get calls(): number {
      return requests.length;
    },
    providers: () => options.providers ?? ["openrouter"],
    models: () => options.models ?? [],
    async executeStep(request): Promise<FrontierStepResult> {
      requests.push(request);
      const step = steps[index];
      index += 1;
      if (step === undefined) {
        throw new Error(
          `scripted frontier received step #${index} with no scripted result`,
        );
      }
      if (step.error !== undefined) {
        throw step.error;
      }
      return {
        stepId: request.stepId,
        providerId: request.providerId,
        modelId: request.modelId,
        content: step.content ?? `completed ${request.stepId}`,
        finishReason: "stop",
        ...(step.usage === undefined || step.omitUsage === true
          ? {}
          : { usage: step.usage }),
        usageReported: step.usage !== undefined && step.omitUsage !== true,
        latencyMs: step.latencyMs ?? 25,
        ...(step.attempts === undefined ? {} : { attempts: step.attempts }),
        ...(step.requestId === undefined ? {} : { requestId: step.requestId }),
      };
    },
  };
}

/** A provider fake whose one adapter serves several models. */
export interface MultiModelProvider extends LlmProvider {
  readonly requests: readonly LlmRequest[];
}

export function createMultiModelProvider(input: {
  readonly id: string;
  readonly modelIds: readonly string[];
  readonly content?: string;
  readonly usage?: AIUsage;
}): MultiModelProvider {
  const requests: LlmRequest[] = [];
  return {
    id: input.id,
    models: [...input.modelIds],
    requests,
    async complete(request: LlmRequest): Promise<LlmResponse> {
      requests.push(request);
      return {
        providerId: input.id,
        modelId: request.modelId,
        content: input.content ?? "provider completion",
        finishReason: "stop",
        ...(input.usage === undefined ? {} : { usage: input.usage }),
        latencyMs: 12,
      };
    },
  };
}

export const FIXTURE_USAGE: AIUsage = {
  inputTokens: 1_000,
  outputTokens: 500,
  cachedInputTokens: 0,
};
