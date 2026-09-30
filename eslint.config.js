import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // `.kilo/` and `.freebuff/` hold local agent/tooling state (see .gitignore and
    // AGENTS.md §8.1). They are not project source, they are never committed, and
    // they can contain their own tsconfig files — which makes the type-aware parser
    // see several candidate project roots and fail on every file in this
    // repository. Ignoring them is a config-level exclusion rather than a
    // per-invocation `--ignore-pattern`, so `pnpm lint` behaves the same for
    // everyone; `src/`, `tests/` and `scripts/` are untouched by it. `.cline/` is
    // deliberately not listed: it holds a committed adapter file.
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      ".kilo/**",
      ".freebuff/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
