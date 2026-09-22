import type { AccessCheckResult } from "./operation-gateway.js";
import { checkOperationAccess } from "./operation-gateway.js";
import type { AccessPolicy } from "../policy/access-policy.js";
import { type Capability, assertCapability } from "../policy/capability.js";
import type { PolicyReasonCode } from "../policy/reason.js";
import type { OperationRequest, SandboxBoundary } from "../ports/operation.js";
import {
  commandTarget,
  pathTarget,
  urlTarget,
  variableTarget,
} from "../policy/target.js";

/**
 * `ai policy check`: a dry run of the enforcement decision.
 *
 * This module contains the *whole* of the interpretation a check needs, so the CLI
 * command around it is argument parsing and printing. Two rules it follows:
 *
 * - the target is validated with the same functions the boundary uses, so a
 *   traversal is refused here for the reason it would be refused there
 *   (`TARGET_REFUSED`) rather than being normalised into something allowed;
 * - nothing is performed, nothing is recorded, and no grant is consulted. A dry run
 *   that consumed authority would be one nobody could safely run twice.
 */
export interface PolicyCheckInput {
  readonly capability: string;
  /** `--target`: a path, command, URL or variable name, per the capability. */
  readonly target: string;
  /** Arguments a `process.execute` check claims, for the recorded target only. */
  readonly argumentCount?: number;
}

export interface PolicyCheckOutcome {
  /** Present when the target was interpretable and evaluated. */
  readonly result?: AccessCheckResult;
  /** Present when the target could not be interpreted; nothing was evaluated. */
  readonly refused?: {
    readonly reasonCode: PolicyReasonCode;
    readonly reason: string;
  };
  readonly request?: OperationRequest;
}

/** Builds the operation a capability check describes, or explains why it cannot. */
export function buildCheckRequest(input: PolicyCheckInput): PolicyCheckOutcome {
  let capability: Capability;
  try {
    capability = assertCapability(input.capability, "capability");
  } catch (error) {
    return {
      refused: {
        reasonCode: "MALFORMED_REQUEST",
        reason: error instanceof Error ? error.message : "unknown capability",
      },
    };
  }

  try {
    switch (capability) {
      case "filesystem.read":
      case "git.read":
        return {
          request: { kind: "fs.read", ref: pathTarget(input.target).ref },
        };
      case "filesystem.write":
      case "git.write":
        return {
          request: {
            kind: "fs.write",
            ref: pathTarget(input.target).ref,
            content: "",
          },
        };
      case "process.execute": {
        const target = commandTarget(input.target, input.argumentCount ?? 0);
        return {
          request: {
            kind: "process.exec",
            command: target.command,
            args: [],
          },
        };
      }
      case "network.connect": {
        const target = urlTarget(input.target);
        return {
          request: { kind: "network.request", url: target.url, method: "GET" },
        };
      }
      case "environment.read":
        return {
          request: {
            kind: "env.read",
            name: variableTarget(input.target).name,
          },
        };
      default:
        return {
          refused: {
            reasonCode: "MALFORMED_REQUEST",
            reason: `capability "${String(capability)}" has no operation mapping`,
          },
        };
    }
  } catch (error) {
    return {
      refused: {
        reasonCode: "TARGET_REFUSED",
        reason: error instanceof Error ? error.message : "target was refused",
      },
    };
  }
}

export interface CheckPolicyInput {
  readonly policy: AccessPolicy;
  readonly envelope: readonly Capability[];
  readonly boundary: SandboxBoundary;
  readonly check: PolicyCheckInput;
}

export async function runPolicyCheck(
  input: CheckPolicyInput,
): Promise<PolicyCheckOutcome> {
  const built = buildCheckRequest(input.check);
  if (built.request === undefined) {
    return built;
  }
  const result = await checkOperationAccess({
    policy: input.policy,
    envelope: input.envelope,
    boundary: input.boundary,
    request: built.request,
  });
  return { result, request: built.request };
}

/**
 * Exit code for a check: 0 only for `allowed`.
 *
 * `approval-required` is not success — the operation would not happen — so it exits
 * non-zero and stays distinguishable from a denial by its status and reason code.
 */
export function policyCheckExitCode(outcome: PolicyCheckOutcome): number {
  if (outcome.refused !== undefined) {
    return 2;
  }
  return outcome.result?.status === "allowed" ? 0 : 1;
}
