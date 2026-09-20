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

/** Exit codes are a contract: 0 ok, 1 failure, 2 usage error. */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
