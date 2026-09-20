/**
 * ProcessRunner port: run one program, with arguments, and capture its output.
 *
 * This exists so that the only place in the platform that starts a subprocess is
 * an adapter that can be replaced, faked and audited. Today exactly one caller
 * needs it (`git`, for change detection), and it is kept deliberately narrow:
 *
 * - **No shell.** Arguments are passed as an array, so no string is ever parsed by
 *   a shell and there is no quoting surface to get wrong. A task title containing
 *   `; rm -rf /` is a value in an argv slot, not a program.
 * - **Bounded.** Every call carries a timeout and a maximum captured byte count.
 *   A hung child or a runaway listing must not become a hung selection.
 * - **Not sandboxed, and labelled as such.** This is not the sandbox of
 *   V2-ARCHITECTURE §20; it runs with the platform's own privileges. It is only
 *   acceptable because the platform controls every argv it passes, and callers MUST
 *   NOT forward user text into a command name.
 *
 * A non-zero exit status is a *result*, not an exception: "is this a git
 * repository?" is answered by `git rev-parse` failing, and turning that into a
 * thrown error would force every caller to catch control flow.
 *
 * See docs/architecture/V2-ARCHITECTURE.md §36.7 and DECISIONS.md ADR-042.
 */
export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ProcessResult {
  readonly ok: boolean;
  /** Process exit code, or `undefined` when it was killed or never started. */
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** True when the child was killed because the timeout elapsed. */
  readonly timedOut: boolean;
  /** True when the executable could not be found or started. */
  readonly spawnFailed: boolean;
}

export interface ProcessRunner {
  readonly id: string;
  run(request: ProcessRequest): Promise<ProcessResult>;
}
