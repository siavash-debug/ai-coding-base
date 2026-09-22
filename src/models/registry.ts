import type {
  ModelEligibility,
  ModelProfile,
  ModelRequirements,
} from "./model.js";
import { isUsableHealth, modelSatisfies } from "./model.js";

/**
 * The model registry: what models exist, what they can do, and which of them may be
 * considered for a requirement.
 *
 * The registry is *knowledge*, not authority. It answers "who could do this?"; it
 * never answers "who may do this?" — that belongs to policy, and it never answers
 * "who should do this?" — that belongs to the decision layer. Keeping the three
 * apart is what makes a routing decision explainable: the candidate list is a
 * deterministic fact, so a surprising choice is either a scoring bug or a decision
 * bug, never an invisible one.
 *
 * There is no registry-wide singleton and no global mutable state: a runtime builds
 * one registry from its own project configuration, so one project's models cannot be
 * visible to another (ADR-056).
 */

export interface RejectedModel {
  readonly modelId: string;
  /** `disabled`, `health:<state>`, `role-mismatch` or `capability-mismatch`. */
  readonly reasonCode: string;
  /** Missing role/capability/specialization/modality codes, on a mismatch. */
  readonly missing: readonly string[];
}

export interface EligibilityReport {
  readonly eligible: readonly ModelProfile[];
  readonly rejected: readonly RejectedModel[];
}

export interface ModelRegistry {
  readonly id: string;
  /** Every registered profile, in deterministic order. */
  list(): readonly ModelProfile[];
  get(modelId: string): ModelProfile | undefined;
  /** Which registered models satisfy these requirements, and why the rest do not. */
  eligible(requirements: ModelRequirements): EligibilityReport;
  /**
   * Records observed health for one model.
   *
   * Health is process-local by design: it is an observation about *this* workspace's
   * recent calls, not a fact about the world, and persisting it would turn a
   * transient rate limit into a permanent configuration (ADR-056).
   */
  noteHealth(modelId: string, health: ModelProfile["health"]): void;
  /** The models as they are now, including observed health. */
  snapshot(): readonly ModelProfile[];
}

/**
 * Deterministic registry order: declared priority first, then model id.
 *
 * Priority is the operator's preference; model id is the tie-break that makes two
 * equally-preferred models order the same way on every machine, so a recorded
 * candidate list is comparable across runs.
 */
function compareModels(a: ModelProfile, b: ModelProfile): number {
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }
  return a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0;
}

export interface ModelRegistryDeps {
  readonly models: readonly ModelProfile[];
  readonly id?: string;
}

export function createModelRegistry(deps: ModelRegistryDeps): ModelRegistry {
  const seen = new Set<string>();
  const order: string[] = [];
  const byId = new Map<string, ModelProfile>();
  for (const model of deps.models) {
    if (seen.has(model.modelId)) {
      // A duplicate is a configuration error, not a merge: two profiles for one
      // model would make "which capabilities does it have?" unanswerable.
      throw new Error(`duplicate model "${model.modelId}" in the registry`);
    }
    seen.add(model.modelId);
    byId.set(model.modelId, model);
    order.push(model.modelId);
  }

  function sorted(): readonly ModelProfile[] {
    return order
      .map((modelId) => byId.get(modelId) as ModelProfile)
      .sort(compareModels);
  }

  return {
    id: deps.id ?? "model-registry",

    list: sorted,

    get: (modelId) => byId.get(modelId),

    snapshot: sorted,

    eligible(requirements) {
      const eligible: ModelProfile[] = [];
      const rejected: RejectedModel[] = [];
      for (const model of sorted()) {
        if (!model.enabled) {
          rejected.push({
            modelId: model.modelId,
            reasonCode: "disabled",
            missing: [],
          });
          continue;
        }
        if (!isUsableHealth(model.health)) {
          rejected.push({
            modelId: model.modelId,
            reasonCode: `health:${model.health}`,
            missing: [],
          });
          continue;
        }
        const fit: ModelEligibility = modelSatisfies(model, requirements);
        if (!fit.ok) {
          // A model that is not generative is reported as a *role* mismatch rather
          // than as missing capabilities: it is not an incomplete candidate for a
          // step, it is the wrong kind of model, and a caller reading the rejection
          // should not go looking for a capability it could have declared.
          rejected.push({
            modelId: model.modelId,
            reasonCode: fit.missing.some((code) => code.startsWith("role:"))
              ? "role-mismatch"
              : "capability-mismatch",
            missing: fit.missing,
          });
          continue;
        }
        eligible.push(model);
      }
      return { eligible, rejected };
    },

    noteHealth(modelId, health) {
      const current = byId.get(modelId);
      if (current === undefined) {
        return;
      }
      byId.set(modelId, { ...current, health });
    },
  };
}

/**
 * The capabilities a set of models could together satisfy.
 *
 * Used to explain *coverage*: when no single model fits but a decomposition does,
 * the plan can say which model would cover which requirement instead of reporting a
 * flat "no model available".
 */
export function capabilitiesOf(
  models: readonly ModelProfile[],
): readonly string[] {
  const union = new Set<string>();
  for (const model of models) {
    for (const capability of model.capabilities) {
      union.add(capability);
    }
  }
  return [...union].sort();
}
