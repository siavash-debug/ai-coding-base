import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXCLUDED_DIRECTORIES,
  evaluateIgnoreRules,
  exclusionFor,
  isHardExcludedPath,
  isSecretShapedPath,
  matchesPathPattern,
  parseExclusionPatterns,
  parseIgnoreRules,
  parsePathPattern,
} from "../../src/context/ignore.js";
import { expectDomainError } from "../support/errors.js";

/**
 * The security boundary of context selection, tested where it is decided.
 *
 * A context engine's worst failure is not selecting the wrong file; it is selecting
 * a file it was never allowed to read. These tests pin the ordering of that policy
 * (secret shape → hard exclusion → configuration → gitignore) because the ordering
 * *is* the guarantee: a `!` rule or an operator pattern must not be able to
 * re-include a credential.
 */
describe("context ignore rules: the gitignore subset that is actually implemented", () => {
  it("ignores a bare pattern at any depth, and a slashed pattern from the root", () => {
    const rules = parseIgnoreRules("dist\n/only-at-root.txt\n");

    expect(evaluateIgnoreRules(rules, "dist").ignored).toBe(true);
    expect(evaluateIgnoreRules(rules, "packages/a/dist").ignored).toBe(true);
    expect(evaluateIgnoreRules(rules, "only-at-root.txt").ignored).toBe(true);
    expect(evaluateIgnoreRules(rules, "nested/only-at-root.txt").ignored).toBe(
      false,
    );
  });

  it("excludes everything under a directory the pattern names", () => {
    const rules = parseIgnoreRules("build/\n");
    expect(
      evaluateIgnoreRules(rules, "build/deep/nested/file.js").ignored,
    ).toBe(true);
  });

  it("honours negation, last match winning", () => {
    const rules = parseIgnoreRules("*.log\n!keep.log\n");
    expect(evaluateIgnoreRules(rules, "app.log").ignored).toBe(true);
    expect(evaluateIgnoreRules(rules, "keep.log").ignored).toBe(false);
  });

  it("treats comments and blank lines as no rule at all", () => {
    const rules = parseIgnoreRules("# a comment\n\n   \nreal.txt\n");
    expect(rules).toHaveLength(1);
    expect(evaluateIgnoreRules(rules, "a-comment").ignored).toBe(false);
  });

  it("supports `*`, `?` and `**` without letting `*` cross a separator", () => {
    const rules = parseIgnoreRules("docs/**/*.md\nsrc/?.ts\n");
    expect(evaluateIgnoreRules(rules, "docs/a/b/design.md").ignored).toBe(true);
    expect(evaluateIgnoreRules(rules, "docs/design.md").ignored).toBe(true);
    expect(evaluateIgnoreRules(rules, "src/a.ts").ignored).toBe(true);
    expect(evaluateIgnoreRules(rules, "src/ab.ts").ignored).toBe(false);
  });

  it("reports which rule decided, so an exclusion can be explained", () => {
    const rules = parseIgnoreRules("generated/**\n");
    const decision = evaluateIgnoreRules(rules, "generated/schema.ts");
    expect(decision.ignored).toBe(true);
    expect(decision.rule).toBe("generated/**");
  });
});

describe("context exclusions: secret-shaped paths can never be context", () => {
  it.each([
    ".env",
    ".env.local",
    "config/.env.production",
    "keys/id_rsa",
    "keys/id_ed25519.pub",
    "certs/server.pem",
    "certs/client.key",
    "infra/service-account.json",
    "deploy/secrets.yaml",
    "deploy/production-credentials.json",
    ".npmrc",
    ".netrc",
    "vault/.htpasswd",
  ])("refuses %s by name, before it is ever read", (ref) => {
    expect(isSecretShapedPath(ref)).toBe(true);
  });

  it.each([
    "src/env.ts",
    "src/environment.ts",
    "src/keys.ts",
    "src/tokens.ts",
    "src/auth/service.ts",
  ])("does not refuse ordinary source named %s", (ref) => {
    expect(isSecretShapedPath(ref)).toBe(false);
  });

  it("refuses a secret-named directory's contents too", () => {
    expect(isSecretShapedPath("secrets/api.json")).toBe(true);
  });

  it("is deliberately over-broad: a document *about* secrets is refused", () => {
    // The trade is intentional. A false positive costs one candidate and is
    // visible in the trace as an exclusion; a false negative puts a credential in
    // a prompt. `docs/secrets-guide.md` is therefore refused, and the rules that
    // produced it are a closed set a reviewer can read in full.
    expect(isSecretShapedPath("docs/secrets-guide.md")).toBe(true);
    expect(isSecretShapedPath("src/credentials.ts")).toBe(true);
  });

  it("cannot be re-included by a negation rule or an operator pattern", () => {
    const decision = exclusionFor(".env", {
      ignoreRules: parseIgnoreRules("!.env\n"),
      exclusionRules: parseExclusionPatterns(["!.env"]),
    });
    expect(decision.excluded).toBe(true);
    expect(decision.reason).toBe("secret-shaped");
  });

  it("cannot be re-included by configuration either", () => {
    const decision = exclusionFor("certs/server.key", {
      ignoreRules: [],
      exclusionRules: parseExclusionPatterns(["certs/**"]),
    });
    expect(decision.reason).toBe("secret-shaped");
  });
});

describe("context exclusions: hard-excluded paths", () => {
  it.each([
    "node_modules/pkg/index.js",
    ".git/config",
    "dist/main.js",
    "build/output.js",
    "coverage/lcov.info",
    "vendor/lib.go",
    "target/debug/app",
  ])("refuses %s", (ref) => {
    expect(isHardExcludedPath(ref)).toBe(true);
  });

  it("keeps the platform's own runtime state out of context", () => {
    // `.ai/runtime` holds event logs and task records: bookkeeping, not engineering
    // context, and the one directory guaranteed to grow without bound.
    expect(isHardExcludedPath(".ai/runtime/events/ws.jsonl")).toBe(true);
    expect(
      exclusionFor(".ai/project.json", {
        ignoreRules: [],
        exclusionRules: [],
      }).reason,
    ).toBe("hard-excluded");
  });

  it("excludes by reason, with the layer that decided it", () => {
    expect(
      exclusionFor("lib/a.js", { ignoreRules: [], exclusionRules: [] })
        .excluded,
    ).toBe(false);
    expect(
      exclusionFor("lib/a.js", {
        ignoreRules: parseIgnoreRules("lib/\n"),
        exclusionRules: [],
      }),
    ).toMatchObject({ excluded: true, reason: "ignored", rule: "lib/" });
    expect(
      exclusionFor("lib/a.js", {
        ignoreRules: [],
        exclusionRules: parseExclusionPatterns(["lib/**"]),
      }),
    ).toMatchObject({ excluded: true, reason: "configured" });
    expect(
      exclusionFor("dist/a.js", { ignoreRules: [], exclusionRules: [] }),
    ).toMatchObject({ excluded: true, reason: "hard-excluded" });
  });
});

describe("context exclusions: configuration is validated, never trusted", () => {
  it("compiles a pattern and refuses an unusable one", () => {
    expect(
      parsePathPattern("src/core/**", "field").regex.test("src/core/a.ts"),
    ).toBe(true);
    expectDomainError(() => parsePathPattern("   ", "field"), "VALIDATION");
    expectDomainError(
      () => parsePathPattern("# comment", "field"),
      "VALIDATION",
    );
  });

  it("matches a path pattern against the path or any ancestor directory", () => {
    expect(matchesPathPattern("src/core", "src/core/engine.ts")).toBe(true);
    expect(matchesPathPattern("src/core/**", "src/core/engine.ts")).toBe(true);
    expect(matchesPathPattern("src/cli/**", "src/core/engine.ts")).toBe(false);
  });

  it("never descends into a hard-excluded directory", () => {
    expect(DEFAULT_EXCLUDED_DIRECTORIES).toContain("node_modules");
    expect(DEFAULT_EXCLUDED_DIRECTORIES).toContain(".ai");
    expect(DEFAULT_EXCLUDED_DIRECTORIES).toContain(".git");
  });
});
