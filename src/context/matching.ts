import type { ContextItemKind } from "./selection.js";

/**
 * Pure path/text reasoning used by discovery and scoring.
 *
 * Everything here is a total function of its arguments: no clock, no filesystem,
 * no randomness. That is what makes a selection reproducible, and it is why the
 * heuristics live in this module rather than being spread through the engine.
 *
 * The heuristics are deliberately crude and auditable — token overlap, path
 * shape, filename shape — because a selection nobody can explain is a selection
 * nobody can debug. No embeddings, no model calls, no learned weights.
 * See docs/architecture/V2-ARCHITECTURE.md §36.4 and DECISIONS.md ADR-039.
 */

/** Words that carry no discriminating power in a repository path or task text. */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "when",
  "then",
  "than",
  "but",
  "not",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "will",
  "would",
  "should",
  "could",
  "must",
  "may",
  "might",
  "can",
  "its",
  "it",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "as",
  "is",
  "be",
  "or",
  "if",
  "do",
  "does",
  "add",
  "new",
  "use",
  "using",
  "make",
  "sure",
  "all",
  "any",
  "each",
  "every",
  "some",
  "one",
  "two",
  "also",
  "only",
  "more",
  "less",
  "over",
  "under",
  "via",
  "per",
  "out",
  "up",
  "down",
  "off",
  "on",
  "so",
  "such",
  "there",
  "their",
  "them",
  "these",
  "those",
  "which",
  "who",
  "whom",
  "what",
  "where",
  "why",
  "how",
  "task",
  "code",
  "file",
  "files",
  "change",
  "changes",
]);

const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_-]*/g;
/** A token that looks like a path or a filename rather than prose. */
const PATH_SHAPED = /[./\\]/;

/**
 * Lower-cased word tokens with stopwords and pure numbers removed.
 *
 * Camel case and snake/kebab case are split into their parts so `ContextEngine`
 * and `context-engine` produce the same tokens: a task that says "context engine"
 * should find `src/context/engine.ts` without an embedding model.
 */
export function tokenize(text: string): readonly string[] {
  const out: string[] = [];
  for (const raw of text.match(IDENTIFIER_PATTERN) ?? []) {
    for (const part of splitIdentifier(raw)) {
      const token = part.toLowerCase();
      if (token.length < 3 || STOPWORDS.has(token) || /^\d+$/.test(token)) {
        continue;
      }
      if (!out.includes(token)) {
        out.push(token);
      }
    }
  }
  return out;
}

function splitIdentifier(raw: string): readonly string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0);
}

export function tokenSet(texts: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const text of texts) {
    for (const token of tokenize(text)) {
      set.add(token);
    }
  }
  return set;
}

/**
 * Extracts tokens from task text that are explicitly path-shaped, e.g.
 * `src/auth/service.ts`, `./config.json`, `tests/unit`.
 *
 * These are the strongest *inferred* signal available: a task that names a path
 * is stating where to look.
 */
export function extractPathTokens(texts: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const raw of text.split(/[\s,;()"'`[\]]+/)) {
      const token = raw.replace(/^[.:/\\]+/, "").replace(/[.:,;]+$/, "");
      if (token.length === 0 || !PATH_SHAPED.test(raw)) {
        continue;
      }
      if (/^[a-z]+:\/\//i.test(raw)) {
        continue;
      }
      if (!/[A-Za-z0-9]/.test(token)) {
        continue;
      }
      if (!found.includes(token)) {
        found.push(token);
      }
    }
  }
  return found;
}

/**
 * Normalises a task-supplied path reference to a workspace-relative POSIX path.
 *
 * Leading `./` and `/` are removed and backslashes are folded to `/`, so a
 * Windows-style reference in a task description still matches the repository's
 * own paths. Traversal is refused rather than resolved: a task may not point
 * outside the workspace, and silently clamping `../../etc/passwd` to something
 * inside it would be worse than refusing.
 */
export function normalizeRef(raw: string): string | undefined {
  let ref = raw.trim().replace(/\\/g, "/");
  ref = ref.replace(/^\.\//, "").replace(/^\/+/, "");
  if (ref.length === 0) {
    return undefined;
  }
  const segments = ref.split("/").filter((segment) => segment !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    return undefined;
  }
  return segments.join("/");
}

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".cs",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".swift",
  ".php",
  ".scala",
  ".sh",
] as const;

const CONFIG_EXTENSIONS = [
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
] as const;

const DOCUMENTATION_EXTENSIONS = [
  ".md",
  ".mdx",
  ".rst",
  ".txt",
  ".adoc",
] as const;

const TEST_MARKERS = [
  ".test.",
  ".spec.",
  "_test.",
  "-test.",
  ".test-",
  "_spec.",
] as const;

function hasExtension(ref: string, extensions: readonly string[]): boolean {
  const lower = ref.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

export function isTestRef(ref: string): boolean {
  const lower = ref.toLowerCase();
  const name = lower.split("/").pop() ?? lower;
  if (TEST_MARKERS.some((marker) => name.includes(marker))) {
    return true;
  }
  const segments = lower.split("/");
  if (segments.includes("tests") || segments.includes("test")) {
    return hasExtension(lower, SOURCE_EXTENSIONS) || lower.endsWith(".sql");
  }
  return false;
}

export function isAdrRef(ref: string): boolean {
  const lower = ref.toLowerCase();
  if (
    !lower.startsWith("docs/") ||
    !hasExtension(lower, DOCUMENTATION_EXTENSIONS)
  ) {
    return false;
  }
  const name = lower.split("/").pop() ?? "";
  return (
    name.startsWith("adr") ||
    lower.includes("/adr/") ||
    lower.includes("/adrs/") ||
    lower.includes("/decisions/") ||
    lower.includes("/architecture/")
  );
}

export function isDocumentationRef(ref: string): boolean {
  const lower = ref.toLowerCase();
  if (!hasExtension(lower, DOCUMENTATION_EXTENSIONS)) {
    return false;
  }
  const name = lower.split("/").pop() ?? "";
  return (
    name.startsWith("readme") ||
    name.startsWith("changelog") ||
    name.startsWith("contributing") ||
    name.startsWith("guide") ||
    name.startsWith("docs") ||
    lower.includes("/docs/") ||
    lower.includes("/documentation/")
  );
}

/** Files the verification loop itself depends on: build, test and type config. */
const VERIFICATION_CONFIG_NAMES = [
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "vitest.config.ts",
  "jest.config.js",
  "pyproject.toml",
  "go.mod",
  "cargo.toml",
  "makefile",
  "dockerfile",
  ".eslintrc.json",
  "eslint.config.js",
  "pnpm-workspace.yaml",
] as const;

export function isVerificationConfigRef(ref: string): boolean {
  const lower = ref.toLowerCase();
  const name = lower.split("/").pop() ?? "";
  return VERIFICATION_CONFIG_NAMES.some((candidate) => candidate === name);
}

/**
 * Classifies a path into the small kind vocabulary this phase can actually
 * justify. Test-ness is checked before source-ness so `foo.test.ts` is a test.
 */
export function classifyRef(ref: string): ContextItemKind {
  if (isTestRef(ref)) {
    return "test-file";
  }
  if (isAdrRef(ref)) {
    return "adr";
  }
  if (isDocumentationRef(ref)) {
    return "documentation";
  }
  if (hasExtension(ref, SOURCE_EXTENSIONS)) {
    return "source-file";
  }
  if (hasExtension(ref, CONFIG_EXTENSIONS) || isVerificationConfigRef(ref)) {
    return "config-file";
  }
  return "source-file";
}

/**
 * Paths that would conventionally hold the tests for `ref`.
 *
 * Ordered by how strongly the convention implies the relationship: a sibling
 * `foo.test.ts` is the same module's test, a `tests/unit/foo.test.ts` is very
 * likely its unit test, and anything else is a guess the caller does not make.
 */
export function testSiblingRefs(ref: string): readonly string[] {
  const segments = ref.split("/");
  const name = segments.pop() ?? ref;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return [];
  }
  const stem = name.slice(0, dot);
  const extension = name.slice(dot);
  const directory = segments.join("/");
  const prefix = directory.length === 0 ? "" : `${directory}/`;
  const candidates = [
    `${prefix}${stem}.test${extension}`,
    `${prefix}${stem}.spec${extension}`,
    `${prefix}__tests__/${stem}.test${extension}`,
    `tests/unit/${stem}.test${extension}`,
    `tests/${stem}.test${extension}`,
  ];
  return candidates.filter((candidate) => candidate !== ref);
}

/**
 * Reverses `testSiblingRefs` well enough to link a test back to its subject.
 *
 * The relationship is useful in both directions: a task that names a *test* file
 * almost always needs the module under test, and a task that names a module almost
 * always needs its tests.
 */
export function subjectRefsForTest(ref: string): readonly string[] {
  const segments = ref.split("/");
  const name = segments.pop() ?? ref;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return [];
  }
  const extension = name.slice(dot);
  let stem = name.slice(0, dot);
  for (const marker of [".test", ".spec", "_test", "-test"]) {
    if (stem.endsWith(marker)) {
      stem = stem.slice(0, -marker.length);
      break;
    }
  }
  const directory = segments.join("/");
  const base = directory.length === 0 ? "" : `${directory}/`;
  const out = [`${base}${stem}${extension}`];
  if (directory === "tests/unit" || directory === "tests") {
    out.push(`src/${stem}${extension}`);
  }
  return out.filter((candidate) => candidate !== ref);
}

/**
 * Every way a module reference can appear, in one alternation so that the result
 * keeps the file's own textual order.
 *
 * Four shapes, because all four are common and missing one would leave a real
 * dependency invisible: `import … from`, `export … from`, a side-effect
 * `import './x.js'`, a dynamic `import('./x.js')`, and `require('./x.js')`.
 * A bare package specifier is matched too and filtered out afterwards, so the
 * pattern stays simple rather than trying to be clever about node_modules.
 */
const IMPORT_PATTERN =
  /(?:^|[\s;{(=])(?:(?:import|export)\s[^;'"]*?from\s*["']([^"']+)["']|(?:import|export)\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\))/g;

/** Relative specifiers found in a file's text. Bare package names are ignored. */
export function extractRelativeSpecifiers(content: string): readonly string[] {
  const found: string[] = [];
  for (const match of content.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier === undefined || !specifier.startsWith(".")) {
      continue;
    }
    if (!found.includes(specifier)) {
      found.push(specifier);
    }
  }
  return found;
}

function resolveRelative(
  fromRef: string,
  specifier: string,
): string | undefined {
  const segments = fromRef.split("/");
  segments.pop();
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (segments.length === 0) {
        return undefined;
      }
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  const joined = segments.join("/");
  return joined.length === 0 ? undefined : joined;
}

/**
 * Paths in `known` that `content` imports, as workspace-relative refs.
 *
 * TypeScript's own module resolution is not reimplemented: the candidate is
 * matched against the repository listing, trying the specifier verbatim, with a
 * `.js`-to-`.ts` rewrite, and with the common index/extension fallbacks. A
 * specifier that resolves to nothing in the listing is dropped rather than guessed.
 */
export function resolveImports(
  fromRef: string,
  content: string,
  known: ReadonlySet<string>,
): readonly string[] {
  const resolved: string[] = [];
  for (const specifier of extractRelativeSpecifiers(content)) {
    const base = resolveRelative(fromRef, specifier);
    if (base === undefined) {
      continue;
    }
    const rewrites: string[] = [base];
    if (base.endsWith(".js")) {
      rewrites.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
    }
    if (base.endsWith(".mjs")) {
      rewrites.push(`${base.slice(0, -4)}.mts`);
    }
    for (const extension of SOURCE_EXTENSIONS) {
      rewrites.push(`${base}${extension}`);
    }
    for (const extension of SOURCE_EXTENSIONS) {
      rewrites.push(`${base}/index${extension}`);
    }
    const hit = rewrites.find(
      (candidate) => candidate !== fromRef && known.has(candidate),
    );
    if (hit !== undefined && !resolved.includes(hit)) {
      resolved.push(hit);
    }
  }
  return resolved;
}
