import { DomainError } from "../../core/errors.js";
import { matchesPathPattern } from "../../context/ignore.js";
import type { PolicyReasonCode } from "../../policy/reason.js";
import type { Environment } from "../../ports/environment.js";
import type { OperationRefusal } from "../../ports/operation.js";

/**
 * The environment boundary.
 *
 * `Environment` is the platform's own read-only handle on the process environment —
 * used to look up a credential named in configuration. Handing that directly to an
 * operation would mean every variable, including every credential the platform can
 * see, is one call away. This wrapper is what an operation gets instead: a name is
 * answered only if policy lists it and no denial pattern matches it.
 *
 * It is deliberately *not* a filter over `process.env`: the underlying port exposes
 * a single `get(name)`, so there is no enumeration to leak, and this layer refuses
 * before delegating rather than delegating and then hiding the answer.
 */
export interface AllowlistedEnvironmentOptions {
  readonly environment: Environment;
  readonly allowedVariables: readonly string[];
  readonly deniedPatterns: readonly string[];
}

export interface AllowlistedEnvironment {
  readonly id: string;
  admitVariable(name: string): OperationRefusal | undefined;
  read(name: string): { readonly present: boolean; readonly value?: string };
}

const refusal = (
  reasonCode: PolicyReasonCode,
  reason: string,
): OperationRefusal => ({ reasonCode, reason });

export function createAllowlistedEnvironment(
  options: AllowlistedEnvironmentOptions,
): AllowlistedEnvironment {
  function admitVariable(name: string): OperationRefusal | undefined {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return refusal(
        "TARGET_REFUSED",
        "an environment target must be a variable NAME",
      );
    }
    const denied = options.deniedPatterns.find((pattern) =>
      pattern.includes("*")
        ? matchesPathPattern(pattern, name)
        : pattern === name,
    );
    if (denied !== undefined) {
      return refusal(
        "POLICY_DENIED",
        `environment variable "${name}" matches denied pattern "${denied}"`,
      );
    }
    if (!options.allowedVariables.includes(name)) {
      return refusal(
        "TARGET_NOT_ALLOWED",
        `environment variable "${name}" is not on policy.environment.allowedVariables`,
      );
    }
    return undefined;
  }

  return {
    id: "allowlisted-environment",
    admitVariable,
    read(name) {
      const admitted = admitVariable(name);
      if (admitted !== undefined) {
        // Fail closed *and* quietly: a refusal here must not reveal whether the
        // variable exists.
        return { present: false };
      }
      const value = options.environment.get(name);
      if (value === undefined) {
        return { present: false };
      }
      return { present: true, value };
    },
  };
}

/**
 * The environment a *child process* is given.
 *
 * Separate from the operation-facing wrapper above because the questions differ: an
 * operation asks for one named variable, while a child is handed a whole environment
 * object. Only allowlisted names are copied, and the result never includes anything
 * the platform did not explicitly list.
 */
export function filteredChildEnvironment(
  host: Readonly<Record<string, string | undefined>>,
  allowlist: readonly string[],
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const name of allowlist) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new DomainError(
        "VALIDATION",
        `"${name}" is not a usable environment variable name`,
        { field: "policy.process.environmentAllowlist" },
      );
    }
    const value = host[name];
    if (typeof value === "string") {
      environment[name] = value;
    }
  }
  return environment;
}
