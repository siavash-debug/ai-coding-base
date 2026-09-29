import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import prettier from "prettier";

/**
 * Reconciliation notes: the one definition of the dated amendment a historical
 * document carries when a later phase supersedes one of its claims, plus the
 * generator for `docs/architecture/RECONCILIATIONS.md`.
 *
 * A note is an italic span opening `_Reconciled YYYY-MM-DD: ` and closing `_`.
 * The document keeps its original claim and is amended rather than rewritten, so
 * the note records both what changed and which ADRs changed it. This module is
 * shared by the generator below and by
 * `tests/integration/docs-consistency.test.ts`, so the index and the guard can
 * never disagree about what a note is.
 *
 * Run `pnpm docs:reconciliations` to regenerate the index after editing the
 * documents; the docs-consistency test fails if the committed page drifts.
 */

export interface Doc {
  readonly name: string;
  readonly text: string;
}

export interface ReconciliationNote {
  readonly date: string;
  readonly body: string;
  /** The nearest preceding markdown heading, which locates the amended claim. */
  readonly section: string;
}

/**
 * The canonical note form. `[^_]+` for the body is deliberate: a note closes at
 * the first underscore, so a body may not contain one.
 */
export const RECONCILIATION_NOTE = /_Reconciled (\d{4}-\d{2}-\d{2}): ([^_]+)_/g;

/**
 * Every canonical `_Reconciled YYYY-MM-DD: …_` note in a document, each carrying
 * the nearest heading above it so the index can say which claim was amended.
 */
export function reconciliationNotes(text: string): ReconciliationNote[] {
  return [...text.matchAll(RECONCILIATION_NOTE)].map((match) => {
    const before = text.slice(0, match.index ?? 0);
    const headings = [...before.matchAll(/^#{1,6} (.+)$/gm)];
    return {
      date: match[1]!,
      body: match[2]!,
      section: headings.at(-1)?.[1]?.trim() ?? "",
    };
  });
}

/**
 * Every distinct `ADR-0NN` reference in a passage, in order of first appearance.
 *
 * The trailing `\b` keeps a four-digit example id such as `"ADR-0007"` from
 * being read as a reference to a non-existent `000`.
 */
export function adrReferences(text: string): string[] {
  return [...new Set([...text.matchAll(/ADR-(\d{3})\b/g)].map((m) => m[1]!))];
}

/** The documents the index is derived from, in the order notes appear in them. */
export const NORMATIVE_DOC_PATHS = [
  "README.md",
  "docs/ARCHITECTURE.md",
  "docs/architecture/V2-ARCHITECTURE.md",
  "docs/architecture/DECISIONS.md",
] as const;

/** Where the generated index lives, relative to the project root. */
export const RECONCILIATION_INDEX_PATH = "docs/architecture/RECONCILIATIONS.md";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Render the index for `docs`. The result is plain markdown; callers format it
 * with Prettier before writing or comparing, so the committed page is exactly
 * what `pnpm format:check` accepts.
 */
export function renderReconciliationIndex(docs: readonly Doc[]): string {
  const lines: string[] = [
    "<!-- Generated from the normative documents by `pnpm docs:reconciliations`. Do not edit by hand. -->",
    "",
    "# Reconciliation notes",
    "",
    "The normative documents keep their historical claims intact. When a later phase makes a claim",
    "out of date, the section is amended with a dated **reconciliation note** — an italic span",
    "opening `_Reconciled YYYY-MM-DD:` and closing `_` — rather than being rewritten. This page",
    "collects every one, so a reader can see what was superseded, when, and by which decisions in a",
    "single place.",
    "",
    "It is a projection, not a source: the notes in `README.md`, `docs/ARCHITECTURE.md`, the RFC",
    "(`docs/architecture/V2-ARCHITECTURE.md`) and the ADR set (`docs/architecture/DECISIONS.md`) are",
    "authoritative, and `tests/integration/docs-consistency.test.ts` fails if this page drifts from",
    "them.",
  ];

  for (const doc of docs) {
    for (const note of reconciliationNotes(doc.text)) {
      const refs = adrReferences(note.body);
      const where = note.section === "" ? "" : ` — ${note.section}`;
      lines.push("", `## ${note.date} — \`${doc.name}\`${where}`, "");
      lines.push(
        refs.length === 0
          ? "Cites no ADR (a malformed note; the docs-consistency guard fails on this)."
          : `Cites ${refs.map((ref) => `ADR-${ref}`).join(", ")}.`,
      );
      lines.push("");
      for (const line of note.body.split(/\r?\n/)) {
        lines.push(`> ${line.trim()}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Format markdown the way `pnpm format:check` would, using the repo's config. */
export async function formatMarkdown(
  markdown: string,
  filePath: string,
): Promise<string> {
  const options = await prettier.resolveConfig(filePath);
  return prettier.format(markdown, { ...(options ?? {}), parser: "markdown" });
}

async function main(): Promise<void> {
  const docs: Doc[] = NORMATIVE_DOC_PATHS.map((name) => ({
    name,
    text: readFileSync(join(PROJECT_ROOT, name), "utf8"),
  }));
  const formatted = await formatMarkdown(
    renderReconciliationIndex(docs),
    join(PROJECT_ROOT, RECONCILIATION_INDEX_PATH),
  );
  writeFileSync(join(PROJECT_ROOT, RECONCILIATION_INDEX_PATH), formatted);
  const notes = docs.reduce(
    (sum, doc) => sum + reconciliationNotes(doc.text).length,
    0,
  );
  process.stdout.write(
    `Wrote ${RECONCILIATION_INDEX_PATH} (${notes} note(s) from ${docs.length} documents).\n`,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  await main();
}
