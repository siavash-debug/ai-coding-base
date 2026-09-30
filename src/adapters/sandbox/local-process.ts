import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

import { type Clock, durationMsFrom, toIsoString } from "../../core/clock.js";
import { matchesPathPattern } from "../../context/ignore.js";
import { isWithinRoot, resolveRef } from "../../policy/path-boundary.js";
import type { PolicyReasonCode } from "../../policy/reason.js";
import { assertWorkspaceRef, safeCommandName } from "../../policy/target.js";
import type { BoundaryScope, OperationRefusal } from "../../ports/operation.js";

/**
 * The local process boundary.
 *
 * Requirements it exists to satisfy, in order of importance:
 *
 * 1. **No shell, ever.** `spawn` is called with an argument array, so a task title
 *    containing `; rm -rf /` is a value in an argv slot and never a program. There
 *    is no `shell: true` on any code path, and the type of the options object here
 *    has no field that could turn one on.
 * 2. **A filtered environment.** A child receives *only* the variables policy
 *    allows, plus a minimal non-secret baseline (`PATH`-free by default). Without
 *    this, every credential the platform holds would be inherited by every command
 *    it runs, which is how a build script exfiltrates a token.
 * 3. **A working-directory fence.** `cwd` is a workspace-relative reference,
 *    resolved and `realpath`-checked, exactly like a file read; a command may not be
 *    started outside the workspace it belongs to.
 * 4. **Bounded.** A hard timeout kills the child, and captured output is capped, so
 *    a hung or noisy process cannot become a hung or unbounded operation.
 *
 * What this is *not*: a container, a namespace, a user-switch or a seccomp filter.
 * A child runs with the platform's own privileges. That is stated plainly in
 * V2-ARCHITECTURE §37 and in `ai doctor`, because overstating this boundary is worse
 * than having a small one (ADR-048).
 */
export interface LocalProcessBoundaryOptions {
  readonly scope: BoundaryScope;
  readonly maxTimeoutMs: number;
  /**
   * Programs that may be executed, and ones that never may.
   *
   * Passed in rather than looked up: there is one source (the project's policy) and
   * two enforcement points — the policy layer decides whether an operation is
   * authorised at all, and this boundary refuses a program the policy does not list
   * even if a caller reached it directly. The same pattern as the filesystem roots,
   * for the same reason: a boundary that trusted the layer above it would be one
   * refactor away from being bypassable (ADR-045).
   */
  readonly allowedCommands: readonly string[];
  readonly deniedCommands: readonly string[];
  /** Variables passed to children. Everything else is dropped. */
  readonly environmentAllowlist: readonly string[];
  readonly clock: Clock;
  /** The host environment, read once. Values are filtered before use. */
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly maxOutputBytes?: number;
  readonly platform?: string;
}

export const DEFAULT_MAX_PROCESS_OUTPUT_BYTES = 65_536;

export interface LocalProcessBoundary {
  readonly id: string;
  admitCommand(
    command: string,
    cwdRef: string | undefined,
  ): Promise<OperationRefusal | undefined>;
  /** The exact environment a child would receive. Values are never returned. */
  childEnvironmentNames(): readonly string[];
  run(request: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwdRef?: string;
    readonly timeoutMs?: number;
  }): Promise<
    | {
        readonly ok: true;
        readonly result: {
          readonly exitCode?: number;
          readonly stdout: string;
          readonly stderr: string;
          readonly durationMs: number;
          readonly timedOut: boolean;
        };
      }
    | { readonly ok: false; readonly refusal: OperationRefusal }
  >;
}

const refusal = (
  reasonCode: PolicyReasonCode,
  reason: string,
): OperationRefusal => ({ reasonCode, reason });

/**
 * Whether a policy pattern names a command.
 *
 * The same three comparisons the policy layer makes, kept in step with it by the
 * shared test in `sandbox-process.test.ts`: a glob against the reference, the exact
 * basename, or the exact reference.
 */
function commandPatternMatches(pattern: string, command: string): boolean {
  return (
    matchesPathPattern(pattern, command) ||
    pattern.toLowerCase() === safeCommandName(command).toLowerCase() ||
    pattern.toLowerCase() === command.toLowerCase()
  );
}

/**
 * Variables Node adds to a child on Windows regardless of `env`.
 *
 * Verified on Windows: `spawn(process.execPath, [...], { env: { ONLY: "x" } })` gives
 * the child these in addition to `ONLY`. They are OS facts — home directory, temp
 * path, user and domain names, the system root and `PATH` — rather than credentials,
 * and Node needs them to start a process at all, so this platform cannot remove them.
 *
 * They are listed rather than glossed over, because the guarantee has to be stated
 * precisely: *every variable this process holds is dropped unless policy allowlists
 * it; a fixed set of OS-level Windows variables survives and is not controllable by
 * policy.* Stated in V2-ARCHITECTURE §37 and reported by `ai doctor` (ADR-048).
 */
export const WINDOWS_CHILD_INHERITED_VARIABLES: readonly string[] = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
];

export function createLocalProcessBoundary(
  options: LocalProcessBoundaryOptions,
): LocalProcessBoundary {
  const platform = options.platform ?? process.platform;
  const maxOutputBytes =
    options.maxOutputBytes ?? DEFAULT_MAX_PROCESS_OUTPUT_BYTES;

  function childEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const name of options.environmentAllowlist) {
      const value = options.hostEnvironment[name];
      if (typeof value === "string") {
        environment[name] = value;
      }
    }
    return environment;
  }

  async function admitCommand(
    command: string,
    cwdRef: string | undefined,
  ): Promise<OperationRefusal | undefined> {
    let name: string;
    try {
      name = assertWorkspaceRef(command, "command");
    } catch {
      return refusal(
        "TARGET_REFUSED",
        "the command must be a program name or a workspace-relative path",
      );
    }

    // The allowlist, enforced here as well as in the policy layer. A denial is
    // checked first so an explicit denial always wins.
    const denied = options.deniedCommands.find((pattern) =>
      commandPatternMatches(pattern, name),
    );
    if (denied !== undefined) {
      return refusal(
        "POLICY_DENIED",
        `command "${safeCommandName(name)}" is denied by policy`,
      );
    }
    if (
      !options.allowedCommands.some((pattern) =>
        commandPatternMatches(pattern, name),
      )
    ) {
      return refusal(
        "TARGET_NOT_ALLOWED",
        `command "${safeCommandName(name)}" is not on policy.process.allowedCommands`,
      );
    }

    let ref: string;
    try {
      ref = cwdRef === undefined ? "." : assertWorkspaceRef(cwdRef, "cwdRef");
    } catch {
      return refusal(
        "TARGET_REFUSED",
        "the working directory must be a workspace-relative reference",
      );
    }
    const absolute = resolveRef(options.scope.workspaceRoot, ref);
    if (!isWithinRoot(options.scope.workspaceRoot, absolute, platform)) {
      return refusal(
        "RESOURCE_OUTSIDE_BOUNDARY",
        "the working directory resolves outside the workspace root",
      );
    }
    // A link in the path must not move the child out of the workspace.
    try {
      const realWorkspace = await realpath(options.scope.workspaceRoot);
      const realCwd = await realpath(absolute);
      if (!isWithinRoot(realWorkspace, realCwd, platform)) {
        return refusal(
          "SYMLINK_ESCAPE",
          "the working directory resolves outside the workspace through a link",
        );
      }
    } catch {
      return refusal(
        "UNRESOLVED_TARGET",
        `the working directory "${ref}" does not exist`,
      );
    }
    return undefined;
  }

  return {
    id: "local-process-boundary",
    admitCommand,
    childEnvironmentNames: () => Object.keys(childEnvironment()).sort(),

    async run(request) {
      const admitted = await admitCommand(request.command, request.cwdRef);
      if (admitted !== undefined) {
        return { ok: false, refusal: admitted };
      }
      const timeoutMs = Math.min(
        request.timeoutMs ?? options.maxTimeoutMs,
        options.maxTimeoutMs,
      );
      const cwd = resolveRef(
        options.scope.workspaceRoot,
        request.cwdRef ?? ".",
      );
      const startedAt = options.clock.now();

      return await new Promise((resolvePromise) => {
        const child = spawn(request.command, [...request.args], {
          cwd,
          // Deliberately absent: `shell`. There is no option on this object that
          // can turn a string into a command line.
          env: childEnvironment(),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);

        const append = (target: "out" | "err", chunk: Buffer): void => {
          const current = target === "out" ? stdout : stderr;
          if (current.length >= maxOutputBytes) {
            return;
          }
          const text = chunk.toString("utf8");
          const room = maxOutputBytes - current.length;
          const bounded = text.length > room ? text.slice(0, room) : text;
          if (target === "out") {
            stdout += bounded;
          } else {
            stderr += bounded;
          }
        };

        child.stdout?.on("data", (chunk: Buffer) => append("out", chunk));
        child.stderr?.on("data", (chunk: Buffer) => append("err", chunk));

        const finish = (
          result:
            | {
                readonly ok: true;
                readonly result: {
                  readonly exitCode?: number;
                  readonly stdout: string;
                  readonly stderr: string;
                  readonly durationMs: number;
                  readonly timedOut: boolean;
                };
              }
            | { readonly ok: false; readonly refusal: OperationRefusal },
        ): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolvePromise(result);
        };

        child.on("error", (error: Error) => {
          // A missing program is a result, not a crash: the caller learns that the
          // command could not be started.
          const code = (error as { code?: unknown }).code;
          finish({
            ok: false,
            refusal: refusal(
              "OPERATION_FAILED",
              code === "ENOENT"
                ? `command "${safeCommandName(request.command)}" was not found`
                : `command "${safeCommandName(request.command)}" could not be started`,
            ),
          });
        });

        child.on("close", (code: number | null) => {
          finish({
            ok: true,
            result: {
              ...(code === null ? {} : { exitCode: code }),
              stdout,
              stderr,
              durationMs: durationMsFrom(
                toIsoString(startedAt),
                toIsoString(options.clock.now()),
              ),
              timedOut,
            },
          });
        });
      });
    },
  };
}
