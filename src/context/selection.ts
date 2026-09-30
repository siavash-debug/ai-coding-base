import type { ProjectId, TaskId, WorkspaceId } from "../core/ids.js";

/**
 * Context selection: the vocabulary shared by the engine, the ports, the trace read
 * model and the CLI.
 *
 * Two objects are deliberately kept apart, because conflating them is how a
 * trace starts leaking:
 *
 * - **`ContextSelection` is metadata.** Candidate ids, kinds, refs, token estimates,
 *   scores, reason codes, budget arithmetic. It is serializable, deterministic and
 *   safe to record in the event log and to print.
 * - **`ContextBundle` is content.** The selected text, held in memory for exactly as
 *   long as it takes to build one request. Content is never an event payload, never
 *   a trace field and never a CLI output.
 *
 * See docs/architecture/V2-ARCHITECTURE.md §11 and §36, and DECISIONS.md ADR-039.
 */

/**
 * Kinds of context this phase can actually produce.
 *
 * The RFC lists more (`symbol`, `dependency`, `git-history`, `previous-task`,
 * `convention`, `memory`); those need metadata this repository does not have yet, so
 * they are NOT declared. A kind that nothing can produce would be a lie in a type.
 * See §36.6.
 */
export const CONTEXT_ITEM_KINDS = [
  "source-file",
  "test-file",
  "config-file",
  "documentation",
  "adr",
] as const;

export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number];

/** Why a candidate was dropped. A closed set, so a trace stays queryable. */
export const CONTEXT_EXCLUSION_REASONS = [
  /** Ranked below the budget cut-off: the budget ran out before its turn. */
  "budget-cutoff",
  /** Sized by content, then found not to fit — or larger than the file cap. */
  "oversize-after-sizing",
  /** Mandatory items alone exceed the budget: the honest overflow signal. */
  "budget-exceeded",
  /** The file disappeared or could not be read between listing and sizing. */
  "unreadable",
] as const;

export type ContextExclusionReason = (typeof CONTEXT_EXCLUSION_REASONS)[number];

/**
 * One relevance signal that fired, and what it contributed.
 *
 * `points` is carried so a human can see the arithmetic rather than a verdict, and
 * the codes are stable enough to be recorded, diffed and tested.
 */
export interface ContextReason {
  readonly code: string;
  readonly points: number;
  /** Human-readable detail for `--explain`. Never content, never a secret. */
  readonly detail?: string;
}

/** A candidate discovered on disk, before scoring. */
export interface ContextCandidate {
  /** Stable within one selection: `<kind>:<ref>`, so ordering never depends on hashing. */
  readonly key: string;
  readonly kind: ContextItemKind;
  /** Workspace-relative path. Never an absolute path, never content. */
  readonly ref: string;
  /**
   * Token estimate. `size` is derived from the file's byte length and is an
   * estimate; `content` is derived from the text actually read and is what the
   * final budget was checked against.
   */
  readonly tokens: number;
  readonly basis: "size" | "content";
  /** Signals that fired during discovery, before scoring. */
  readonly signals: readonly ContextSignal[];
}

/**
 * A discovery signal: something observable about the candidate and the task, stated
 * as a fact rather than a score, so scoring stays the only place that decides
 * importance.
 */
export const CONTEXT_SIGNALS = [
  /** The task's `context` notes name this exact path. */
  "explicit-path",
  /** A path-shaped token from the task text appears in this path. */
  "path-token",
  /** The task text mentions this file's name. */
  "filename-token",
  /** This file changed in the working tree / recent history. */
  "changed",
  /** Linked to a relevant file by the test/source naming convention. */
  "test-relationship",
  /** This file is directly imported by a relevant file. */
  "direct-dependency",
  /** This file shares a directory with an explicitly referenced file. */
  "same-directory",
  /** A file the verification loop itself depends on (package.json, tsconfig, …). */
  "verification-config",
  /** An ADR under `docs/architecture/`. */
  "adr",
  /** Documentation that mentions a task token. */
  "documentation",
  /** Matched by an operator-configured priority rule. */
  "configured-priority",
] as const;

export type ContextSignal = (typeof CONTEXT_SIGNALS)[number];

/** A candidate after scoring: still metadata only. */
export interface ScoredCandidate extends ContextCandidate {
  readonly score: number;
  readonly reasons: readonly ContextReason[];
}

/** A selected candidate, as recorded. */
export interface ContextSelectedRef {
  readonly candidateId: string;
  readonly kind: ContextItemKind;
  readonly ref: string;
  readonly tokens: number;
  readonly basis: "size" | "content";
  readonly score: number;
  readonly reasons: readonly string[];
  /** True when it was included because a task reference required it. */
  readonly mandatory: boolean;
}

/** An excluded candidate, as recorded, with the single reason it was dropped. */
export interface ContextExcludedRef {
  readonly candidateId: string;
  readonly kind: ContextItemKind;
  readonly ref: string;
  /** Size-based estimate: an excluded file is never read, so never sized. */
  readonly tokens: number;
  readonly basis: "size" | "content";
  readonly score: number;
  readonly reason: ContextExclusionReason;
}

/**
 * What the discovery layer could actually do. Reported, not assumed: a trace that
 * claims git awareness it did not have would make the selection unreproducible.
 */
export interface ContextCapabilities {
  /** Names of the capabilities that were available. Stable strings. */
  readonly available: readonly string[];
  /** Capabilities that were asked for and unavailable, with a reason code. */
  readonly unavailable: readonly string[];
}

export const CAPABILITY_REPOSITORY = "repository";
export const CAPABILITY_GIT_CHANGES = "git-changes";

/**
 * The outcome of one selection: metadata, serializable, reproducible.
 *
 * Token fields use two units on purpose, and the distinction is the honest part:
 *
 * - `candidateTokens` is the sum of **size-based estimates** over every scored
 *   candidate — "what was on the table", computed without reading anything.
 * - `selectedTokens` is the sum of **content-based estimates** over the selected
 *   candidates — what this selection actually costs, and the number to compare
 *   against a provider's reported input tokens.
 * - `excludedTokens` is `candidateTokens` minus the size-based estimates of the
 *   selected candidates, so nothing is double counted and nothing goes missing.
 *
 * `budgetExceeded` is the honest overflow flag: the selection still lists the
 * mandatory items it could not fit, and the caller decides what to do (today:
 * refuse to spend, and fail the task with a reason).
 */
export interface ContextSelection {
  readonly selectionId: string;
  readonly strategy: string;
  readonly selectionVersion: number;
  /** Short, stable fingerprint of the configuration that produced this selection. */
  readonly configFingerprint: string;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly taskId?: TaskId;
  readonly budgetTokens: number;
  readonly candidateTokens: number;
  readonly selectedTokens: number;
  readonly excludedTokens: number;
  readonly remainingTokens: number;
  readonly mandatoryTokens: number;
  readonly considered: number;
  readonly selected: readonly ContextSelectedRef[];
  readonly excluded: readonly ContextExcludedRef[];
  /**
   * True when the recorded ref lists were capped. The *counts* above are always
   * exact; only the per-candidate lists are truncated, and saying so is the
   * difference between a bounded log and a quietly incomplete one.
   */
  readonly refsTruncated: boolean;
  /** Files considered but never scored, because no signal fired. */
  readonly filteredByScore: number;
  /** Files skipped before scoring by an ignore or exclusion rule. */
  readonly excludedByRules: number;
  readonly budgetExceeded: boolean;
  readonly overBudgetTokens: number;
  readonly durationMs: number;
  readonly capabilities: ContextCapabilities;
  readonly createdAt: string;
}

/** What the selection actually contains, for building one request. Never recorded. */
export interface ContextBundle {
  readonly selectionId: string;
  readonly selectionVersion: number;
  readonly items: readonly ContextBundleItem[];
}

export interface ContextBundleItem {
  readonly ref: string;
  readonly kind: ContextItemKind;
  readonly content: string;
  readonly tokens: number;
}

export interface ContextSelectionResult {
  readonly selection: ContextSelection;
  readonly bundle: ContextBundle;
}

/** Human-facing rendering of one excluded candidate, for `--explain`. */
export function describeSelectionForHuman(
  selection: ContextSelection,
): readonly string[] {
  return [
    `strategy        ${selection.strategy} (v${selection.selectionVersion})`,
    `config          ${selection.configFingerprint}`,
    `budget          ${selection.budgetTokens} tokens`,
    `candidates      ${selection.considered} scored, ${selection.filteredByScore} filtered, ${selection.excludedByRules} excluded by rules`,
    `selected        ${selection.selected.length} (${selection.selectedTokens} tokens)`,
    `excluded        ${selection.excluded.length} (${selection.excludedTokens} tokens)`,
    `remaining       ${selection.remainingTokens} tokens`,
    `duration        ${selection.durationMs}ms`,
  ];
}
