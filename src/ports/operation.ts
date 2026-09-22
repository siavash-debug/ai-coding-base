import type { ProjectId, WorkspaceId } from "../core/ids.js";
import type { OperationKind, RiskLevel } from "../decisions/risk.js";
import type { Capability } from "../policy/capability.js";
import type { AccessDecision } from "../policy/access-policy.js";
import type { PolicyReasonCode } from "../policy/reason.js";
import type { OperationTarget } from "../policy/target.js";

/**
 * Operations: the only way application code reaches the outside world.
 *
 * An `OperationRequest` is a typed, declarative statement of intent — "read this
 * workspace-relative file", "run this program with these arguments", "call this
 * URL". It is *not* a filesystem call, and it is not authorisation: the request is
 * what the enforcement layer evaluates (ADR-045).
 *
 * Three properties are deliberate:
 *
 * - **Everything is a reference.** Paths are workspace-relative, commands are
 *   program names, URLs are absolute, environment targets are variable *names*.
 *   Nothing here can express "the host's `/etc/shadow`" without going through a
 *   resolver that refuses it.
 * - **Content travels in memory.** A read result and a write body are values in the
 *   process; they are never fields of an event.
 * - **The request does not name a capability to trust.** `capabilityForRequest`
 *   derives it from the operation kind, so a caller cannot claim a cheap capability
 *   for an expensive operation.
 */

export const BRIDGED_OPERATION_KINDS = [
  "fs.read",
  "fs.list",
  "fs.write",
  "process.exec",
  "network.request",
  "env.read",
] as const;

export type BridgedOperationKind = (typeof BRIDGED_OPERATION_KINDS)[number];

export interface FsReadRequest {
  readonly kind: "fs.read";
  readonly ref: string;
}

export interface FsListRequest {
  readonly kind: "fs.list";
  readonly ref: string;
}

export interface FsWriteRequest {
  readonly kind: "fs.write";
  readonly ref: string;
  /** Written in memory, recorded nowhere. */
  readonly content: string;
}

export interface ProcessExecRequest {
  readonly kind: "process.exec";
  readonly command: string;
  /** Passed as an argv array. There is no shell, so no string is ever parsed. */
  readonly args: readonly string[];
  /** Workspace-relative working directory. Defaults to the workspace root. */
  readonly cwdRef?: string;
  readonly timeoutMs?: number;
}

export interface NetworkRequestRequest {
  readonly kind: "network.request";
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export interface EnvReadRequest {
  readonly kind: "env.read";
  readonly name: string;
}

export type OperationRequest =
  | FsReadRequest
  | FsListRequest
  | FsWriteRequest
  | ProcessExecRequest
  | NetworkRequestRequest
  | EnvReadRequest;

/**
 * The capability each operation kind requires. One table, one place to audit.
 */
const REQUEST_CAPABILITY: Readonly<Record<BridgedOperationKind, Capability>> = {
  "fs.read": "filesystem.read",
  "fs.list": "filesystem.read",
  "fs.write": "filesystem.write",
  "process.exec": "process.execute",
  "network.request": "network.connect",
  "env.read": "environment.read",
};

export function capabilityForRequest(request: OperationRequest): Capability {
  return REQUEST_CAPABILITY[request.kind];
}

/** The target a request points at, in the policy layer's vocabulary. */
export function targetForRequest(request: OperationRequest): OperationTarget {
  switch (request.kind) {
    case "fs.read":
    case "fs.list":
    case "fs.write":
      return { kind: "path", ref: request.ref };
    case "process.exec":
      return {
        kind: "command",
        command: request.command,
        argumentCount: request.args.length,
      };
    case "network.request":
      return { kind: "url", url: request.url };
    case "env.read":
      return { kind: "variable", name: request.name };
  }
}

export interface FsReadResult {
  readonly content: string;
  readonly bytes: number;
  /** True when the file was larger than the boundary's read cap. */
  readonly truncated: boolean;
}

export interface FsListResult {
  readonly entries: readonly string[];
  readonly truncated: boolean;
}

export interface FsWriteResult {
  readonly bytes: number;
}

export interface ProcessExecResult {
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface NetworkRequestResult {
  readonly status: number;
  readonly body: string;
}

export interface EnvReadResult {
  readonly present: boolean;
  /** Present only when the variable exists and policy allowed it to be read. */
  readonly value?: string;
}

export interface OperationResultMap {
  "fs.read": FsReadResult;
  "fs.list": FsListResult;
  "fs.write": FsWriteResult;
  "process.exec": ProcessExecResult;
  "network.request": NetworkRequestResult;
  "env.read": EnvReadResult;
}

/** Why an operation did not happen. Always a reason code, never prose alone. */
export interface OperationRefusal {
  readonly reasonCode: PolicyReasonCode;
  /** Safe to record: no secret, no absolute host path. */
  readonly reason: string;
}

export interface OperationSucceeded<K extends BridgedOperationKind> {
  readonly ok: true;
  readonly operationId: string;
  readonly kind: K;
  readonly capability: Capability;
  readonly operation: OperationKind;
  readonly riskLevel: RiskLevel;
  readonly decision: AccessDecision;
  readonly result: OperationResultMap[K];
  readonly durationMs: number;
}

export interface OperationRefused<K extends BridgedOperationKind> {
  readonly ok: false;
  readonly kind: K;
  readonly capability: Capability;
  readonly operation: OperationKind;
  readonly riskLevel: RiskLevel;
  readonly decision: AccessDecision;
  /** Absent when the request was rejected before an operation id was assigned. */
  readonly operationId?: string;
  /** The approval a human must grant, when the refusal is a suspension. */
  readonly approvalRequestId?: string;
}

export type OperationOutcome =
  | OperationSucceeded<BridgedOperationKind>
  | OperationRefused<BridgedOperationKind>;

/**
 * OperationGateway: the enforcement boundary.
 *
 * This is the *only* interface the agent runtime is given for touching the world.
 * It evaluates policy, consults the approval ledger, delegates to a sandbox
 * boundary, and records what it decided. It has no method that skips a step, which
 * is what makes "no capability → no operation" a property of the type rather than a
 * convention (ADR-045).
 */
export interface OperationGateway {
  readonly id: string;
  /** What the gateway guarantees, in one word, for `ai doctor` to report. */
  readonly guarantee: "in-process";
  execute(request: OperationRequest): Promise<OperationOutcome>;
}

/** The scope a boundary is bound to. It cannot be changed at call time. */
export interface BoundaryScope {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  /** Absolute workspace root: the fence every reference resolves against. */
  readonly workspaceRoot: string;
  /** Absolute project root, one level above any workspace. */
  readonly projectRoot: string;
}

/**
 * SandboxBoundary: the last line, which performs the operation.
 *
 * Two methods, because there are two different questions:
 *
 * - `admit` answers "would this target be inside the boundary at all?" — it is what
 *   lets the gateway deny a traversal *before* asking a human for approval, instead
 *   of asking for approval for something that can never be allowed;
 * - `perform` re-checks the same conditions and then acts.
 *
 * The re-check is not redundancy. `perform` is reached from `admit` through policy
 * and approval code, and a boundary that trusted an earlier verdict would be one
 * refactor away from being bypassable (ADR-048).
 */
export interface SandboxBoundary {
  readonly id: string;
  readonly scope: BoundaryScope;
  admit(request: OperationRequest): Promise<OperationRefusal | undefined>;
  perform(request: OperationRequest): Promise<
    | {
        readonly ok: true;
        readonly result: OperationResultMap[BridgedOperationKind];
      }
    | { readonly ok: false; readonly refusal: OperationRefusal }
  >;
}
