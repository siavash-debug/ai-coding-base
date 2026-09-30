import { DomainError } from "../core/errors.js";
import { assertNonEmptyString } from "../core/validation.js";

/**
 * Which paths a context selection is even allowed to look at.
 *
 * Three layers, deliberately separated because they have different authorities:
 *
 * 1. **Hard exclusions** (this module's `DEFAULT_EXCLUDED_DIRECTORIES` plus
 *    `SECRET_FILE_PATTERNS`). Policy, not preference: no `.gitignore` negation and
 *    no configuration can re-include a credential file. A candidate that reaches
 *    them is dropped before its contents are ever read.
 * 2. **The workspace's own `.gitignore`.** The project's declared opinion about
 *    what is source. Honoured with standard last-match-wins and `!` negation.
 * 3. **Operator-configured exclusions** from `.ai/project.json` (`context.exclusions`).
 *    Applied after gitignore, so they can also re-exclude something gitignore
 *    allows, and can `!`-include something a *non-secret* gitignore rule removed.
 *
 * The gitignore implementation is a documented **subset**: comments, blank lines,
 * `!` negation, trailing-`/` directory-only rules, leading-`/` anchoring, `*`, `?`
 * and `**`, last-match-wins, and the standard rule that a pattern naming a
 * directory also excludes everything beneath it. What is *not* implemented —
 * escaping with `\`, nested `.gitignore` files, `.git/info/exclude`, and
 * `core.excludesFile` — is listed in the report rather than silently approximated,
 * because an ignore rule that quietly does not apply is how a secret file leaks
 * into a context window.
 *
 * See docs/architecture/V2-ARCHITECTURE.md §36.3 and DECISIONS.md ADR-041.
 */
export const DEFAULT_EXCLUDED_DIRECTORIES: readonly string[] = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  // Runtime state is the platform's own bookkeeping, never engineering context.
  ".ai",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".gradle",
  ".idea",
  ".vscode",
];

/**
 * File-name shapes that must never become context, whatever any configuration says.
 *
 * This is a name test, applied before the file is read, so a matching file's bytes
 * never enter the process. It is deliberately broad: a false positive costs one
 * missing candidate, a false negative puts a credential in a prompt.
 */
export const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env($|\.)/i,
  /^\.envrc$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|[-_.])(secrets?|credentials?|passwords?)([-_.]|$)/i,
  /^\.(npmrc|netrc|pypirc|git-credentials)$/i,
  /^\.htpasswd$/i,
  /(^|\/)\.aws\/(credentials|config)$/i,
  /service[-_]?account.*\.json$/i,
  /^\.docker\/config\.json$/i,
];

/**
 * True when a workspace-relative path names something that could hold a credential.
 *
 * Checks every path segment and the final name, so both `.env` and
 * `config/.env.local` are refused.
 */
export function isSecretShapedPath(ref: string): boolean {
  const segments = ref.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name))) {
    return true;
  }
  // A secret-named directory hides everything under it.
  for (const segment of segments.slice(0, -1)) {
    if (SECRET_FILE_PATTERNS.some((pattern) => pattern.test(segment))) {
      return true;
    }
  }
  return false;
}

/** True when any path segment is a hard-excluded directory. */
export function isHardExcludedPath(ref: string): boolean {
  return ref
    .split("/")
    .some((segment) => DEFAULT_EXCLUDED_DIRECTORIES.includes(segment));
}

export interface IgnoreRule {
  readonly source: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly anchored: boolean;
  readonly regex: RegExp;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Translates one gitignore glob into a regular expression.
 *
 * `**` is translated to "any number of characters including `/`"; `*` and `?`
 * never cross a `/`. This is the behaviour the tests pin.
 */
function globToRegExpBody(glob: string): string {
  let out = "";
  let index = 0;
  while (index < glob.length) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          out += "(?:.*/)?";
          index += 3;
          continue;
        }
        out += ".*";
        index += 2;
        continue;
      }
      out += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      index += 1;
      continue;
    }
    out += escapeRegExp(char);
    index += 1;
  }
  return out;
}

function compileRule(raw: string): IgnoreRule | undefined {
  const source = raw;
  let line = raw.trim();
  if (line.length === 0 || line.startsWith("#")) {
    return undefined;
  }
  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  }
  if (line.length === 0) {
    return undefined;
  }
  let directoryOnly = false;
  if (line.endsWith("/")) {
    directoryOnly = true;
    line = line.slice(0, -1);
  }
  if (line.length === 0) {
    return undefined;
  }
  const anchored = line.startsWith("/") || line.includes("/");
  if (line.startsWith("/")) {
    line = line.slice(1);
  }
  const body = globToRegExpBody(line);
  const prefix = anchored ? "^" : "^(?:.*/)?";
  // A rule may name a file or a directory; matching a directory also excludes its
  // contents, which is why the caller matches every ancestor prefix too.
  const regex = new RegExp(`${prefix}${body}$`);
  return { source, negated, directoryOnly, anchored, regex };
}

/**
 * Compiles one path pattern (from configuration, not a file) into a rule.
 *
 * `context.priority` and `context.exclusions` share this compiler with
 * `.gitignore`, so an operator's `src/core/**` means the same thing in both
 * places — and so there is exactly one implementation to get right.
 */
export function parsePathPattern(pattern: string, field: string): IgnoreRule {
  const rule = compileRule(assertNonEmptyString(pattern, field));
  if (rule === undefined) {
    throw new DomainError(
      "VALIDATION",
      `${field} must be a path pattern, not an empty string or comment`,
      { field },
    );
  }
  return rule;
}

/** True when a bare pattern matches a path or any of its ancestor directories. */
export function matchesPathPattern(pattern: string, ref: string): boolean {
  const rule = compileRule(pattern);
  if (rule === undefined) {
    return false;
  }
  return [ref, ...ancestorsOf(ref)].some((candidate) =>
    rule.regex.test(candidate),
  );
}

export function parseIgnoreRules(text: string): readonly IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const rule = compileRule(line);
    if (rule !== undefined) {
      rules.push(rule);
    }
  }
  return rules;
}

export function parseExclusionPatterns(
  patterns: readonly string[],
  field = "context.exclusions",
): readonly IgnoreRule[] {
  return patterns.map((pattern, index) =>
    parsePathPattern(pattern, `${field}[${index}]`),
  );
}

function ancestorsOf(ref: string): readonly string[] {
  const segments = ref.split("/");
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join("/"));
  }
  return ancestors;
}

export interface IgnoreDecision {
  readonly ignored: boolean;
  /** The rule that decided it, for a trace that can explain itself. */
  readonly rule?: string;
}

/**
 * Evaluates one path against an ordered rule list, last match winning.
 *
 * Every ancestor directory is tested as well as the path itself, so a rule naming
 * a directory also excludes its contents — and so a `!` rule can re-include a
 * specific file inside an otherwise-ignored tree.
 */
export function evaluateIgnoreRules(
  rules: readonly IgnoreRule[],
  ref: string,
): IgnoreDecision {
  const candidates = [ref, ...ancestorsOf(ref)];
  let decision: IgnoreDecision = { ignored: false };
  for (const rule of rules) {
    const matches = candidates.some((candidate) => rule.regex.test(candidate));
    if (matches) {
      decision = rule.negated
        ? { ignored: false }
        : { ignored: true, rule: rule.source };
    }
  }
  return decision;
}

export interface ExclusionDecision {
  readonly excluded: boolean;
  readonly reason?:
    "hard-excluded" | "secret-shaped" | "ignored" | "configured";
  readonly rule?: string;
}

/**
 * The single decision point for "may this path be considered at all?".
 *
 * Ordered from least negotiable to most: a secret-shaped path is refused even if a
 * `!` rule would have re-included it, and even if configuration explicitly named
 * it. That ordering is the whole security argument, so it lives in one function
 * with one test suite rather than being spread across call sites.
 */
export function exclusionFor(
  ref: string,
  options: {
    readonly ignoreRules: readonly IgnoreRule[];
    readonly exclusionRules: readonly IgnoreRule[];
  },
): ExclusionDecision {
  if (isSecretShapedPath(ref)) {
    return { excluded: true, reason: "secret-shaped" };
  }
  if (isHardExcludedPath(ref)) {
    return { excluded: true, reason: "hard-excluded" };
  }
  const configured = evaluateIgnoreRules(options.exclusionRules, ref);
  if (configured.ignored) {
    return {
      excluded: true,
      reason: "configured",
      ...(configured.rule === undefined ? {} : { rule: configured.rule }),
    };
  }
  const ignored = evaluateIgnoreRules(options.ignoreRules, ref);
  if (ignored.ignored) {
    return {
      excluded: true,
      reason: "ignored",
      ...(ignored.rule === undefined ? {} : { rule: ignored.rule }),
    };
  }
  return { excluded: false };
}

/** Validates a workspace-relative path that came from outside the type system. */
export function assertSafeRelativeRef(value: unknown, field: string): string {
  const ref = assertNonEmptyString(value, field);
  if (ref.includes("\0")) {
    throw new DomainError("VALIDATION", `${field} must not contain NUL`, {
      field,
    });
  }
  if (ref.startsWith("/") || /^[A-Za-z]:/.test(ref)) {
    throw new DomainError(
      "VALIDATION",
      `${field} must be workspace-relative, not absolute`,
      { field },
    );
  }
  if (ref.split("/").includes("..")) {
    throw new DomainError(
      "VALIDATION",
      `${field} must not contain parent-directory traversal`,
      { field },
    );
  }
  return ref;
}
