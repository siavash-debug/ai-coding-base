import { mkdir, open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { type Clock, durationMsFrom, toIsoString } from "../../core/clock.js";
import { DomainError } from "../../core/errors.js";
import {
  type AppendLock,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STALE_LOCK_MS,
} from "../../ports/append-lock.js";
import type { Sleep } from "../../ports/sleep.js";

/**
 * Local file-based append coordination (ADR-036).
 *
 * Two mechanisms, because one is not enough:
 *
 * 1. **In-process queue.** Callers in this process are serialised in memory, which
 *    is exact, free, and covers the common case of several tasks appended by one
 *    CLI invocation.
 * 2. **Exclusive-create lock file.** `open(path, "wx")` is atomic on every
 *    filesystem we target, so two *processes* cannot both believe they hold the
 *    stream. This is what makes "two writers cannot both append sequence 8" true
 *    rather than hoped for.
 *
 * What this is **not**, stated plainly so nobody relies on more:
 *
 * - **Not a distributed lock.** It coordinates cooperating writers on one machine
 *   sharing a filesystem with atomic `O_EXCL`. A writer that ignores the port, or a
 *   filesystem without atomic exclusive create, is outside the guarantee.
 * - **Reclaim is best-effort.** A lock older than `staleLockMs` is treated as
 *   abandoned and removed, because a crashed process must not wedge a project
 *   forever. A process paused mid-append for longer than that threshold can
 *   therefore have its lock reclaimed. The threshold is deliberately far larger
 *   than any append takes.
 * - **Readers never lock.** Reading is not blocked by writing and vice versa.
 *
 * Acquisition failure is explicit: a `LOCK_TIMEOUT` domain error, never a silent
 * proceed. Everything that waits goes through the injected `Sleep`, so tests are
 * instant and deterministic.
 */
export const DEFAULT_POLL_INTERVAL_MS = 25;
/** How many times a stale lock may be reclaimed before giving up. */
const MAX_RECLAIMS = 3;

export interface FileAppendLockOptions {
  /** Directory holding the `.lock` files. Created on demand. */
  readonly directory: string;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly pollIntervalMs?: number;
  readonly id?: string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? ((error as { code?: unknown }).code as string | undefined)
    : undefined;
}

export function createFileAppendLock(
  options: FileAppendLockOptions,
): AppendLock {
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const tails = new Map<string, Promise<void>>();

  /**
   * In-process mutual exclusion. Resolves with a release function; the returned
   * promise is separate from the gate so a caller cannot release before holding.
   */
  function acquireInProcess(streamKey: string): Promise<() => void> {
    const tail = tails.get(streamKey) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = tail.then(() => gate);
    tails.set(streamKey, chained);
    return tail.then(() => () => {
      release();
      if (tails.get(streamKey) === chained) {
        tails.delete(streamKey);
      }
    });
  }

  function lockPathFor(streamKey: string): string {
    // A stream key is a workspace id (already validated), so it cannot traverse.
    return join(options.directory, `.${streamKey}.lock`);
  }

  async function tryAcquireFile(
    path: string,
    streamKey: string,
  ): Promise<boolean> {
    let handle;
    try {
      handle = await open(path, "wx");
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        return false;
      }
      throw error;
    }
    try {
      // Diagnostics only: pid and time, never content.
      await handle.writeFile(
        JSON.stringify({
          streamKey,
          pid: process.pid,
          acquiredAt: toIsoString(options.clock.now()),
        }),
        "utf8",
      );
    } finally {
      await handle.close();
    }
    return true;
  }

  /**
   * Removes a lock that is older than the stale threshold. Returns true when the
   * caller should retry immediately, false when the lock is still fresh.
   */
  async function reclaimIfStale(path: string, nowMs: number): Promise<boolean> {
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      // Already gone: another writer finished or reclaimed it.
      return errorCode(error) === "ENOENT";
    }
    if (nowMs - info.mtimeMs <= staleLockMs) {
      return false;
    }
    try {
      await unlink(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return true;
      }
      throw error;
    }
    return true;
  }

  return {
    id: options.id ?? `file:${options.directory}`,
    guarantee: "local-process-and-file",

    async withLock(streamKey, work, callOptions) {
      const timeoutMs = callOptions?.timeoutMs ?? lockTimeoutMs;
      const releaseInProcess = await acquireInProcess(streamKey);
      const path = lockPathFor(streamKey);
      const startedAt = toIsoString(options.clock.now());
      const maxPolls =
        Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollIntervalMs))) +
        MAX_RECLAIMS;
      let held = false;
      let polls = 0;
      let reclaims = 0;

      try {
        for (;;) {
          await mkdir(options.directory, { recursive: true });
          if (await tryAcquireFile(path, streamKey)) {
            held = true;
            break;
          }
          if (reclaims < MAX_RECLAIMS) {
            const nowMs = options.clock.now().getTime();
            if (await reclaimIfStale(path, nowMs)) {
              reclaims += 1;
              continue;
            }
          }
          polls += 1;
          const waitedMs = durationMsFrom(
            startedAt,
            toIsoString(options.clock.now()),
          );
          if (waitedMs >= timeoutMs || polls > maxPolls) {
            throw new DomainError(
              "LOCK_TIMEOUT",
              `could not acquire the append lock for "${streamKey}" within ` +
                `${timeoutMs}ms (waited ${waitedMs}ms across ${polls} poll(s)); ` +
                `another writer holds ${path}. A lock older than ` +
                `${staleLockMs}ms is reclaimed automatically; if no writer is ` +
                `active, delete that file.`,
              {
                field: "streamKey",
                streamKey,
                waitedMs,
                polls,
                staleLockMs,
              },
            );
          }
          await options.sleep.sleep(
            Math.max(1, Math.min(pollIntervalMs, timeoutMs - waitedMs)),
          );
        }
        return await work();
      } finally {
        // Cleanup never masks the real outcome: a release failure is reported by
        // the stale-lock policy above, which reclaims the file after
        // `staleLockMs`. Losing the caller's actual error to a cleanup error
        // would be strictly worse than a briefly wedged stream.
        try {
          if (held) {
            await unlink(path);
          }
        } catch {
          // Stale reclaim is the recovery path.
        } finally {
          releaseInProcess();
        }
      }
    },
  };
}
