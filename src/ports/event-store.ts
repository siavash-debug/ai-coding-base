import type { SessionId, TaskId } from "../core/ids.js";
import type { DomainEvent } from "../observability/events.js";
import type { ProjectScope } from "./scope.js";

/**
 * EventStore port: the append-only log of everything that happened.
 *
 * Design notes (see DECISIONS.md ADR-006 and V2-ARCHITECTURE §17, §27):
 *
 * - **Append-only.** There is no update and no delete. Corrections are new
 *   events, never mutations.
 * - **Scope-bound reads.** Reads take a `ProjectScope` rather than a bare id, so
 *   a project cannot reach another project's events through the normal API.
 * - **Async.** Storage is an I/O boundary; a future SQLite or remote adapter must
 *   not force an interface change.
 * - **No `close()`.** The Phase C JSONL adapter opens, appends and closes per
 *   call, so there is nothing to flush. Adding lifecycle methods speculatively
 *   would constrain future adapters for no current benefit.
 *
 * Ordering contract: implementations MUST return events ordered by
 * `(occurredAt, sequence, id)`. Ordering by wall-clock alone is never correct
 * (clock skew is real), which is why `sequence` is the secondary key.
 */
export interface EventStore {
  readonly id: string;

  /** Appends one event. Rejects a malformed event or an out-of-order sequence. */
  append(event: DomainEvent): Promise<void>;

  /**
   * Appends a batch. Implementations MUST fail atomically enough that a rejected
   * batch leaves the log unchanged.
   */
  appendMany(events: readonly DomainEvent[]): Promise<void>;

  /** All events visible in the scope, chronologically ordered. */
  readAll(scope: ProjectScope): Promise<readonly DomainEvent[]>;

  /** Events carrying `taskId`, chronologically ordered. */
  readByTask(
    scope: ProjectScope,
    taskId: TaskId,
  ): Promise<readonly DomainEvent[]>;

  /** Events carrying `sessionId`, chronologically ordered. */
  readBySession(
    scope: ProjectScope,
    sessionId: SessionId,
  ): Promise<readonly DomainEvent[]>;

  /** Distinct task ids in the scope, in order of first appearance. */
  listTaskIds(scope: ProjectScope): Promise<readonly TaskId[]>;
}
