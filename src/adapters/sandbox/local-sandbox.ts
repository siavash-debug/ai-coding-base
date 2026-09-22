import type { Clock } from "../../core/clock.js";
import type { Environment } from "../../ports/environment.js";
import type {
  BoundaryScope,
  BridgedOperationKind,
  OperationRefusal,
  OperationRequest,
  OperationResultMap,
  SandboxBoundary,
} from "../../ports/operation.js";
import type { HttpTransport } from "../../ports/http-transport.js";
import type { AccessPolicy } from "../../policy/access-policy.js";
import {
  createAllowlistedEnvironment,
  type AllowlistedEnvironment,
} from "./allowlisted-environment.js";
import {
  createGuardedNetwork,
  type GuardedNetwork,
} from "./guarded-network.js";
import { createLocalFsBoundary, type LocalFsBoundary } from "./local-fs.js";
import {
  createLocalProcessBoundary,
  type LocalProcessBoundary,
} from "./local-process.js";

/**
 * The local sandbox: one object that owns every way an operation can touch the
 * world, bound to one workspace.
 *
 * Composition, not inheritance: the four specialised boundaries stay separate and
 * individually testable, and this module is the only place that knows all of them.
 * Nothing above it receives `fs`, `child_process`, `fetch` or `process.env` — the
 * gateway holds a `SandboxBoundary`, and this is the only implementation.
 *
 * The scope is fixed at construction. There is no `withScope()` and no per-request
 * scope argument, because a boundary that could be re-pointed is a boundary that
 * could be re-pointed at another project (ADR-048).
 *
 * Honest labels, stated here and reported by `ai doctor`:
 *
 * - this is **not** a container, a VM, a user switch or a kernel boundary;
 * - it does **not** protect against a compromised host or a malicious process that
 *   escapes by other means;
 * - it *does* enforce, in-process and by construction, which paths may be read or
 *   written, which programs may run, with which environment and working directory,
 *   which hosts may be reached, and which variables may be read.
 */
export interface LocalSandboxOptions {
  readonly scope: BoundaryScope;
  readonly policy: AccessPolicy;
  readonly clock: Clock;
  readonly environment: Environment;
  /** The transport an operation request goes through. Guarded here, not by callers. */
  readonly transport: HttpTransport;
  /** The host environment, for filtering children. Defaults to `process.env`. */
  readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  readonly maxReadBytes?: number;
  readonly maxListEntries?: number;
  readonly maxOutputBytes?: number;
}

export interface LocalSandbox extends SandboxBoundary {
  readonly fs: LocalFsBoundary;
  readonly process: LocalProcessBoundary;
  readonly network: GuardedNetwork;
  readonly environmentBoundary: AllowlistedEnvironment;
  /** What a child process would inherit, by name only. For `ai doctor`. */
  readonly childEnvironmentNames: readonly string[];
}

export function createLocalSandbox(options: LocalSandboxOptions): LocalSandbox {
  const { scope, policy } = options;
  const fs = createLocalFsBoundary({
    scope,
    readableRoots: policy.filesystem.readableRoots,
    writableRoots: policy.filesystem.writableRoots,
    deniedPatterns: policy.filesystem.deniedPatterns,
    ...(options.maxReadBytes === undefined
      ? {}
      : { maxReadBytes: options.maxReadBytes }),
    ...(options.maxListEntries === undefined
      ? {}
      : { maxListEntries: options.maxListEntries }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  const processBoundary = createLocalProcessBoundary({
    scope,
    maxTimeoutMs: policy.process.maxTimeoutMs,
    // The command lists are handed to the boundary as well as being evaluated by
    // the policy layer, so a caller that reached the boundary directly still cannot
    // run a program this project did not list.
    allowedCommands: policy.process.allowedCommands,
    deniedCommands: policy.process.deniedCommands,
    environmentAllowlist: policy.process.environmentAllowlist,
    clock: options.clock,
    hostEnvironment: options.hostEnvironment ?? process.env,
    ...(options.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  const network = createGuardedNetwork({
    transport: options.transport,
    operationEnabled: policy.network.enabled,
    operationHosts: policy.network.allowedHosts,
    providerHosts: policy.network.providerHosts,
  });
  const environmentBoundary = createAllowlistedEnvironment({
    environment: options.environment,
    allowedVariables: policy.environment.allowedVariables,
    deniedPatterns: policy.environment.deniedPatterns,
  });

  /**
   * The pre-check. Every branch is a refusal the gateway can act on *before*
   * spending a human's attention on an approval.
   */
  async function admit(
    request: OperationRequest,
  ): Promise<OperationRefusal | undefined> {
    switch (request.kind) {
      case "fs.read":
      case "fs.list":
        return await fs.admitRef(request.ref, "read");
      case "fs.write":
        return await fs.admitRef(request.ref, "write");
      case "process.exec":
        return await processBoundary.admitCommand(
          request.command,
          request.cwdRef,
        );
      case "network.request":
        return network.admitUrl(request.url);
      case "env.read":
        return environmentBoundary.admitVariable(request.name);
    }
  }

  /**
   * The operation. It re-runs every admission check first: the boundary does not
   * trust an earlier verdict, so a future caller that skips `admit` — or a bug in
   * the gateway — still cannot escape.
   */
  async function perform(request: OperationRequest): Promise<
    | {
        readonly ok: true;
        readonly result: OperationResultMap[BridgedOperationKind];
      }
    | { readonly ok: false; readonly refusal: OperationRefusal }
  > {
    const admitted = await admit(request);
    if (admitted !== undefined) {
      return { ok: false, refusal: admitted };
    }
    switch (request.kind) {
      case "fs.read":
        return await fs.read(request.ref);
      case "fs.list":
        return await fs.list(request.ref);
      case "fs.write":
        return await fs.write(request.ref, request.content);
      case "process.exec":
        return await processBoundary.run({
          command: request.command,
          args: request.args,
          ...(request.cwdRef === undefined ? {} : { cwdRef: request.cwdRef }),
          ...(request.timeoutMs === undefined
            ? {}
            : { timeoutMs: request.timeoutMs }),
        });
      case "network.request":
        return await network.request({
          url: request.url,
          method: request.method,
          ...(request.headers === undefined
            ? {}
            : { headers: request.headers }),
          ...(request.body === undefined ? {} : { body: request.body }),
          ...(request.timeoutMs === undefined
            ? {}
            : { timeoutMs: request.timeoutMs }),
        });
      case "env.read":
        return { ok: true, result: environmentBoundary.read(request.name) };
    }
  }

  return {
    id: "local-sandbox",
    scope,
    fs,
    process: processBoundary,
    network,
    environmentBoundary,
    childEnvironmentNames: processBoundary.childEnvironmentNames(),
    admit,
    perform,
  };
}
