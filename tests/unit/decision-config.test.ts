import { describe, expect, it } from "vitest";

import {
  DEFAULT_DECISION_CONFIG,
  assertDecisionConfig,
} from "../../src/adapters/config/project-config.js";
import { hasDomainErrorCode } from "../../src/core/errors.js";
import { DEFAULT_COMPLETION_CONFIDENCE_THRESHOLD } from "../../src/decisions/domains.js";

/**
 * The decision configuration contract.
 *
 * The interesting field is the completion confidence threshold, because it is the one
 * piece of decision *policy* that lives in configuration: it decides how often a
 * confident "done" is accepted and how often a human is asked instead. Two properties
 * are asserted here rather than assumed —
 *
 * - **it can never be absent.** A gate that silently disappeared whenever its threshold
 *   was omitted would be a safety invariant that depends on someone remembering to
 *   declare it, so the parser always resolves one.
 * - **it is bounded**, because a number outside `[0, 1]` is not a threshold and a
 *   non-number is not a policy. Both are refused rather than coerced.
 */

const TYPESAFE = {
  provider: "typesafe",
  credentialEnvVar: "TYPESAFE_API_KEY",
} as const;

describe("decision configuration: the completion confidence threshold", () => {
  it("resolves a threshold even when the project declares none", () => {
    expect(assertDecisionConfig(undefined).minCompletionConfidence).toBe(
      DEFAULT_COMPLETION_CONFIDENCE_THRESHOLD,
    );
    expect(
      assertDecisionConfig({ provider: "disabled" }).minCompletionConfidence,
    ).toBe(DEFAULT_COMPLETION_CONFIDENCE_THRESHOLD);
    expect(DEFAULT_DECISION_CONFIG.minCompletionConfidence).toBe(
      DEFAULT_COMPLETION_CONFIDENCE_THRESHOLD,
    );
  });

  it("keeps the default inside the unit interval", () => {
    const threshold = DEFAULT_COMPLETION_CONFIDENCE_THRESHOLD;
    expect(Number.isFinite(threshold)).toBe(true);
    expect(threshold).toBeGreaterThan(0);
    expect(threshold).toBeLessThanOrEqual(1);
  });

  it("accepts an explicit threshold on every provider variant", () => {
    // The threshold is a shared limit rather than a per-provider option, so an operator
    // can tighten it without changing which decision layer is installed.
    for (const config of [
      { provider: "disabled" },
      TYPESAFE,
      {
        provider: "jev-http",
        baseUrl: "https://jev.internal/v1",
        credentialEnvVar: "JEV_API_KEY",
      },
    ] as const) {
      expect(
        assertDecisionConfig({ ...config, minCompletionConfidence: 0.55 })
          .minCompletionConfidence,
      ).toBe(0.55);
    }
  });

  it("accepts the inclusive boundaries", () => {
    for (const threshold of [0, 1]) {
      expect(
        assertDecisionConfig({
          ...TYPESAFE,
          minCompletionConfidence: threshold,
        }).minCompletionConfidence,
      ).toBe(threshold);
    }
  });

  it("refuses a threshold outside the unit interval", () => {
    for (const threshold of [
      1.5,
      -0.1,
      2,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      let caught: unknown;
      try {
        assertDecisionConfig({
          ...TYPESAFE,
          minCompletionConfidence: threshold,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught, `threshold ${String(threshold)}`).toBeDefined();
      expect(
        hasDomainErrorCode(caught, "VALIDATION"),
        `threshold ${String(threshold)}`,
      ).toBe(true);
    }
  });

  it("refuses a threshold that is not a number", () => {
    for (const threshold of ["0.8", true, {}, []]) {
      let caught: unknown;
      try {
        assertDecisionConfig({
          ...TYPESAFE,
          minCompletionConfidence: threshold,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught, `threshold ${JSON.stringify(threshold)}`).toBeDefined();
      expect(
        hasDomainErrorCode(caught, "VALIDATION"),
        `threshold ${JSON.stringify(threshold)}`,
      ).toBe(true);
    }
  });
});
