import { DomainError } from "../core/errors.js";
import { assertOneOf } from "../core/validation.js";
import type {
  ModelCapability,
  ModelProfile,
  ModelRequirements,
  RoutingMode,
} from "../models/model.js";
import {
  MODEL_CAPABILITIES,
  latencyRank,
  lifecycleRank,
  modelSatisfies,
} from "../models/model.js";
import { estimateCost, type ModelRate } from "../observability/cost.js";
import type { AIUsage } from "../observability/usage.js";
import type { TaskRequirements } from "./requirements.js";

/**
 * Candidate ranking and plan construction: the deterministic half of routing.
 *
 * The split of responsibility is the point of this module:
 *
 * - **Code filters and orders.** Eligibility is a set question ("can this model do
 *   what the task needs?") and ordering is a stated preference ("cheapest first",
 *   "fastest first"). Neither needs judgement, so neither is delegated — which is
 *   also what stops a decision layer from being a mandatory network round trip
 *   (ADR-052, ADR-056).
 * - **JEV reorders and chooses.** Given the bounded, already-eligible candidate set,
 *   the decision layer may rank it; validation guarantees its answer is a permutation
 *   of what it was handed, so it can express preference but cannot invent a model,
 *   resurrect a rejected one, or reach outside the scope.
 *
 * Every ordering key is *declared* knowledge: cost from the project rate table,
 * latency class and priority from the model profile. There is no fabricated score and
 * no invented latency percentile — an unpriced model is ordered as *unknown*, never as
 * free (ADR-035).
 */

// The routing vocabulary lives with the model vocabulary so that configuration can
// name a mode without importing the orchestration layer.
export { ROUTING_MODES, type RoutingMode } from "../models/model.js";

export const PLAN_STRATEGIES = [
  "deterministic",
  "single-model",
  "sequential-decomposition",
  "parallel-decomposition",
] as const;

export type PlanStrategy = (typeof PLAN_STRATEGIES)[number];

export const PLAN_REASON_CODES = [
  "no-model-required",
  "single-model-sufficient",
  "decomposition-required",
  "parallel-independent-subtasks",
] as const;

export type PlanReasonCode = (typeof PLAN_REASON_CODES)[number];

export const STEP_PURPOSES = [
  "analysis",
  "implementation",
  "verification",
  "subtask",
] as const;

export type StepPurpose = (typeof STEP_PURPOSES)[number];

export interface CandidateReason {
  /** Stable code, e.g. `cost:priced`, `latency:fast`, `priority:10`. */
  readonly code: string;
}

export interface ScoredCandidate {
  /** 1-based position in the deterministic order. */
  readonly rank: number;
  readonly model: ModelProfile;
  /** Cost for the reference usage, when the project prices this model. */
  readonly referenceCostMicros?: number;
  /** True when the rate table has no entry: cost is unknown, never zero. */
  readonly unpriced: boolean;
  readonly reasons: readonly CandidateReason[];
}

/**
 * A fixed reference usage used only to make candidates comparable.
 *
 * It is not an estimate of the call that will happen and is never recorded as cost:
 * it exists so that "cheaper" can be decided deterministically from the rate table.
 * Real usage is measured from the provider's report and priced separately.
 */
export const REFERENCE_USAGE: AIUsage = {
  inputTokens: 1_000,
  outputTokens: 500,
  cachedInputTokens: 0,
};

export interface ScoreCandidatesInput {
  readonly requirements: ModelRequirements;
  readonly models: readonly ModelProfile[];
  readonly rates: readonly ModelRate[];
  readonly mode: RoutingMode;
}

function referenceCost(
  model: ModelProfile,
  rates: readonly ModelRate[],
): number | undefined {
  const cost = estimateCost({
    usage: REFERENCE_USAGE,
    providerId: model.providerId,
    modelId: model.modelId,
    rates,
  });
  return cost?.micros;
}

/** Declared surplus: capabilities the model has beyond what the step needs. */
function capabilitySurplus(
  model: ModelProfile,
  requirements: ModelRequirements,
): number {
  const needed = new Set<string>(requirements.requiredCapabilities);
  return model.capabilities.filter((capability) => !needed.has(capability))
    .length;
}

/**
 * Orders candidate models for one requirement set.
 *
 * Ordering keys are explicit and mode-specific; ties are always broken by model id so
 * two runs on two machines produce the same list.
 */
export function scoreCandidates(
  input: ScoreCandidatesInput,
): readonly ScoredCandidate[] {
  const rows = input.models
    .filter((model) => modelSatisfies(model, input.requirements).ok)
    .map((model) => {
      const cost = referenceCost(model, input.rates);
      return {
        model,
        cost,
        unpriced: cost === undefined,
        surplus: capabilitySurplus(model, input.requirements),
        // Announced decline outranks every preference below: a model the vendor has
        // deprecated must not win on price or latency against one that is still
        // active, because that saving is borrowed against a guaranteed outage. An
        // *undeclared* lifecycle is not a demotion — it ties with `active`.
        lifecycle: lifecycleRank(model.operational?.status),
      };
    });

  const unpricedFirst = (a: boolean, b: boolean): number =>
    a === b ? 0 : a ? 1 : -1;

  rows.sort((a, b) => {
    const orderedKeys: number[] = [a.lifecycle - b.lifecycle];
    switch (input.mode) {
      case "cost":
        orderedKeys.push(
          unpricedFirst(a.unpriced, b.unpriced),
          (a.cost ?? 0) - (b.cost ?? 0),
          latencyRank(a.model.latencyClass) - latencyRank(b.model.latencyClass),
          b.model.priority - a.model.priority,
        );
        break;
      case "latency":
        orderedKeys.push(
          latencyRank(a.model.latencyClass) - latencyRank(b.model.latencyClass),
          b.model.priority - a.model.priority,
          unpricedFirst(a.unpriced, b.unpriced),
          (a.cost ?? 0) - (b.cost ?? 0),
        );
        break;
      case "quality":
        orderedKeys.push(
          b.model.priority - a.model.priority,
          a.surplus - b.surplus,
          unpricedFirst(a.unpriced, b.unpriced),
          (a.cost ?? 0) - (b.cost ?? 0),
        );
        break;
      case "balanced":
        orderedKeys.push(
          latencyRank(a.model.latencyClass) - latencyRank(b.model.latencyClass),
          unpricedFirst(a.unpriced, b.unpriced),
          (a.cost ?? 0) - (b.cost ?? 0),
          b.model.priority - a.model.priority,
        );
        break;
    }
    for (const key of orderedKeys) {
      if (key !== 0) {
        return key;
      }
    }
    return a.model.modelId < b.model.modelId
      ? -1
      : a.model.modelId > b.model.modelId
        ? 1
        : 0;
  });

  return rows.map((row, index) => ({
    rank: index + 1,
    model: row.model,
    ...(row.cost === undefined ? {} : { referenceCostMicros: row.cost }),
    unpriced: row.unpriced,
    reasons: [
      {
        code: `status:${row.model.operational?.status ?? "undeclared"}`,
      },
      { code: `latency:${row.model.latencyClass}` },
      { code: row.unpriced ? "cost:unpriced" : "cost:priced" },
      { code: `priority:${row.model.priority}` },
      { code: `surplus:${row.surplus}` },
    ],
  }));
}

export interface PlanStep {
  readonly stepId: string;
  readonly purpose: StepPurpose;
  /** Code-owned instruction text. Never repository content. */
  readonly instruction: string;
  readonly requirements: ModelRequirements;
  /** Candidate model ids, already filtered and ordered. JEV may reorder these. */
  readonly candidateIds: readonly string[];
  /** Steps that must finish first. */
  readonly dependsOn: readonly string[];
}

export interface PlanEstimate {
  readonly maxModelCalls: number;
  readonly latencyClass: "fast" | "standard" | "slow";
  /** Sum of reference costs across steps, when every step is priced. */
  readonly priced: boolean;
  readonly estimatedReferenceCostMicros?: number;
  readonly unpricedSteps: number;
}

export interface PlanVariant {
  readonly planId: string;
  readonly strategy: PlanStrategy;
  readonly reasonCode: PlanReasonCode;
  readonly steps: readonly PlanStep[];
  /** True when the steps have no dependencies between them and may run together. */
  readonly parallel: boolean;
  readonly estimate: PlanEstimate;
}

export interface IndependentSubTask {
  readonly id: string;
  readonly instruction: string;
  readonly requiredCapabilities: readonly string[];
}

export interface BuildPlanInput {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly requirements: TaskRequirements;
  readonly mode: RoutingMode;
  readonly allowDecomposition: boolean;
  readonly allowParallel: boolean;
  readonly maxSteps: number;
  /** Deterministic ranking for an arbitrary requirement set. */
  readonly rankFor: (
    requirements: ModelRequirements,
  ) => readonly ScoredCandidate[];
  readonly subTasks?: readonly IndependentSubTask[];
}

function worstLatency(
  latency: readonly ("fast" | "standard" | "slow")[],
): "fast" | "standard" | "slow" {
  let worst: "fast" | "standard" | "slow" = "fast";
  for (const entry of latency) {
    if (latencyRank(entry) > latencyRank(worst)) {
      worst = entry;
    }
  }
  return worst;
}

/**
 * Requirements no step in this plan would satisfy.
 *
 * The union is checked against the *task's* requirement set, not against a step's:
 * coverage is a property of the whole plan, and a gap means the plan cannot deliver
 * the task no matter how well each individual step goes.
 */
function uncoveredRequirements(
  requirements: ModelRequirements,
  steps: readonly PlanStep[],
): readonly string[] {
  const capabilities = new Set(
    steps.flatMap((step) => step.requirements.requiredCapabilities),
  );
  const inputs = new Set(
    steps.flatMap((step) => step.requirements.inputModalities),
  );
  const outputs = new Set(
    steps.flatMap((step) => step.requirements.outputModalities),
  );
  const missing: string[] = [];
  for (const capability of requirements.requiredCapabilities) {
    if (!capabilities.has(capability)) {
      missing.push(`capability:${capability}`);
    }
  }
  for (const modality of requirements.inputModalities) {
    if (!inputs.has(modality)) {
      missing.push(`input:${modality}`);
    }
  }
  for (const modality of requirements.outputModalities) {
    if (!outputs.has(modality)) {
      missing.push(`output:${modality}`);
    }
  }
  return missing;
}

function estimateFor(
  steps: readonly PlanStep[],
  rankFor: BuildPlanInput["rankFor"],
): PlanEstimate {
  let estimated = 0;
  let unpricedSteps = 0;
  const latencies: ("fast" | "standard" | "slow")[] = [];
  for (const step of steps) {
    const top = rankFor(step.requirements)[0];
    if (top === undefined) {
      unpricedSteps += 1;
      latencies.push("standard");
      continue;
    }
    latencies.push(top.model.latencyClass);
    if (top.referenceCostMicros === undefined) {
      unpricedSteps += 1;
    } else {
      estimated += top.referenceCostMicros;
    }
  }
  return {
    maxModelCalls: steps.length,
    latencyClass: worstLatency(latencies),
    priced: unpricedSteps === 0,
    ...(unpricedSteps === 0 ? { estimatedReferenceCostMicros: estimated } : {}),
    unpricedSteps,
  };
}

/**
 * Capabilities that are about perceiving or producing a medium.
 *
 * These are what make a task undividable for a single text model, so they are the
 * natural seam for a decomposition: the step that handles them reads the task's own
 * input modalities, and the other step does everything else.
 */
const MODALITY_CAPABILITIES: readonly ModelCapability[] = [
  "vision",
  "imageGeneration",
  "audioInput",
  "audioOutput",
  "videoInput",
  "videoOutput",
];

const verificationRequirements: ModelRequirements = {
  requiredCapabilities: ["reasoning"],
  inputModalities: ["text"],
  outputModalities: ["text"],
};

/**
 * Splits a requirement set along the modality seam.
 *
 * By construction the two groups partition the task's own capabilities, which is what
 * makes "does this decomposition still cover the task?" answerable rather than hoped
 * for.
 */
function decompositionGroups(requirements: ModelRequirements): {
  readonly perceptual: ModelRequirements;
  readonly textual: ModelRequirements;
} {
  const perceptual = requirements.requiredCapabilities.filter((capability) =>
    MODALITY_CAPABILITIES.includes(capability),
  );
  const textual = requirements.requiredCapabilities.filter(
    (capability) => !MODALITY_CAPABILITIES.includes(capability),
  );
  return {
    perceptual: {
      requiredCapabilities: perceptual,
      inputModalities: requirements.inputModalities,
      outputModalities: ["text"],
    },
    textual: {
      requiredCapabilities: textual,
      inputModalities: ["text"],
      outputModalities: requirements.outputModalities,
    },
  };
}

/**
 * Builds the bounded set of execution plans a task's requirements permit.
 *
 * Everything here is structural: how many steps, in what order, and which
 * capabilities each step needs. Which *model* fills each step is a ranking question
 * (code first, decision layer second) and happens after a variant is chosen, so the
 * variant ids stay stable across model-registry changes.
 */
export function buildPlanVariants(
  input: BuildPlanInput,
): readonly PlanVariant[] {
  const variants: PlanVariant[] = [];

  if (!input.requirements.modelRequired) {
    variants.push({
      planId: "plan:deterministic",
      strategy: "deterministic",
      reasonCode: "no-model-required",
      steps: [],
      parallel: false,
      estimate: {
        maxModelCalls: 0,
        latencyClass: "fast",
        priced: true,
        estimatedReferenceCostMicros: 0,
        unpricedSteps: 0,
      },
    });
    return variants;
  }

  const all = input.rankFor(input.requirements.modelRequirements);
  if (all.length > 0) {
    const step: PlanStep = {
      stepId: "step-1",
      purpose: "implementation",
      instruction: `Complete the task "${input.taskTitle}" and state what you changed or concluded.`,
      requirements: input.requirements.modelRequirements,
      candidateIds: all.map((candidate) => candidate.model.modelId),
      dependsOn: [],
    };
    variants.push({
      planId: "plan:single",
      strategy: "single-model",
      reasonCode: "single-model-sufficient",
      steps: [step],
      parallel: false,
      estimate: estimateFor([step], input.rankFor),
    });
  } else if (input.allowDecomposition) {
    // No single registered model covers every requirement. Split the work along
    // capability boundaries, but only if each half is actually coverable: a two-step
    // plan whose second step has no candidate is not a plan.
    const steps: PlanStep[] = [];
    const groups = decompositionGroups(input.requirements.modelRequirements);
    const perceptual = input.rankFor(groups.perceptual);
    if (
      perceptual.length > 0 &&
      (groups.perceptual.requiredCapabilities.length > 0 ||
        groups.perceptual.inputModalities.length > 0)
    ) {
      steps.push({
        stepId: "step-1",
        purpose: "analysis",
        instruction: `Analyse the supplied material for the task "${input.taskTitle}" and report the specific findings another step must act on.`,
        requirements: groups.perceptual,
        candidateIds: perceptual.map((candidate) => candidate.model.modelId),
        dependsOn: [],
      });
    }
    const textual = input.rankFor(groups.textual);
    if (textual.length > 0 && groups.textual.requiredCapabilities.length > 0) {
      steps.push({
        stepId: `step-${steps.length + 1}`,
        purpose: "implementation",
        instruction: `Carry out the task "${input.taskTitle}" using the previous step's findings, and state exactly what changed.`,
        requirements: groups.textual,
        candidateIds: textual.map((candidate) => candidate.model.modelId),
        dependsOn: steps.map((step) => step.stepId),
      });
    }
    const verification = input.rankFor(verificationRequirements);
    if (
      verification.length > 0 &&
      input.requirements.complexity === "complex"
    ) {
      steps.push({
        stepId: `step-${steps.length + 1}`,
        purpose: "verification",
        instruction: `Review the work performed for "${input.taskTitle}" against its acceptance criteria and report what is met and what is not.`,
        requirements: verificationRequirements,
        candidateIds: verification.map((candidate) => candidate.model.modelId),
        dependsOn: steps.map((step) => step.stepId),
      });
    }
    // A decomposition is only a plan if it still covers *everything* the task
    // needs. Splitting a screenshot-analysis task into "coding only" would produce a
    // cheap plan that silently drops a required capability — which is exactly the
    // trade this platform refuses to make.
    const uncovered = uncoveredRequirements(
      input.requirements.modelRequirements,
      steps,
    );
    if (
      steps.length > 0 &&
      steps.length <= input.maxSteps &&
      uncovered.length === 0
    ) {
      variants.push({
        planId: "plan:decomposed",
        strategy: "sequential-decomposition",
        reasonCode: "decomposition-required",
        steps,
        parallel: false,
        estimate: estimateFor(steps, input.rankFor),
      });
    }
  }

  const subTasks = input.subTasks ?? [];
  if (
    input.allowParallel &&
    subTasks.length >= 2 &&
    subTasks.length <= input.maxSteps
  ) {
    const steps: PlanStep[] = [];
    for (const [index, subTask] of subTasks.entries()) {
      const requirements: ModelRequirements = {
        // Re-validated against the closed vocabulary so a plan can never carry an
        // invented capability, however the caller built the sub-task list.
        requiredCapabilities: subTask.requiredCapabilities.map(
          (capability, position): ModelCapability =>
            assertOneOf(
              capability,
              MODEL_CAPABILITIES,
              `subTasks[${index}].requiredCapabilities[${position}]`,
            ),
        ),
        inputModalities: ["text"],
        outputModalities: ["text"],
      };
      const candidates = input.rankFor(requirements);
      if (candidates.length === 0) {
        continue;
      }
      steps.push({
        stepId: `step-${index + 1}`,
        purpose: "subtask",
        instruction: subTask.instruction,
        requirements,
        candidateIds: candidates.map((candidate) => candidate.model.modelId),
        dependsOn: [],
      });
    }
    if (steps.length >= 2) {
      variants.push({
        planId: "plan:parallel",
        strategy: "parallel-decomposition",
        reasonCode: "parallel-independent-subtasks",
        steps,
        parallel: true,
        estimate: estimateFor(steps, input.rankFor),
      });
    }
  }

  if (variants.length === 0) {
    throw new DomainError(
      "NOT_FOUND",
      `no execution plan is available for task "${input.taskId}": no registered model satisfies ` +
        `${input.requirements.modelRequirements.requiredCapabilities.join(", ") || "the task"}`,
      { field: "plan" },
    );
  }
  return variants;
}
