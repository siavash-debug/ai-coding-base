import type { Clock } from "../core/clock.js";

/**
 * Everything the CLI is allowed to know about the outside world.
 *
 * Injecting stdout/stderr, the working directory, the clock and the runtime
 * version is what makes command behaviour testable without spawning a process,
 * faking a terminal, or depending on the machine running the tests.
 */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export interface CliEnv {
  /** Project root; the CLI resolves everything relative to this. */
  readonly cwd: string;
  readonly clock: Clock;
  readonly runtimeVersion: string;
  readonly platform: string;
}

/**
 * Exit codes are a contract (V2-ARCHITECTURE §25.2).
 *
 * `0`/`1`/`2` are universal: success, general failure (including an unexpected
 * domain error), and usage/argument error. `3`/`4`/`5` are *task execution
 * outcomes* — a policy denial, a budget stop, or a suspension waiting on a human —
 * and are produced only where an execution result reports them, never inferred
 * from rendered text.
 *
 * `ai policy --check` deliberately keeps its own `0`/`1`/`2` query contract
 * (allowed / denied-or-approval-required / uninterpretable): it evaluates a
 * hypothetical operation and performs nothing, so it is a query, not a run.
 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_POLICY_DENIED = 3;
export const EXIT_BUDGET_EXCEEDED = 4;
export const EXIT_APPROVAL_REQUIRED = 5;
