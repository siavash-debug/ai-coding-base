import { spawn } from "node:child_process";

import { type Clock, durationMsFrom, toIsoString } from "../../core/clock.js";
import { assertPositiveInteger } from "../../core/validation.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../ports/process-runner.js";

/**
 * The default `ProcessRunner`: one child, argv, no shell.
 *
 * Two deliberate choices:
 *
 * - **`shell: false`.** The platform builds every argv itself and never inserts
 *   task text into a command name, but not using a shell removes the entire class
 *   of quoting and injection bugs rather than relying on that discipline.
 * - **The clock is injected.** A duration measured with `Date.now()` would make
 *   this adapter the one non-deterministic thing in an otherwise reproducible
 *   selection, and would make its tests time-dependent.
 *
 * Output is capped while it is being read, not after: a command that prints a
 * gigabyte must not become a gigabyte of string. Exceeding the cap truncates and
 * the result stays usable, because a truncated listing is still evidence.
 *
 * See docs/architecture/V2-ARCHITECTURE.md §36.7 and DECISIONS.md ADR-042.
 */
export const DEFAULT_PROCESS_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
export const NODE_PROCESS_RUNNER_ID = "node-child-process";

export interface NodeProcessRunnerOptions {
  readonly clock: Clock;
  readonly runnerId?: string;
  readonly defaultTimeoutMs?: number;
  readonly defaultMaxOutputBytes?: number;
}

export function createNodeProcessRunner(
  options: NodeProcessRunnerOptions,
): ProcessRunner {
  const defaultTimeoutMs =
    options.defaultTimeoutMs ??
    assertPositiveInteger(DEFAULT_PROCESS_TIMEOUT_MS, "defaultTimeoutMs");
  const defaultMaxOutputBytes =
    options.defaultMaxOutputBytes ??
    assertPositiveInteger(DEFAULT_MAX_OUTPUT_BYTES, "defaultMaxOutputBytes");

  return {
    id: options.runnerId ?? NODE_PROCESS_RUNNER_ID,

    async run(request: ProcessRequest): Promise<ProcessResult> {
      const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
      const maxOutputBytes = request.maxOutputBytes ?? defaultMaxOutputBytes;
      const startedAt = options.clock.now();

      const elapsed = (): number =>
        durationMsFrom(
          toIsoString(startedAt),
          toIsoString(options.clock.now()),
        );

      return await new Promise<ProcessResult>((resolve) => {
        let settled = false;
        let timedOut = false;
        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;

        const finish = (result: Omit<ProcessResult, "durationMs">): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve({ ...result, durationMs: elapsed() });
        };

        let child;
        try {
          child = spawn(request.command, [...request.args], {
            cwd: request.cwd,
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          // `spawn` throws synchronously for an invalid cwd on some platforms.
          finish({
            ok: false,
            stdout: "",
            stderr: "",
            timedOut: false,
            spawnFailed: true,
          });
          return;
        }

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        // A pending timer must not hold the event loop open on a long-lived host.
        if (typeof timer.unref === "function") {
          timer.unref();
        }

        child.stdout?.on("data", (chunk: Buffer) => {
          if (stdoutBytes >= maxOutputBytes) {
            return;
          }
          stdoutBytes += chunk.byteLength;
          stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderrBytes >= maxOutputBytes) {
            return;
          }
          stderrBytes += chunk.byteLength;
          stderr += chunk.toString("utf8");
        });

        child.on("error", () => {
          finish({
            ok: false,
            stdout,
            stderr,
            timedOut,
            spawnFailed: true,
          });
        });

        child.on("close", (code) => {
          finish({
            ok: code === 0 && !timedOut,
            ...(code === null ? {} : { exitCode: code }),
            stdout,
            stderr,
            timedOut,
            spawnFailed: false,
          });
        });
      });
    },
  };
}
