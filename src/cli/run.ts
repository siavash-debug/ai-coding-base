import { createSystemClock } from "../core/clock.js";
import { main } from "./main.js";

/**
 * The only place the CLI touches the process.
 *
 * Everything testable lives behind `main(argv, io, env)`. Here we bind real
 * stdout/stderr, the real working directory, the system clock and the runtime
 * version, then set `process.exitCode` rather than calling `process.exit`: letting
 * Node drain naturally cannot truncate buffered output on a pipe.
 */
const exitCode = await main(
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

process.exitCode = exitCode;
