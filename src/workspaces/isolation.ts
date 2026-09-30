import { DomainError } from "../core/errors.js";
import { assertOneOf } from "../core/validation.js";

/**
 * Isolation is a DECLARED capability profile, not a technology choice.
 *
 * `mode` is what the workspace requests; `enforcement` is what the active adapter
 * can actually deliver. Honest reporting beats optimistic reporting: claiming an
 * unenforced boundary is a defect, not a rounding error.
 * See docs/architecture/V2-ARCHITECTURE.md §5, §19 and DECISIONS.md ADR-010.
 */
export const ISOLATION_MODES = [
  "none",
  "shared",
  "scoped",
  "process",
  "container",
  "sandbox",
  "vm",
] as const;

export type IsolationMode = (typeof ISOLATION_MODES)[number];

export const ISOLATION_ENFORCEMENT_LEVELS = [
  "enforced",
  "declared",
  "unsupported",
] as const;

export type IsolationEnforcement =
  (typeof ISOLATION_ENFORCEMENT_LEVELS)[number];

export const ISOLATION_DIMENSIONS = [
  "filesystem",
  "git",
  "processes",
  "dependencies",
  "environment",
  "secrets",
  "network",
  "aiContext",
  "aiMemory",
  "taskHistory",
  "telemetry",
  "resourceLimits",
] as const;

export type IsolationDimensionName = (typeof ISOLATION_DIMENSIONS)[number];

export interface IsolationDimension {
  readonly mode: IsolationMode;
  readonly enforcement: IsolationEnforcement;
  readonly note?: string;
}

export type IsolationProfile = Readonly<
  Record<IsolationDimensionName, IsolationDimension>
>;

/**
 * Dimensions where an unenforced boundary is a security finding rather than a
 * presentation detail.
 */
export const HIGH_CONSEQUENCE_DIMENSIONS = [
  "filesystem",
  "processes",
  "environment",
  "secrets",
  "network",
  "resourceLimits",
] as const satisfies readonly IsolationDimensionName[];

const dimension = (
  mode: IsolationMode,
  enforcement: IsolationEnforcement = "declared",
): IsolationDimension => ({ mode, enforcement });

/**
 * Isolation by default, access by explicit permission: the default profile is
 * restrictive, not permissive.
 */
export function defaultIsolationProfile(): IsolationProfile {
  return {
    filesystem: dimension("scoped"),
    git: dimension("scoped"),
    processes: dimension("process"),
    dependencies: dimension("scoped"),
    environment: dimension("scoped"),
    secrets: dimension("scoped"),
    network: dimension("none"),
    aiContext: dimension("scoped"),
    aiMemory: dimension("scoped"),
    taskHistory: dimension("scoped"),
    telemetry: dimension("scoped"),
    resourceLimits: dimension("scoped"),
  };
}

/**
 * Default profile with specific dimensions overridden. Existing enforcement
 * levels are preserved so a mode change cannot silently claim enforcement.
 */
export function withIsolationModes(
  profile: IsolationProfile,
  overrides: Partial<Record<IsolationDimensionName, IsolationMode>>,
): IsolationProfile {
  const next: Partial<Record<IsolationDimensionName, IsolationDimension>> = {};
  for (const name of ISOLATION_DIMENSIONS) {
    const override = overrides[name];
    next[name] =
      override === undefined
        ? profile[name]
        : { ...profile[name], mode: override };
  }
  return validateIsolationProfile(next as IsolationProfile);
}

export function isolationDimension(
  profile: IsolationProfile,
  name: IsolationDimensionName,
): IsolationDimension {
  return profile[name];
}

export function isDimensionEnforced(
  profile: IsolationProfile,
  name: IsolationDimensionName,
): boolean {
  return profile[name].enforcement === "enforced";
}

/** Dimensions whose boundary is not independently enforced, in profile order. */
export function unenforcedDimensions(
  profile: IsolationProfile,
): readonly IsolationDimensionName[] {
  return ISOLATION_DIMENSIONS.filter(
    (name) => !isDimensionEnforced(profile, name),
  );
}

/**
 * Findings that must be surfaced to the user (e.g. by `ai doctor`): a
 * high-consequence boundary that is merely declared or unsupported.
 */
export function isolationFindings(
  profile: IsolationProfile,
): readonly string[] {
  const findings: string[] = [];
  for (const name of ISOLATION_DIMENSIONS) {
    const entry = profile[name];
    const highConsequence = HIGH_CONSEQUENCE_DIMENSIONS.includes(
      name as (typeof HIGH_CONSEQUENCE_DIMENSIONS)[number],
    );
    if (!highConsequence || entry.enforcement === "enforced") {
      continue;
    }
    findings.push(
      `${name}: mode "${entry.mode}" is ${entry.enforcement}, not independently enforced`,
    );
  }
  return findings;
}

export function validateIsolationProfile(
  profile: IsolationProfile,
): IsolationProfile {
  if (typeof profile !== "object" || profile === null) {
    throw new DomainError("VALIDATION", "isolation must be an object", {
      field: "isolation",
    });
  }
  for (const name of ISOLATION_DIMENSIONS) {
    const entry = (profile as Record<string, unknown>)[name];
    if (typeof entry !== "object" || entry === null) {
      throw new DomainError(
        "VALIDATION",
        `isolation.${name} must be an object`,
        { field: `isolation.${name}` },
      );
    }
    const candidate = entry as Record<string, unknown>;
    assertOneOf(candidate["mode"], ISOLATION_MODES, `isolation.${name}.mode`);
    assertOneOf(
      candidate["enforcement"],
      ISOLATION_ENFORCEMENT_LEVELS,
      `isolation.${name}.enforcement`,
    );
    if (
      candidate["note"] !== undefined &&
      typeof candidate["note"] !== "string"
    ) {
      throw new DomainError(
        "VALIDATION",
        `isolation.${name}.note must be a string`,
        { field: `isolation.${name}.note` },
      );
    }
  }
  return profile;
}
