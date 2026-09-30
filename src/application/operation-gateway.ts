import type { Clock } from "../core/clock.js";
import { durationMsFrom, toIsoString } from "../core/clock.js";
import { DomainError } from "../core/errors.js";
import type {
  IdFactory,
  ProjectId,
  SessionId,
  TaskId,
  WorkspaceId,
} from "../core/ids.js";
import {
  type AccessDecision,
  type AccessPolicy,
  evaluateAccess,
} from "../policy/access-policy.js";
import {
  type Capability,
  operationKindForCapability,
  sortCapabilities,
} from "../policy/capability.js";
import { describeTarget } from "../policy/target.js";
import type { EventActor } from "../observability/events.js";
import type { OperationKind, RiskLevel } from "../decisions/risk.js";
import {
  type ApprovalLedger,
  type ApprovalRequirement,
  type ApprovalScope,
  pendingRequest,
  scopeCovers,
  usableGrant,
} from "./approval-ledger.js";
import type { ApprovalService } from "./approval-service.js";
import type { EventRecorder } from "./event-recorder.js";
import {
  type BridgedOperationKind,
  type OperationGateway,
  type OperationOutcome,
  type OperationRefusal,
  type OperationRequest,
  type OperationResultMap,
  type SandboxBoundary,
  capabilityForRequest,
  targetForRequest,
} from "../ports/operation.js";

/**
 * The operation gateway: the single enforcement point for every operation.
 *
 * The pipeline is the whole of Phase F, and its *order* is the security argument
 * (ADR-045):
 *
 * ```text
 * operation request
 *   → capability derived from the request kind (never claimed by the caller)
 *   → declared envelope       (was this capability declared for this attempt?)
 *   → policy evaluation       (is it allowed, for this exact target?)
 *   → boundary admission      (is the real target inside the sandbox at all?)
 *   → approval                (only if policy already said "approvable")
 *   → boundary performs it    (re-checking admission itself)
 *   → audit events for every decision
 * ```
 *
 * Four properties are worth stating explicitly, because they are what an attacker
 * or a careless refactor would go after:
 *
 * 1. **No method skips a step.** `execute` is the entire surface. There is no
 *    `executeUnchecked`, and the boundary is not exposed to callers.
 * 2. **Approval is a confirmation, never an escalation.** Policy is evaluated
 *    *before* the ledger is consulted, and a grant is only ever looked up for a
 *    decision policy already marked `approval-required`. A capability that policy
 *    denies can never be reached by approving anything.
 * 3. **The envelope cannot be widened.** The declared set is fixed when the gateway
 *    is built, and a grant for one capability does not cover another capability,
 *    another task or another workspace.
 * 4. **A denial is never silent.** Every refusal carries a stable reason code, and
 *    the check is recorded *before* the operation is attempted, so a crash cannot
 *    lose the decision that preceded it.
 *
 * A gateway is bound to one task and one workspace at construction, and refuses to
 * be built against a boundary with a different scope. That is what makes "an
 * approval for task A cannot authorise task B" structural rather than a convention:
 * the ledger query is scoped, and there is no way to ask it about another task.
 */
export interface OperationGatewayScope {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly taskId: TaskId;
  readonly sessionId?: SessionId;
  readonly correlationId?: string;
}

export interface OperationGatewayDeps {
  readonly policy: AccessPolicy;
  /** Capabilities declared for this attempt. Evaluated, never widened. */
  readonly envelope: readonly Capability[];
  readonly boundary: SandboxBoundary;
  readonly ledger: ApprovalLedger;
  readonly approvals: ApprovalService;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly scope: OperationGatewayScope;
  readonly ids: IdFactory;
  /** Who is asking. Recorded on every audit event. */
  readonly actor: EventActor;
  readonly gatewayId?: string;
}

/** What the agent runtime is given: a gateway per attempt, never a boundary. */
export interface OperationGatewayFactory {
  readonly id: string;
  readonly guarantee: "in-process";
  readonly policyId: string;
  readonly policyVersion: number;
  readonly envelope: readonly Capability[];
  forAttempt(scope: OperationGatewayScope): OperationGateway;
}

export const OPERATION_GATEWAY_ACTOR: EventActor = {
  type: "system",
  id: "operation-gateway",
};

export interface EnforcedOperationGateway extends OperationGateway {
  readonly envelope: readonly Capability[];
  readonly policyId: string;
  readonly scope: OperationGatewayScope;
}

export function createOperationGateway(
  deps: OperationGatewayDeps,
): EnforcedOperationGateway {
  const { scope, boundary } = deps;
  if (
    boundary.scope.projectId !== scope.projectId ||
    boundary.scope.workspaceId !== scope.workspaceId
  ) {
    // Fail closed. A gateway describing one scope while holding a boundary for
    // another is exactly the shape of a cross-project leak, and there is no
    // legitimate reason to build one.
    throw new DomainError(
      "FORBIDDEN",
      "refusing to build an operation gateway whose scope differs from its boundary's scope",
      { field: "scope" },
    );
  }

  /**
   * Authority established *within this attempt* by consuming a grant.
   *
   * A grant authorises one attempt within its boundary (ADR-037), so a second
   * operation needing the same capability in the same attempt is covered — and an
   * operation needing a *different* capability is not.
   */
  let authority: ApprovalScope | undefined;

  const audit = {
    workspaceId: scope.workspaceId,
    taskId: scope.taskId,
    ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
    ...(scope.correlationId === undefined
      ? {}
      : { correlationId: scope.correlationId }),
  };

  const safeOf = (request: OperationRequest) =>
    describeTarget(targetForRequest(request));

  async function execute(request: OperationRequest): Promise<OperationOutcome> {
    const capability = capabilityForRequest(request);
    const operation = operationKindForCapability(capability);
    const safe = safeOf(request);
    const checkId = deps.ids.next();

    // The check is recorded *before* it is evaluated, so a crash mid-decision
    // still shows that a decision was being made about this target.
    await deps.recorder.emit({
      type: "CapabilityCheckRequested",
      actor: deps.actor,
      payload: {
        checkId,
        capability,
        operation,
        targetKind: safe.kind,
        target: safe.target,
      },
      ...audit,
    });

    const evaluation = await evaluateOperation({
      policy: deps.policy,
      envelope: deps.envelope,
      boundary,
      request,
    });
    let decision = evaluation.decision;

    // A policy denial is final: no boundary, no approval, no operation. This is
    // the line that makes "approval never overrides a policy deny" true.
    if (!decision.allowed && !decision.requiresApproval) {
      return await refuse(checkId, request, decision, capability, operation, {
        kind: "policy",
      });
    }

    // Boundary admission has already run inside `evaluateOperation`, so an
    // impossible target never reaches a human as an approval request.
    if (evaluation.violation !== undefined) {
      return await refuse(checkId, request, decision, capability, operation, {
        kind: "sandbox",
      });
    }

    if (decision.requiresApproval) {
      const resolution = await resolveApproval(capability, decision.riskLevel);
      if (resolution.kind === "suspended") {
        await deps.recorder.emit({
          type: "CapabilityCheckCompleted",
          actor: deps.actor,
          payload: {
            checkId,
            capability,
            decision: "approval-required",
            reasonCode: "APPROVAL_REQUIRED",
            requiresApproval: true,
            riskLevel: decision.riskLevel,
            approvalRequestId: resolution.requestId,
          },
          ...audit,
        });
        return {
          ok: false,
          kind: request.kind,
          capability,
          operation,
          riskLevel: decision.riskLevel,
          decision,
          approvalRequestId: resolution.requestId,
        };
      }
      // A grant was consumed. The reason code stays truthful: the capability
      // needed approval and got it, so the operation itself is allowed now.
      decision = {
        ...decision,
        allowed: true,
        reasonCode: "ALLOWED",
        reason: `capability "${capability}" was approved for this attempt`,
      };
    }

    await deps.recorder.emit({
      type: "CapabilityCheckCompleted",
      actor: deps.actor,
      payload: {
        checkId,
        capability,
        decision: "allowed",
        reasonCode: decision.reasonCode,
        requiresApproval: false,
        riskLevel: decision.riskLevel,
      },
      ...audit,
    });

    const operationId = deps.ids.next();
    const startedAt = deps.clock.now();
    await deps.recorder.emit({
      type: "OperationStarted",
      actor: deps.actor,
      payload: {
        operationId,
        capability,
        operation,
        targetKind: safe.kind,
        target: safe.target,
      },
      ...audit,
    });

    const performed = await boundary.perform(request);
    const durationMs = durationMsFrom(
      toIsoString(startedAt),
      toIsoString(deps.clock.now()),
    );

    if (!performed.ok) {
      const refusal = performed.refusal;
      // A refusal that is not a plain operation failure is the boundary refusing
      // something policy had allowed: a race, a link that appeared in between, or
      // a caller that skipped admission. It is recorded as a violation.
      const isViolation = refusal.reasonCode !== "OPERATION_FAILED";
      if (isViolation) {
        await deps.recorder.emit({
          type: "SandboxViolation",
          actor: deps.actor,
          payload: {
            capability,
            operation,
            targetKind: safe.kind,
            target: safe.target,
            reasonCode: refusal.reasonCode,
          },
          ...audit,
        });
      }
      await deps.recorder.emit(
        isViolation
          ? {
              type: "OperationDenied",
              actor: deps.actor,
              payload: {
                capability,
                operation,
                targetKind: safe.kind,
                target: safe.target,
                reasonCode: refusal.reasonCode,
              },
              ...audit,
            }
          : {
              type: "OperationFailed",
              actor: deps.actor,
              payload: {
                operationId,
                capability,
                reasonCode: refusal.reasonCode,
              },
              ...audit,
            },
      );
      return {
        ok: false,
        kind: request.kind,
        capability,
        operation,
        riskLevel: decision.riskLevel,
        decision: {
          ...decision,
          allowed: false,
          reasonCode: refusal.reasonCode,
          reason: refusal.reason,
        },
        operationId,
      };
    }

    await deps.recorder.emit({
      type: "OperationCompleted",
      actor: deps.actor,
      payload: {
        operationId,
        ok: true,
        durationMs,
        ...sizeOfOperationResult(performed.result),
      },
      ...audit,
    });

    return {
      ok: true,
      operationId,
      kind: request.kind,
      capability,
      operation,
      riskLevel: decision.riskLevel,
      decision,
      result: performed.result,
      durationMs,
    };
  }

  /** One refusal path: record the check, record the denial, answer. */
  async function refuse(
    checkId: string,
    request: OperationRequest,
    decision: AccessDecision,
    capability: Capability,
    operation: OperationKind,
    origin: { readonly kind: "policy" | "sandbox" },
  ): Promise<OperationOutcome> {
    const safe = safeOf(request);
    if (origin.kind === "sandbox") {
      await deps.recorder.emit({
        type: "SandboxViolation",
        actor: deps.actor,
        payload: {
          capability,
          operation,
          targetKind: safe.kind,
          target: safe.target,
          reasonCode: decision.reasonCode,
        },
        ...audit,
      });
    }
    await deps.recorder.emit({
      type: "CapabilityCheckCompleted",
      actor: deps.actor,
      payload: {
        checkId,
        capability,
        decision: "denied",
        reasonCode: decision.reasonCode,
        requiresApproval: false,
        riskLevel: decision.riskLevel,
      },
      ...audit,
    });
    await deps.recorder.emit({
      type: "OperationDenied",
      actor: deps.actor,
      payload: {
        capability,
        operation,
        targetKind: safe.kind,
        target: safe.target,
        reasonCode: decision.reasonCode,
      },
      ...audit,
    });
    return {
      ok: false,
      kind: request.kind,
      capability,
      operation,
      riskLevel: decision.riskLevel,
      decision,
    };
  }

  /**
   * The approval half of the pipeline. Deliberately the same three-step order the
   * run use case uses (ADR-037): authority already established in this attempt,
   * then an existing grant to consume, then an outstanding request to re-state,
   * then a new request.
   */
  async function resolveApproval(
    capability: Capability,
    riskLevel: RiskLevel,
  ): Promise<
    | { readonly kind: "granted" }
    | { readonly kind: "suspended"; readonly requestId: string }
  > {
    const requirement: ApprovalRequirement = {
      riskLevel,
      operation: operationKindForCapability(capability),
    };
    if (authority !== undefined && scopeCovers(authority, requirement)) {
      return { kind: "granted" };
    }

    const states = await deps.ledger.forTask(
      { projectId: scope.projectId, workspaceId: scope.workspaceId },
      scope.taskId,
    );
    const grant = usableGrant(states, requirement);
    if (grant !== undefined) {
      await deps.approvals.consume({
        workspaceId: scope.workspaceId,
        taskId: scope.taskId,
        requestId: grant.requestId,
        riskLevel: grant.riskLevel,
        ...(grant.operation === undefined
          ? {}
          : { operation: grant.operation }),
        ...(scope.sessionId === undefined
          ? {}
          : { sessionId: scope.sessionId }),
      });
      authority = {
        riskLevel: grant.riskLevel,
        ...(grant.operation === undefined
          ? {}
          : { operation: grant.operation }),
      };
      return { kind: "granted" };
    }

    const outstanding = pendingRequest(states, requirement);
    if (outstanding !== undefined) {
      return { kind: "suspended", requestId: outstanding.requestId };
    }

    const requested = await deps.approvals.request({
      workspaceId: scope.workspaceId,
      taskId: scope.taskId,
      riskLevel,
      ...(requirement.operation === undefined
        ? {}
        : { operation: requirement.operation }),
    });
    return { kind: "suspended", requestId: requested.requestId };
  }

  return {
    id: deps.gatewayId ?? "operation-gateway",
    guarantee: "in-process",
    envelope: deps.envelope,
    policyId: deps.policy.id,
    scope,
    execute,
  };
}

/** Builds one gateway per attempt, from one policy and one boundary. */
export function createOperationGatewayFactory(
  deps: Omit<OperationGatewayDeps, "scope">,
): OperationGatewayFactory {
  return {
    id: deps.gatewayId ?? "operation-gateway",
    guarantee: "in-process",
    policyId: deps.policy.id,
    policyVersion: deps.policy.version,
    envelope: deps.envelope,
    forAttempt(scope) {
      return createOperationGateway({ ...deps, scope });
    },
  };
}

/**
 * The result's size in its own natural unit — bytes, entries, HTTP status.
 *
 * Never content, and never a count of anything the operation read. A process
 * result reports only whether it timed out, because an exit code is not a size and
 * neither stdout nor stderr may be recorded.
 */
function sizeOfOperationResult(
  result: OperationResultMap[BridgedOperationKind],
): { readonly resultSize?: number; readonly timedOut?: boolean } {
  if ("bytes" in result) {
    return { resultSize: result.bytes };
  }
  if ("entries" in result) {
    return { resultSize: result.entries.length };
  }
  if ("status" in result) {
    return { resultSize: result.status };
  }
  if ("timedOut" in result) {
    return { timedOut: result.timedOut };
  }
  return {};
}

/** Records the attempt's capability envelope once, before any operation. */
export async function declareCapabilities(input: {
  readonly recorder: EventRecorder;
  readonly gateway: OperationGatewayFactory;
  readonly actor: EventActor;
  readonly workspaceId: WorkspaceId;
  readonly taskId: TaskId;
  readonly sessionId?: SessionId;
  readonly correlationId?: string;
}): Promise<void> {
  await input.recorder.emit({
    type: "CapabilitiesDeclared",
    actor: input.actor,
    payload: {
      policyId: input.gateway.policyId,
      policyVersion: input.gateway.policyVersion,
      capabilities: [...input.gateway.envelope],
    },
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: input.correlationId }),
  });
}

/**
 * The evaluation half of the pipeline: policy, then boundary admission.
 *
 * Split out so that `ai policy check` can answer the same question with the same
 * code path while performing nothing — the dry run and the real operation cannot
 * drift, and neither can their reasons. Pure with respect to policy: the only
 * side effect is the boundary's own read-only resolution.
 */
export interface OperationEvaluation {
  readonly decision: AccessDecision;
  /** Present when the boundary refused, whatever policy said. */
  readonly violation?: OperationRefusal;
}

export async function evaluateOperation(input: {
  readonly policy: AccessPolicy;
  readonly envelope: readonly Capability[];
  readonly boundary: SandboxBoundary;
  readonly request: OperationRequest;
}): Promise<OperationEvaluation> {
  const capability = capabilityForRequest(input.request);
  const decision = evaluateAccess(input.policy, {
    capability,
    target: targetForRequest(input.request),
    envelope: input.envelope,
  });
  if (!decision.allowed && !decision.requiresApproval) {
    return { decision };
  }
  const violation = await input.boundary.admit(input.request);
  if (violation === undefined) {
    return { decision };
  }
  return {
    decision: {
      ...decision,
      allowed: false,
      requiresApproval: false,
      reasonCode: violation.reasonCode,
      reason: violation.reason,
    },
    violation,
  };
}

/** The three answers a dry run can give. `approval-required` is not `allowed`. */
export type AccessCheckStatus = "allowed" | "approval-required" | "denied";

export interface AccessCheckResult {
  readonly status: AccessCheckStatus;
  readonly capability: Capability;
  readonly operation: OperationKind;
  readonly targetKind: string;
  readonly target: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly envelope: readonly Capability[];
  readonly reasonCode: PolicyReasonCodeFromDecision;
  readonly reason: string;
  readonly requiresApproval: boolean;
  readonly riskLevel: RiskLevel;
  /** True when the boundary refused, false when policy did. */
  readonly fromSandbox: boolean;
  readonly matchedRule?: string;
}

type PolicyReasonCodeFromDecision = AccessDecision["reasonCode"];

/**
 * `ai policy check`: answer what would happen, without doing anything.
 *
 * No event is written and no grant is consulted: a dry run that consumed authority
 * would be a dry run nobody could safely perform. The approval states are reported
 * as `approval-required`, never as `allowed`, because that is the truth about an
 * operation nobody has permitted yet.
 */
export async function checkOperationAccess(input: {
  readonly policy: AccessPolicy;
  readonly envelope: readonly Capability[];
  readonly boundary: SandboxBoundary;
  readonly request: OperationRequest;
}): Promise<AccessCheckResult> {
  const evaluation = await evaluateOperation(input);
  const decision = evaluation.decision;
  const safe = describeTarget(targetForRequest(input.request));
  return {
    status: decision.allowed
      ? "allowed"
      : decision.requiresApproval
        ? "approval-required"
        : "denied",
    capability: decision.capability,
    operation: decision.operation,
    targetKind: safe.kind,
    target: safe.target,
    policyId: input.policy.id,
    policyVersion: input.policy.version,
    envelope: input.envelope,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    requiresApproval: decision.requiresApproval,
    riskLevel: decision.riskLevel,
    fromSandbox: evaluation.violation !== undefined,
    ...(decision.matchedRule === undefined
      ? {}
      : { matchedRule: decision.matchedRule }),
  };
}

/**
 * The capability envelope an attempt is given.
 *
 * Derived from policy, never from a request: with no `requested` list a runtime
 * gets the whole permitted ceiling, and with one it gets the intersection — so a
 * task can *narrow* its authority and can never widen it.
 */
export function capabilityEnvelope(
  policy: AccessPolicy,
  options: { readonly requested?: readonly Capability[] } = {},
): readonly Capability[] {
  const permitted = policy.capabilities.allowed.filter(
    (capability) => !policy.capabilities.denied.includes(capability),
  );
  if (options.requested === undefined) {
    return sortCapabilities(permitted);
  }
  return sortCapabilities(
    options.requested.filter((capability) => permitted.includes(capability)),
  );
}
