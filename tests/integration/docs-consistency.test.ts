import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  adrReferences,
  formatMarkdown,
  reconciliationNotes,
  renderReconciliationIndex,
  RECONCILIATION_INDEX_PATH,
} from "../../scripts/reconciliation-notes.js";

/**
 * The architectural invariant: the normative documents agree with each other and
 * with the ADR set.
 *
 * `README.md`, `docs/ARCHITECTURE.md` and the RFC (`V2-ARCHITECTURE.md`) make
 * claims about *which phase is current* and *what is implemented*, and they cite
 * ADRs as their authority. `DECISIONS.md` is the ADR set those claims rest on.
 * Documentation drift — a phase status that contradicts the roadmap, an ADR
 * reference that points at nothing, an index row with no ADR behind it, an
 * architecture pointer to a section that does not exist, a documented source path
 * that is not on disk, or a capability listed as "not implemented" after a
 * completed phase delivered it — is exactly the failure this suite makes
 * structural: it fails the build the moment the docs stop agreeing.
 *
 * Every check is a cross-document equation expressed as a pure function of the
 * document text, never a snapshot of the current phase. Those functions are also
 * exercised below against deliberately mutated text, so the guard proves it can
 * fail rather than merely asserting that today's prose is fine.
 *
 * ## What is generic and what is intentionally current-state
 *
 * Generic (stays true as the project advances through Phase I, Phase J, …):
 *   - every ADR reference resolves, and the ADR index mirrors the headings;
 *   - the roadmap mermaid graph and phase table agree on every phase's status;
 *   - a document's declared "current phase" equals the newest completed phase;
 *   - every status section belongs to a completed phase, and every completed
 *     phase from the earliest status section onward has a status section;
 *   - architecture `§n (Phase X)` pointers name real RFC sections and cover them;
 *   - documented `src/`… layout paths exist on disk;
 *   - a capability a completed phase delivers is not listed as not implemented;
 *   - every dated reconciliation note is well-formed and cites an existing ADR;
 *   - the generated reconciliation index matches the notes it is derived from.
 *
 * Intentionally current-state (machine-detectable contract lines that must move
 * with the roadmap, not be reworded away): the README `Status: **Phase X**`
 * line, the ARCHITECTURE `Implemented today (Phases C–X)` line, and the
 * capability markers in `DELIVERED_CAPABILITY_MARKERS` below.
 */

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), "utf8");
}

const README = read("README.md");
const ARCHITECTURE = read("docs/ARCHITECTURE.md");
const RFC = read("docs/architecture/V2-ARCHITECTURE.md");
const DECISIONS = read("docs/architecture/DECISIONS.md");

interface Doc {
  readonly name: string;
  readonly text: string;
}

/** The documents that make normative claims against the ADR set. */
const NORMATIVE_DOCS: readonly Doc[] = [
  { name: "README.md", text: README },
  { name: "docs/ARCHITECTURE.md", text: ARCHITECTURE },
  { name: "docs/architecture/V2-ARCHITECTURE.md", text: RFC },
  { name: "docs/architecture/DECISIONS.md", text: DECISIONS },
];

/**
 * Capabilities that a completed phase delivers. Each is matched only where the
 * roadmap's own table says a completed phase produced it, and never where a
 * "not implemented" clause names it. Adding a normal phase does not touch this
 * list; it changes only if a capability is renamed.
 */
const DELIVERED_CAPABILITY_MARKERS: readonly RegExp[] = [/multi-?model/i];

// ---------------------------------------------------------------------------
// Parsing: text in, structure out. No assertion lives in this section.
// ---------------------------------------------------------------------------

/** Every `## ADR-0NN — Title` heading number in the ADR set. */
function adrHeadingNumbers(text: string): string[] {
  return [...text.matchAll(/^## ADR-(\d{3}) — /gm)].map((m) => m[1]!);
}

/**
 * Every distinct `ADR-0NN` reference in a document. Defined in
 * `scripts/reconciliation-notes.ts`, the same module the reconciliation index
 * generator uses, so the reference syntax is shared rather than copied.
 */

/** The numbers listed in the ADR index table, which must mirror the headings. */
function adrIndexNumbers(text: string): string[] {
  const start = text.indexOf("\n## ADR index");
  const end = text.indexOf("\n## ", start + 1);
  const block = text.slice(start, end === -1 ? undefined : end);
  return [...block.matchAll(/^\| (\d{3}) \|/gm)].map((m) => m[1]!);
}

/**
 * The body of a `##` section, located by its heading text rather than its
 * number, so renumbering the RFC does not break the guard. Stops at the next
 * `##`/`###` heading.
 */
function sectionBody(text: string, heading: RegExp): string {
  const start = text.search(heading);
  if (start === -1) {
    return "";
  }
  const after = text.slice(start + 1);
  const end = after.search(/^#{2,3} /m);
  return end === -1 ? after : after.slice(0, end);
}

/** The RFC's roadmap section, which carries the mermaid graph and phase table. */
function roadmapSection(text: string): string {
  return sectionBody(text, /^## \d+\. Phased roadmap\b/m);
}

interface PhaseRow {
  readonly letter: string;
  readonly complete: boolean;
  readonly deliverable: string;
}

/** One entry per roadmap table row: its phase letter, status and deliverable. */
function phaseRows(text: string): PhaseRow[] {
  const rows: PhaseRow[] = [];
  for (const line of roadmapSection(text).split(/\r?\n/)) {
    const match = line.match(/^\| \*\*([A-J])\*\*(\s+✅)?\s*\|([^|]*)\|/);
    if (match) {
      rows.push({
        letter: match[1]!,
        complete: Boolean(match[2]),
        deliverable: match[3]!.trim(),
      });
    }
  }
  return rows;
}

/** Which phases the roadmap graph marks complete (`Phase X<br/>…✅`). */
function mermaidPhaseMarks(text: string): Map<string, boolean> {
  const graph =
    roadmapSection(text).match(/```mermaid([\s\S]*?)```/)?.[1] ?? "";
  const marks = new Map<string, boolean>();
  for (const match of graph.matchAll(
    /([A-J])\["Phase ([A-J])<br\/>([^"]*)"\]/g,
  )) {
    marks.set(match[2]!, match[3]!.includes("✅"));
  }
  return marks;
}

/** Which phases the roadmap table marks complete (`**X** ✅`). */
function tablePhaseMarks(text: string): Map<string, boolean> {
  return new Map(phaseRows(text).map((row) => [row.letter, row.complete]));
}

/** `section number → phase letter` for the RFC's per-phase status sections. */
function rfcStatusSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const match of text.matchAll(/^## (\d+)\. Phase ([A-J]) status/gm)) {
    sections.set(match[1]!, match[2]!);
  }
  return sections;
}

/** The paragraph that enumerates what a document says is *not* implemented. */
function notImplementedClause(text: string): string {
  const marker = text.search(/not implemented\*{0,2}:/i);
  if (marker === -1) {
    return "";
  }
  const rest = text.slice(marker);
  const end = rest.search(/\n\s*\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Repository-relative paths documented in the `## Layout` section. */
function documentedPaths(text: string): string[] {
  const body = sectionBody(text, /^## Layout\b/m);
  const paths = new Set<string>();
  for (const match of body.matchAll(/`([^`]+)`/g)) {
    const token = match[1]!.replace(/\/$/, "");
    if (/^(src|tests|scripts|docs|\.github)\//.test(token)) {
      paths.add(token);
    }
  }
  return [...paths];
}

/**
 * Markers that do not fit the canonical form. `reconciliationNotes` — from
 * `scripts/reconciliation-notes.ts`, the module the index generator uses too, so
 * the guard and the generated page can never disagree about what a note is —
 * parses the canonical notes. Every literal `Reconciled` must belong to exactly
 * one of them, so a mistyped date, a missing colon or a dropped italic marker
 * leaves the marker count above the note count.
 */
function malformedReconciliationNotes(text: string): string[] {
  const markers = [...text.matchAll(/Reconciled\b/g)].length;
  const canonical = reconciliationNotes(text).length;
  return markers === canonical
    ? []
    : [`${markers} "Reconciled" marker(s) but ${canonical} canonical note(s)`];
}

// ---------------------------------------------------------------------------
// Invariants: each returns the violations it finds, empty when the docs agree.
// ---------------------------------------------------------------------------

function unresolvedAdrReferences(
  docs: readonly Doc[],
  headings: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  for (const doc of docs) {
    for (const ref of adrReferences(doc.text)) {
      if (!headings.has(ref)) {
        violations.push(`${doc.name} references ADR-${ref}`);
      }
    }
  }
  return violations;
}

function adrIndexViolations(text: string): string[] {
  const index = adrIndexNumbers(text);
  const headings = adrHeadingNumbers(text);
  const violations: string[] = [];
  if (index.length === 0) {
    violations.push("the ADR index table was not found");
  }
  for (const heading of headings) {
    if (!index.includes(heading)) {
      violations.push(`ADR-${heading} is missing from the index`);
    }
  }
  for (const listed of index) {
    if (!headings.includes(listed)) {
      violations.push(`the index lists ADR-${listed} with no heading`);
    }
  }
  return violations;
}

function roadmapMarkDisagreements(text: string): string[] {
  const graph = mermaidPhaseMarks(text);
  const table = tablePhaseMarks(text);
  const letters = new Set([...graph.keys(), ...table.keys()]);
  const violations: string[] = [];
  for (const letter of letters) {
    if (graph.get(letter) !== table.get(letter)) {
      violations.push(letter);
    }
  }
  return violations;
}

/** The newest phase the roadmap marks complete, or undefined if none is. */
function newestCompletedPhase(text: string): string | undefined {
  return phaseRows(text)
    .filter((row) => row.complete)
    .map((row) => row.letter)
    .reduce<string | undefined>(
      (a, b) => (a === undefined || b > a ? b : a),
      undefined,
    );
}

/** README's machine-detectable `Status: **Phase X**` claim. */
function readmePhaseClaim(text: string): string | undefined {
  return text.match(/^Status: \*\*Phase ([A-J])\*\*/m)?.[1];
}

/** ARCHITECTURE's machine-detectable `Implemented today (Phases C–X)` claim. */
function archImplementedRange(
  text: string,
): readonly [string, string] | undefined {
  const match = text.match(/Implemented today \(Phases ([A-J])[–-]([A-J])\)/);
  return match ? [match[1]!, match[2]!] : undefined;
}

/**
 * Status sections must stand on completed phases, and completed phases from the
 * earliest status section onward must each have one — so a phase cannot be
 * marked done in the roadmap without the section that documents it.
 */
function statusSectionViolations(text: string): string[] {
  const sections = rfcStatusSections(text);
  const rows = phaseRows(text);
  const byLetter = new Map(rows.map((row) => [row.letter, row]));
  const violations: string[] = [];

  for (const [section, letter] of sections) {
    if (byLetter.get(letter)?.complete !== true) {
      violations.push(
        `§${section} is a Phase ${letter} status section but Phase ${letter} is not marked complete`,
      );
    }
  }

  const sectionLetters = [...sections.values()];
  const earliest = [...sectionLetters].sort()[0];
  if (earliest !== undefined) {
    const withSections = new Set(sectionLetters);
    for (const row of rows) {
      if (
        row.letter >= earliest &&
        row.complete &&
        !withSections.has(row.letter)
      ) {
        violations.push(
          `Phase ${row.letter} is complete but has no "§n. Phase ${row.letter} status" section`,
        );
      }
    }
  }
  return violations;
}

function archPointerViolations(archText: string, rfcText: string): string[] {
  const sections = rfcStatusSections(rfcText);
  const pointers = [...archText.matchAll(/§(\d+) \(Phase ([A-J])\)/g)].map(
    (match) => [match[1]!, match[2]!] as const,
  );
  const violations: string[] = [];
  for (const [section, letter] of pointers) {
    if (sections.get(section) !== letter) {
      violations.push(
        `§${section} (Phase ${letter}) does not name an RFC status section`,
      );
    }
  }
  const pointed = new Set(pointers.map(([section]) => section));
  for (const section of sections.keys()) {
    if (!pointed.has(section)) {
      violations.push(`no architecture pointer to §${section}`);
    }
  }
  return violations;
}

/** Documented layout paths that are not present on disk. */
function missingDocumentedPaths(text: string, base: string): string[] {
  return documentedPaths(text).filter((path) => !existsSync(join(base, path)));
}

/** Completed phases that no longer deliver one of the guarded capabilities. */
function undeliveredCapabilityMarkers(
  rfcText: string,
  markers: readonly RegExp[],
): string[] {
  const completed = phaseRows(rfcText).filter((row) => row.complete);
  return markers
    .filter((marker) => !completed.some((row) => marker.test(row.deliverable)))
    .map((marker) => String(marker));
}

/** "Not implemented" clauses that name a capability a completed phase delivers. */
/** Reconciliation notes that cite no ADR, or one that does not exist. */
function unbackedReconciliationNotes(
  docs: readonly Doc[],
  headings: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  for (const doc of docs) {
    for (const note of reconciliationNotes(doc.text)) {
      const refs = adrReferences(note.body);
      if (refs.length === 0) {
        violations.push(`${doc.name}: note "${note.date}" cites no ADR`);
        continue;
      }
      for (const ref of refs) {
        if (!headings.has(ref)) {
          violations.push(`${doc.name}: note "${note.date}" cites ADR-${ref}`);
        }
      }
    }
  }
  return violations;
}

function contradictedCapabilities(
  docs: readonly Doc[],
  markers: readonly RegExp[],
): string[] {
  const violations: string[] = [];
  for (const doc of docs) {
    const clause = notImplementedClause(doc.text);
    if (clause === "") {
      continue;
    }
    for (const marker of markers) {
      if (marker.test(clause)) {
        violations.push(`${doc.name}: ${String(marker)}`);
      }
    }
  }
  return violations;
}

/** The RFC section that documents the newest completed phase. */
function currentStatusSection(rfcText: string): string | undefined {
  const phase = newestCompletedPhase(rfcText);
  if (phase === undefined) {
    return undefined;
  }
  for (const [section, letter] of rfcStatusSections(rfcText)) {
    if (letter === phase) {
      return section;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The guard, run against the real documents.
// ---------------------------------------------------------------------------

describe("documentation consistency: ADR references", () => {
  const headings = new Set(adrHeadingNumbers(DECISIONS));

  it("every ADR referenced anywhere in the normative docs exists", () => {
    expect(unresolvedAdrReferences(NORMATIVE_DOCS, headings).join("\n")).toBe(
      "",
    );
  });

  it("the ADR index lists exactly the ADRs that exist", () => {
    expect(adrIndexViolations(DECISIONS).join("\n")).toBe("");
  });
});

describe("documentation consistency: phase status", () => {
  it("the roadmap graph and table agree on every phase's completion", () => {
    expect(roadmapMarkDisagreements(RFC).join(", ")).toBe("");
  });

  it("README declares the newest completed phase as current", () => {
    const claim = readmePhaseClaim(README);
    expect(claim, "README.md has no `Status: **Phase X**` line").toBeDefined();
    expect(claim).toBe(newestCompletedPhase(RFC));
  });

  it("ARCHITECTURE.md's implemented range ends at the newest completed phase", () => {
    const range = archImplementedRange(ARCHITECTURE);
    expect(
      range,
      "docs/ARCHITECTURE.md has no `Implemented today (Phases C–X)` line",
    ).toBeDefined();
    expect(range![1]).toBe(newestCompletedPhase(RFC));
  });

  it("status sections and completed phases stand on each other", () => {
    expect(statusSectionViolations(RFC).join("\n")).toBe("");
  });

  it("ARCHITECTURE.md's `§n (Phase X)` pointers name the RFC sections they claim", () => {
    expect(archPointerViolations(ARCHITECTURE, RFC).join("\n")).toBe("");
  });

  it("README points the reader at the current phase's RFC status section", () => {
    const section = currentStatusSection(RFC);
    expect(
      section,
      "the RFC has no status section for the newest phase",
    ).toBeDefined();
    expect(README).toContain(`§${section}`);
  });

  it("the guarded capabilities are still delivered by a completed phase", () => {
    // Keeps DELIVERED_CAPABILITY_MARKERS from silently checking nothing.
    expect(
      undeliveredCapabilityMarkers(RFC, DELIVERED_CAPABILITY_MARKERS),
    ).toEqual([]);
  });
});

describe("documentation consistency: what is not implemented", () => {
  it("README and ARCHITECTURE describe a not-implemented list at all", () => {
    expect(notImplementedClause(README)).not.toBe("");
    expect(notImplementedClause(ARCHITECTURE)).not.toBe("");
  });

  it("no capability a completed phase delivers is listed as not implemented", () => {
    expect(
      contradictedCapabilities(
        [
          { name: "README.md", text: README },
          { name: "docs/ARCHITECTURE.md", text: ARCHITECTURE },
        ],
        DELIVERED_CAPABILITY_MARKERS,
      ).join("\n"),
    ).toBe("");
  });
});

describe("documentation consistency: documented layout paths", () => {
  it("every path ARCHITECTURE.md presents as implemented exists on disk", () => {
    expect(missingDocumentedPaths(ARCHITECTURE, PROJECT_ROOT).join("\n")).toBe(
      "",
    );
  });
});

describe("documentation consistency: dated reconciliation notes", () => {
  const headings = new Set(adrHeadingNumbers(DECISIONS));

  it("every reconciliation marker fits the canonical dated italic form", () => {
    const violations = NORMATIVE_DOCS.flatMap((doc) =>
      malformedReconciliationNotes(doc.text).map(
        (violation) => `${doc.name}: ${violation}`,
      ),
    );
    expect(violations.join("\n")).toBe("");
  });

  it("every reconciliation note cites an existing ADR", () => {
    expect(
      unbackedReconciliationNotes(NORMATIVE_DOCS, headings).join("\n"),
    ).toBe("");
  });

  it("the docs actually carry reconciliation notes", () => {
    // Keeps the two checks above from passing by finding nothing.
    const total = NORMATIVE_DOCS.reduce(
      (sum, doc) => sum + reconciliationNotes(doc.text).length,
      0,
    );
    expect(total).toBeGreaterThan(0);
  });

  it("the index carries an entry for every note in the docs", () => {
    const page = read(RECONCILIATION_INDEX_PATH);
    for (const doc of NORMATIVE_DOCS) {
      for (const note of reconciliationNotes(doc.text)) {
        expect(page).toContain(`${note.date} — \`${doc.name}\``);
      }
    }
  });

  it("the index page is exactly what the notes render to", async () => {
    const expected = await formatMarkdown(
      renderReconciliationIndex(NORMATIVE_DOCS),
      join(PROJECT_ROOT, RECONCILIATION_INDEX_PATH),
    );
    expect(read(RECONCILIATION_INDEX_PATH)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Mutation coverage: each generic invariant must actually detect its failure.
// The mutations are applied to in-memory copies; no file is written.
// ---------------------------------------------------------------------------

describe("guard mutation coverage: generic checks fail on injected drift", () => {
  it("detects a dangling ADR reference", () => {
    const headings = new Set(adrHeadingNumbers(DECISIONS));
    const mutated: Doc[] = [
      { name: "README.md", text: `${README}\nSee ADR-999.` },
    ];
    expect(unresolvedAdrReferences(mutated, headings)).toContain(
      "README.md references ADR-999",
    );
  });

  it("detects roadmap graph/table phase-status disagreement", () => {
    const mutated = RFC.replace(
      "Phase H<br/>multi-model frontier ✅",
      "Phase H<br/>multi-model frontier",
    );
    expect(mutated).not.toBe(RFC);
    expect(roadmapMarkDisagreements(mutated)).toContain("H");
  });

  it("detects a README current-phase mismatch", () => {
    const mutated = README.replace(
      "Status: **Phase H**",
      "Status: **Phase G**",
    );
    expect(mutated).not.toBe(README);
    expect(readmePhaseClaim(mutated)).not.toBe(newestCompletedPhase(RFC));
  });

  it("detects a completed phase with no status section", () => {
    const mutated = RFC.replace(/\| \*\*I\*\*\s+\|/, "| **I** ✅ |");
    expect(mutated).not.toBe(RFC);
    expect(statusSectionViolations(mutated).join("\n")).toContain("Phase I");
  });

  it("detects an architecture pointer to a section that is about another phase", () => {
    const mutated = ARCHITECTURE.replace("§38 (Phase G)", "§38 (Phase H)");
    expect(mutated).not.toBe(ARCHITECTURE);
    expect(archPointerViolations(mutated, RFC).join("\n")).toContain("§38");
  });

  it("detects a documented source path that does not exist", () => {
    const mutated = ARCHITECTURE.replace("`src/models/`", "`src/models-typo/`");
    expect(mutated).not.toBe(ARCHITECTURE);
    expect(missingDocumentedPaths(mutated, PROJECT_ROOT)).toContain(
      "src/models-typo",
    );
  });

  it("detects a capability listed as not implemented after a phase delivered it", () => {
    const mutated: Doc[] = [
      {
        name: "README.md",
        text: "Still designed but **not implemented**: multi-model routing.",
      },
    ];
    expect(
      contradictedCapabilities(mutated, DELIVERED_CAPABILITY_MARKERS),
    ).not.toEqual([]);
  });

  it("detects a reconciliation note with a malformed date", () => {
    const mutated = RFC.replace(
      "_Reconciled 2026-09-27:",
      "_Reconciled 2026-9-27:",
    );
    expect(mutated).not.toBe(RFC);
    expect(malformedReconciliationNotes(mutated).join("\n")).not.toBe("");
  });

  it("detects a reconciliation note that cites no ADR", () => {
    const headings = new Set(adrHeadingNumbers(DECISIONS));
    const mutated = RFC.replace(
      /_Reconciled 2026-09-27:[\s\S]*?_/,
      "_Reconciled 2026-09-27: this note lost its citations._",
    );
    expect(mutated).not.toBe(RFC);
    expect(
      unbackedReconciliationNotes(
        [{ name: "V2-ARCHITECTURE.md", text: mutated }],
        headings,
      ).join("\n"),
    ).not.toBe("");
  });

  it("detects a reconciliation note citing an ADR that does not exist", () => {
    const headings = new Set(adrHeadingNumbers(DECISIONS));
    const mutated = RFC.replace(
      "_Reconciled 2026-09-27:",
      "_Reconciled 2026-09-27: see ADR-999.",
    );
    expect(mutated).not.toBe(RFC);
    expect(
      unbackedReconciliationNotes(
        [{ name: "V2-ARCHITECTURE.md", text: mutated }],
        headings,
      ).join("\n"),
    ).toContain("ADR-999");
  });

  it("detects an index that has fallen behind a newly added note", () => {
    const mutated: Doc[] = NORMATIVE_DOCS.map((doc) =>
      doc.name === "README.md"
        ? {
            name: doc.name,
            text: `${doc.text}\n\n_Reconciled 2026-09-28: a newly superseded claim (ADR-059)._`,
          }
        : doc,
    );
    expect(renderReconciliationIndex(mutated)).not.toBe(
      renderReconciliationIndex(NORMATIVE_DOCS),
    );
  });
});
