import type { Sleep } from "../../ports/sleep.js";

/**
 * The real `Sleep`: an actual timer.
 *
 * Injected everywhere it is used, so production gets a real wait and tests get
 * whatever they need — instant, recording, or failing. Nothing in the platform
 * calls `setTimeout` directly outside this module.
 */
export function createTimerSleep(): Sleep {
  return {
    id: "timer",
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, Math.max(0, ms));
      }),
  };
}
