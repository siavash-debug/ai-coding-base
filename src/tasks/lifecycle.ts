import { DomainError } from "../core/errors.js";

/**
 * Task lifecycle.
 *
 * Transitions are a pure function over a declared table. Any transition that is
 * not in the table throws. `verification -> in_progress` and `review ->
 * in_progress` are the only backwards transitions, because honest verification
 * fails and rework is normal.
 * See docs/architecture/V2-ARCHITECTURE.md §18.
 */
export const TASK_STATUSES = [
  "created",
  "planning",
  "in_progress",
  "verification",
  "review",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_TASK_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly TaskStatus[];

export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];

export const TASK_TRANSITIONS: Readonly<
  Record<TaskStatus, readonly TaskStatus[]>
> = {
  created: ["planning", "cancelled"],
  planning: ["in_progress", "cancelled", "failed"],
  in_progress: ["verification", "failed", "cancelled"],
  verification: ["review", "in_progress", "failed"],
  review: ["completed", "in_progress", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalStatus(status: TaskStatus): boolean {
  return TASK_TRANSITIONS[status].length === 0;
}

export function allowedTransitions(status: TaskStatus): readonly TaskStatus[] {
  return TASK_TRANSITIONS[status];
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/**
 * Validates a transition and returns the resulting status. Terminal states are
 * immutable, so any transition out of them is rejected.
 */
export function transitionStatus(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (from === to) {
    throw new DomainError("TRANSITION", `task is already in status "${from}"`, {
      field: "status",
      from,
      to,
    });
  }
  if (isTerminalStatus(from)) {
    throw new DomainError(
      "TRANSITION",
      `task status "${from}" is terminal and cannot transition`,
      { field: "status", from, to },
    );
  }
  if (!canTransition(from, to)) {
    throw new DomainError(
      "TRANSITION",
      `illegal task transition from "${from}" to "${to}"`,
      {
        field: "status",
        from,
        to,
        allowed: TASK_TRANSITIONS[from],
      },
    );
  }
  return to;
}
