/**
 * Sleep port: waiting, injected.
 *
 * Two very different mechanisms wait in this platform — a retry backoff and a lock
 * acquisition poll — and both must be instant and deterministic in tests. Making
 * `Sleep` a port rather than calling `setTimeout` inline is what lets a test assert
 * "the retry waited 250ms, then 500ms" without waiting 750ms.
 */
export interface Sleep {
  readonly id: string;
  sleep(ms: number): Promise<void>;
}

/** Does not actually wait. Used by tests and by single-attempt configurations. */
export function createImmediateSleep(): Sleep {
  return {
    id: "immediate",
    sleep: async () => undefined,
  };
}

/** Records requested delays instead of waiting, so backoff is directly assertable. */
export interface RecordingSleep extends Sleep {
  readonly delays: readonly number[];
}

export function createRecordingSleep(): RecordingSleep {
  const delays: number[] = [];
  return {
    id: "recording",
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}
