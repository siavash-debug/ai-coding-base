import { DomainError } from "../core/errors.js";
import {
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertNoSecretLikeValue,
  assertOneOf,
  assertStringArray,
} from "../core/validation.js";

/**
 * The model registry's vocabulary: what a model *is*, not how it is reached.
 *
 * Phase H separates four things that are easy to conflate:
 *
 * - **capabilities** — what a model can do (`coding`, `vision`, `reasoning`);
 * - **modalities** — what it accepts and produces (`text`, `image`, `audio`, `video`);
 * - **connection** — how it is reached (a provider adapter);
 * - **judgement** — which model should run *this* task (the decision layer).
 *
 * This module owns the first two and nothing else. It is pure: no configuration
 * reading, no network, no environment, no clock. A capability is *declared* by
 * configuration and validated against a closed vocabulary; it is never inferred from
 * a model's name, because a name is marketing copy and a capability is a routing
 * input. See ADR-056.
 */

/**
 * The closed capability vocabulary.
 *
 * Closed rather than free-form so that "does this model satisfy this task?" is a set
 * question with a computable answer, and so a typo in configuration is a validation
 * error instead of a silently unusable model.
 *
 * A vocabulary entry is a *set* answer: a model either declares it or does not, and
 * "not declared" is never the same claim as "known not to do it". Vocabulary grows
 * in place rather than by synonym: a second name for a fact this list already carries
 * would make the same model answer `modelSatisfies` differently depending on which
 * name configuration happened to pick. So the common vendor wordings map onto the
 * existing entries — `toolUse`/`functionCalling` onto `toolCalling`, `audio` onto
 * `audioInput` plus `audioOutput`, `video` onto `videoInput` plus `videoOutput` — and
 * only genuinely new kinds of work (`mathematics`, `planning`, `agentic`,
 * `computerUse`) are added.
 */
export const MODEL_CAPABILITIES = [
  /** Multi-step inference over supplied material. */
  "reasoning",
  /** Producing or modifying source code. */
  "coding",
  /** Reasoning about structure and design rather than a single file. */
  "architecture",
  /** Emitting provider-native tool/function calls. */
  "toolCalling",
  /** Accepting images as input. */
  "vision",
  /** Producing images as output. */
  "imageGeneration",
  "audioInput",
  "audioOutput",
  "videoInput",
  "videoOutput",
  /** Emitting machine-parseable structured output reliably. */
  "structuredOutput",
  /** Comfortably operating over very large inputs. */
  "longContext",
  /** Optimised for low time-to-first-token. */
  "fastInference",
  /** General-purpose text work that needs no specialisation. */
  "general",
  /** Proving or deriving a result from formal material. */
  "mathematics",
  /** Decomposing work into ordered steps before acting on it. */
  "planning",
  /** Built for multi-step autonomous work rather than a single turn. */
  "agentic",
  /** Driving a computer, browser or GUI rather than emitting text alone. */
  "computerUse",
] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export function isModelCapability(value: unknown): value is ModelCapability {
  return (
    typeof value === "string" &&
    (MODEL_CAPABILITIES as readonly string[]).includes(value)
  );
}

export const MODEL_INPUT_MODALITIES = [
  "text",
  "image",
  "audio",
  "video",
] as const;
export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number];

export const MODEL_OUTPUT_MODALITIES = [
  "text",
  "image",
  "audio",
  "video",
] as const;
export type ModelOutputModality = (typeof MODEL_OUTPUT_MODALITIES)[number];

/**
 * Model health, as the registry knows it.
 *
 * Health is *runtime* state, not configuration: it starts `unknown` (nothing has
 * been attempted yet) and moves only as a result of observed calls. `unknown` counts
 * as usable — refusing every model nobody has tried yet would make the first call
 * impossible — while `unavailable`, `rate_limited` and `disabled` do not.
 */
/**
 * What a registered model is *for*.
 *
 * Only a generative model can fill a Frontier step; everything else is knowledge the
 * platform holds about a model that answers a different kind of question. A reranker
 * scores candidates, it does not write text, and letting one into the generative pool
 * would make "registered" mean "executable". The role is therefore a hard gate in
 * `modelSatisfies` and a filter over what a provider adapter is ever handed.
 */
export const MODEL_ROLES = ["generative", "retrieval"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** What a profile means when it declares no role: an executable model. */
export const DEFAULT_MODEL_ROLE: ModelRole = "generative";

export function roleOf(model: Pick<ModelProfile, "role">): ModelRole {
  return model.role ?? DEFAULT_MODEL_ROLE;
}

/**
 * Where a model sits in its own lifecycle, as the operator declares it.
 *
 * Not a health signal: health is what this platform *observed* on its own calls,
 * whereas lifecycle is what the vendor *announced*. `undefined` means "not declared",
 * and an undeclared lifecycle is never treated as a failing one — absent information
 * is not bad news, and this module does not invent a status any more than it invents
 * a latency.
 */
export const MODEL_LIFECYCLE_STATES = [
  "active",
  "experimental",
  "deprecated",
  "going-away",
] as const;
export type ModelLifecycleState = (typeof MODEL_LIFECYCLE_STATES)[number];

/**
 * Ordering key for lifecycle. Lower is preferred; undeclared ties with `active`.
 *
 * A deprecated or going-away model is not preferred over an equivalent candidate that
 * is still active, because a plan that leans on a model with an announced end date has
 * a failure scheduled into it. This is a demotion of *announced* decline, never a
 * promotion of the models nobody has classified.
 */
export function lifecycleRank(state: ModelLifecycleState | undefined): number {
  switch (state) {
    case "active":
    case undefined:
      return 0;
    case "experimental":
      return 1;
    case "deprecated":
      return 2;
    case "going-away":
      return 3;
  }
}

/**
 * Domain specialisations: a smaller, closed vocabulary than capabilities.
 *
 * `capabilities` answers "can it do this kind of work?"; `specializations` answers
 * "was it built for this field?". A finance requirement must not be smuggled into the
 * generic capability set, because "reasons well" and "was trained for finance" are
 * different facts about a model. Like every other routing input here, it is declared —
 * never inferred from a model's name.
 */
export const MODEL_SPECIALIZATIONS = [
  "finance",
  "medical",
  "legal",
  "relevance-ranking",
  "retrieval",
] as const;
export type ModelSpecialization = (typeof MODEL_SPECIALIZATIONS)[number];

export function isModelSpecialization(
  value: unknown,
): value is ModelSpecialization {
  return (
    typeof value === "string" &&
    (MODEL_SPECIALIZATIONS as readonly string[]).includes(value)
  );
}

/**
 * How a model is operated. Kept apart from what it can do.
 *
 * Every field is optional and `undefined` means **unknown**, never "no": a model
 * whose tier nobody declared is not thereby assumed paid, and one with no declared
 * rate-limit class is not assumed unthrottled. Nothing here is derived from a name —
 * the `:free` suffix in an OpenRouter id is a naming convention, and `free` is a
 * declaration.
 */
export interface ModelOperationalProfile {
  /** True only when the operator declares a free tier. Absent means unknown. */
  readonly free?: boolean;
  readonly status?: ModelLifecycleState;
  /** ISO date (`YYYY-MM-DD`) the vendor announced the model ends. Only when announced. */
  readonly sunsetAt?: string;
  /** Operator-declared coarse class. Never a measured rate or a promise. */
  readonly rateLimitClass?: string;
}

/**
 * What a response from this model is expected to look like, when that is known.
 *
 * The schema's answer to a distinction the live runs made concrete: a request can
 * succeed while the response is not a usable completion. This adapter requires an
 * OpenAI-shaped `choices[0].message.content` carrying text; a response whose only
 * content is reasoning is accepted by the wire and rejected by normalisation as
 * `malformed-response`. Every field is optional, and unset means unknown: the platform
 * records what a vendor documented, and never guesses a model's response shape from
 * the fact that it answered at all.
 */
export interface ResponseCompatibility {
  readonly openAiChatCompletions?: boolean;
  readonly supportsTextContent?: boolean;
  readonly supportsReasoningContent?: boolean;
}

export const MODEL_HEALTH_STATES = [
  "available",
  "degraded",
  "rate_limited",
  "unavailable",
  "disabled",
  "unknown",
] as const;

export type ModelHealthState = (typeof MODEL_HEALTH_STATES)[number];

export function isUsableHealth(health: ModelHealthState): boolean {
  return (
    health === "available" || health === "unknown" || health === "degraded"
  );
}

/**
 * What "best" means when models are ordered.
 *
 * A declared policy, not a heuristic: it decides which ordering key comes first, and
 * it is recorded with every plan so a routing choice can be explained later.
 */
export const ROUTING_MODES = [
  "cost",
  "latency",
  "quality",
  "balanced",
] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

/** A declared latency expectation. Deliberately coarse: it is a prior, not a measurement. */
export const LATENCY_CLASSES = ["fast", "standard", "slow"] as const;
export type LatencyClass = (typeof LATENCY_CLASSES)[number];

export function latencyRank(latency: LatencyClass): number {
  switch (latency) {
    case "fast":
      return 0;
    case "standard":
      return 1;
    case "slow":
      return 2;
  }
}

/**
 * One registered model.
 *
 * `enabled`, `priority` and `userOwned` are the operator's (in this platform: the
 * project's) voice in routing; `health` is what the platform has observed. Keeping
 * them in one profile is what lets a routing decision explain itself from a single
 * record.
 */
export interface ModelProfile {
  readonly modelId: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly capabilities: readonly ModelCapability[];
  /** What the model is for. Absent means `generative`. */
  readonly role?: ModelRole;
  /** Closed-vocabulary domain specialisations. Absent means none declared. */
  readonly specializations?: readonly ModelSpecialization[];
  readonly inputModalities: readonly ModelInputModality[];
  readonly outputModalities: readonly ModelOutputModality[];
  /**
   * Declared context window in tokens, when documented. Absent means "not declared".
   *
   * This *is* the context window; there is no second field for it. A number here is a
   * vendor-documented figure, and a profile with none is not treated as small — only
   * a requirement that asks for a minimum context window can reject it.
   */
  readonly contextLimit?: number;
  /** Declared maximum output tokens, when documented. Absent means "not declared". */
  readonly maxOutputTokens?: number;
  /**
   * Convenience flags kept for configuration compatibility only.
   *
   * `modelSatisfies` reads `capabilities` and never these: a boolean that disagreed
   * with the capability list would be a second source of truth for one fact. When
   * absent, the capability list is the answer, and absent is not `false`.
   */
  readonly toolCalling?: boolean;
  readonly structuredOutput?: boolean;
  readonly latencyClass: LatencyClass;
  /** Higher wins ties. Never a substitute for a capability match. */
  readonly priority: number;
  readonly enabled: boolean;
  /** True when the operator added this model rather than it being a built-in default. */
  readonly userOwned: boolean;
  readonly health: ModelHealthState;
  /** Lifecycle, tier and rate-limit class. Absent fields are unknown, never false. */
  readonly operational?: ModelOperationalProfile;
  readonly responseCompatibility?: ResponseCompatibility;
}

/**
 * What a task requires of a model.
 *
 * Produced by deterministic code (`orchestration/requirements.ts`) or supplied by an
 * operator; never by a model, and never by repository text.
 */
export interface ModelRequirements {
  readonly requiredCapabilities: readonly ModelCapability[];
  /** Domains the model must specialise in. Declared, never inferred. */
  readonly requiredSpecializations?: readonly string[];
  readonly inputModalities: readonly ModelInputModality[];
  readonly outputModalities: readonly ModelOutputModality[];
  /** When set, a model declaring a smaller window is ineligible. */
  readonly minContextTokens?: number;
}

export const NO_REQUIREMENTS: ModelRequirements = {
  requiredCapabilities: [],
  inputModalities: [],
  outputModalities: [],
};

export interface ModelEligibility {
  readonly ok: boolean;
  /** Stable codes for what was missing, in vocabulary order, deduplicated. */
  readonly missing: readonly string[];
}

/**
 * Does this profile satisfy these requirements?
 *
 * Total and deterministic: same inputs, same verdict, always. Missing capabilities
 * are reported as `capability:<id>` and missing modalities as `input:<id>` /
 * `output:<id>`, so a rejection can be rendered without re-deriving it.
 */
export function modelSatisfies(
  model: ModelProfile,
  requirements: ModelRequirements,
): ModelEligibility {
  const missing: string[] = [];
  // The gate comes first: a model that is not generative cannot fill a step at all,
  // however well it matches what the step asked for. Reporting it as a role mismatch
  // rather than as a missing capability keeps the reason honest — nothing about a
  // reranker is "missing"; it is answering a different question.
  if (roleOf(model) !== DEFAULT_MODEL_ROLE) {
    missing.push(`role:${roleOf(model)}`);
  }
  for (const capability of requirements.requiredCapabilities) {
    if (!model.capabilities.includes(capability)) {
      missing.push(`capability:${capability}`);
    }
  }
  const declared = model.specializations ?? [];
  for (const specialization of requirements.requiredSpecializations ?? []) {
    if (!(declared as readonly string[]).includes(specialization)) {
      missing.push(`specialization:${specialization}`);
    }
  }
  for (const modality of requirements.inputModalities) {
    if (!model.inputModalities.includes(modality)) {
      missing.push(`input:${modality}`);
    }
  }
  for (const modality of requirements.outputModalities) {
    if (!model.outputModalities.includes(modality)) {
      missing.push(`output:${modality}`);
    }
  }
  const minContext = requirements.minContextTokens;
  if (minContext !== undefined) {
    if (model.contextLimit === undefined || model.contextLimit < minContext) {
      missing.push("context:unknown-or-too-small");
    }
  }
  return { ok: missing.length === 0, missing };
}

export function isModelProfile(value: unknown): value is ModelProfile {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { modelId?: unknown }).modelId === "string" &&
    typeof (value as { providerId?: unknown }).providerId === "string"
  );
}

const MAX_PRIORITY = 1_000;
export const MAX_MODEL_CONTEXT_TOKENS = 100_000_000;
export const MAX_MODEL_OUTPUT_TOKENS = 1_000_000;

/**
 * A sunset date is a *date a vendor announced*, so it is validated as one: an ISO
 * calendar date, and only that.
 *
 * No clock is consulted. A model whose announced end has passed is still a registered
 * model, and what that implies is a question about *announced* decline — see
 * `lifecycleRank` — not a wall-clock event this pure module could decide for a
 * process that might be replaying a trace from last week.
 */
function assertSunsetDate(value: unknown, field: string): string {
  const text = assertNonEmptyString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new DomainError(
      "VALIDATION",
      `${field} must be an ISO date (YYYY-MM-DD)`,
      { field },
    );
  }
  return text;
}

/**
 * Lifecycle, tier and rate-limit class.
 *
 * Every field is optional and nothing is defaulted: a profile that declares no tier
 * is unknown, not paid, and one that declares no status has not been classified
 * rather than cleared.
 */
function assertOperationalProfile(
  value: unknown,
  field: string,
): ModelOperationalProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("VALIDATION", `${field} must be an object`, {
      field,
    });
  }
  const candidate = value as Record<string, unknown>;
  const free = optionalBoolean(candidate["free"], `${field}.free`);
  const status =
    candidate["status"] === undefined
      ? undefined
      : assertOneOf(
          candidate["status"],
          MODEL_LIFECYCLE_STATES,
          `${field}.status`,
        );
  const sunsetAt =
    candidate["sunsetAt"] === undefined
      ? undefined
      : assertSunsetDate(candidate["sunsetAt"], `${field}.sunsetAt`);
  const rateLimitClass =
    candidate["rateLimitClass"] === undefined
      ? undefined
      : nonSecretString(candidate["rateLimitClass"], `${field}.rateLimitClass`);
  return {
    ...(free === undefined ? {} : { free }),
    ...(status === undefined ? {} : { status }),
    ...(sunsetAt === undefined ? {} : { sunsetAt }),
    ...(rateLimitClass === undefined ? {} : { rateLimitClass }),
  };
}

/**
 * Declared response shape. Optional throughout, because a provider documenting that a
 * model answers in a given shape is not the same thing as this platform having
 * verified it, and neither is the same thing as it being so.
 */
function assertResponseCompatibility(
  value: unknown,
  field: string,
): ResponseCompatibility {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("VALIDATION", `${field} must be an object`, {
      field,
    });
  }
  const candidate = value as Record<string, unknown>;
  const openAiChatCompletions = optionalBoolean(
    candidate["openAiChatCompletions"],
    `${field}.openAiChatCompletions`,
  );
  const supportsTextContent = optionalBoolean(
    candidate["supportsTextContent"],
    `${field}.supportsTextContent`,
  );
  const supportsReasoningContent = optionalBoolean(
    candidate["supportsReasoningContent"],
    `${field}.supportsReasoningContent`,
  );
  return {
    ...(openAiChatCompletions === undefined ? {} : { openAiChatCompletions }),
    ...(supportsTextContent === undefined ? {} : { supportsTextContent }),
    ...(supportsReasoningContent === undefined
      ? {}
      : { supportsReasoningContent }),
  };
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  return value === undefined ? undefined : booleanField(value, field);
}

/**
 * Validates one profile from untrusted configuration.
 *
 * Configuration is untrusted input (AGENTS.md §3): every field is checked, the
 * vocabularies are closed, and a secret-shaped value in any string field is a hard
 * error rather than something that lands in a committed `.ai/project.json`.
 */
export function assertModelProfile(
  value: unknown,
  field = "model",
): ModelProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("VALIDATION", `${field} must be an object`, {
      field,
    });
  }
  const candidate = value as Record<string, unknown>;

  const modelId = nonSecretString(candidate["modelId"], `${field}.modelId`);
  const providerId = nonSecretString(
    candidate["providerId"],
    `${field}.providerId`,
  );
  const displayName = nonSecretString(
    candidate["displayName"],
    `${field}.displayName`,
  );

  const capabilities = assertStringArray(
    candidate["capabilities"],
    `${field}.capabilities`,
  ).map((entry, index) =>
    assertOneOf(entry, MODEL_CAPABILITIES, `${field}.capabilities[${index}]`),
  );
  const inputModalities = assertStringArray(
    candidate["inputModalities"],
    `${field}.inputModalities`,
  ).map((entry, index) =>
    assertOneOf(
      entry,
      MODEL_INPUT_MODALITIES,
      `${field}.inputModalities[${index}]`,
    ),
  );
  const outputModalities = assertStringArray(
    candidate["outputModalities"],
    `${field}.outputModalities`,
  ).map((entry, index) =>
    assertOneOf(
      entry,
      MODEL_OUTPUT_MODALITIES,
      `${field}.outputModalities[${index}]`,
    ),
  );

  const contextLimit =
    candidate["contextLimit"] === undefined
      ? undefined
      : assertNonNegativeInteger(
          candidate["contextLimit"],
          `${field}.contextLimit`,
        );
  if (contextLimit !== undefined && contextLimit > MAX_MODEL_CONTEXT_TOKENS) {
    throw new DomainError(
      "VALIDATION",
      `${field}.contextLimit must be at most ${MAX_MODEL_CONTEXT_TOKENS}`,
      { field: `${field}.contextLimit` },
    );
  }

  const maxOutputTokens =
    candidate["maxOutputTokens"] === undefined
      ? undefined
      : assertNonNegativeInteger(
          candidate["maxOutputTokens"],
          `${field}.maxOutputTokens`,
        );
  if (
    maxOutputTokens !== undefined &&
    maxOutputTokens > MAX_MODEL_OUTPUT_TOKENS
  ) {
    throw new DomainError(
      "VALIDATION",
      `${field}.maxOutputTokens must be at most ${MAX_MODEL_OUTPUT_TOKENS}`,
      { field: `${field}.maxOutputTokens` },
    );
  }

  const role =
    candidate["role"] === undefined
      ? undefined
      : assertOneOf(candidate["role"], MODEL_ROLES, `${field}.role`);
  const specializations =
    candidate["specializations"] === undefined
      ? undefined
      : assertStringArray(
          candidate["specializations"],
          `${field}.specializations`,
        ).map((entry, index) =>
          assertOneOf(
            entry,
            MODEL_SPECIALIZATIONS,
            `${field}.specializations[${index}]`,
          ),
        );
  const operational =
    candidate["operational"] === undefined
      ? undefined
      : assertOperationalProfile(
          candidate["operational"],
          `${field}.operational`,
        );
  const responseCompatibility =
    candidate["responseCompatibility"] === undefined
      ? undefined
      : assertResponseCompatibility(
          candidate["responseCompatibility"],
          `${field}.responseCompatibility`,
        );

  const toolCalling = optionalBoolean(
    candidate["toolCalling"],
    `${field}.toolCalling`,
  );
  const structuredOutput = optionalBoolean(
    candidate["structuredOutput"],
    `${field}.structuredOutput`,
  );

  const priority =
    candidate["priority"] === undefined
      ? 0
      : assertNonNegativeInteger(candidate["priority"], `${field}.priority`);
  if (priority > MAX_PRIORITY) {
    throw new DomainError(
      "VALIDATION",
      `${field}.priority must be at most ${MAX_PRIORITY}`,
      { field: `${field}.priority` },
    );
  }

  const health =
    candidate["health"] === undefined
      ? "unknown"
      : assertOneOf(
          candidate["health"],
          MODEL_HEALTH_STATES,
          `${field}.health`,
        );

  return {
    modelId,
    providerId,
    displayName,
    capabilities,
    ...(role === undefined ? {} : { role }),
    ...(specializations === undefined ? {} : { specializations }),
    inputModalities,
    outputModalities,
    ...(contextLimit === undefined ? {} : { contextLimit }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(toolCalling === undefined ? {} : { toolCalling }),
    ...(structuredOutput === undefined ? {} : { structuredOutput }),
    latencyClass:
      candidate["latencyClass"] === undefined
        ? "standard"
        : assertOneOf(
            candidate["latencyClass"],
            LATENCY_CLASSES,
            `${field}.latencyClass`,
          ),
    priority,
    enabled: booleanField(candidate["enabled"], `${field}.enabled`),
    userOwned:
      candidate["userOwned"] === undefined
        ? false
        : booleanField(candidate["userOwned"], `${field}.userOwned`),
    health,
    ...(operational === undefined ? {} : { operational }),
    ...(responseCompatibility === undefined ? {} : { responseCompatibility }),
  };
}

function nonSecretString(value: unknown, field: string): string {
  const text = assertNonEmptyString(value, field);
  assertNoSecretLikeValue(text, field);
  return text;
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new DomainError("VALIDATION", `${field} must be a boolean`, {
      field,
    });
  }
  return value;
}

/**
 * The models registered on a fresh `ai init`.
 *
 * Registered, not enabled for routing: the registry *describes* what these models
 * can do, and `frontier.enabled` decides whether anything may be routed to them. A
 * project with no vendor account still lists them, and `ai models` says plainly that
 * routing is off.
 *
 * Capabilities are declared explicitly. They are **not** inferred from the model
 * name: `inclusionai/ling-3.0-flash-vl:free` is registered with image input because
 * that is what this project asserts about it, and an operator who disagrees edits
 * `.ai/project.json`.
 *
 * The catalog answers "who exists and what can they do?", and it answers nothing else.
 * In particular it makes no claim this project cannot support:
 *
 * - no benchmark score, no measured latency percentile, no uptime or reliability
 *   figure, no price. Those are not fields here at all.
 * - `contextLimit` and `maxOutputTokens` are set only from a vendor's own documented
 *   figures, so a free-tier model whose window nobody has verified carries **no**
 *   number rather than a plausible one. `undefined` propagates as "not declared", and
 *   the only thing it can cause is a requirement with a minimum window rejecting the
 *   model — never a fabricated success.
 * - `latencyClass` is stated as the vocabulary's coarse default (`standard`) for every
 *   model whose latency this project has not declared. It is a prior used for
 *   ordering, never a measurement, and `fast` is kept only where it already was.
 * - `priority` is a declared preference, not a quality ranking: the models added here
 *   all declare the same value, so the deterministic order between them falls through
 *   to the tie-break on model id. Nothing in this file says one model is better.
 * - `operational.free` is `true` only where the model id is the vendor's free variant.
 *   The retrieval model declares no tier, because this project has not established one.
 * - `responseCompatibility` is absent throughout: no vendor documentation for these
 *   models has been recorded here, and a guess about a response shape is exactly the
 *   kind of invented fact this catalog refuses.
 *
 * Lifecycle is declared, and it is the one thing that makes the difference between an
 * active candidate and a model that is on its way out: `dots-studio/dots-3-note-preview`
 * carries `going-away` with the vendor's announced date, so it is registered as known
 * while being neither enabled nor preferred.
 */
export const DEFAULT_FRONTIER_MODELS: readonly ModelProfile[] = [
  // --- Core reasoning / coding ---------------------------------------------
  {
    modelId: "inclusionai/ling-3.0-flash-fin:free",
    providerId: "openrouter",
    displayName: "Ling 3.0 Flash Fin (OpenRouter, free tier)",
    capabilities: [
      "general",
      "reasoning",
      "coding",
      "toolCalling",
      "structuredOutput",
      "fastInference",
    ],
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolCalling: true,
    structuredOutput: true,
    latencyClass: "fast",
    priority: 10,
    enabled: true,
    userOwned: false,
    health: "unknown",
    operational: { free: true, status: "active" },
  },
  {
    modelId: "nvidia/nemotron-3-ultra-550b-a55b:free",
    providerId: "openrouter",
    displayName: "Nemotron 3 Ultra 550B A55B (OpenRouter, free tier)",
    capabilities: ["general", "reasoning", "coding"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    latencyClass: "standard",
    priority: 0,
    enabled: true,
    userOwned: false,
    health: "unknown",
    operational: { free: true, status: "active" },
  },
  {
    modelId: "poolside/laguna-s-2.1:free",
    providerId: "openrouter",
    displayName: "Laguna S 2.1 (OpenRouter, free tier)",
    capabilities: ["general", "reasoning", "coding"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    latencyClass: "standard",
    priority: 0,
    enabled: true,
    userOwned: false,
    health: "unknown",
    operational: { free: true, status: "active" },
  },
  {
    modelId: "nvidia/nemotron-3.5-lightning:free",
    providerId: "openrouter",
    displayName: "Nemotron 3.5 Lightning (OpenRouter, free tier)",
    capabilities: ["general", "reasoning", "coding"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    latencyClass: "standard",
    priority: 0,
    enabled: true,
    userOwned: false,
    health: "unknown",
    operational: { free: true, status: "active" },
  },
  {
    modelId: "cohere/north-mini-code:free",
    providerId: "openrouter",
    displayName: "North Mini Code (OpenRouter, free tier)",
    capabilities: ["general", "reasoning", "coding"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    latencyClass: "standard",
    priority: 0,
    enabled: true,
    userOwned: false,
    health: "unknown",
    operational: { free: true, status: "active" },
  },
  {
    modelId: "poolside/laguna-xs-2.1:free",
    providerId: "openrouter",
    displayName: "Laguna XS 2.1 (OpenRouter, free tier)",
    capabilities: ["general", "reasoning", "coding"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    latencyClass: "standard",
    priority: 0,
    enabled: true,
    userOwned: false,
    health: "unknown",
    operational: { free: true, status: "active" },
  },

  // --- Multimodal ------------------------------------------------------------
  {
    modelId: "inclusionai/ling-3.0-flash-vl:free",
    providerId: "openrouter",
    displayName: "Ling 3.0 Flash VL (OpenRouter, free tier)",
    capabilities: ["vision", "reasoning", "structuredOutput"],
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    toolCalling: false,
    structuredOutput: true,
    latencyClass: "fast",
    priority: 5,
    enabled: true,
    userOwned: false,
    health: "unknown",
    operational: { free: true, status: "active" },
  },
  {
    modelId: "thinkingmachines/inkling:free",
    providerId: "openrouter",
    displayName: "Inkling (OpenRouter, free tier)",
    capabilities: ["general", "reasoning", "vision"],
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    latencyClass: "standard",
    priority: 0,
    enabled: true,
    userOwned: false,
    health: "unknown",
    operational: { free: true, status: "active" },
  },
  {
    modelId: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    providerId: "openrouter",
    displayName:
      "Nemotron 3 Nano Omni 30B A3B Reasoning (OpenRouter, free tier)",
    capabilities: ["general", "reasoning", "vision"],
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    latencyClass: "standard",
    priority: 0,
    enabled: true,
    userOwned: false,
    health: "unknown",
    operational: { free: true, status: "active" },
  },

  // --- Autonomous / computer use ---------------------------------------------
  {
    modelId: "nex-agi/nex-n2.5-pro:free",
    providerId: "openrouter",
    displayName: "Nex N2.5 Pro (OpenRouter, free tier)",
    capabilities: [
      "general",
      "reasoning",
      "agentic",
      "computerUse",
      "toolCalling",
    ],
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolCalling: true,
    latencyClass: "standard",
    priority: 0,
    enabled: true,
    userOwned: false,
    health: "unknown",
    operational: { free: true, status: "active" },
  },

  // --- Experimental: registered knowledge, disabled for routing ---------------
  //
  // Disabled by default, and worth being precise about why each one is here: these
  // are models this project knows about but does not route to yet. Declaring them
  // with `general` only is deliberate: nothing about their reasoning, coding or
  // multimodal behaviour has been established for this project, and `general` is the
  // one capability that says no more than "it answers text".
  {
    modelId: "dots-studio/dots-3-note-preview:free",
    providerId: "openrouter",
    displayName: "Dots 3 Note Preview (OpenRouter, free tier, going away)",
    capabilities: ["general"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    latencyClass: "standard",
    priority: 0,
    enabled: false,
    userOwned: false,
    health: "unknown",
    // The vendor has announced an end date for this one. It is registered as known
    // history rather than as a candidate, and `lifecycleRank` makes sure that if it
    // were ever enabled it would still lose to an equivalent active model.
    operational: { free: true, status: "going-away", sunsetAt: "2026-09-30" },
  },
  {
    modelId: "inclusionai/ling-3.0-flash-sante:free",
    providerId: "openrouter",
    displayName: "Ling 3.0 Flash Sante (OpenRouter, free tier)",
    capabilities: ["general"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    latencyClass: "standard",
    priority: 0,
    enabled: false,
    userOwned: false,
    health: "unknown",
    operational: { free: true, status: "experimental" },
  },
  {
    modelId: "thinkingmachines/inkling-small:free",
    providerId: "openrouter",
    displayName: "Inkling Small (OpenRouter, free tier)",
    capabilities: ["general"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    latencyClass: "standard",
    priority: 0,
    enabled: false,
    userOwned: false,
    health: "unknown",
    operational: { free: true, status: "experimental" },
  },
  {
    modelId: "nex-agi/nex-n2.5-mini:free",
    providerId: "openrouter",
    displayName: "Nex N2.5 Mini (OpenRouter, free tier)",
    capabilities: ["general"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    latencyClass: "standard",
    priority: 0,
    enabled: false,
    userOwned: false,
    health: "unknown",
    operational: { free: true, status: "experimental" },
  },
  {
    modelId: "google/gemma-4-26b-a4b-it:free",
    providerId: "openrouter",
    displayName: "Gemma 4 26B A4B IT (OpenRouter, free tier)",
    capabilities: ["general"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    latencyClass: "standard",
    priority: 0,
    enabled: false,
    userOwned: false,
    health: "unknown",
    operational: { free: true, status: "experimental" },
  },
  {
    modelId: "google/gemma-4-31b-it:free",
    providerId: "openrouter",
    displayName: "Gemma 4 31B IT (OpenRouter, free tier)",
    capabilities: ["general"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    latencyClass: "standard",
    priority: 0,
    enabled: false,
    userOwned: false,
    health: "unknown",
    operational: { free: true, status: "experimental" },
  },

  // --- Retrieval: knowledge, never a generative candidate ---------------------
  //
  // A reranker scores candidate passages. It does not answer a step, so it is
  // registered with `role: "retrieval"`: the registry knows it, `modelSatisfies`
  // refuses it for every generative requirement, and the provider wiring never hands
  // it to an adapter. Registering it *without* the role would have made it quietly
  // executable, which is the one outcome this entry exists to prevent.
  {
    modelId: "voyageai/rerank-2.5-lite",
    providerId: "openrouter",
    displayName: "Voyage Rerank 2.5 Lite (retrieval, not a generative model)",
    role: "retrieval",
    specializations: ["relevance-ranking", "retrieval"],
    capabilities: [],
    inputModalities: ["text"],
    outputModalities: [],
    latencyClass: "standard",
    priority: 0,
    enabled: false,
    userOwned: false,
    health: "unknown",
    operational: { status: "active" },
  },
];
