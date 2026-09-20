import type { ProjectId, SessionId, TaskId, WorkspaceId } from "../core/ids.js";
import type { ContextBundle, ContextSelection } from "../context/selection.js";

/**
 * ContextEngine port: choose the smallest useful context for a task, under a hard
 * token budget, and say why.
 *
 * The boundary this port draws is the point of the whole module:
 *
 * - The **LLM provider never chooses repository files.** A model asked "which of
 *   these 4,000 files matter?" answers plausibly, costs money, and cannot be
 *   reproduced; and the choice it makes is invisible in a trace. Selection is a
 *   deterministic engine, not a prompt.
 * - The **engine never calls a model to decide context.** There is no `LlmProvider`
 *   in this request and no adapter may add one: a selection that needs a model to
 *   produce cannot be explained by arithmetic, and cannot be replayed offline.
 * - The **trace carries metadata, not content.** `ContextSelection` is recorded;
 *   `ContextBundle` is not. They are separate types so that returns the selection
 *   can never accidentally return the content, which is the failure mode that turns
 *   a repo file into an event payload.
 *
 * `select` is expected to be a pure function of `(repository state, task text,
 * configuration)` and must record its own events: every selection is a fact about
 * a task, so the engine is the only thing that can guarantee the event is written
 * even when the selection fails to fit.
 *
 * See docs/architecture/V2-ARCHITECTURE.md §36 and DECISIONS.md ADR-039.
 */
export interface ContextSelectRequest {
  /**
   * The text a selection is matched against: task title, description, acceptance
   * criteria and constraints. Passed as plain strings so the engine does not need
   * the whole task contract, and so a future caller (a dashboard, an evaluation
   * harness) can ask for a selection without one.
   */
  readonly taskText: readonly string[];
  /**
   * Path references stated explicitly by the task (`task.context`). These are the
   * only paths that can produce a mandatory candidate, and they are validated as
   * workspace-relative before use.
   */
  readonly explicitPaths?: readonly string[];
  /** Hard upper bound on selected tokens. The engine never exceeds it. */
  readonly budgetTokens: number;
  readonly taskId?: TaskId;
  readonly sessionId?: SessionId;
  /** Correlates the selection's events with the run that caused it. */
  readonly correlationId?: string;
}

/**
 * The engine's own record of what it is capable of in this workspace.
 * Reported, never inferred, so a caller can tell a small selection from a
 * selection made without change information.
 */
export interface ContextEngineInfo {
  readonly id: string;
  readonly strategy: string;
  readonly selectionVersion: number;
  readonly configFingerprint: string;
}

export interface ContextEngine {
  readonly info: ContextEngineInfo;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  /**
   * Selects context and records the selection. Returns the content bundle only
   * when the selection fits the budget; an over-budget selection returns an empty
   * bundle so the caller cannot accidentally spend it.
   */
  select(request: ContextSelectRequest): Promise<{
    readonly selection: ContextSelection;
    readonly bundle: ContextBundle;
  }>;
}
