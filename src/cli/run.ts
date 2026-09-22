import { createSystemClock } from "../core/clock.js";
import { loadLocalEnv } from "../adapters/config/local-env.js";
import { EXIT_FAILURE } from "./io.js";
import { main } from "./main.js";

/**
 * The only place the CLI touches the process.
 *
 * Everything testable lives behind `main(argv, io, env)`. Here we bind real
 * stdout/stderr, the real working directory, the system clock and the runtime
 * version, then set `process.exitCode` rather than calling `process.exit`: letting
 * Node drain naturally cannot truncate buffered output on a pipe.
 *
 * `.env.local` is applied first, and only here. Filling `process.env` before a runtime
 * is opened is what keeps the `Environment` port the single reader of credentials at
 * call time (ADR-033): the file is another way the process environment gets populated,
 * not another credential store. Nothing about it is printed — `loadLocalEnv` reports
 * names, never values — and a file the platform could not use stops the run instead of
 * proceeding with a half-applied configuration.
 */
const localEnv = await loadLocalEnv({ projectRoot: process.cwd() });

if (localEnv.status === "invalid") {
  process.stderr.write(
    `error: ${localEnv.path} is not a usable environment file\n`,
  );
  process.exitCode = EXIT_FAILURE;
} else {
  process.exitCode = await main(
    process.argv.slice(2),
    {
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
    },
    {
      cwd: process.cwd(),
      clock: createSystemClock(),
      runtimeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
    },
  );
}
