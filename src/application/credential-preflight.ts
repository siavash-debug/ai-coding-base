import type {
  DecisionConfig,
  FrontierConfig,
  LlmConfig,
} from "../adapters/config/project-config.js";
import { DomainError } from "../core/errors.js";
import type { Environment } from "../ports/environment.js";

/**
 * Credential preflight: fail before any provider work starts, never after.
 *
 * A missing credential is the one configuration mistake that cannot be discovered
 * cheaply at the point of use. Every adapter reads its variable at call time and
 * fails with `auth`, which is correct but late: a task has already been claimed, a
 * session opened, a context selection spent and a decision asked — and the operator
 * learns about an unset variable from a categorised failure in the middle of a run.
 * This module answers the same question *before* the first step: which credentials
 * does this runtime actually need, and are they present?
 *
 * Three properties are deliberate:
 *
 * - **Requirements are derived, not listed by hand.** Only a provider that this
 *   runtime would really call contributes a requirement: the offline LLM provider
 *   needs none, a decision layer that is disabled needs none, and a frontier
 *   provider with routing off or no enabled model needs none — there is nothing its
 *   credential could pay for.
 * - **Presence is a boolean.** The report says *set* or *not set* per variable. It
 *   never reports a length, a prefix, a suffix or a fingerprint, so a preflight can
 *   be printed, logged or attached to an issue without leaking a credential. This is
 *   deliberately stricter than `ai doctor`, which exists to help an operator confirm
 *   *which* key they exported.
 * - **The message names the variable and the provider, never the value.** A failure
 *   is a `VALIDATION` domain error whose details carry variable names only, so it can
 *   travel through the CLI, the event log and a bug report unchanged.
 *
 * The requirements are computed once, in the composition root, from the same
 * configuration the adapters were built from (ADR-022) — so the check cannot drift
 * away from what was actually wired.
 */

/** Which layer a credential belongs to. Never a fallback ordering. */
export type ProviderRole = "llm" | "decision" | "frontier";

export interface CredentialRequirement {
  readonly role: ProviderRole;
  readonly providerId: string;
  /** The name of the environment variable holding the credential. Never a value. */
  readonly variable: string;
}

export interface CredentialStatus extends CredentialRequirement {
  readonly present: boolean;
}

export interface CredentialReport {
  readonly requirements: readonly CredentialStatus[];
  readonly missing: readonly CredentialStatus[];
  readonly ok: boolean;
}

export interface CredentialRequirementInput {
  readonly llm: LlmConfig;
  readonly decision: DecisionConfig;
  /**
   * The decision provider this runtime installed, when one is installed at all.
   *
   * Absent means "the engine answers every question deterministically", which is a
   * supported state that needs no credential.
   */
  readonly decisionProviderId?: string;
  readonly frontier: FrontierConfig;
  /** Provider ids this runtime actually built an adapter for. */
  readonly frontierProviderIds: readonly string[];
}

/**
 * Which credentials this runtime will need.
 *
 * One rule per role, each of them "only if it could really be used":
 *
 * - the LLM provider needs a credential only when it is a real provider (the offline
 *   provider is the default and reads nothing);
 * - the decision layer needs one only when a provider is installed *and* the
 *   configuration names a variable — a provider injected by configuration that says
 *   `disabled` is an embedding, not a credential;
 * - a frontier provider needs one only when routing is enabled, an adapter for it was
 *   built, and at least one of its registered models is enabled.
 *
 * The result is ordered by role and provider id, so two runs of the same
 * configuration produce the same list.
 */
export function providerCredentialRequirements(
  input: CredentialRequirementInput,
): readonly CredentialRequirement[] {
  const requirements: CredentialRequirement[] = [];

  if (input.llm.provider !== "simulated") {
    requirements.push({
      role: "llm",
      providerId: input.llm.provider,
      variable: input.llm.credentialEnvVar,
    });
  }

  if (
    input.decision.provider !== "disabled" &&
    input.decisionProviderId !== undefined
  ) {
    requirements.push({
      role: "decision",
      providerId: input.decisionProviderId,
      variable: input.decision.credentialEnvVar,
    });
  }

  if (input.frontier.enabled) {
    for (const provider of input.frontier.providers) {
      if (!input.frontierProviderIds.includes(provider.id)) {
        continue;
      }
      const served = input.frontier.models.filter(
        (model) => model.providerId === provider.id && model.enabled,
      );
      if (served.length === 0) {
        continue;
      }
      requirements.push({
        role: "frontier",
        providerId: provider.id,
        variable: provider.credentialEnvVar,
      });
    }
  }

  return requirements;
}

/**
 * Checks presence, one read per variable, without ever keeping a value.
 *
 * An empty string is *not* present: the platform's loaders deliberately treat an
 * empty entry as a declaration with no value, and an adapter would refuse it anyway.
 */
export function credentialReport(
  requirements: readonly CredentialRequirement[],
  environment: Environment,
): CredentialReport {
  const statuses = requirements.map((requirement) => {
    const value = environment.get(requirement.variable);
    return {
      ...requirement,
      present: value !== undefined && value.length > 0,
    };
  });
  const missing = statuses.filter((status) => !status.present);
  return { requirements: statuses, missing, ok: missing.length === 0 };
}

export interface MissingCredentialMessageOptions {
  /**
   * What to do about it, appended once after the facts.
   *
   * Passed in by the caller so this module stays unaware of how a credential is
   * provided — the CLI can mention `.env.local`, an embedding cannot.
   */
  readonly hint?: string;
}

/** Names and providers only. Never a value, a length or a fingerprint. */
export function missingCredentialMessage(
  missing: readonly CredentialStatus[],
  options: MissingCredentialMessageOptions = {},
): string {
  const facts = missing
    .map(
      (status) =>
        `provider "${status.providerId}" (${status.role}) needs environment ` +
        `variable ${status.variable}, which is not set`,
    )
    .join("; ");
  return options.hint === undefined ? facts : `${facts}; ${options.hint}`;
}

/**
 * Throws unless every required credential is present.
 *
 * `VALIDATION` rather than a new code: this is the configuration being unusable, and
 * callers already branch on that code for every other malformed configuration. The
 * details carry the variable and provider names so a caller can render its own
 * message without ever touching a value.
 */
export function assertProviderCredentials(
  report: CredentialReport,
  options: MissingCredentialMessageOptions = {},
): void {
  if (report.ok) {
    return;
  }
  throw new DomainError(
    "VALIDATION",
    missingCredentialMessage(report.missing, options),
    {
      field: "credentialEnvVar",
      variables: report.missing.map((status) => status.variable),
      providers: report.missing.map((status) => status.providerId),
    },
  );
}
