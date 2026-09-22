import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DECISION_PROVIDER_KINDS } from "../../src/adapters/config/project-config.js";
import {
  DECISION_DOMAINS,
  DECISION_PROVIDER_EXECUTION_SOURCES,
} from "../../src/decisions/domains.js";
import { EVENT_TYPES } from "../../src/observability/events.js";

/**
 * The architectural invariant: the decision layer is TypeSafe/JEV and nothing else.
 *
 * The repository once carried a second, local inference layer ("Laya") and the
 * shadow-decision plumbing that existed only to observe it. That layer has been
 * removed, and this suite makes the removal *structural* rather than remembered: it
 * fails the moment a Laya reference, a shadow-decision path or the local-model
 * provenance marker is reintroduced into production source or configuration.
 *
 * It scans source and configuration as text rather than relying on imports alone,
 * because the failure being prevented is not only a bad `import` — it is a
 * configuration key, a bridge path, an environment variable name or a checkpoint
 * reference creeping back in. A text scan catches all of them; an import graph
 * catches one.
 *
 * The scan deliberately does not read `docs/`. Historical documents may name the
 * removed phase in prose, and that is intentional; production code may not.
 */

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Directories whose contents are production surface and must stay Laya-free. */
const PRODUCTION_ROOTS = ["src", "scripts"] as const;

/** Configuration files that are executable surface, not documentation. */
const CONFIG_FILES = [
  "package.json",
  ".env.example",
  ".gitignore",
  "eslint.config.js",
  ".ai/project.json",
] as const;

/**
 * What is forbidden, and why each pattern exists.
 *
 * The Laya pattern uses a negative lookbehind rather than a word boundary so it
 * catches the identifier shapes a real reference takes (`laya_bridge`, `.laya-venv`,
 * `convaiinnovations/laya`) while *not* matching the ordinary English word
 * "replayable", which shares the letters but is not a reference to anything.
 */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly label: string }[] =
  [
    { pattern: /(?<![a-zA-Z])laya/i, label: "Laya reference" },
    { pattern: /shadow-?decision/i, label: "shadow-decision reference" },
    { pattern: /local-model/i, label: "local-model provenance reference" },
  ];

function* walkFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      yield* walkFiles(full);
      continue;
    }
    yield full;
  }
}

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly label: string;
  readonly text: string;
}

function scanForbiddenReferences(): Offender[] {
  const offenders: Offender[] = [];
  const files: string[] = [];
  for (const root of PRODUCTION_ROOTS) {
    const absolute = join(PROJECT_ROOT, root);
    if (existsSync(absolute)) {
      files.push(...walkFiles(absolute));
    }
  }
  for (const file of CONFIG_FILES) {
    const absolute = join(PROJECT_ROOT, file);
    if (existsSync(absolute)) {
      files.push(absolute);
    }
  }

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, index) => {
      for (const { pattern, label } of FORBIDDEN) {
        if (pattern.test(text)) {
          offenders.push({
            file: relative(PROJECT_ROOT, file),
            line: index + 1,
            label,
            text: text.trim(),
          });
        }
      }
    });
  }
  return offenders;
}

describe("architectural invariant: no Laya dependency in production", () => {
  it("production source and configuration carry no Laya or shadow-decision reference", () => {
    const offenders = scanForbiddenReferences();
    // Rendered as a readable list so a reintroduction names its own file and line
    // instead of failing with an opaque "expected [] to equal [...]".
    const report = offenders
      .map((o) => `${o.file}:${o.line} [${o.label}] ${o.text}`)
      .join("\n");
    expect(offenders, `forbidden references found:\n${report}`).toEqual([]);
  });

  it("none of the removed Laya scripts exist on disk", () => {
    for (const script of [
      "scripts/laya_bridge.py",
      "scripts/laya_download.py",
      "scripts/laya_infer_proof.py",
      "scripts/laya_shadow_eval.py",
    ]) {
      expect(existsSync(join(PROJECT_ROOT, script)), script).toBe(false);
    }
  });

  it("the decision provider vocabulary is TypeSafe/JEV only", () => {
    expect([...DECISION_PROVIDER_KINDS]).toEqual([
      "disabled",
      "jev-http",
      "typesafe",
    ]);
  });

  it("the recorded execution-source vocabulary has no local-model value", () => {
    // `local-model` was minted only by the removed adapter's local inference
    // boundary. No surviving provider can produce it, so the vocabulary must not
    // advertise it — a closed vocabulary with a dead value is a lie about what can
    // be recorded.
    expect([...DECISION_PROVIDER_EXECUTION_SOURCES]).toEqual([
      "live-sdk",
      "test-double",
    ]);
  });

  it("the event vocabulary has no shadow-decision event", () => {
    expect([...EVENT_TYPES]).not.toContain("ShadowDecisionCompleted");
  });

  it("the decision layer still owns the full bounded-domain set", () => {
    // The invariants above forbid an extra layer; this one guards against the
    // opposite failure — removing Laya by quietly deleting decision domains.
    expect([...DECISION_DOMAINS].sort()).toEqual(
      [
        "routing",
        "tool-selection",
        "risk-assessment",
        "retry",
        "completion",
        "ranking",
        "relevance",
        "human-escalation",
        "execution-strategy",
        "skill-selection",
        "context-selection",
      ].sort(),
    );
  });

  it("the runtime declares no learned-model dependency beyond the TypeSafe SDK", () => {
    const pkg = JSON.parse(
      readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
    ) as { readonly dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      "@typesafe-ai/sdk",
    ]);
  });

  it("the project configuration carries no shadow-decision block", () => {
    const config = JSON.parse(
      readFileSync(join(PROJECT_ROOT, ".ai", "project.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(config["decisionShadow"]).toBeUndefined();
  });
});
