import { redactSecretLikeValues } from "../core/validation.js";

/**
 * Environment port: the process environment, reduced to a single read.
 *
 * Credentials are read through this port and never stored: a project config names
 * the *variable* that holds a key (`.ai/project.json` is committed), and the value
 * is read at call time, used for one request, and dropped. Tests inject a fake
 * environment, so no test can accidentally read a real credential.
 *
 * There is deliberately no `list()`/`all()`: a whole-environment read is how
 * secrets end up in logs and traces.
 */
export interface Environment {
  readonly id: string;
  get(name: string): string | undefined;
}

export function createProcessEnvironment(): Environment {
  return {
    id: "process",
    get: (name) => process.env[name],
  };
}

export function createFixedEnvironment(
  values: Readonly<Record<string, string>>,
): Environment {
  return {
    id: "fixed",
    get: (name) => values[name],
  };
}

/**
 * Reports whether a credential is present without ever revealing it. The only
 * things a caller learns are: present or absent, and a non-reversible fingerprint
 * suffix that is safe to compare and safe to print.
 */
export interface CredentialPresence {
  readonly name: string;
  readonly present: boolean;
  /** Last four characters, for operator confirmation only. Never a prefix. */
  readonly fingerprint?: string;
  readonly length?: number;
}

export function describeCredential(
  environment: Environment,
  name: string,
): CredentialPresence {
  const value = environment.get(name);
  if (value === undefined || value.length === 0) {
    return { name, present: false };
  }
  // A shape check that never returns the value itself.
  return {
    name,
    present: true,
    fingerprint: value.length <= 4 ? "…" : `…${value.slice(-4)}`,
    length: value.length,
  };
}

/** Operator-facing rendering of a credential check. Never includes the value. */
export function formatCredentialPresence(presence: CredentialPresence): string {
  if (!presence.present) {
    return `${presence.name} is not set`;
  }
  return `${presence.name} is set (${presence.length ?? 0} characters, ending ${presence.fingerprint ?? "…"})`;
}

/** Guards a value that is about to be shown to an operator. */
export function safeForOperator(text: string): string {
  return redactSecretLikeValues(text, 300);
}
