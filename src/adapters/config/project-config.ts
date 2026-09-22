import { mkdir, readFile, writeFile } from "node:fs/promises";

import { DomainError } from "../../core/errors.js";
import {
  assertNoSecretLikeValue,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertOneOf,
  assertPositiveInteger,
  assertStringArray,
} from "../../core/validation.js";
import { parsePathPattern } from "../../context/ignore.js";
import {
  type AccessPolicy,
  assertAccessPolicy,
} from "../../policy/access-policy.js";
import {
  type ModelRate,
  assertValidModelRate,
} from "../../observability/cost.js";
import {
  DEFAULT_FRONTIER_MODELS,
  ROUTING_MODES,
  type ModelProfile,
  type RoutingMode,
  assertModelProfile,
  roleOf,
} from "../../models/model.js";
import { type Project, validateProject } from "../../projects/project.js";
import {
  type Workspace,
  isWorkspaceWithinProject,
  validateWorkspace,
} from "../../workspaces/workspace.js";
import {
  PROJECT_CONFIG_SCHEMA_VERSION,
  projectConfigPath,
  runtimeDirectories,
} from "../storage/layout.js";

/**
 * Project configuration: `<projectRoot>/.ai/project.json`.
 *
 * This is *configuration*, not a domain record: it names the project, its
 * workspaces and its model pricing table. It is written by an explicit human
 * action (`ai init`) and read at every CLI invocation. Acceptance-criteria
 * progress and lifecycle state are NOT here — those live in the event log.
 *
 * Config is JSON rather than the `project.yaml` sketched in V2-ARCHITECTURE §21
 * because a YAML parser would be the first runtime dependency of a repository
 * whose core must stay dependency-free (ADR-020). See DECISIONS.md ADR-024.
 *
 * Everything read from disk is validated as untrusted input (AGENTS.md §3),
 * including cross-checks that the file has not been edited into an illegal
 * shape (a workspace belonging to a different project, or escaping the root).
 */
/** Providers the platform can construct. A closed set, validated on read. */
export const LLM_PROVIDER_KINDS = ["simulated", "openai-compatible"] as const;
export type LlmProviderKind = (typeof LLM_PROVIDER_KINDS)[number];

/**
 * LLM configuration.
 *
 * The credential is referenced by the **name** of an environment variable, never
 * by value: `.ai/project.json` is a committed file (ADR-033). Validation enforces
 * that, so an accidentally pasted key fails loudly instead of being committed.
 *
 * `simulated` is the default because the platform must be usable with no vendor
 * account at all; selecting a real provider is an explicit act.
 */
interface LlmRetryOptions {
  readonly timeoutMs?: number;
  /** Bounded transport attempts, including the first. */
  readonly maxAttempts?: number;
}

/**
 * A discriminated union rather than optional fields: once a real provider is
 * selected, its base URL, model and credential variable are *required by the type*,
 * so no call site needs an assertion to use them.
 */
export type LlmConfig =
  | { readonly provider: "simulated" }
  | ({
      readonly provider: "openai-compatible";
      /** API root, e.g. `https://api.openai.com/v1`. */
      readonly baseUrl: string;
      readonly modelId: string;
      /** Name of the environment variable holding the key. Never the key. */
      readonly credentialEnvVar: string;
    } & LlmRetryOptions);

export const DEFAULT_LLM_CONFIG: LlmConfig = { provider: "simulated" };

/** Upper bounds keep "bounded retries" a property of the system, not a hope. */
export const MAX_LLM_ATTEMPTS = 10;
export const MAX_LLM_TIMEOUT_MS = 600_000;

function assertCredentialVariableName(value: unknown, field: string): string {
  const name = assertNonEmptyString(value, field);
  assertNoSecretLikeValue(name, field);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new DomainError(
      "VALIDATION",
      `${field} must be the NAME of the environment variable holding the credential, not a value`,
      { field },
    );
  }
  return name;
}

function assertBaseUrl(value: unknown, field: string): string {
  const text = assertNonEmptyString(value, field);
  assertNoSecretLikeValue(text, field);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new DomainError("VALIDATION", `${field} must be an absolute URL`, {
      field,
    });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new DomainError(
      "VALIDATION",
      `${field} must use http or https (got "${parsed.protocol}")`,
      { field },
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new DomainError(
      "VALIDATION",
      `${field} must not embed credentials; reference an environment variable instead`,
      { field },
    );
  }
  return text;
}

function assertOptionalBoundedInteger(
  value: unknown,
  field: string,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = assertPositiveInteger(value, field);
  if (parsed > maximum) {
    throw new DomainError("VALIDATION", `${field} must be at most ${maximum}`, {
      field,
    });
  }
  return parsed;
}

export function assertLlmConfig(
  value: unknown,
  field = "config.llm",
): LlmConfig {
  if (value === undefined) {
    return DEFAULT_LLM_CONFIG;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("VALIDATION", `${field} must be an object`, {
      field,
    });
  }
  const candidate = value as Record<string, unknown>;
  const provider = assertOneOf(
    candidate["provider"] ?? DEFAULT_LLM_CONFIG.provider,
    LLM_PROVIDER_KINDS,
    `${field}.provider`,
  );
  if (provider === "simulated") {
    return DEFAULT_LLM_CONFIG;
  }

  const baseUrl = assertBaseUrl(candidate["baseUrl"], `${field}.baseUrl`);
  const modelId = assertNonEmptyString(
    candidate["modelId"],
    `${field}.modelId`,
  );
  assertNoSecretLikeValue(modelId, `${field}.modelId`);
  const credentialEnvVar = assertCredentialVariableName(
    candidate["credentialEnvVar"],
    `${field}.credentialEnvVar`,
  );

  const timeoutMs = assertOptionalBoundedInteger(
    candidate["timeoutMs"],
    `${field}.timeoutMs`,
    MAX_LLM_TIMEOUT_MS,
  );
  const maxAttempts = assertOptionalBoundedInteger(
    candidate["maxAttempts"],
    `${field}.maxAttempts`,
    MAX_LLM_ATTEMPTS,
  );

  return {
    provider,
    baseUrl,
    modelId,
    credentialEnvVar,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  };
}

/**
 * Decision-layer configuration.
 *
 * The decision layer is optional by architecture, so the default is `disabled`: a
 * project that says nothing about decisions gets deterministic answers, recorded as
 * such, and no network call at all (ADR-004, ADR-052). Selecting `jev-http` is an
 * explicit act, and even then the credential is referenced by the *name* of an
 * environment variable rather than by value.
 *
 * `maxDecisionsPerTask` is a hard budget, not a hint: when it is exhausted the
 * decision layer is not consulted and the deterministic fallback answers. It has a
 * minimum of 1 because a budget of zero would mean "record nothing about decisions",
 * which contradicts the observability invariant.
 */
export const DECISION_PROVIDER_KINDS = [
  "disabled",
  "jev-http",
  "typesafe",
] as const;

export type DecisionProviderKind = (typeof DECISION_PROVIDER_KINDS)[number];

/** The credential variable TypeSafe's own SDK looks for, used unless configured otherwise. */
export const DEFAULT_TYPESAFE_CREDENTIAL_ENV_VAR = "TYPESAFE_API_KEY";
/** The documented TypeSafe API root, used unless configured otherwise. */
export const DEFAULT_TYPESAFE_BASE_URL = "https://api.typesafe.ai";
/** The documented default JEV model, used unless configured otherwise. */
export const DEFAULT_TYPESAFE_MODEL = "jev-latest";

export const MAX_DECISIONS_PER_TASK = 200;
export const MAX_DECISION_RETRIES_PER_TASK = 5;
export const MAX_DECISION_TIMEOUT_MS = 120_000;

interface DecisionLimits {
  /** Hard cap on recorded decisions for one task. */
  readonly maxDecisionsPerTask: number;
  /**
   * Attempt-level retries the retry gate may consider.
   *
   * Transport retries already happen inside a provider adapter with its own cap;
   * this is the second, coarser level — re-running an attempt — and it is capped here
   * so no decision layer can extend it.
   */
  readonly maxRetriesPerTask: number;
  /**
   * Optional hard cap on known decision cost per task.
   *
   * Enforced from the log: once the recorded cost of consultations reaches the cap,
   * the decision layer is not consulted again. `undefined` means the count cap is the
   * only bound. Cost that could not be priced is not counted here — it is reported as
   * unpriced elsewhere rather than silently treated as free.
   */
  readonly maxDecisionCostMicrosPerTask?: number;
}

export type DecisionConfig =
  | ({ readonly provider: "disabled" } & DecisionLimits)
  | ({
      readonly provider: "jev-http";
      /** Decision service root, e.g. `https://jev.internal/v1`. */
      readonly baseUrl: string;
      /** Name of the environment variable holding the credential. Never the key. */
      readonly credentialEnvVar: string;
      /** Optional provider-side model or version identifier. */
      readonly modelId?: string;
      readonly timeoutMs?: number;
    } & DecisionLimits)
  | ({
      /**
       * TypeSafe is the JEV implementation: the SDK talks to `api.typesafe.ai`
       * through the same guarded transport every other provider uses.
       */
      readonly provider: "typesafe";
      /** API root. Defaults to the documented `https://api.typesafe.ai`. */
      readonly baseUrl?: string;
      /** Name of the environment variable holding the credential. Never the key. */
      readonly credentialEnvVar: string;
      /** Default JEV model. Defaults to the documented `jev-latest`. */
      readonly defaultModel?: string;
      readonly timeoutMs?: number;
    } & DecisionLimits);

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  provider: "disabled",
  maxDecisionsPerTask: 24,
  maxRetriesPerTask: 1,
};

export function assertDecisionConfig(
  value: unknown,
  field = "config.decision",
): DecisionConfig {
  if (value === undefined) {
    return DEFAULT_DECISION_CONFIG;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("VALIDATION", `${field} must be an object`, {
      field,
    });
  }
  const candidate = value as Record<string, unknown>;
  const provider = assertOneOf(
    candidate["provider"] ?? DEFAULT_DECISION_CONFIG.provider,
    DECISION_PROVIDER_KINDS,
    `${field}.provider`,
  );

  const maxDecisionsPerTask = assertOptionalBoundedInteger(
    candidate["maxDecisionsPerTask"] ??
      DEFAULT_DECISION_CONFIG.maxDecisionsPerTask,
    `${field}.maxDecisionsPerTask`,
    MAX_DECISIONS_PER_TASK,
  );
  const maxRetriesPerTask = assertOptionalBoundedInteger(
    candidate["maxRetriesPerTask"] ?? DEFAULT_DECISION_CONFIG.maxRetriesPerTask,
    `${field}.maxRetriesPerTask`,
    MAX_DECISION_RETRIES_PER_TASK,
  );
  const maxDecisionCostMicrosPerTask = assertOptionalBoundedInteger(
    candidate["maxDecisionCostMicrosPerTask"],
    `${field}.maxDecisionCostMicrosPerTask`,
    1_000_000_000,
  );
  const limits: DecisionLimits = {
    maxDecisionsPerTask: maxDecisionsPerTask ?? 1,
    maxRetriesPerTask: maxRetriesPerTask ?? 0,
    ...(maxDecisionCostMicrosPerTask === undefined
      ? {}
      : { maxDecisionCostMicrosPerTask }),
  };

  if (provider === "disabled") {
    return { provider, ...limits };
  }

  const optionalModel = (
    key: "modelId" | "defaultModel",
  ): string | undefined => {
    if (candidate[key] === undefined) {
      return undefined;
    }
    const text = assertNonEmptyString(candidate[key], `${field}.${key}`);
    assertNoSecretLikeValue(text, `${field}.${key}`);
    return text;
  };
  const timeoutMs = assertOptionalBoundedInteger(
    candidate["timeoutMs"],
    `${field}.timeoutMs`,
    MAX_DECISION_TIMEOUT_MS,
  );

  if (provider === "typesafe") {
    const baseUrl =
      candidate["baseUrl"] === undefined
        ? undefined
        : assertBaseUrl(candidate["baseUrl"], `${field}.baseUrl`);
    const credentialEnvVar = assertCredentialVariableName(
      candidate["credentialEnvVar"] ?? DEFAULT_TYPESAFE_CREDENTIAL_ENV_VAR,
      `${field}.credentialEnvVar`,
    );
    const defaultModel = optionalModel("defaultModel");
    return {
      provider,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      credentialEnvVar,
      ...(defaultModel === undefined ? {} : { defaultModel }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...limits,
    };
  }

  const baseUrl = assertBaseUrl(candidate["baseUrl"], `${field}.baseUrl`);
  const credentialEnvVar = assertCredentialVariableName(
    candidate["credentialEnvVar"],
    `${field}.credentialEnvVar`,
  );
  const modelId = optionalModel("modelId");

  return {
    provider,
    baseUrl,
    credentialEnvVar,
    ...(modelId === undefined ? {} : { modelId }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...limits,
  };
}

/**
 * Frontier configuration: the model catalog, the providers that can reach it, and the
 * routing policy that orders it.
 *
 * Three separate things, deliberately kept separate (ADR-056):
 *
 * - `models` is **knowledge** — what a model can do. Registering a model creates no
 *   authority to call it and no network path.
 * - `providers` is a **connection** — an API root and the *name* of the environment
 *   variable holding its credential. Configuring a provider still does not make its
 *   host reachable: `policy.network.providerHosts` must allow it, or the transport
 *   refuses before a socket exists (ADR-050).
 * - `routing` is **preference** — cost, latency, quality or balanced, the bounds, and
 *   whether decomposition and parallel execution are permitted at all.
 *
 * `enabled` defaults to false, so a project that says nothing about frontier keeps
 * the Phase D/E behaviour exactly: no model calls, no vendor account, no network.
 */
export const FRONTIER_PROVIDER_KINDS = ["openai-compatible"] as const;
export type FrontierProviderKind = (typeof FRONTIER_PROVIDER_KINDS)[number];

export const MAX_FRONTIER_MODEL_CALLS = 12;
export const MAX_FRONTIER_RETRIES_PER_STEP = 3;
export const MAX_FRONTIER_MODELS = 32;
export const MAX_FRONTIER_PROVIDERS = 8;

export interface FrontierProviderConfig {
  readonly id: string;
  readonly kind: FrontierProviderKind;
  /** API root, e.g. `https://openrouter.ai/api/v1`. */
  readonly baseUrl: string;
  /** Name of the environment variable holding the key. Never the key. */
  readonly credentialEnvVar: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}

export interface FrontierRoutingConfig {
  readonly mode: RoutingMode;
  readonly allowDecomposition: boolean;
  readonly allowParallel: boolean;
  /** Hard cap on model calls for one orchestrated run. */
  readonly maxModelCalls: number;
  /** Hard cap on retries per step; the retry decision may spend fewer, never more. */
  readonly maxRetriesPerStep: number;
}

export interface FrontierConfig {
  readonly enabled: boolean;
  readonly providers: readonly FrontierProviderConfig[];
  readonly models: readonly ModelProfile[];
  readonly routing: FrontierRoutingConfig;
}

/**
 * The registered models a generative provider adapter may serve.
 *
 * A model's *role* is what keeps "registered" from meaning "executable". The registry
 * holds knowledge, including knowledge about models that answer a different kind of
 * question — a reranker scores passages, it does not write an answer — and the adapter's
 * model list is the boundary where that knowledge would otherwise become reachable.
 * Filtering here, rather than relying on eligibility alone, means a non-generative
 * model cannot be named, cannot be resolved by Frontier, and cannot become the one
 * registered entry that a mis-written plan could turn into a live request.
 *
 * `enabled` is deliberately not consulted here: it is a *routing* preference, and this
 * function answers a *connection* question.
 */
export function generativeModels(
  frontier: FrontierConfig,
): readonly ModelProfile[] {
  return frontier.models.filter((model) => roleOf(model) === "generative");
}

export const DEFAULT_FRONTIER_CONFIG: FrontierConfig = {
  enabled: false,
  providers: [
    {
      id: "openrouter",
      kind: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      credentialEnvVar: "OPENROUTER_API_KEY",
    },
  ],
  models: DEFAULT_FRONTIER_MODELS,
  routing: {
    mode: "balanced",
    allowDecomposition: true,
    allowParallel: true,
    maxModelCalls: 4,
    maxRetriesPerStep: 1,
  },
};

function assertFrontierProvider(
  value: unknown,
  field: string,
): FrontierProviderConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("VALIDATION", `${field} must be an object`, {
      field,
    });
  }
  const candidate = value as Record<string, unknown>;
  const id = assertNonEmptyString(candidate["id"], `${field}.id`);
  assertNoSecretLikeValue(id, `${field}.id`);
  const kind = assertOneOf(
    candidate["kind"],
    FRONTIER_PROVIDER_KINDS,
    `${field}.kind`,
  );
  const baseUrl = assertBaseUrl(candidate["baseUrl"], `${field}.baseUrl`);
  const credentialEnvVar = assertCredentialVariableName(
    candidate["credentialEnvVar"],
    `${field}.credentialEnvVar`,
  );
  const timeoutMs = assertOptionalBoundedInteger(
    candidate["timeoutMs"],
    `${field}.timeoutMs`,
    MAX_LLM_TIMEOUT_MS,
  );
  const maxAttempts = assertOptionalBoundedInteger(
    candidate["maxAttempts"],
    `${field}.maxAttempts`,
    MAX_LLM_ATTEMPTS,
  );
  return {
    id,
    kind,
    baseUrl,
    credentialEnvVar,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  };
}

export function assertFrontierConfig(
  value: unknown,
  field = "config.frontier",
): FrontierConfig {
  if (value === undefined) {
    return DEFAULT_FRONTIER_CONFIG;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("VALIDATION", `${field} must be an object`, {
      field,
    });
  }
  const candidate = value as Record<string, unknown>;
  const enabled =
    candidate["enabled"] === undefined
      ? DEFAULT_FRONTIER_CONFIG.enabled
      : (() => {
          if (typeof candidate["enabled"] !== "boolean") {
            throw new DomainError(
              "VALIDATION",
              `${field}.enabled must be a boolean`,
              { field: `${field}.enabled` },
            );
          }
          return candidate["enabled"];
        })();

  const rawProviders = candidate["providers"] ?? [];
  if (!Array.isArray(rawProviders)) {
    throw new DomainError("VALIDATION", `${field}.providers must be an array`, {
      field: `${field}.providers`,
    });
  }
  if (rawProviders.length > MAX_FRONTIER_PROVIDERS) {
    throw new DomainError(
      "VALIDATION",
      `${field}.providers must carry at most ${MAX_FRONTIER_PROVIDERS} entries`,
      { field: `${field}.providers` },
    );
  }
  const providerIds = new Set<string>();
  const providers = rawProviders.map((entry, index) => {
    const provider = assertFrontierProvider(
      entry,
      `${field}.providers[${index}]`,
    );
    if (providerIds.has(provider.id)) {
      throw new DomainError(
        "INVARIANT",
        `duplicate frontier provider id "${provider.id}"`,
        { field: `${field}.providers[${index}].id` },
      );
    }
    providerIds.add(provider.id);
    return provider;
  });

  const rawModels = candidate["models"] ?? [];
  if (!Array.isArray(rawModels)) {
    throw new DomainError("VALIDATION", `${field}.models must be an array`, {
      field: `${field}.models`,
    });
  }
  if (rawModels.length > MAX_FRONTIER_MODELS) {
    throw new DomainError(
      "VALIDATION",
      `${field}.models must carry at most ${MAX_FRONTIER_MODELS} entries`,
      { field: `${field}.models` },
    );
  }
  const modelIds = new Set<string>();
  const models = rawModels.map((entry, index) => {
    const model = assertModelProfile(entry, `${field}.models[${index}]`);
    if (modelIds.has(model.modelId)) {
      throw new DomainError(
        "INVARIANT",
        `duplicate frontier model id "${model.modelId}"`,
        { field: `${field}.models[${index}].modelId` },
      );
    }
    if (!providerIds.has(model.providerId)) {
      // A registered model with no configured provider is knowledge without a
      // connection. It is a configuration error, not something to skip silently:
      // a plan that names it would fail at execution time.
      throw new DomainError(
        "INVARIANT",
        `${field}.models[${index}].providerId "${model.providerId}" is not one of ${field}.providers`,
        { field: `${field}.models[${index}].providerId` },
      );
    }
    modelIds.add(model.modelId);
    return model;
  });

  const rawRouting =
    candidate["routing"] === undefined ? {} : candidate["routing"];
  if (
    typeof rawRouting !== "object" ||
    rawRouting === null ||
    Array.isArray(rawRouting)
  ) {
    throw new DomainError("VALIDATION", `${field}.routing must be an object`, {
      field: `${field}.routing`,
    });
  }
  const routingCandidate = rawRouting as Record<string, unknown>;
  const defaults = DEFAULT_FRONTIER_CONFIG.routing;
  const routing: FrontierRoutingConfig = {
    mode: assertOneOf(
      routingCandidate["mode"] ?? defaults.mode,
      ROUTING_MODES,
      `${field}.routing.mode`,
    ),
    allowDecomposition: booleanOrDefault(
      routingCandidate["allowDecomposition"],
      defaults.allowDecomposition,
      `${field}.routing.allowDecomposition`,
    ),
    allowParallel: booleanOrDefault(
      routingCandidate["allowParallel"],
      defaults.allowParallel,
      `${field}.routing.allowParallel`,
    ),
    maxModelCalls:
      assertOptionalBoundedInteger(
        routingCandidate["maxModelCalls"],
        `${field}.routing.maxModelCalls`,
        MAX_FRONTIER_MODEL_CALLS,
      ) ?? defaults.maxModelCalls,
    // Zero is a legitimate setting here: "never retry a step" is a policy, and it
    // must be expressible (unlike a token budget, where zero would mean the same as
    // a missing budget with a worse trace).
    maxRetriesPerStep:
      assertOptionalNonNegativeBoundedInteger(
        routingCandidate["maxRetriesPerStep"],
        `${field}.routing.maxRetriesPerStep`,
        MAX_FRONTIER_RETRIES_PER_STEP,
      ) ?? defaults.maxRetriesPerStep,
  };

  return { enabled, providers, models, routing };
}

function assertOptionalNonNegativeBoundedInteger(
  value: unknown,
  field: string,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = assertNonNegativeInteger(value, field);
  if (parsed > maximum) {
    throw new DomainError("VALIDATION", `${field} must be at most ${maximum}`, {
      field,
    });
  }
  return parsed;
}

function booleanOrDefault(
  value: unknown,
  fallback: boolean,
  field: string,
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new DomainError("VALIDATION", `${field} must be a boolean`, {
      field,
    });
  }
  return value;
}

/**
 * Context configuration: the explicit knobs of the deterministic context engine.
 *
 * Every field here is a *budget* or an *exclusion*, never a scoring secret. The
 * signals and their weights live in `src/context/scoring.ts` where they are unit
 * tested; exposing them as configuration would let a project's `.ai/project.json`
 * change what "relevant" means without any code review, and would make two
 * projects' selections incomparable for no benefit.
 *
 * `maxTokens` is the selection budget, not the spend budget. The two are different
 * questions — "how much may I read?" and "how much may I spend?" — and they are
 * combined at the run site (the smaller of the two wins) rather than conflated
 * here. See ADR-040.
 */
export const CONTEXT_STRATEGY = "deterministic";
/** Bumped when a change to selection *behaviour* would alter what a task gets. */
export const CONTEXT_SELECTION_VERSION = 1;
export const MAX_CONTEXT_TOKENS = 200_000;
export const MAX_CONTEXT_FILE_TOKENS = 100_000;

export interface ContextPriorityRule {
  /** Path pattern, same syntax as `.gitignore` (`src/core/**`, `docs/**`). */
  readonly pattern: string;
  /** Points added (or removed, when negative) when the pattern matches. */
  readonly points: number;
}

export interface ContextConfig {
  readonly strategy: typeof CONTEXT_STRATEGY;
  readonly version: number;
  /** Hard upper bound on selected tokens. */
  readonly maxTokens: number;
  /** Characters per token used for estimation. See `context/tokens.ts`. */
  readonly bytesPerToken: number;
  /** A single file larger than this is never read into a selection. */
  readonly maxFileTokens: number;
  /** Whether git change information may be consulted at all. */
  readonly useGitChanges: boolean;
  readonly includeTests: boolean;
  readonly includeDocumentation: boolean;
  readonly includeAdr: boolean;
  /** Extra path patterns to exclude. Cannot re-include secrets. */
  readonly exclusions: readonly string[];
  /** Operator ranking adjustments. Adds points; never creates relevance. */
  readonly priority: readonly ContextPriorityRule[];
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  strategy: CONTEXT_STRATEGY,
  version: CONTEXT_SELECTION_VERSION,
  maxTokens: 8_000,
  bytesPerToken: 4,
  maxFileTokens: 3_000,
  useGitChanges: true,
  includeTests: true,
  includeDocumentation: true,
  includeAdr: true,
  exclusions: [],
  priority: [],
};

function assertBoundedPositiveInteger(
  value: unknown,
  field: string,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = assertPositiveInteger(value, field);
  if (parsed > maximum) {
    throw new DomainError("VALIDATION", `${field} must be at most ${maximum}`, {
      field,
    });
  }
  return parsed;
}

function assertBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new DomainError("VALIDATION", `${field} must be a boolean`, {
      field,
    });
  }
  return value;
}

export function assertContextConfig(
  value: unknown,
  field = "config.context",
): ContextConfig {
  if (value === undefined) {
    return DEFAULT_CONTEXT_CONFIG;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("VALIDATION", `${field} must be an object`, {
      field,
    });
  }
  const candidate = value as Record<string, unknown>;
  const strategy = assertOneOf(
    candidate["strategy"] ?? CONTEXT_STRATEGY,
    [CONTEXT_STRATEGY] as const,
    `${field}.strategy`,
  );
  const version = assertBoundedPositiveInteger(
    candidate["version"],
    `${field}.version`,
    CONTEXT_SELECTION_VERSION,
    CONTEXT_SELECTION_VERSION,
  );
  if (version !== CONTEXT_SELECTION_VERSION) {
    throw new DomainError(
      "VALIDATION",
      `${field}.version must be ${CONTEXT_SELECTION_VERSION}; a selection version is a code change, not a setting`,
      { field: `${field}.version` },
    );
  }

  const exclusions = assertStringArray(
    candidate["exclusions"] ?? [],
    `${field}.exclusions`,
  );
  // Compiled here, not at selection time: a malformed pattern must fail `ai init`
  // or the first read, never silently stop excluding something.
  exclusions.forEach((pattern, index) =>
    parsePathPattern(pattern, `${field}.exclusions[${index}]`),
  );

  const rawPriority = candidate["priority"] ?? [];
  if (!Array.isArray(rawPriority)) {
    throw new DomainError("VALIDATION", `${field}.priority must be an array`, {
      field: `${field}.priority`,
    });
  }
  const priority = rawPriority.map((entry, index) => {
    const at = `${field}.priority[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new DomainError("VALIDATION", `${at} must be an object`, {
        field: at,
      });
    }
    const record = entry as Record<string, unknown>;
    const pattern = assertNonEmptyString(record["pattern"], `${at}.pattern`);
    parsePathPattern(pattern, `${at}.pattern`);
    const points = record["points"];
    if (typeof points !== "number" || !Number.isSafeInteger(points)) {
      throw new DomainError(
        "VALIDATION",
        `${at}.points must be an integer (negative values lower a candidate's rank)`,
        { field: `${at}.points` },
      );
    }
    if (Math.abs(points) > 1_000) {
      throw new DomainError(
        "VALIDATION",
        `${at}.points must be between -1000 and 1000`,
        { field: `${at}.points` },
      );
    }
    return { pattern, points };
  });

  return {
    strategy,
    version,
    maxTokens: assertBoundedPositiveInteger(
      candidate["maxTokens"],
      `${field}.maxTokens`,
      MAX_CONTEXT_TOKENS,
      DEFAULT_CONTEXT_CONFIG.maxTokens,
    ),
    bytesPerToken: assertBoundedPositiveInteger(
      candidate["bytesPerToken"],
      `${field}.bytesPerToken`,
      16,
      DEFAULT_CONTEXT_CONFIG.bytesPerToken,
    ),
    maxFileTokens: assertBoundedPositiveInteger(
      candidate["maxFileTokens"],
      `${field}.maxFileTokens`,
      MAX_CONTEXT_FILE_TOKENS,
      DEFAULT_CONTEXT_CONFIG.maxFileTokens,
    ),
    useGitChanges: assertBoolean(
      candidate["useGitChanges"],
      `${field}.useGitChanges`,
      DEFAULT_CONTEXT_CONFIG.useGitChanges,
    ),
    includeTests: assertBoolean(
      candidate["includeTests"],
      `${field}.includeTests`,
      DEFAULT_CONTEXT_CONFIG.includeTests,
    ),
    includeDocumentation: assertBoolean(
      candidate["includeDocumentation"],
      `${field}.includeDocumentation`,
      DEFAULT_CONTEXT_CONFIG.includeDocumentation,
    ),
    includeAdr: assertBoolean(
      candidate["includeAdr"],
      `${field}.includeAdr`,
      DEFAULT_CONTEXT_CONFIG.includeAdr,
    ),
    exclusions,
    priority,
  };
}

export interface ProjectConfig {
  readonly schemaVersion: typeof PROJECT_CONFIG_SCHEMA_VERSION;
  readonly project: Project;
  readonly workspaces: readonly Workspace[];
  readonly modelRates: readonly ModelRate[];
  readonly llm: LlmConfig;
  readonly context: ContextConfig;
  /**
   * The enforcement policy: what any operation may touch.
   *
   * Part of the project configuration rather than a separate file because it is
   * read at exactly the same moments as everything else here, and because a second
   * configuration system would be a second thing to keep in sync (ADR-045). Absent
   * means the built-in deny-everything policy, so a configuration written before
   * Phase F keeps working — it simply cannot reach anything.
   */
  readonly policy: AccessPolicy;
  /**
   * The decision layer: which engine, if any, may answer bounded questions.
   *
   * Absent means `disabled`, so a configuration written before Phase G keeps working
   * and answers every question deterministically.
   */
  readonly decision: DecisionConfig;
  /**
   * The model catalog and routing policy.
   *
   * Absent means the documented defaults: the registry describes the built-in Ling
   * models, routing is disabled, and nothing is called. A configuration written
   * before Phase H therefore keeps working unchanged.
   */
  readonly frontier: FrontierConfig;
}

export function assertProjectConfig(value: unknown): ProjectConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("VALIDATION", "project config must be an object", {
      field: "config",
    });
  }
  const candidate = value as Record<string, unknown>;
  if (candidate["schemaVersion"] !== PROJECT_CONFIG_SCHEMA_VERSION) {
    throw new DomainError(
      "VALIDATION",
      `config.schemaVersion must be ${PROJECT_CONFIG_SCHEMA_VERSION}`,
      { field: "config.schemaVersion" },
    );
  }

  const project = candidate["project"] as Project;
  validateProject(project);

  const rawWorkspaces = candidate["workspaces"];
  if (!Array.isArray(rawWorkspaces) || rawWorkspaces.length === 0) {
    throw new DomainError(
      "VALIDATION",
      "config.workspaces must be a non-empty array",
      { field: "config.workspaces" },
    );
  }
  const seenWorkspaceIds = new Set<string>();
  const workspaces = rawWorkspaces.map((entry, index) => {
    const workspace = entry as Workspace;
    validateWorkspace(workspace);
    if (seenWorkspaceIds.has(workspace.id)) {
      throw new DomainError(
        "INVARIANT",
        `duplicate workspace id "${workspace.id}"`,
        { field: "config.workspaces" },
      );
    }
    seenWorkspaceIds.add(workspace.id);
    if (workspace.projectId !== project.id) {
      throw new DomainError(
        "INVARIANT",
        `workspace "${workspace.id}" belongs to project "${workspace.projectId}", not "${project.id}"`,
        { field: `config.workspaces[${index}].projectId` },
      );
    }
    if (!isWorkspaceWithinProject(workspace, project)) {
      throw new DomainError(
        "INVARIANT",
        `workspace "${workspace.id}" escapes the project root`,
        { field: `config.workspaces[${index}].rootPath` },
      );
    }
    return workspace;
  });

  const rawRates = candidate["modelRates"] ?? [];
  if (!Array.isArray(rawRates)) {
    throw new DomainError("VALIDATION", "config.modelRates must be an array", {
      field: "config.modelRates",
    });
  }
  const modelRates = rawRates.map((entry, index) =>
    assertValidModelRate(entry, `config.modelRates[${index}]`),
  );

  // Absent means the offline provider, so configurations written before Phase D
  // keep working unchanged.
  const llm = assertLlmConfig(candidate["llm"], "config.llm");
  // Absent means the documented defaults, so a Phase D configuration keeps working
  // unchanged and an operator only writes what they actually want to change.
  const context = assertContextConfig(candidate["context"], "config.context");
  // Absent means "this project may reach nothing", which is the only safe reading
  // of an unconfigured boundary. It is never defaulted to something permissive.
  const policy = assertAccessPolicy(candidate["policy"], "config.policy");
  // Absent means "no decision engine is installed", which is a fully functional
  // state: bounded questions are then answered deterministically and recorded.
  const decision = assertDecisionConfig(
    candidate["decision"],
    "config.decision",
  );
  // Absent means "the registry is populated but nothing may be routed", which keeps
  // every pre-Phase-H project working with no model calls at all.
  const frontier = assertFrontierConfig(
    candidate["frontier"],
    "config.frontier",
  );
  return {
    schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
    project,
    workspaces,
    modelRates,
    llm,
    context,
    policy,
    decision,
    frontier,
  };
}

/** Creates the `.ai/` runtime directories if they do not exist yet. */
export async function ensureRuntimeLayout(projectRoot: string): Promise<void> {
  for (const directory of runtimeDirectories(projectRoot)) {
    await mkdir(directory, { recursive: true });
  }
}

export async function readProjectConfig(
  projectRoot: string,
): Promise<ProjectConfig> {
  const path = projectConfigPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      throw new DomainError(
        "NOT_FOUND",
        `no project configuration at ${path}; run \`ai init\` to create one`,
        { field: "config", path },
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DomainError("VALIDATION", `${path} is not valid JSON`, {
      field: "config",
      path,
    });
  }
  return assertProjectConfig(parsed);
}

export async function writeProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): Promise<void> {
  const validated = assertProjectConfig(config);
  await ensureRuntimeLayout(projectRoot);
  await writeFile(
    projectConfigPath(projectRoot),
    `${JSON.stringify(validated, null, 2)}\n`,
    "utf8",
  );
}

export function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
