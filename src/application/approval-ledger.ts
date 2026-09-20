import { type Clock, durationMsFrom } from "../core/clock.js";
import type { ProjectId, TaskId, WorkspaceId } from "../core/ids.js";
import type { OperationKind, RiskLevel } from "../decisions/risk.js";
import { riskRank } from "../decisions/risk.js";
import type { DomainEvent } from "../observability/events.js";
import type { EventStore } from "../ports/event-store.js";
import type { ProjectScope } from "../ports/scope.js";

/**
 * The approval ledger: grant state, projected from approval events.
 *
 * Approval is a lifecycle, not a flag. A request is asked, answered, and then used
 * at most once; each of those steps is an event, and this module is the only place
 * that decides what the sequence means. Keeping that derivation here — rather than
 * inside `runTask` — is what lets the CLI, `ai doctor` and the tests agree about
 * whether a task is suspended, granted, expired or already spent.
 *
 * Rules, stated so they can be checked:
 *
 * - A grant is **scoped**: it covers a risk level at most, and either one operation
 *   or the whole task. It never *widens* what policy allows (ADR-037).
 * - A grant is **single-use**. Consumption is an event, so "was this approval used,
 *   and for what" is answerable from the log.
 * - A grant may **expire**. An absent expiry means it does not expire; that is a
 *   deliberate choice for locally-run work, not an oversight.
 * - A task-level gate requires a task-wide grant. An operation-scoped grant is
 *   narrower than the question it would be answering.
 *
 * Scope is explicit, exactly like every other read (ADR-027): the ledger is bound
 * to one project and refuses a foreign scope.
 */
export type ApprovalStatus = "pending" | "granted" | "consumed" | "expired";

export interface ApprovalState {
  readonly requestId: string;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly taskId: TaskId;
  readonly riskLevel: RiskLevel;
  /** Absent means the grant covers the whole task, not one operation. */
  readonly operation?: OperationKind;
  readonly requestedAt: string;
  readonly grantedAt?: string;
  readonly approver?: string;
  readonly expiresAt?: string;
  readonly consumedAt?: string;
  readonly status: ApprovalStatus;
}

/** What a gate needs before it may proceed. */
export interface ApprovalRequirement {
  readonly riskLevel: RiskLevel;
  /** Absent for a task-level gate: the whole task is the subject. */
  readonly operation?: OperationKind;
}

/**
 * The boundary an approval covers: a risk level, and either one operation or the
 * whole task. A grant and the authority a consumed grant establishes in a running
 * attempt are both described by this shape, so one comparison answers both.
 */
export interface ApprovalScope {
  readonly riskLevel: RiskLevel;
  readonly operation?: OperationKind;
}

export interface ApprovalLedger {
  readonly id: string;
  list(scope: ProjectScope): Promise<readonly ApprovalState[]>;
  forTask(
    scope: ProjectScope,
    taskId: TaskId,
  ): Promise<readonly ApprovalState[]>;
}

export interface ApprovalLedgerDeps {
  readonly store: EventStore;
  readonly clock: Clock;
}

/**
 * True when a scope covers a requirement.
 *
 * Both directions matter: a lower risk level must not cover a higher requirement,
 * and an operation-scoped grant must not cover a different operation or a
 * task-wide gate. Comparison is one-way by construction — a grant may cover *less*
 * than policy would allow, never more.
 */
export function scopeCovers(
  scope: ApprovalScope,
  requirement: ApprovalRequirement,
): boolean {
  if (riskRank(scope.riskLevel) < riskRank(requirement.riskLevel)) {
    return false;
  }
  if (scope.operation === undefined) {
    return true;
  }
  return scope.operation === requirement.operation;
}

/** A grant's coverage is its scope. Named separately for readability at call sites. */
export function coversRequirement(
  state: ApprovalState,
  requirement: ApprovalRequirement,
): boolean {
  return scopeCovers(state, requirement);
}

/** The most recent unconsumed, unexpired grant covering the requirement. */
export function usableGrant(
  states: readonly ApprovalState[],
  requirement: ApprovalRequirement,
): ApprovalState | undefined {
  let found: ApprovalState | undefined;
  for (const state of states) {
    if (state.status !== "granted" || !coversRequirement(state, requirement)) {
      continue;
    }
    found = state;
  }
  return found;
}

/**
 * An outstanding question identical to the one about to be asked, so a repeated
 * `ai task run` re-states the existing request instead of filling the log with
 * duplicate questions.
 */
export function pendingRequest(
  states: readonly ApprovalState[],
  requirement: ApprovalRequirement,
): ApprovalState | undefined {
  return states.find(
    (state) =>
      state.status === "pending" &&
      state.operation === requirement.operation &&
      state.riskLevel === requirement.riskLevel,
  );
}

export function describeApproval(state: ApprovalState): string {
  const scope =
    state.operation === undefined
      ? "whole task"
      : `operation "${state.operation}"`;
  switch (state.status) {
    case "pending":
      return `pending since ${state.requestedAt} (risk ${state.riskLevel}, ${scope})`;
    case "granted":
      return (
        `granted by ${state.approver ?? "unknown"} at ${state.grantedAt}` +
        (state.expiresAt === undefined
          ? " (no expiry)"
          : ` (expires ${state.expiresAt})`)
      );
    case "consumed":
      return `consumed at ${state.consumedAt}`;
    case "expired":
      return `expired at ${state.expiresAt}`;
  }
}

/**
 * Status of an approval from its timestamps alone.
 *
 * Exported because the trace needs the same answer the ledger gives: two
 * implementations of "is this grant still usable" would eventually disagree, and
 * the one a human reads would be the one that is wrong.
 */
export function approvalStatusOf(
  state: {
    grantedAt?: string;
    expiresAt?: string;
    consumedAt?: string;
  },
  nowMs: number,
): ApprovalStatus {
  if (state.consumedAt !== undefined) {
    return "consumed";
  }
  if (state.grantedAt === undefined) {
    return "pending";
  }
  if (state.expiresAt !== undefined && Date.parse(state.expiresAt) <= nowMs) {
    return "expired";
  }
  return "granted";
}

const APPROVAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "HumanApprovalRequested",
  "HumanApprovalGranted",
  "HumanApprovalConsumed",
]);

export function createApprovalLedger(deps: ApprovalLedgerDeps): ApprovalLedger {
  function project(events: readonly DomainEvent[]): readonly ApprovalState[] {
    const byRequest = new Map<string, ApprovalState>();
    const nowMs = deps.clock.now().getTime();

    for (const event of events) {
      if (!APPROVAL_EVENT_TYPES.has(event.type)) {
        continue;
      }
      const taskId = event.taskId;
      if (taskId === undefined) {
        // Approvals are always task-scoped; an unscoped one cannot be acted on.
        continue;
      }
      switch (event.type) {
        case "HumanApprovalRequested":
          byRequest.set(event.payload.requestId, {
            requestId: event.payload.requestId,
            projectId: event.projectId,
            workspaceId: event.workspaceId,
            taskId,
            riskLevel: event.payload.riskLevel,
            ...(event.payload.operation === undefined
              ? {}
              : { operation: event.payload.operation }),
            requestedAt: event.occurredAt,
            status: "pending",
          });
          break;
        case "HumanApprovalGranted": {
          const existing = byRequest.get(event.payload.requestId);
          if (existing === undefined) {
            // A grant without a request is a real integrity problem; the trace
            // reports it. The ledger simply has nothing to attach it to.
            break;
          }
          const granted = {
            ...existing,
            riskLevel: event.payload.riskLevel,
            ...(event.payload.operation === undefined
              ? {}
              : { operation: event.payload.operation }),
            grantedAt: event.occurredAt,
            approver: event.payload.approver,
            ...(event.payload.expiresAt === undefined
              ? {}
              : { expiresAt: event.payload.expiresAt }),
          };
          byRequest.set(event.payload.requestId, {
            ...granted,
            status: approvalStatusOf(granted, nowMs),
          });
          break;
        }
        case "HumanApprovalConsumed": {
          const existing = byRequest.get(event.payload.requestId);
          if (existing === undefined) {
            break;
          }
          const consumed = {
            ...existing,
            consumedAt: event.occurredAt,
          };
          byRequest.set(event.payload.requestId, {
            ...consumed,
            status: approvalStatusOf(consumed, nowMs),
          });
          break;
        }
        default:
          break;
      }
    }

    return [...byRequest.values()].sort(
      (a, b) =>
        Date.parse(a.requestedAt) - Date.parse(b.requestedAt) ||
        (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0),
    );
  }

  return {
    id: deps.store.id,

    async list(scope) {
      return project(await deps.store.readAll(scope));
    },

    async forTask(scope, taskId) {
      return project(await deps.store.readByTask(scope, taskId));
    },
  };
}

/** Milliseconds a grant stays valid, defaulted by the CLI. Never a secret. */
export function approvalAgeMs(state: ApprovalState, now: string): number {
  return state.grantedAt === undefined
    ? 0
    : durationMsFrom(state.grantedAt, now);
}
