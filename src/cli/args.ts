import { EXIT_USAGE } from "./io.js";

/**
 * A small, dependency-free argv parser.
 *
 * The platform's core is dependency-free on purpose (ADR-020), and the CLI is the
 * thinnest possible shell over the application layer, so a CLI framework would be
 * the largest dependency in the repository for the least value. Parsing is a pure
 * function of `(argv, specs)`, which also makes it directly testable.
 *
 * Every failure is a `UsageError`, which the dispatcher turns into exit code 2.
 * Nothing here throws a `DomainError`: unknown flags are a usage problem, not a
 * domain problem.
 */
export class UsageError extends Error {
  readonly exitCode = EXIT_USAGE;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface FlagSpec {
  readonly name: string;
  /** True when the flag consumes the next token (or `--flag=value`). */
  readonly value: boolean;
  /** True when the flag may be repeated (e.g. `--acceptance`). */
  readonly multiple?: boolean;
  readonly aliases?: readonly string[];
  readonly placeholder?: string;
  readonly description: string;
}

export interface ParsedArgs {
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly positionals: readonly string[];
}

function findSpec(
  specs: readonly FlagSpec[],
  token: string,
): FlagSpec | undefined {
  return specs.find(
    (spec) => spec.name === token || (spec.aliases ?? []).includes(token),
  );
}

export function parseArgv(
  argv: readonly string[],
  specs: readonly FlagSpec[],
): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (positionalOnly) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    // `--flag`, `--flag=value` and `-h` are all accepted; spec names are bare.
    const body = token.startsWith("--") ? token.slice(2) : token.slice(1);
    const equals = body.indexOf("=");
    const name = equals === -1 ? body : body.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : body.slice(equals + 1);
    if (name === "") {
      throw new UsageError(`malformed option "${token}"`);
    }
    const spec = findSpec(specs, name);
    if (spec === undefined) {
      throw new UsageError(
        `unknown option "--${name}"; supported options: ${
          specs.length === 0
            ? "(none)"
            : specs.map((candidate) => `--${candidate.name}`).join(", ")
        }`,
      );
    }

    let value: string | undefined = inlineValue;
    if (spec.value) {
      if (value === undefined) {
        const next = argv[index + 1];
        if (next === undefined) {
          throw new UsageError(`option "--${spec.name}" requires a value`);
        }
        value = next;
        index += 1;
      }
    } else if (value !== undefined) {
      throw new UsageError(
        `option "--${spec.name}" does not take a value (got "${inlineValue}")`,
      );
    }

    const existing = flags.get(spec.name) ?? [];
    if (existing.length > 0 && spec.multiple !== true) {
      throw new UsageError(`option "--${spec.name}" may only be given once`);
    }
    if (spec.value) {
      existing.push(value as string);
    } else {
      existing.push("true");
    }
    flags.set(spec.name, existing);
  }

  return { flags, positionals };
}

export function flagValues(args: ParsedArgs, name: string): readonly string[] {
  return args.flags.get(name) ?? [];
}

export function flagValue(args: ParsedArgs, name: string): string | undefined {
  return flagValues(args, name)[0];
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

export function requireFlag(args: ParsedArgs, name: string): string {
  const value = flagValue(args, name);
  if (value === undefined) {
    throw new UsageError(`option "--${name}" is required`);
  }
  return value;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = flagValue(args, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new UsageError(
      `option "--${name}" must be a number (got "${value}")`,
    );
  }
  return parsed;
}

export function requirePositional(
  args: ParsedArgs,
  index: number,
  label: string,
): string {
  const value = args.positionals[index];
  if (value === undefined) {
    throw new UsageError(`missing required argument: ${label}`);
  }
  return value;
}

/** Renders the supported options of a command, for `--help` and error hints. */
export function formatFlagHelp(specs: readonly FlagSpec[]): string {
  const lines = specs.map((spec) => {
    const name = `--${spec.name}${spec.value ? ` <${spec.placeholder ?? "value"}>` : ""}`;
    return `  ${name.padEnd(28)}${spec.description}`;
  });
  return lines.join("\n");
}
