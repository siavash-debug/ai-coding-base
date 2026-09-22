import { describe, expect, it } from "vitest";

import { projectId } from "../../src/core/ids.js";
import { hasDomainErrorCode } from "../../src/core/errors.js";
import {
  DEFAULT_FRONTIER_CONFIG,
  assertFrontierConfig,
} from "../../src/adapters/config/project-config.js";
import {
  DEFAULT_FRONTIER_MODELS,
  MODEL_CAPABILITIES,
  NO_REQUIREMENTS,
  assertModelProfile,
  isUsableHealth,
  latencyRank,
  lifecycleRank,
  modelSatisfies,
  roleOf,
  type ModelProfile,
} from "../../src/models/model.js";
import {
  capabilitiesOf,
  createModelRegistry,
} from "../../src/models/registry.js";
import {
  SLOW_STRONG_MODEL,
  TEXT_MODEL,
  VISION_MODEL,
  frontierConfig,
  frontierModel,
} from "../support/frontier.js";

/**
 * The registry is knowledge, so the tests are about two things: that it refuses to
 * hold a model profile it cannot justify, and that it answers eligibility questions
 * deterministically — the same list, in the same order, on every run.
 */

describe("model profiles", () => {
  it("validates a profile from untrusted configuration", () => {
    const profile = assertModelProfile({
      modelId: "vendor/model-a",
      providerId: "openrouter",
      displayName: "Model A",
      capabilities: ["coding", "reasoning"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      toolCalling: true,
      structuredOutput: false,
      enabled: true,
    });
    expect(profile.capabilities).toEqual(["coding", "reasoning"]);
    // Defaults are explicit rather than accidental: nothing is claimed about health,
    // latency or preference unless configuration says so.
    expect(profile.health).toBe("unknown");
    expect(profile.latencyClass).toBe("standard");
    expect(profile.priority).toBe(0);
    expect(profile.userOwned).toBe(false);
  });

  it("rejects a capability outside the closed vocabulary", () => {
    expect(() =>
      assertModelProfile({
        modelId: "vendor/model-a",
        providerId: "openrouter",
        displayName: "Model A",
        capabilities: ["telepathy"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        toolCalling: false,
        structuredOutput: false,
        enabled: true,
      }),
    ).toThrowError(/capabilities\[0\]/);
  });

  it("rejects a modality outside the closed vocabulary", () => {
    expect(() =>
      assertModelProfile({
        modelId: "vendor/model-a",
        providerId: "openrouter",
        displayName: "Model A",
        capabilities: ["general"],
        inputModalities: ["smell"],
        outputModalities: ["text"],
        toolCalling: false,
        structuredOutput: false,
        enabled: true,
      }),
    ).toThrowError(/inputModalities\[0\]/);
  });

  it("rejects a secret-shaped value anywhere in a profile", () => {
    try {
      assertModelProfile({
        modelId: "vendor/model-a",
        providerId: "openrouter",
        displayName: "sk-live-abcdefghijklmnopqrstuvwxyz012345",
        capabilities: ["general"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        toolCalling: false,
        structuredOutput: false,
        enabled: true,
      });
      throw new Error("expected a validation error");
    } catch (error) {
      expect(hasDomainErrorCode(error, "VALIDATION")).toBe(true);
    }
  });
});

describe("the default catalog", () => {
  it("registers the two Ling models with declared, not inferred, capabilities", () => {
    const fin = DEFAULT_FRONTIER_MODELS.find((model) =>
      model.modelId.includes("ling-3.0-flash-fin"),
    );
    const vl = DEFAULT_FRONTIER_MODELS.find((model) =>
      model.modelId.includes("ling-3.0-flash-vl"),
    );
    expect(fin?.providerId).toBe("openrouter");
    expect(fin?.capabilities).toContain("coding");
    expect(fin?.inputModalities).toEqual(["text"]);
    expect(vl?.capabilities).toContain("vision");
    expect(vl?.inputModalities).toContain("image");
    // The name says "vl"; the *model* only accepts images because a profile says so.
    expect(vl?.capabilities).not.toContain("coding");
  });

  it("does not enable routing on a freshly initialised project", () => {
    expect(DEFAULT_FRONTIER_CONFIG.enabled).toBe(false);
    expect(DEFAULT_FRONTIER_CONFIG.models.length).toBeGreaterThan(0);
    expect(DEFAULT_FRONTIER_CONFIG.providers[0]?.credentialEnvVar).toBe(
      "OPENROUTER_API_KEY",
    );
  });

  it("refuses a registered model whose provider is not configured", () => {
    expect(() =>
      assertFrontierConfig({
        enabled: true,
        providers: frontierConfig().providers,
        models: [
          TEXT_MODEL,
          frontierModel({ modelId: "x/y", providerId: "ghost" }),
        ],
      }),
    ).toThrowError(
      /providerId "ghost" is not one of config.frontier.providers/,
    );
  });

  it("refuses a duplicate model id", () => {
    expect(() =>
      assertFrontierConfig({
        enabled: true,
        providers: frontierConfig().providers,
        models: [TEXT_MODEL, TEXT_MODEL],
      }),
    ).toThrowError(/duplicate frontier model id/);
  });
});

describe("eligibility", () => {
  it("matches capabilities, modalities and declared context", () => {
    expect(
      modelSatisfies(TEXT_MODEL, {
        requiredCapabilities: ["coding"],
        inputModalities: ["text"],
        outputModalities: ["text"],
      }).ok,
    ).toBe(true);

    const mismatch = modelSatisfies(TEXT_MODEL, {
      requiredCapabilities: ["coding", "vision"],
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.missing).toEqual(["capability:vision", "input:image"]);
  });

  it("treats an undeclared context window as unsatisfied when one is required", () => {
    expect(
      modelSatisfies(TEXT_MODEL, {
        ...NO_REQUIREMENTS,
        minContextTokens: 8_000,
      }).missing,
    ).toEqual(["context:unknown-or-too-small"]);
  });

  it("is usable while unknown or degraded, and not otherwise", () => {
    expect(isUsableHealth("unknown")).toBe(true);
    expect(isUsableHealth("available")).toBe(true);
    expect(isUsableHealth("degraded")).toBe(true);
    expect(isUsableHealth("rate_limited")).toBe(false);
    expect(isUsableHealth("unavailable")).toBe(false);
    expect(isUsableHealth("disabled")).toBe(false);
  });

  it("never infers a capability from a model name", () => {
    const namedVision = frontierModel({
      modelId: "vendor/vision-ultra:free",
      providerId: "openrouter",
      capabilities: ["general"],
    });
    const registry = createModelRegistry({ models: [namedVision] });
    const report = registry.eligible({
      requiredCapabilities: ["vision"],
      inputModalities: ["image"],
      outputModalities: ["text"],
    });
    expect(report.eligible).toHaveLength(0);
    expect(report.rejected[0]?.reasonCode).toBe("capability-mismatch");
  });
});

describe("the registry", () => {
  it("orders by declared priority, then deterministically by id", () => {
    const registry = createModelRegistry({
      models: [
        frontierModel({ modelId: "b/model", providerId: "p", priority: 5 }),
        frontierModel({ modelId: "a/model", providerId: "p", priority: 5 }),
        SLOW_STRONG_MODEL,
      ],
    });
    expect(registry.list().map((model) => model.modelId)).toEqual([
      SLOW_STRONG_MODEL.modelId,
      "a/model",
      "b/model",
    ]);
  });

  it("refuses two profiles for one model id", () => {
    expect(() =>
      createModelRegistry({ models: [TEXT_MODEL, TEXT_MODEL] }),
    ).toThrowError(/duplicate model/);
  });

  it("reports why each ineligible model was rejected", () => {
    const registry = createModelRegistry({
      models: [
        TEXT_MODEL,
        VISION_MODEL,
        frontierModel({
          modelId: "disabled/model",
          providerId: "openrouter",
          capabilities: ["vision", "reasoning"],
          inputModalities: ["text", "image"],
          enabled: false,
        }),
        frontierModel({
          modelId: "limited/model",
          providerId: "openrouter",
          capabilities: ["vision", "reasoning"],
          inputModalities: ["text", "image"],
          health: "rate_limited",
        }),
      ],
    });
    const report = registry.eligible({
      requiredCapabilities: ["vision"],
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
    });
    expect(report.eligible.map((model) => model.modelId)).toEqual([
      VISION_MODEL.modelId,
    ]);
    expect(report.rejected.map((entry) => entry.reasonCode)).toEqual([
      "capability-mismatch",
      "disabled",
      "health:rate_limited",
    ]);
  });

  it("records observed health without touching configuration", () => {
    const registry = createModelRegistry({ models: [TEXT_MODEL] });
    registry.noteHealth(TEXT_MODEL.modelId, "unavailable");
    expect(registry.get(TEXT_MODEL.modelId)?.health).toBe("unavailable");
    expect(registry.eligible(NO_REQUIREMENTS).eligible).toHaveLength(0);
    registry.noteHealth("not-registered", "available");
    expect(registry.get(TEXT_MODEL.modelId)?.health).toBe("unavailable");
  });

  it("describes the capabilities a set of models covers together", () => {
    expect(capabilitiesOf([TEXT_MODEL, VISION_MODEL])).toEqual([
      "coding",
      "general",
      "reasoning",
      "vision",
    ]);
  });

  it("is not global state: two registries are independent", () => {
    const a = createModelRegistry({ models: [TEXT_MODEL] });
    const b = createModelRegistry({ models: [VISION_MODEL] });
    a.noteHealth(TEXT_MODEL.modelId, "unavailable");
    expect(b.get(TEXT_MODEL.modelId)).toBeUndefined();
    expect(a.get(VISION_MODEL.modelId)).toBeUndefined();
  });
});

/**
 * The expanded catalog.
 *
 * A registry is only useful to the decision layer if it makes capability
 * *differences* visible, so these tests are as much about what the catalog refuses to
 * claim as about what it lists: no tier it cannot verify, no number it cannot source,
 * no model whose role would make it reachable as an execution candidate.
 */
describe("the expanded catalog", () => {
  const ids = DEFAULT_FRONTIER_MODELS.map((model) => model.modelId);
  const byId = (modelId: string) =>
    DEFAULT_FRONTIER_MODELS.find((model) => model.modelId === modelId);

  it("registers the active core set as enabled, free, active candidates", () => {
    const active = [
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "poolside/laguna-s-2.1:free",
      "inclusionai/ling-3.0-flash-fin:free",
      "nvidia/nemotron-3.5-lightning:free",
      "cohere/north-mini-code:free",
      "poolside/laguna-xs-2.1:free",
      "inclusionai/ling-3.0-flash-vl:free",
      "thinkingmachines/inkling:free",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      "nex-agi/nex-n2.5-pro:free",
    ];
    expect(active).toHaveLength(10);
    for (const modelId of active) {
      const model = byId(modelId);
      expect(model, modelId).toBeDefined();
      expect(model?.enabled, modelId).toBe(true);
      expect(model?.providerId, modelId).toBe("openrouter");
      expect(model?.operational?.status, modelId).toBe("active");
      expect(model?.operational?.free, modelId).toBe(true);
      expect(roleOf(model as ModelProfile), modelId).toBe("generative");
    }
  });

  it("registers the experimental models as known but disabled", () => {
    const experimental = [
      "inclusionai/ling-3.0-flash-sante:free",
      "thinkingmachines/inkling-small:free",
      "nex-agi/nex-n2.5-mini:free",
      "google/gemma-4-26b-a4b-it:free",
      "google/gemma-4-31b-it:free",
    ];
    for (const modelId of experimental) {
      const model = byId(modelId);
      expect(model, modelId).toBeDefined();
      expect(model?.enabled, modelId).toBe(false);
      expect(model?.operational?.status, modelId).toBe("experimental");
    }
  });

  it("carries the announced end date of the model that is going away", () => {
    const ending = byId("dots-studio/dots-3-note-preview:free");
    expect(ending).toBeDefined();
    expect(ending?.operational?.status).toBe("going-away");
    expect(ending?.operational?.sunsetAt).toBe("2026-09-30");
    // Registered as known history, not as a candidate.
    expect(ending?.enabled).toBe(false);
  });

  it("never registers an aggregate router in place of a specific model", () => {
    // JEV owns model selection. A model id that hands the choice to the provider
    // would move routing out of the platform, so the catalog must not carry one.
    expect(ids).not.toContain("openrouter/free");
    expect(ids).not.toContain("openrouter/auto");
    expect(ids.filter((modelId) => modelId.startsWith("openrouter/"))).toEqual(
      [],
    );
  });

  it("keeps the retrieval model out of every generative candidate set", () => {
    const reranker = byId("voyageai/rerank-2.5-lite") as ModelProfile;
    expect(reranker).toBeDefined();
    expect(roleOf(reranker)).toBe("retrieval");
    expect(reranker.enabled).toBe(false);
    expect(reranker.specializations).toEqual([
      "relevance-ranking",
      "retrieval",
    ]);

    // Even asked for nothing at all, it is not a model a step could run.
    const fit = modelSatisfies(reranker, NO_REQUIREMENTS);
    expect(fit.ok).toBe(false);
    expect(fit.missing).toContain("role:retrieval");

    const registry = createModelRegistry({ models: DEFAULT_FRONTIER_MODELS });
    const report = registry.eligible(NO_REQUIREMENTS);
    expect(report.eligible.map((model) => model.modelId)).not.toContain(
      "voyageai/rerank-2.5-lite",
    );
    // As shipped it is disabled, and that is the first honest reason reported.
    expect(
      report.rejected.find(
        (rejected) => rejected.modelId === "voyageai/rerank-2.5-lite",
      )?.reasonCode,
    ).toBe("disabled");

    // Enabling it would not make it a candidate either: the role gate is the reason
    // that survives an operator flipping the flag, which is the whole point of the role.
    const enabled = createModelRegistry({
      models: DEFAULT_FRONTIER_MODELS.map((model) =>
        model.modelId === "voyageai/rerank-2.5-lite"
          ? { ...model, enabled: true }
          : model,
      ),
    });
    const enabledReport = enabled.eligible(NO_REQUIREMENTS);
    expect(enabledReport.eligible.map((model) => model.modelId)).not.toContain(
      "voyageai/rerank-2.5-lite",
    );
    const rejection = enabledReport.rejected.find(
      (rejected) => rejected.modelId === "voyageai/rerank-2.5-lite",
    );
    expect(rejection?.reasonCode).toBe("role-mismatch");
    expect(rejection?.missing).toContain("role:retrieval");
  });

  it("leaves undocumented numbers unknown rather than estimating them", () => {
    // If a context window, an output limit or a response shape is ever added to the
    // catalog it must arrive with a source. This test exists so that adding one is a
    // deliberate act rather than a drift into plausible-looking numbers.
    for (const model of DEFAULT_FRONTIER_MODELS) {
      expect(model.contextLimit, model.modelId).toBeUndefined();
      expect(model.maxOutputTokens, model.modelId).toBeUndefined();
      expect(model.responseCompatibility, model.modelId).toBeUndefined();
      expect(model.health, model.modelId).toBe("unknown");
      expect(model.operational?.rateLimitClass, model.modelId).toBeUndefined();
    }
  });

  it("declares the free tier only where the id is the vendor's free variant", () => {
    for (const model of DEFAULT_FRONTIER_MODELS) {
      if (model.operational?.free === true) {
        expect(model.modelId.endsWith(":free"), model.modelId).toBe(true);
      } else {
        // Absent is unknown, never "paid": the retrieval model declares no tier.
        expect(model.operational?.free, model.modelId).toBeUndefined();
      }
    }
  });

  it("carries model knowledge, and no credential or response material", () => {
    const serialized = JSON.stringify(DEFAULT_FRONTIER_MODELS);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(serialized).not.toContain("Bearer");
    for (const model of DEFAULT_FRONTIER_MODELS) {
      expect(model.providerId, model.modelId).toBe("openrouter");
    }
    const keys = new Set(
      DEFAULT_FRONTIER_MODELS.flatMap((model) => Object.keys(model)),
    );
    for (const forbidden of [
      "content",
      "prompt",
      "messages",
      "output",
      "completion",
      "response",
    ]) {
      expect([...keys], forbidden).not.toContain(forbidden);
    }
  });

  it("supplies candidates and never a winner", () => {
    // The registry's entire API surface: knowledge about models, plus an eligibility
    // question. There is deliberately no `select`, `best` or `rank`, because choosing
    // is the decision layer's job and this layer holds no opinion about it.
    const registry = createModelRegistry({ models: DEFAULT_FRONTIER_MODELS });
    expect(Object.keys(registry).sort()).toEqual([
      "eligible",
      "get",
      "id",
      "list",
      "noteHealth",
      "snapshot",
    ]);
    const { eligible } = registry.eligible({
      requiredCapabilities: ["reasoning"],
      inputModalities: [],
      outputModalities: [],
    });
    expect(eligible.length).toBeGreaterThan(1);
  });
});

describe("capability matching across the catalog", () => {
  const registry = createModelRegistry({ models: DEFAULT_FRONTIER_MODELS });

  it("offers only vision-capable models to a vision requirement", () => {
    const { eligible, rejected } = registry.eligible({
      requiredCapabilities: ["vision"],
      inputModalities: ["image"],
      outputModalities: ["text"],
    });
    expect(eligible.map((model) => model.modelId).sort()).toEqual([
      "inclusionai/ling-3.0-flash-vl:free",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      "thinkingmachines/inkling:free",
    ]);
    expect(
      rejected.find((entry) => entry.modelId === "cohere/north-mini-code:free")
        ?.missing,
    ).toContain("capability:vision");
  });

  it("offers only computer-use models to a computer-use requirement", () => {
    const { eligible, rejected } = registry.eligible({
      requiredCapabilities: ["computerUse"],
      inputModalities: [],
      outputModalities: [],
    });
    expect(eligible.map((model) => model.modelId)).toEqual([
      "nex-agi/nex-n2.5-pro:free",
    ]);
    expect(
      rejected.find(
        (entry) => entry.modelId === "nvidia/nemotron-3-ultra-550b-a55b:free",
      )?.missing,
    ).toContain("capability:computerUse");
  });

  it("does not present a model without structured output as an equivalent", () => {
    const { eligible, rejected } = registry.eligible({
      requiredCapabilities: ["structuredOutput"],
      inputModalities: [],
      outputModalities: [],
    });
    expect(eligible.map((model) => model.modelId).sort()).toEqual([
      "inclusionai/ling-3.0-flash-fin:free",
      "inclusionai/ling-3.0-flash-vl:free",
    ]);
    expect(
      rejected.find((entry) => entry.modelId === "poolside/laguna-s-2.1:free")
        ?.missing,
    ).toContain("capability:structuredOutput");
  });

  it("matches specializations on their own axis, and only when declared", () => {
    const specialist = frontierModel({
      modelId: "vendor/fin-specialist:free",
      providerId: "openrouter",
      capabilities: ["general", "reasoning"],
      specializations: ["finance"],
    });
    const generalist = frontierModel({
      modelId: "vendor/generalist:free",
      providerId: "openrouter",
      capabilities: ["general", "reasoning"],
    });
    const requirements = {
      requiredCapabilities: ["reasoning"] as const,
      requiredSpecializations: ["finance"],
      inputModalities: [] as const,
      outputModalities: [] as const,
    };
    expect(modelSatisfies(specialist, requirements).ok).toBe(true);
    const refused = modelSatisfies(generalist, requirements);
    expect(refused.ok).toBe(false);
    expect(refused.missing).toContain("specialization:finance");
    // Nothing in this catalog declares a domain specialisation, so a finance
    // requirement finds nothing rather than the nearest general-purpose model.
    expect(registry.eligible(requirements).eligible).toEqual([]);
  });
});

/**
 * Operational metadata: lifecycle, tier and response shape.
 *
 * The rule these tests defend is that an absent field is *unknown*, never a negative
 * fact — and that a field which is declared is validated against a closed vocabulary,
 * so a typo in configuration is an error rather than an unclassified model.
 */
describe("operational metadata", () => {
  const BASE = {
    modelId: "vendor/model:free",
    providerId: "openrouter",
    displayName: "Model",
    capabilities: ["general"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    enabled: true,
  };

  it("accepts declared lifecycle, tier and rate-limit class", () => {
    const profile = assertModelProfile({
      ...BASE,
      operational: {
        free: true,
        status: "going-away",
        sunsetAt: "2026-09-30",
        rateLimitClass: "shared-free-pool",
      },
    });
    expect(profile.operational).toEqual({
      free: true,
      status: "going-away",
      sunsetAt: "2026-09-30",
      rateLimitClass: "shared-free-pool",
    });
  });

  it("leaves unknown metadata absent, and never defaults it to false", () => {
    const profile = assertModelProfile(BASE);
    expect(profile.operational).toBeUndefined();
    expect(profile.toolCalling).toBeUndefined();
    expect(profile.structuredOutput).toBeUndefined();
    expect(profile.responseCompatibility).toBeUndefined();
    expect(profile.specializations).toBeUndefined();
    expect(profile.role).toBeUndefined();
    // An undeclared role means an executable model, not an unusable one.
    expect(roleOf(profile)).toBe("generative");
  });

  it("accepts a declared retrieval role with its specializations", () => {
    const profile = assertModelProfile({
      ...BASE,
      role: "retrieval",
      specializations: ["relevance-ranking"],
      capabilities: [],
      outputModalities: [],
    });
    expect(roleOf(profile)).toBe("retrieval");
    expect(profile.specializations).toEqual(["relevance-ranking"]);
  });

  it("rejects a lifecycle state outside the vocabulary", () => {
    expect(() =>
      assertModelProfile({ ...BASE, operational: { status: "retired" } }),
    ).toThrowError(/operational.status must be one of/);
  });

  it("rejects a sunset date that is not a date", () => {
    expect(() =>
      assertModelProfile({
        ...BASE,
        operational: { status: "going-away", sunsetAt: "soon" },
      }),
    ).toThrowError(/must be an ISO date/);
  });

  it("rejects a tier that is not a boolean", () => {
    expect(() =>
      assertModelProfile({ ...BASE, operational: { free: "yes" } }),
    ).toThrowError(/operational.free must be a boolean/);
  });

  it("rejects a specialization outside the vocabulary", () => {
    expect(() =>
      assertModelProfile({ ...BASE, specializations: ["astrology"] }),
    ).toThrowError(/specializations\[0\] must be one of/);
  });

  it("rejects a role outside the vocabulary", () => {
    expect(() => assertModelProfile({ ...BASE, role: "oracle" })).toThrowError(
      /role must be one of/,
    );
  });

  it("rejects a response compatibility block that is not made of booleans", () => {
    expect(() =>
      assertModelProfile({
        ...BASE,
        responseCompatibility: { supportsTextContent: "sometimes" },
      }),
    ).toThrowError(
      /responseCompatibility.supportsTextContent must be a boolean/,
    );
  });

  it("rejects a declared output limit outside the permitted range", () => {
    expect(() =>
      assertModelProfile({ ...BASE, maxOutputTokens: 5_000_000 }),
    ).toThrowError(/maxOutputTokens must be at most/);
  });

  it("orders declared lifecycle states, and never treats undeclared as declined", () => {
    expect(lifecycleRank(undefined)).toBe(lifecycleRank("active"));
    expect(lifecycleRank("experimental")).toBeGreaterThan(
      lifecycleRank("active"),
    );
    expect(lifecycleRank("deprecated")).toBeGreaterThan(
      lifecycleRank("experimental"),
    );
    expect(lifecycleRank("going-away")).toBeGreaterThan(
      lifecycleRank("deprecated"),
    );
  });
});

describe("the vocabulary", () => {
  it("keeps routing to declared capabilities only", () => {
    for (const capability of MODEL_CAPABILITIES) {
      const profile: ModelProfile = frontierModel({
        modelId: `vendor/${capability}`,
        providerId: "p",
        capabilities: [capability],
      });
      expect(modelSatisfies(profile, { ...NO_REQUIREMENTS }).ok).toBe(true);
    }
    expect(latencyRank("fast")).toBeLessThan(latencyRank("slow"));
    expect(projectId("prj").startsWith("prj")).toBe(true);
  });
});
