import { describe, expect, it } from "vitest";

import {
  candidateIdOf,
  isMandatoryCandidate,
  orderCandidates,
  scoreCandidate,
} from "../../src/context/scoring.js";
import { admitCandidate, fitsWithin } from "../../src/context/budget.js";
import {
  classifyRef,
  extractPathTokens,
  extractRelativeSpecifiers,
  isTestRef,
  normalizeRef,
  resolveImports,
  subjectRefsForTest,
  testSiblingRefs,
  tokenSet,
  tokenize,
} from "../../src/context/matching.js";
import {
  estimateTokensFromBytes,
  estimateTokensFromText,
} from "../../src/context/tokens.js";
import type {
  ContextCandidate,
  ScoredCandidate,
} from "../../src/context/selection.js";
import { createContextHarness } from "../support/context.js";

/**
 * Discovery, scoring and budgeting, each tested where it is decided.
 *
 * The heuristics are crude on purpose, so the tests assert the *rules* rather than
 * impressiveness: a path the task names is mandatory, a test beside a relevant
 * source is linked to it, a changed file is noticed, ties break the same way
 * everywhere, and the budget is never exceeded.
 */
describe("context matching: pure path and text reasoning", () => {
  it("splits identifiers so camelCase and kebab-case tokenise alike", () => {
    expect(tokenize("ContextEngine")).toEqual(["context", "engine"]);
    expect(tokenize("context-engine")).toEqual(["context", "engine"]);
    expect(tokenize("context_engine")).toEqual(["context", "engine"]);
  });

  it("drops stopwords, short fragments and bare numbers", () => {
    expect(tokenize("add a new file for the 3 users")).toEqual(["users"]);
  });

  it("keeps first-seen order, so token lists are comparable", () => {
    expect(tokenSet(["alpha beta", "beta gamma"])).toEqual(
      new Set(["alpha", "beta", "gamma"]),
    );
  });

  it("extracts only path-shaped tokens", () => {
    expect(
      extractPathTokens(["fix src/auth/service.ts and tests/unit"]),
    ).toEqual(["src/auth/service.ts", "tests/unit"]);
    expect(extractPathTokens(["fix the login flow"])).toEqual([]);
  });

  it("normalises a path reference without allowing escape", () => {
    expect(normalizeRef("./src\\a.ts")).toBe("src/a.ts");
    expect(normalizeRef("/src/a.ts")).toBe("src/a.ts");
    expect(normalizeRef("./")).toBeUndefined();
    expect(normalizeRef("../../etc/passwd")).toBeUndefined();
  });

  it("classifies by name, checking test-ness first", () => {
    expect(classifyRef("src/a.test.ts")).toBe("test-file");
    expect(classifyRef("tests/unit/b.ts")).toBe("test-file");
    expect(classifyRef("src/b.ts")).toBe("source-file");
    expect(classifyRef("package.json")).toBe("config-file");
    expect(classifyRef("README.md")).toBe("documentation");
    expect(classifyRef("docs/architecture/adr/ADR-001.md")).toBe("adr");
  });

  it("names the conventional test siblings of a source file", () => {
    expect(testSiblingRefs("src/engine.ts")).toEqual([
      "src/engine.test.ts",
      "src/engine.spec.ts",
      "src/__tests__/engine.test.ts",
      "tests/unit/engine.test.ts",
      "tests/engine.test.ts",
    ]);
    expect(isTestRef("src/engine.test.ts")).toBe(true);
  });

  it("links a test back to its subject, and a tests/ file back to src/", () => {
    expect(subjectRefsForTest("src/engine.test.ts")).toEqual(["src/engine.ts"]);
    expect(subjectRefsForTest("tests/unit/engine.test.ts")).toEqual([
      "tests/unit/engine.ts",
      "src/engine.ts",
    ]);
  });

  it("reads only relative import specifiers", () => {
    const content = [
      "import { a } from './a.js';",
      "import type { B } from '../shared/b.js';",
      "import { c } from 'c';\nconst d = require('./d.js');",
    ].join("\n");
    expect(extractRelativeSpecifiers(content)).toEqual([
      "./a.js",
      "../shared/b.js",
      "./d.js",
    ]);
  });

  it("resolves an import against the listing, including the .js -> .ts rewrite", () => {
    const known = new Set([
      "src/a.ts",
      "src/shared/b.ts",
      "src/index.ts",
      "src/d.ts",
    ]);
    expect(resolveImports("src/main.ts", "import './a.js';", known)).toEqual([
      "src/a.ts",
    ]);
    expect(
      resolveImports("src/deep/main.ts", "import '../shared/b.js';", known),
    ).toEqual(["src/shared/b.ts"]);
    expect(resolveImports("src/main.ts", "import './';", known)).toEqual([
      "src/index.ts",
    ]);
    expect(resolveImports("src/main.ts", "import './nope.js';", known)).toEqual(
      [],
    );
    expect(resolveImports("src/main.ts", "require('./d.js');", known)).toEqual([
      "src/d.ts",
    ]);
  });

  it("refuses a specifier that climbs above the repository root", () => {
    expect(
      resolveImports(
        "src/main.ts",
        "import '../../outside.ts';",
        new Set(["outside.ts"]),
      ),
    ).toEqual([]);
  });
});

describe("context tokens: an explicit, auditable estimate", () => {
  it("estimates from bytes and never returns zero for non-empty input", () => {
    expect(estimateTokensFromBytes(0)).toBe(0);
    expect(estimateTokensFromBytes(1)).toBe(1);
    expect(estimateTokensFromBytes(4)).toBe(1);
    expect(estimateTokensFromBytes(5)).toBe(2);
  });

  it("counts bytes, not characters, so multi-byte text is not under-counted", () => {
    expect(estimateTokensFromText("abcd")).toBe(1);
    // Three characters, nine UTF-8 bytes: three tokens, not one.
    expect(estimateTokensFromText("日本語")).toBe(3);
  });
});

describe("context scoring: additive, explainable, order-independent", () => {
  const candidate = (
    signals: ContextCandidate["signals"],
    tokens = 100,
  ): ContextCandidate => ({
    key: candidateIdOf({ kind: "source-file", ref: "src/a.ts" }),
    kind: "source-file",
    ref: "src/a.ts",
    tokens,
    basis: "size",
    signals,
  });

  it("adds points per signal and records a reason for each", () => {
    const scored = scoreCandidate(candidate(["explicit-path", "changed"]), {
      taskTokens: new Set(),
      priorityRules: [],
    });
    expect(scored.score).toBe(130);
    expect(scored.reasons.map((reason) => reason.code)).toEqual([
      "explicit-path",
      "changed",
    ]);
  });

  it("treats only an explicit reference as mandatory", () => {
    expect(isMandatoryCandidate(candidate(["explicit-path"]))).toBe(true);
    expect(isMandatoryCandidate(candidate(["path-token", "changed"]))).toBe(
      false,
    );
  });

  it("lets configuration add rank, with the rule recorded", () => {
    const scored = scoreCandidate(candidate(["changed"]), {
      taskTokens: new Set(),
      priorityRules: [{ pattern: "src/**", points: 7 }],
    });
    expect(scored.score).toBe(37);
    expect(scored.reasons.at(-1)).toMatchObject({
      code: "configured-priority",
      points: 7,
      detail: "src/**",
    });
  });

  it("breaks ties by ref and kind, never by discovery order", () => {
    const make = (ref: string, score: number): ScoredCandidate => ({
      ...candidate(["changed"]),
      key: candidateIdOf({ kind: "source-file", ref }),
      ref,
      score,
      reasons: [],
    });
    const ordered = orderCandidates([
      make("src/b.ts", 10),
      make("src/a.ts", 10),
      make("src/c.ts", 20),
    ]);
    expect(ordered.map((entry) => entry.ref)).toEqual([
      "src/c.ts",
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("puts mandatory candidates first even when they score lower", () => {
    const low: ScoredCandidate = {
      ...candidate(["explicit-path"]),
      key: "source-file:src/a.ts",
      ref: "src/a.ts",
      score: 100,
      reasons: [{ code: "explicit-path", points: 100 }],
    };
    const high: ScoredCandidate = {
      ...candidate(["changed", "path-token", "filename-token"]),
      key: "source-file:src/z.ts",
      ref: "src/z.ts",
      score: 99,
      reasons: [],
    };
    expect(orderCandidates([high, low]).map((entry) => entry.ref)).toEqual([
      "src/a.ts",
      "src/z.ts",
    ]);
  });
});

describe("context budget: the arithmetic that must never be wrong", () => {
  it("admits on an exact boundary and refuses one token over", () => {
    expect(
      admitCandidate({
        phase: "estimate",
        budgetTokens: 100,
        usedTokens: 60,
        tokens: 40,
        mandatory: false,
        maxFileTokens: 1_000,
      }),
    ).toEqual({ kind: "select" });
    expect(
      admitCandidate({
        phase: "estimate",
        budgetTokens: 100,
        usedTokens: 60,
        tokens: 41,
        mandatory: false,
        maxFileTokens: 1_000,
      }),
    ).toEqual({ kind: "exclude", reason: "budget-cutoff" });
    expect(fitsWithin(100, 60, 40)).toBe(true);
  });

  it("refuses an oversized file before consulting the budget at all", () => {
    expect(
      admitCandidate({
        phase: "estimate",
        budgetTokens: 1_000_000,
        usedTokens: 0,
        tokens: 5_000,
        mandatory: false,
        maxFileTokens: 4_000,
      }),
    ).toEqual({ kind: "exclude", reason: "oversize-after-sizing" });
  });

  it("distinguishes an estimate miss from a content-size miss", () => {
    expect(
      admitCandidate({
        phase: "content",
        budgetTokens: 100,
        usedTokens: 60,
        tokens: 41,
        mandatory: false,
        maxFileTokens: 1_000,
      }),
    ).toEqual({ kind: "exclude", reason: "oversize-after-sizing" });
  });

  it("refuses loudly when the task required a file too large to read", () => {
    // Quietly dropping the file the task named would let the run continue and
    // produce a confident answer about something it never read.
    expect(
      admitCandidate({
        phase: "estimate",
        budgetTokens: 1_000_000,
        usedTokens: 0,
        tokens: 5_000,
        mandatory: true,
        maxFileTokens: 4_000,
      }),
    ).toEqual({ kind: "exclude", reason: "budget-exceeded" });
  });

  it("marks a mandatory candidate that does not fit as budget-exceeded", () => {
    expect(
      admitCandidate({
        phase: "estimate",
        budgetTokens: 10,
        usedTokens: 0,
        tokens: 40,
        mandatory: true,
        maxFileTokens: 1_000,
      }),
    ).toEqual({ kind: "exclude", reason: "budget-exceeded" });
  });

  it("treats a zero budget as no budget, not as unlimited", () => {
    expect(
      admitCandidate({
        phase: "content",
        budgetTokens: 0,
        usedTokens: 0,
        tokens: 1,
        mandatory: false,
        maxFileTokens: 1_000,
      }),
    ).toEqual({ kind: "exclude", reason: "oversize-after-sizing" });
    expect(
      admitCandidate({
        phase: "content",
        budgetTokens: 0,
        usedTokens: 0,
        tokens: 0,
        mandatory: false,
        maxFileTokens: 1_000,
      }),
    ).toEqual({ kind: "select" });
  });
});

const SMALL_FILES = {
  "src/engine.ts": "export const engine = 1;\n",
  "src/engine.test.ts": "import './engine.js';\n",
  "src/other.ts": "export const other = 2;\n",
  "src/util/helper.ts": "export const helper = 3;\n",
  "docs/architecture/ADR-001-engine.md": "# Engine architecture\n",
  "README.md": "# Readme\n",
  "ignored.log": "noise\n",
  ".gitignore": "ignored.log\n",
  "package.json": "{}\n",
} as const;

describe("context selection: discovery and determinism", () => {
  it("selects an explicitly referenced file as mandatory, and its tests", async () => {
    const harness = createContextHarness({ files: SMALL_FILES });
    const { selection } = await harness.engine.select({
      taskText: ["Fix the engine", "See src/engine.ts for the parser"],
      explicitPaths: ["src/engine.ts"],
      budgetTokens: 10_000,
    });

    const engineCandidate = selection.selected.find(
      (candidate) => candidate.ref === "src/engine.ts",
    );
    expect(engineCandidate).toBeDefined();
    expect(engineCandidate?.mandatory).toBe(true);
    expect(engineCandidate?.reasons).toContain("explicit-path");

    const test = selection.selected.find(
      (candidate) => candidate.ref === "src/engine.test.ts",
    );
    expect(test).toBeDefined();
    expect(test?.reasons).toContain("test-relationship");

    expect(selection.budgetExceeded).toBe(false);
    expect(harness.changes.calls).toBe(1);
  });

  it("pulls in a directly imported dependency, one hop only", async () => {
    const harness = createContextHarness({
      files: {
        "src/a.ts": "import { b } from './b.js';\n",
        "src/b.ts": "import { c } from './deep/c.js';\n",
        "src/deep/c.ts": "export const c = 1;\n",
      },
    });
    const { selection } = await harness.engine.select({
      taskText: ["change src/a.ts"],
      explicitPaths: ["src/a.ts"],
      budgetTokens: 10_000,
    });
    const refs = selection.selected.map((candidate) => candidate.ref);
    expect(refs).toContain("src/b.ts");
    // `src/deep/c.ts` is two hops away and in another directory, so nothing pulls
    // it in. A transitive closure over a real repository is "read everything".
    expect(refs).not.toContain("src/deep/c.ts");
    expect(
      selection.selected.find((candidate) => candidate.ref === "src/b.ts")
        ?.reasons,
    ).toContain("direct-dependency");
  });

  it("follows a side-effect and a dynamic import too", async () => {
    const harness = createContextHarness({
      files: {
        "src/entry.ts":
          "import './setup.js';\nconst lazy = import('./lazy.js');\n",
        "src/setup.ts": "export const setup = 1;\n",
        "src/lazy.ts": "export const lazy = 1;\n",
      },
    });
    const { selection } = await harness.engine.select({
      taskText: ["change src/entry.ts"],
      explicitPaths: ["src/entry.ts"],
      budgetTokens: 10_000,
    });
    const refs = selection.selected.map((candidate) => candidate.ref);
    expect(refs).toContain("src/setup.ts");
    expect(refs).toContain("src/lazy.ts");
  });

  it("finds ADRs only when the task is about architecture", async () => {
    const adapter = createContextHarness({
      files: SMALL_FILES,
    });
    const unrelated = await adapter.engine.select({
      taskText: ["Fix the login retry"],
      explicitPaths: [],
      budgetTokens: 10_000,
    });
    expect(
      unrelated.selection.selected.some(
        (candidate) => candidate.kind === "adr",
      ),
    ).toBe(false);

    const architectural = createContextHarness({ files: SMALL_FILES });
    const architecture = await architectural.engine.select({
      taskText: ["Update the architecture decision for the engine"],
      explicitPaths: [],
      budgetTokens: 10_000,
    });
    expect(
      architecture.selection.selected.map((candidate) => candidate.ref),
    ).toContain("docs/architecture/ADR-001-engine.md");
  });

  it("honours .gitignore and reports what it excluded by rule", async () => {
    const harness = createContextHarness({ files: SMALL_FILES });
    const { selection } = await harness.engine.select({
      taskText: ["Fix the engine"],
      explicitPaths: [],
      budgetTokens: 10_000,
    });
    expect(selection.selected.map((candidate) => candidate.ref)).not.toContain(
      "ignored.log",
    );
    expect(selection.excludedByRules).toBeGreaterThan(0);
  });

  it("never selects a secret-shaped path, even when the task names it", async () => {
    const harness = createContextHarness({
      files: {
        "src/a.ts": "export const a = 1;\n",
        ".env": "API_KEY=whatever\n",
        "keys/id_rsa": "-----BEGIN PRIVATE KEY-----\n",
      },
    });
    const { selection } = await harness.engine.select({
      taskText: ["read .env and keys/id_rsa"],
      explicitPaths: [".env", "keys/id_rsa"],
      budgetTokens: 10_000,
    });
    const refs = [
      ...selection.selected.map((candidate) => candidate.ref),
      ...selection.excluded.map((candidate) => candidate.ref),
    ];
    expect(refs).not.toContain(".env");
    expect(refs).not.toContain("keys/id_rsa");
    // And their bytes were never touched.
    expect(harness.fakeReader.readLog).not.toContain(".env");
    expect(harness.fakeReader.readLog).not.toContain("keys/id_rsa");
  });

  it("produces the same selection twice over the same state", async () => {
    const run = async () => {
      const harness = createContextHarness({
        files: SMALL_FILES,
        changedRefs: ["src/other.ts"],
      });
      const { selection } = await harness.engine.select({
        taskText: ["Fix the engine parser"],
        explicitPaths: ["src/engine.ts"],
        budgetTokens: 10_000,
      });
      return selection;
    };
    const first = await run();
    const second = await run();
    expect(second.selected).toEqual(first.selected);
    expect(second.excluded).toEqual(first.excluded);
    expect(second.selectedTokens).toBe(first.selectedTokens);
    expect(second.considered).toBe(first.considered);
  });

  it("notices a changed file and records the capability it had", async () => {
    const harness = createContextHarness({
      files: SMALL_FILES,
      changedRefs: ["src/other.ts"],
    });
    const { selection } = await harness.engine.select({
      taskText: ["Fix the engine"],
      explicitPaths: [],
      budgetTokens: 10_000,
    });
    expect(
      selection.selected.find((candidate) => candidate.ref === "src/other.ts")
        ?.reasons,
    ).toContain("changed");
    expect(selection.capabilities.available).toContain("git-changes");
  });

  it("reports change detection as unavailable rather than as no changes", async () => {
    const harness = createContextHarness({
      files: SMALL_FILES,
      changesAvailable: false,
      changeReason: "not-a-repository",
    });
    const { selection } = await harness.engine.select({
      taskText: ["Fix the engine"],
      explicitPaths: [],
      budgetTokens: 10_000,
    });
    expect(selection.capabilities.unavailable).toContain(
      "git-changes:not-a-repository",
    );
    expect(
      selection.selected.some((candidate) =>
        candidate.reasons.includes("changed"),
      ),
    ).toBe(false);
  });

  it("reports a capped listing instead of hiding it", async () => {
    const harness = createContextHarness({
      files: SMALL_FILES,
      truncated: true,
    });
    const { selection } = await harness.engine.select({
      taskText: ["Fix the engine"],
      explicitPaths: [],
      budgetTokens: 10_000,
    });
    expect(selection.capabilities.unavailable).toContain(
      "repository:listing-truncated",
    );
  });

  it("excludes disabled kinds by rule, not by silence", async () => {
    const harness = createContextHarness({
      files: SMALL_FILES,
      config: { includeTests: false, includeAdr: false },
    });
    const { selection } = await harness.engine.select({
      taskText: ["engine"],
      explicitPaths: [],
      budgetTokens: 10_000,
    });
    expect(
      selection.selected.some((candidate) => candidate.kind === "test-file"),
    ).toBe(false);
    expect(selection.excludedByRules).toBeGreaterThan(0);
  });
});

describe("context selection: the budget binds", () => {
  it("keeps the selection inside the budget and says what it dropped", async () => {
    const bulk: Record<string, string> = { "src/engine.ts": "x".repeat(400) };
    for (let index = 0; index < 20; index += 1) {
      bulk[`src/bulk-${String(index).padStart(2, "0")}.ts`] = "changed".repeat(
        50,
      );
    }
    const harness = createContextHarness({
      files: bulk,
      changedRefs: Object.keys(bulk).filter((ref) => ref !== "src/engine.ts"),
    });
    const { selection, bundle } = await harness.engine.select({
      taskText: ["touch src/engine.ts"],
      explicitPaths: ["src/engine.ts"],
      budgetTokens: 300,
    });

    expect(selection.selectedTokens).toBeLessThanOrEqual(300);
    expect(selection.selected.map((candidate) => candidate.ref)).toContain(
      "src/engine.ts",
    );
    expect(selection.excluded.length).toBeGreaterThan(0);
    expect(
      selection.excluded.every((candidate) =>
        ["budget-cutoff", "oversize-after-sizing", "budget-exceeded"].includes(
          candidate.reason,
        ),
      ),
    ).toBe(true);
    // The bundle only ever contains what was selected.
    expect(bundle.items.map((item) => item.ref)).toEqual(
      selection.selected.map((candidate) => candidate.ref),
    );
  });

  it("refuses loudly when the task's own reference does not fit, and yields no content", async () => {
    const harness = createContextHarness({
      files: { "src/big.ts": "x".repeat(4_000) },
    });
    const { selection, bundle } = await harness.engine.select({
      taskText: ["change src/big.ts"],
      explicitPaths: ["src/big.ts"],
      budgetTokens: 50,
    });

    expect(selection.budgetExceeded).toBe(true);
    expect(selection.overBudgetTokens).toBeGreaterThan(0);
    expect(selection.selected).toEqual([]);
    expect(bundle.items).toEqual([]);
    expect(
      selection.excluded.find((candidate) => candidate.ref === "src/big.ts")
        ?.reason,
    ).toBe("budget-exceeded");
  });

  it("refuses a file larger than the per-file cap without reading it", async () => {
    const harness = createContextHarness({
      files: { "src/huge.ts": "x".repeat(8_000) },
      config: { maxFileTokens: 10, maxTokens: 10_000 },
    });
    const { selection } = await harness.engine.select({
      taskText: ["change src/huge.ts"],
      explicitPaths: [],
      budgetTokens: 10_000,
    });
    expect(
      selection.excluded.find((candidate) => candidate.ref === "src/huge.ts")
        ?.reason,
    ).toBe("oversize-after-sizing");
    expect(harness.fakeReader.readLog).not.toContain("src/huge.ts");
  });

  it("rejects a negative budget rather than treating it as unlimited", async () => {
    const harness = createContextHarness({ files: SMALL_FILES });
    await expect(
      harness.engine.select({
        taskText: ["Fix the engine"],
        explicitPaths: [],
        budgetTokens: -1,
      }),
    ).rejects.toThrow(/non-negative integer/);
  });
});

describe("context selection: the record itself", () => {
  it("records the arithmetic, the counts and the reference lists", async () => {
    const harness = createContextHarness({
      files: SMALL_FILES,
      changedRefs: ["src/other.ts"],
    });
    const { selection } = await harness.engine.select({
      taskText: ["Fix the engine"],
      explicitPaths: ["src/engine.ts"],
      budgetTokens: 1_000,
    });

    expect(selection.selectionId).toBe("sel-1");
    expect(selection.strategy).toBe("deterministic");
    expect(selection.selectionVersion).toBe(1);
    expect(selection.configFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(selection.projectId).toBe(harness.project.id);
    expect(selection.workspaceId).toBe(harness.workspace.id);
    expect(selection.budgetTokens).toBe(1_000);
    expect(selection.considered).toBeGreaterThan(0);
    expect(selection.selectedTokens).toBeGreaterThan(0);
    expect(selection.remainingTokens).toBe(1_000 - selection.selectedTokens);
    expect(selection.candidateTokens).toBeGreaterThanOrEqual(
      selection.selectedTokens,
    );
    expect(selection.refsTruncated).toBe(false);
    expect(selection.durationMs).toBe(0);
    expect(selection.createdAt).toBe("2026-09-20T10:00:00.000Z");
  });

  it("changes the config fingerprint when selection configuration changes", async () => {
    const base = createContextHarness({ files: SMALL_FILES });
    const other = createContextHarness({
      files: SMALL_FILES,
      config: { maxTokens: 4_000 },
    });
    const first = await base.engine.select({
      taskText: ["engine"],
      budgetTokens: 1_000,
    });
    const second = await other.engine.select({
      taskText: ["engine"],
      budgetTokens: 1_000,
    });
    expect(first.selection.configFingerprint).not.toBe(
      second.selection.configFingerprint,
    );
  });

  it("records no file content anywhere in the metadata", async () => {
    const secretish = "TOPSECRETPAYLOAD".repeat(3);
    const harness = createContextHarness({
      files: { "src/a.ts": `export const a = "${secretish}";\n` },
    });
    const { selection, bundle } = await harness.engine.select({
      taskText: ["change src/a.ts"],
      explicitPaths: ["src/a.ts"],
      budgetTokens: 1_000,
    });
    expect(JSON.stringify(selection)).not.toContain("TOPSECRETPAYLOAD");
    // The content is available for one prompt, and only there.
    expect(bundle.items[0]?.content).toContain("TOPSECRETPAYLOAD");
  });
});
