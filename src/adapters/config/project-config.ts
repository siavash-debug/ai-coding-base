import { mkdir, readFile, writeFile } from "node:fs/promises";

import { DomainError } from "../../core/errors.js";
import {
  assertNoSecretLikeValue,
  assertNonEmptyString,
  assertOneOf,
  assertPositiveInteger,
  assertStringArray,
} from "../../core/validation.js";
import { parsePathPattern } from "../../context/ignore.js";
import {
  type ModelRate,
  assertValidModelRate,
} from "../../observability/cost.js";
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

  return {
    schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
    project,
    workspaces,
    modelRates,
    llm,
    context,
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
