import type { Clock } from "../core/clock.js";
import { toIsoString } from "../core/clock.js";
import type {
  IdFactory,
  ProjectId,
  SessionId,
  TaskId,
  WorkspaceId,
} from "../core/ids.js";
import { assertIsoTimestamp } from "../core/validation.js";
import type { OperationKind, RiskLevel } from "../decisions/risk.js";
import type { EventActor } from "../observability/events.js";
import { type EventRecorder, taskCorrelationId } from "./event-recorder.js";

/**
 * Human approval: the platform's explicit stop for high-risk work.
 *
 * An approval request is a first-class event, not a log line, so "this ran
 * because a human said so, and here is who" is answerable from the trace alone.
 * The request is deliberately *not* a decision: a decision records what the
 * deciding layer answered (and the escalation that produced the request is
 * recorded as one), while an approval records who owns the risk.
 *
 * Granting is recorded, never inferred. Nothing in Phase C consumes a grant to
 * unblock a run; that wiring is Phase D.
 * See docs/architecture/V2-ARCHITECTURE.md §23.
 */
export const APPROVAL_ACTOR: EventActor = { type: "system", id: "approval" };

export interface ApprovalRequestInput {
  readonly workspaceId: WorkspaceId;
  readonly taskId: TaskId;
  readonly riskLevel: RiskLevel;
  readonly operation?: OperationKind;
}

export interface Approval {
  readonly requestId: string;
  readonly requestedAt: string;
}

export interface ApprovalGrantInput {
  readonly workspaceId: WorkspaceId;
  readonly taskId: TaskId;
  readonly requestId: string;
  readonly riskLevel: RiskLevel;
  /** Identity of the human taking ownership. Never a secret value. */
  readonly approver: string;
  readonly operation?: OperationKind;
  /** When the grant stops being valid; absent means it does not expire. */
  readonly expiresAt?: string;
}

/**
 * Consumption of a grant.
 *
 * Recorded so that "which approval authorised this attempt" is answerable from the
 * log, and so that a grant cannot be quietly reused (ADR-037). The service records
 * the fact; deciding whether a grant *may* be consumed is the ledger's job.
 */
export interface ApprovalConsumptionInput {
  readonly workspaceId: WorkspaceId;
  readonly taskId: TaskId;
  readonly requestId: string;
  readonly riskLevel: RiskLevel;
  readonly operation?: OperationKind;
  /** The session the grant authorised, when one was already open. */
  readonly sessionId?: SessionId;
}

export interface ApprovalService {
  request(input: ApprovalRequestInput): Promise<Approval>;
  grant(input: ApprovalGrantInput): Promise<void>;
  consume(input: ApprovalConsumptionInput): Promise<void>;
}

export interface ApprovalServiceDeps {
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly projectId: ProjectId;
  readonly requestIds: IdFactory;
}

export function createApprovalService(
  deps: ApprovalServiceDeps,
): ApprovalService {
  function correlation(taskId: TaskId, workspaceId: WorkspaceId): string {
    return taskCorrelationId(deps.projectId, workspaceId, taskId);
  }

  return {
    async request(input) {
      const requestId = deps.requestIds.next();
      const requestedAt = toIsoString(deps.clock.now());
      await deps.recorder.emit({
        type: "HumanApprovalRequested",
        workspaceId: input.workspaceId,
        actor: APPROVAL_ACTOR,
        taskId: input.taskId,
        correlationId: correlation(input.taskId, input.workspaceId),
        payload: {
          requestId,
          riskLevel: input.riskLevel,
          ...(input.operation === undefined
            ? {}
            : { operation: input.operation }),
        },
      });
      return { requestId, requestedAt };
    },

    async grant(input) {
      const expiresAt =
        input.expiresAt === undefined
          ? undefined
          : assertIsoTimestamp(input.expiresAt, "expiresAt");
      await deps.recorder.emit({
        type: "HumanApprovalGranted",
        workspaceId: input.workspaceId,
        actor: { type: "human", id: input.approver },
        taskId: input.taskId,
        correlationId: correlation(input.taskId, input.workspaceId),
        payload: {
          requestId: input.requestId,
          approver: input.approver,
          riskLevel: input.riskLevel,
          ...(input.operation === undefined
            ? {}
            : { operation: input.operation }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        },
      });
    },

    async consume(input) {
      await deps.recorder.emit({
        type: "HumanApprovalConsumed",
        workspaceId: input.workspaceId,
        actor: APPROVAL_ACTOR,
        taskId: input.taskId,
        ...(input.sessionId === undefined
          ? {}
          : { sessionId: input.sessionId }),
        correlationId: correlation(input.taskId, input.workspaceId),
        payload: {
          requestId: input.requestId,
          riskLevel: input.riskLevel,
          ...(input.operation === undefined
            ? {}
            : { operation: input.operation }),
        },
      });
    },
  };
}
