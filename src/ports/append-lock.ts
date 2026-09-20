/**
 * AppendLock port: serialises writers on one stream.
 *
 * The event log is append-only, but "append" is not automatically atomic with
 * "decide what comes next". Two writers that both read `tail = 7` will both try to
 * write sequence 8; without coordination one of them silently produces a stream
 * with a duplicate sequence, and the log stops being a reliable ordering.
 *
 * This port exists so that guarantee is a property of the *storage boundary*
 * rather than a convention in the application layer, and so that a future adapter
 * (a database row lock, a lock service) can replace the local one without touching
 * the store.
 *
 * Scope of the guarantee, stated honestly (ADR-036):
 *
 * - It coordinates writers **on one machine** that go through this port.
 * - It is **not** a distributed lock and cannot coordinate a writer that ignores
 *   it or a filesystem that does not provide atomic exclusive create.
 * - Reads never take the lock, so a reader is never blocked by a writer.
 */
export interface AppendLock {
  readonly id: string;
  /** What this implementation actually guarantees, for `ai doctor` to report. */
  readonly guarantee: "none" | "local-process-and-file";
  /**
   * Runs `work` while holding the lock for `streamKey`.
   *
   * Rejects with a `LOCK_TIMEOUT` domain error when the lock cannot be acquired
   * within the budget, and always releases before settling. `work` MUST NOT recurse
   * into the same stream key.
   */
  withLock<T>(
    streamKey: string,
    work: () => Promise<T>,
    options?: { readonly timeoutMs?: number },
  ): Promise<T>;
}

/** Default budget for acquiring a lock before reporting contention. */
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
/** A lock older than this is treated as abandoned and reclaimed. */
export const DEFAULT_STALE_LOCK_MS = 30_000;

/**
 * No-op coordination, for single-writer processes and for tests that assert the
 * store's own sequence guard rather than the lock.
 */
export function createNullAppendLock(): AppendLock {
  return {
    id: "null",
    guarantee: "none",
    withLock: async (_streamKey, work) => work(),
  };
}
