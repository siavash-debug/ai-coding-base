import { DomainError } from "../core/errors.js";
import { assertOneOf, assertStringArray } from "../core/validation.js";
import {
  MODEL_CAPABILITIES,
  MODEL_INPUT_MODALITIES,
  MODEL_OUTPUT_MODALITIES,
  MODEL_SPECIALIZATIONS,
  type ModelCapability,
  type ModelInputModality,
  type ModelOutputModality,
  type ModelRequirements,
  type ModelSpecialization,
} from "../models/model.js";
import type { Task } from "../tasks/task.js";
import type { RiskLevel } from "../decisions/risk.js";

/**
 * Turning a task contract into what a model must be able to do.
 *
 * Deterministic, total and cheap: a keyword classifier over the task's own words,
 * producing a *closed* requirement set. It is deliberately not a model call. JEV
 * decides *which* eligible model should run; code decides *what eligibility means*,
 * and eligibility is a set question that does not need judgement (ADR-056).
 *
 * Three boundaries this module keeps:
 *
 * - **Text is data.** Task text can make the requirement set *narrower or wider*
 *   (it is the author describing their task) but it can never change a budget, a
 *   permission, a scope or an approval policy. Nothing here reads configuration.
 * - **Declared, not inferred from a name.** Capabilities come from the classifier's
 *   vocabulary or from an explicit operator override — never from a model id.
 * - **No LLM unless something needs one.** A task whose words ask for no reasoning,
 *   coding or visual work is reported as `modelRequired: false`, which is what stops
 *   the orchestrator from spending a model call on work code can finish.
 */

export const TASK_CLASSIFICATIONS = [
  "coding",
  "analysis",
  "architecture",
  "documentation",
  "visual",
  "image-generation",
  "mathematics",
  "planning",
  "agentic",
  "computer-use",
  "structured-output",
  "general",
] as const;

export type TaskClassification = (typeof TASK_CLASSIFICATIONS)[number];

export const TASK_COMPLEXITIES = ["trivial", "standard", "complex"] as const;
export type TaskComplexity = (typeof TASK_COMPLEXITIES)[number];

export const REQUIREMENT_REASON_CODES = [
  "declared-capabilities",
  "declared-specializations",
  "classified-coding",
  "classified-analysis",
  "classified-architecture",
  "classified-visual",
  "classified-image-generation",
  "classified-documentation",
  "classified-mathematics",
  "classified-planning",
  "classified-agentic",
  "classified-computer-use",
  "classified-structured-output",
  "no-model-required",
  "complexity-from-criteria",
  "complexity-from-risk",
  "complexity-default",
] as const;

export type RequirementReasonCode = (typeof REQUIREMENT_REASON_CODES)[number];

export interface TaskRequirements {
  readonly taskId: Task["id"];
  readonly workspaceId: Task["workspaceId"];
  readonly classifications: readonly TaskClassification[];
  /** What a model must be able to do, as a closed vocabulary. */
  readonly modelRequirements: ModelRequirements;
  /**
   * The task's declared risk, unchanged.
   *
   * Risk is *not* re-derived from task text: text raises nothing here, because a
   * classifier that could lower risk from a sentence would be a permission system
   * that reads prose (Phase E, security boundary).
   */
  readonly risk: RiskLevel;
  readonly complexity: TaskComplexity;
  /** False when the task's words ask for nothing a model is required for. */
  readonly modelRequired: boolean;
  readonly reasonCodes: readonly RequirementReasonCode[];
  /** What the classifier matched, as codes. Never the matched text. */
  readonly signals: readonly string[];
}

const CODING_TERMS = [
  "code",
  "coding",
  "implement",
  "refactor",
  "bug",
  "fix",
  "compile",
  "typescript",
  "javascript",
  "python",
  "function",
  "module",
  "api",
  "endpoint",
  "migration",
  "lint",
  "unit test",
  "type error",
  "stack trace",
];

const ANALYSIS_TERMS = [
  "analy",
  "investigate",
  "diagnose",
  "assess",
  "evaluate",
  "compare",
  "why ",
  "root cause",
  "review",
  "audit",
  // Reasoning that is stated as a demand rather than as a verb: "prove it",
  // "derive the bound" and "explain why" are all multi-step inference.
  "explain why",
  "prove that",
  "prove the",
  "derivation",
  "derive the",
  "reason about",
];

const ARCHITECTURE_TERMS = [
  "architecture",
  "system design",
  "module boundar",
  "interface design",
  "trade-off",
  "adr",
];

const VISUAL_TERMS = [
  "screenshot",
  "image",
  "mockup",
  "wireframe",
  "diagram",
  "visual",
  "png",
  "jpeg",
  "jpg",
  "render of the ui",
];

const IMAGE_GENERATION_TERMS = [
  "generate an image",
  "image generation",
  "create an image",
  "generate a logo",
  "illustration",
  "icon set",
  "generate artwork",
];

const DOCUMENTATION_TERMS = [
  "documentation",
  "readme",
  "docs",
  "changelog",
  "guide",
  "tutorial",
  "explain in writing",
];

/**
 * Mathematical work.
 *
 * Descriptive rather than gating, and the distinction is the interesting part: this
 * project registers no model that declares `mathematics`, so requiring the capability
 * outright would make every "calculate …" or "derive …" task unrunnable — the
 * requirement set would match nothing and the work would be handed to a human. What
 * mathematics *does* contribute is the faculty that actually performs it: simple
 * arithmetic stays deterministic (no capability only a model supplies), and anything
 * that needs inference carries `reasoning` through the analysis vocabulary above.
 *
 * The `mathematics` capability is still matched when a model declares it and an
 * operator demands it with `--require mathematics`; this list only decides what the
 * task's own words say.
 */
const MATHEMATICS_TERMS = [
  "calculate",
  "compute",
  "arithmetic",
  "equation",
  "solve for",
  "numerical",
  "numeric value",
  "sum of",
  "product of",
  "percentage of",
  "mathematical",
  "integral of",
  "derivative of",
];

/**
 * Planning: deciding an order of work before doing it.
 *
 * Like mathematics, this is descriptive: it contributes `reasoning` (the faculty that
 * plans) rather than a `planning` requirement nothing currently declares.
 */
const PLANNING_TERMS = [
  "implementation plan",
  "multi-step solution",
  "multi-step plan",
  "step-by-step plan",
  "sequence the dependencies",
  "sequence dependencies",
  "break down the work",
  "breakdown of the work",
  "plan of action",
  "roadmap for",
];

/**
 * Agentic work: the task asks for a *workflow* rather than a single answer.
 *
 * This one is a real routing capability (`agentic`), because a model that can hold a
 * multi-action loop is a different thing from one that answers a question.
 */
const AGENTIC_TERMS = [
  "autonomously",
  "autonomous",
  "multiple actions",
  "iterate until",
  "until the workflow completes",
  "manage the workflow",
  "run the workflow",
  "end-to-end workflow",
  "without further input",
];

/**
 * Computer use: acting on a screen rather than answering about one.
 *
 * Phrased rather than keyword-matched on purpose. `click` and `browser` alone are
 * ordinary words in ordinary tasks ("fix the browser cache bug"), and requiring
 * `computerUse` for those would narrow a coding task to a single registered model for
 * no reason. What is matched here is a statement of *acting* on a user interface.
 */
const COMPUTER_USE_TERMS = [
  "open the browser",
  "use the browser",
  "in the browser",
  "browser window",
  "navigate to the page",
  "navigate the pages",
  "navigate the ui",
  "click the",
  "fill the form",
  "fill in the form",
  "fill out the form",
  "submit the form",
  "web page",
  "webpage",
  "operate the computer",
  "use the interface",
  "interact with the application",
  "gui",
  "inspect the form",
];

/**
 * Structured output: the *shape* of the answer is part of the task.
 *
 * Matched as phrases ("as json", "json schema") and never on the bare word `json`,
 * which appears as the subject of plenty of ordinary coding work — "support JSON
 * config files" is not a request for a JSON-shaped answer. When it does match it is a
 * real requirement, because a model that cannot be constrained to a schema is not
 * equivalent to one that can.
 */
const STRUCTURED_OUTPUT_TERMS = [
  "as json",
  "in json",
  "json format",
  "json schema",
  "valid json",
  "machine-readable",
  "structured output",
  "structured response",
  "exact fields",
  "specific fields",
  "matching this schema",
  "following schema",
];

/** Capabilities that only a model can supply. Everything else code can do. */
const MODEL_ONLY_CAPABILITIES: readonly ModelCapability[] = [
  "reasoning",
  "coding",
  "architecture",
  "vision",
  "imageGeneration",
  // Capabilities a deterministic path cannot stand in for at all. `planning` and
  // `mathematics` are absent deliberately: they describe work code *can* do (a
  // dependency order, a sum) and they contribute `reasoning` when inference is
  // actually required. `structuredOutput` is absent for the same reason — it shapes an
  // answer, it does not make producing one require a model.
  "computerUse",
  "agentic",
  // A structured answer is something only a model can produce: code can *validate* a
  // schema, but producing a schema-shaped answer to a question code cannot answer is
  // exactly the work a model does. Absent `planning` and `mathematics`, which describe
  // work code *can* do (a dependency order, a sum) and which contribute `reasoning`
  // when the task's words actually demand inference.
  "structuredOutput",
];

function normalize(task: Task): string {
  return [
    task.title,
    task.description,
    ...task.context,
    ...task.constraints,
    ...task.acceptanceCriteria.map((criterion) => criterion.statement),
  ]
    .join("\n")
    .toLowerCase();
}

function matches(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

export interface ExtractRequirementsOptions {
  /**
   * Operator-supplied requirements, merged with the classifier's.
   *
   * An override can add or remove capabilities, but it is still validated against
   * the closed vocabularies: configuration cannot invent a capability that no model
   * profile could declare.
   */
  readonly requiredCapabilities?: readonly string[];
  /**
   * Domains the model must specialise in, from the closed specialization vocabulary.
   *
   * A separate axis from capabilities on purpose: "can reason" and "was built for
   * finance" are different facts, and folding the second into the first would make a
   * general-purpose model look like a specialist.
   */
  readonly requiredSpecializations?: readonly string[];
  readonly inputModalities?: readonly string[];
  readonly outputModalities?: readonly string[];
  readonly minContextTokens?: number;
}

export function assertModelRequirements(
  value: {
    readonly requiredCapabilities?: readonly string[];
    readonly requiredSpecializations?: readonly string[];
    readonly inputModalities?: readonly string[];
    readonly outputModalities?: readonly string[];
    readonly minContextTokens?: number;
  },
  field = "requirements",
): ModelRequirements {
  const requiredSpecializations = (
    value.requiredSpecializations === undefined
      ? []
      : assertStringArray(
          value.requiredSpecializations,
          `${field}.requiredSpecializations`,
        )
  ).map((entry, index): ModelSpecialization =>
    assertOneOf(
      entry,
      MODEL_SPECIALIZATIONS,
      `${field}.requiredSpecializations[${index}]`,
    ),
  );
  const requiredCapabilities = (
    value.requiredCapabilities === undefined
      ? []
      : assertStringArray(
          value.requiredCapabilities,
          `${field}.requiredCapabilities`,
        )
  ).map((entry, index): ModelCapability =>
    assertOneOf(
      entry,
      MODEL_CAPABILITIES,
      `${field}.requiredCapabilities[${index}]`,
    ),
  );
  const inputModalities = (
    value.inputModalities === undefined
      ? []
      : assertStringArray(value.inputModalities, `${field}.inputModalities`)
  ).map((entry, index): ModelInputModality =>
    assertOneOf(
      entry,
      MODEL_INPUT_MODALITIES,
      `${field}.inputModalities[${index}]`,
    ),
  );
  const outputModalities = (
    value.outputModalities === undefined
      ? []
      : assertStringArray(value.outputModalities, `${field}.outputModalities`)
  ).map((entry, index): ModelOutputModality =>
    assertOneOf(
      entry,
      MODEL_OUTPUT_MODALITIES,
      `${field}.outputModalities[${index}]`,
    ),
  );
  const minContextTokens = value.minContextTokens;
  if (
    minContextTokens !== undefined &&
    (!Number.isInteger(minContextTokens) || minContextTokens <= 0)
  ) {
    throw new DomainError(
      "VALIDATION",
      `${field}.minContextTokens must be a positive integer`,
      { field: `${field}.minContextTokens` },
    );
  }
  return {
    requiredCapabilities,
    ...(requiredSpecializations.length === 0
      ? {}
      : { requiredSpecializations }),
    inputModalities,
    outputModalities,
    ...(minContextTokens === undefined ? {} : { minContextTokens }),
  };
}

export function extractRequirements(
  task: Task,
  options: ExtractRequirementsOptions = {},
): TaskRequirements {
  const text = normalize(task);
  const classifications = new Set<TaskClassification>();
  const capabilities = new Set<ModelCapability>();
  const inputModalities = new Set<ModelInputModality>();
  const outputModalities = new Set<ModelOutputModality>(["text"]);
  const reasonCodes = new Set<RequirementReasonCode>();
  const signals: string[] = [];

  const coding = matches(text, CODING_TERMS);
  const analysis = matches(text, ANALYSIS_TERMS);
  const architecture = matches(text, ARCHITECTURE_TERMS);
  const visual = matches(text, VISUAL_TERMS);
  const imageGeneration = matches(text, IMAGE_GENERATION_TERMS);
  const documentation = matches(text, DOCUMENTATION_TERMS);
  const mathematics = matches(text, MATHEMATICS_TERMS);
  const planning = matches(text, PLANNING_TERMS);
  const agentic = matches(text, AGENTIC_TERMS);
  const computerUse = matches(text, COMPUTER_USE_TERMS);
  const structuredOutput = matches(text, STRUCTURED_OUTPUT_TERMS);

  if (coding) {
    classifications.add("coding");
    capabilities.add("coding");
    reasonCodes.add("classified-coding");
    signals.push("matched:coding");
  }
  if (analysis) {
    classifications.add("analysis");
    capabilities.add("reasoning");
    reasonCodes.add("classified-analysis");
    signals.push("matched:analysis");
  }
  if (architecture) {
    classifications.add("architecture");
    capabilities.add("architecture");
    capabilities.add("reasoning");
    reasonCodes.add("classified-architecture");
    signals.push("matched:architecture");
  }
  if (visual) {
    classifications.add("visual");
    capabilities.add("vision");
    inputModalities.add("image");
    reasonCodes.add("classified-visual");
    signals.push("matched:visual");
  }
  if (imageGeneration) {
    classifications.add("image-generation");
    capabilities.add("imageGeneration");
    outputModalities.add("image");
    reasonCodes.add("classified-image-generation");
    signals.push("matched:image-generation");
  }
  if (documentation) {
    classifications.add("documentation");
    capabilities.add("general");
    reasonCodes.add("classified-documentation");
    signals.push("matched:documentation");
  }
  if (mathematics) {
    // Classification only. `mathematics` is a capability an operator may demand, but
    // no keyword here requires it: the words "calculate" and "sum of" describe work
    // code can do, and a required capability no registered model declares would turn
    // an arithmetic task into an unrunnable one. Inference-bearing phrasings
    // ("prove that", "derive the") are matched by the analysis vocabulary instead,
    // which is what actually carries the model requirement.
    classifications.add("mathematics");
    reasonCodes.add("classified-mathematics");
    signals.push("matched:mathematics");
  }
  if (planning) {
    // `planning` is likewise not required as a capability no model declares; the
    // faculty that plans is `reasoning`, which every registered profile has.
    classifications.add("planning");
    capabilities.add("reasoning");
    reasonCodes.add("classified-planning");
    signals.push("matched:planning");
  }
  if (agentic) {
    classifications.add("agentic");
    capabilities.add("agentic");
    capabilities.add("reasoning");
    reasonCodes.add("classified-agentic");
    signals.push("matched:agentic");
  }
  if (computerUse) {
    classifications.add("computer-use");
    capabilities.add("computerUse");
    capabilities.add("reasoning");
    reasonCodes.add("classified-computer-use");
    signals.push("matched:computer-use");
  }
  if (structuredOutput) {
    classifications.add("structured-output");
    capabilities.add("structuredOutput");
    reasonCodes.add("classified-structured-output");
    signals.push("matched:structured-output");
  }
  if (classifications.size === 0) {
    classifications.add("general");
    capabilities.add("general");
  }

  const override = assertModelRequirements(options);
  const requiredSpecializations = override.requiredSpecializations ?? [];
  for (const capability of override.requiredCapabilities) {
    capabilities.add(capability);
  }
  for (const modality of override.inputModalities) {
    inputModalities.add(modality);
  }
  for (const modality of override.outputModalities) {
    outputModalities.add(modality);
  }
  if (override.requiredCapabilities.length > 0) {
    reasonCodes.add("declared-capabilities");
    signals.push("declared:capabilities");
  }
  // Specialisations are declarable only: the keyword classifier describes *kinds of
  // work*, and guessing that a task is "finance" from its prose is exactly the kind of
  // inference this registry refuses to make about a model.
  if (requiredSpecializations.length > 0) {
    reasonCodes.add("declared-specializations");
    signals.push("declared:specializations");
  }

  const criterionCount = task.acceptanceCriteria.length;
  const complexity: TaskComplexity =
    task.riskLevel === "high" || task.riskLevel === "critical" || architecture
      ? "complex"
      : criterionCount >= 4 || coding
        ? "standard"
        : criterionCount === 0
          ? "trivial"
          : "standard";
  if (complexity === "complex") {
    reasonCodes.add(
      task.riskLevel === "high" || task.riskLevel === "critical"
        ? "complexity-from-risk"
        : "complexity-from-criteria",
    );
  } else if (complexity === "trivial") {
    reasonCodes.add("complexity-default");
  } else {
    reasonCodes.add("complexity-from-criteria");
  }

  const modelRequired = [...capabilities].some((capability) =>
    MODEL_ONLY_CAPABILITIES.includes(capability),
  );
  if (!modelRequired) {
    reasonCodes.add("no-model-required");
    signals.push("no-model-required");
  }

  return {
    taskId: task.id,
    workspaceId: task.workspaceId,
    classifications: [...classifications],
    modelRequirements: {
      requiredCapabilities: [...capabilities],
      ...(requiredSpecializations.length === 0
        ? {}
        : { requiredSpecializations: [...requiredSpecializations] }),
      inputModalities: [...inputModalities],
      outputModalities: [...outputModalities],
      ...(override.minContextTokens === undefined
        ? {}
        : { minContextTokens: override.minContextTokens }),
    },
    risk: task.riskLevel,
    complexity,
    modelRequired,
    reasonCodes: [...reasonCodes],
    signals,
  };
}
