import { DomainError } from "../core/errors.js";
import {
  assertNonEmptyString,
  assertPositiveInteger,
  assertStringArray,
} from "../core/validation.js";
import {
  isSecretShapedPath,
  matchesPathPattern,
  parsePathPattern,
} from "../context/ignore.js";
import {
  CAPABILITIES,
  type Capability,
  assertCapability,
  sortCapabilities,
  operationKindForCapability,
  baselineRiskForCapability,
} from "./capability.js";
import { isRuntimeStateRef, refWithinAnyRoot } from "./path-boundary.js";
import { assertWorkspaceRef, urlTarget, variableTarget } from "./target.js";
import type { PolicyReasonCode } from "./reason.js";
import {
  type OperationTarget,
  type SafeTarget,
  describeTarget,
  safeCommandName,
} from "./target.js";
import type { OperationKind, RiskLevel } from "../decisions/risk.js";

/**
 * The access policy: what any operation may touch, deterministically.
 *
 * This is a *separate* concern from the risk policy in `src/decisions/policy.ts`,
 * which answers "how much oversight does this operation need?". This one answers
 * "is this operation permitted at all, and where may it reach?". Both are pure and
 * both are evaluated on every operation; neither can be influenced by a model, a
 * repository file, or an agent request (ADR-045).
 *
 * Every default is restrictive:
 *
 * - `capabilities.allowed` is empty, so nothing is authorised until an operator
 *   says so;
 * - `filesystem.readableRoots` is empty, so no read is inside the boundary;
 * - `process.allowedCommands` is empty and there is no shell;
 * - `network.enabled` is false.
 *
 * Approval is deliberately *not* the mechanism by which a boundary is opened. A
 * capability that is not allowed here can never be reached by approving something;
 * approval only ever confirms an operation that policy already says is approvable
 * (ADR-049).
 */
export const ACCESS_POLICY_VERSION = 1;
export const MAX_PROCESS_TIMEOUT_MS = 600_000;

export interface CapabilityPolicy {
  /** The ceiling: a capability absent from this list is denied outright. */
  readonly allowed: readonly Capability[];
  /** Always denied, even if also present in `allowed`. Wins over everything. */
  readonly denied: readonly Capability[];
  /** Allowed only with a human approval bound to the same scope. */
  readonly requireApproval: readonly Capability[];
}

export interface FilesystemPolicy {
  /** Workspace-relative roots a read may reach. `.` is the workspace itself. */
  readonly readableRoots: readonly string[];
  /** Workspace-relative roots a write may reach. Empty means no writes. */
  readonly writableRoots: readonly string[];
  /** Operator denials, in the same pattern syntax as `.gitignore`. */
  readonly deniedPatterns: readonly string[];
}

export interface ProcessPolicy {
  /** Programs that may be executed: names, or `*`/`**` patterns on the ref. */
  readonly allowedCommands: readonly string[];
  /** Always refused, even when an allowed pattern matches. */
  readonly deniedCommands: readonly string[];
  readonly maxTimeoutMs: number;
  /**
   * Variables passed to a child process. Everything else is dropped, so a child
   * cannot inherit a credential by accident. The platform's own environment is
   * never forwarded wholesale.
   */
  readonly environmentAllowlist: readonly string[];
}

export interface NetworkPolicy {
  /** Default false. An operation cannot enable it; only configuration can. */
  readonly enabled: boolean;
  /** Hosts an operation may reach (`example.com`, `*.example.com`). */
  readonly allowedHosts: readonly string[];
  /**
   * Hosts the platform's *own* LLM egress may reach.
   *
   * Kept separate from `allowedHosts` on purpose: configuring a provider must not
   * silently grant an operation the same reach, and an operation can never add a
   * host here (ADR-050).
   */
  readonly providerHosts: readonly string[];
}

export interface EnvironmentPolicy {
  /** Variable names an operation may read. Empty means none. */
  readonly allowedVariables: readonly string[];
  /** Name patterns refused outright, e.g. `*_TOKEN`, `*_SECRET`. */
  readonly deniedPatterns: readonly string[];
}

export interface AccessPolicy {
  readonly id: string;
  readonly version: number;
  readonly capabilities: CapabilityPolicy;
  readonly filesystem: FilesystemPolicy;
  readonly process: ProcessPolicy;
  readonly network: NetworkPolicy;
  readonly environment: EnvironmentPolicy;
}

/**
 * The built-in policy: deny everything.
 *
 * A project that has not configured policy gets a platform that can plan, select
 * context and record events, but cannot read, write, execute, reach the network or
 * read the environment through an operation. That is the only safe default: an
 * unconfigured boundary must fail closed.
 */
export const DEFAULT_ACCESS_POLICY: AccessPolicy = {
  id: "policy-access-default",
  version: ACCESS_POLICY_VERSION,
  capabilities: { allowed: [], denied: [], requireApproval: [] },
  filesystem: { readableRoots: [], writableRoots: [], deniedPatterns: [] },
  process: {
    allowedCommands: [],
    deniedCommands: [],
    maxTimeoutMs: 60_000,
    environmentAllowlist: [],
  },
  network: { enabled: false, allowedHosts: [], providerHosts: [] },
  environment: { allowedVariables: [], deniedPatterns: [] },
};

/**
 * What `ai init` writes.
 *
 * Reads of the workspace are permitted, because a platform that cannot read a file
 * cannot do anything at all. Writes, process execution, network access and
 * environment access are *not*: each one is a deliberate operator decision, and each
 * is visible in `.ai/project.json` rather than implicit.
 */
export function initialAccessPolicy(): AccessPolicy {
  return {
    ...DEFAULT_ACCESS_POLICY,
    capabilities: {
      allowed: ["filesystem.read", "git.read"],
      denied: [],
      requireApproval: [],
    },
    filesystem: {
      readableRoots: ["."],
      writableRoots: [],
      deniedPatterns: [],
    },
  };
}

export function accessPolicyIsDefault(policy: AccessPolicy): boolean {
  return policy.capabilities.allowed.length === 0;
}

function assertRefList(
  value: unknown,
  field: string,
  options: { readonly allowRoot?: boolean } = {},
): readonly string[] {
  const list = assertStringArray(value, field);
  list.forEach((ref, index) => {
    const at = `${field}[${index}]`;
    if (options.allowRoot === true && ref === ".") {
      return;
    }
    // A *root* is a location, so it is validated with the reference rules from
    // `target.ts`: a root that traverses or names an absolute path is a
    // configuration error. It is checked here as well as at evaluation time because
    // a configuration that only explodes when an operation runs is a configuration
    // that passed validation while being unusable.
    assertWorkspaceRef(ref, at);
  });
  return list;
}

function assertPatternList(value: unknown, field: string): readonly string[] {
  const list = assertStringArray(value, field);
  list.forEach((pattern, index) => {
    parsePathPattern(pattern, `${field}[${index}]`);
    // A pattern is a *matcher*, so glob syntax is expected — but an absolute or
    // traversing one describes somewhere outside the workspace, which a denial
    // pattern can never legitimately mean.
    const normalized = pattern.replace(/^!/, "").replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
      throw new DomainError(
        "VALIDATION",
        `${field}[${index}] must be a workspace-relative pattern, not an absolute path`,
        { field: `${field}[${index}]` },
      );
    }
  });
  return list;
}

function assertHost(value: unknown, field: string): string {
  const host = assertNonEmptyString(value, field);
  const candidate = host.startsWith("*.") ? host.slice(2) : host;
  if (
    !/^[A-Za-z0-9.-]+$/.test(candidate) ||
    candidate.startsWith(".") ||
    candidate.endsWith(".") ||
    !candidate.includes(".")
  ) {
    throw new DomainError(
      "VALIDATION",
      `${field} must be a host name such as "api.example.com" or "*.example.com"`,
      { field },
    );
  }
  return host;
}

function assertCommandList(value: unknown, field: string): readonly string[] {
  const list = assertStringArray(value, field);
  list.forEach((command, index) => {
    parsePathPattern(command, `${field}[${index}]`);
    // A pattern that traverses or names an absolute location can never match a
    // command, because a command target is itself checked as a workspace-relative
    // reference. Refusing it here turns a silently useless entry — which reads like
    // a grant — into a configuration error.
    const normalized = command.replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new DomainError(
        "VALIDATION",
        `${field}[${index}] must be a program name or a workspace-relative path, not an absolute or traversing one`,
        { field: `${field}[${index}]` },
      );
    }
  });
  return list;
}

function assertVariableList(value: unknown, field: string): readonly string[] {
  const list = assertStringArray(value, field);
  list.forEach((name, index) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !name.includes("*")) {
      throw new DomainError(
        "VALIDATION",
        `${field}[${index}] must be an environment variable name or a glob`,
        { field: `${field}[${index}]` },
      );
    }
  });
  return list;
}

const objectAt = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("VALIDATION", `${field} must be an object`, {
      field,
    });
  }
  return value as Record<string, unknown>;
};

function unique(
  capabilities: readonly Capability[],
  field: string,
): readonly Capability[] {
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (seen.has(capability)) {
      throw new DomainError(
        "INVARIANT",
        `${field} lists capability "${capability}" more than once`,
        { field },
      );
    }
    seen.add(capability);
  }
  return sortCapabilities(capabilities);
}

export function validateAccessPolicy(policy: AccessPolicy): void {
  assertNonEmptyString(policy.id, "policy.access.id");
  assertPositiveInteger(policy.version, "policy.access.version");
  if (policy.version !== ACCESS_POLICY_VERSION) {
    throw new DomainError(
      "VALIDATION",
      `policy.access.version must be ${ACCESS_POLICY_VERSION}; a policy version is a code change, not a setting`,
      { field: "policy.access.version" },
    );
  }

  const allowed = assertStringArray(
    policy.capabilities.allowed,
    "policy.access.capabilities.allowed",
  ).map((entry, index) =>
    assertCapability(entry, `policy.access.capabilities.allowed[${index}]`),
  );
  const denied = assertStringArray(
    policy.capabilities.denied,
    "policy.access.capabilities.denied",
  ).map((entry, index) =>
    assertCapability(entry, `policy.access.capabilities.denied[${index}]`),
  );
  const requireApproval = assertStringArray(
    policy.capabilities.requireApproval,
    "policy.access.capabilities.requireApproval",
  ).map((entry, index) =>
    assertCapability(
      entry,
      `policy.access.capabilities.requireApproval[${index}]`,
    ),
  );
  unique(allowed, "policy.access.capabilities.allowed");
  unique(denied, "policy.access.capabilities.denied");
  unique(requireApproval, "policy.access.capabilities.requireApproval");
  for (const capability of allowed) {
    if (denied.includes(capability)) {
      throw new DomainError(
        "INVARIANT",
        `capability "${capability}" is both allowed and denied; denial wins, so the entry is contradictory`,
        { field: "policy.access.capabilities" },
      );
    }
  }
  for (const capability of requireApproval) {
    // Approval can only ever confirm something already permitted; requiring it for
    // a denied capability would read as an authorisation that does not exist.
    if (!allowed.includes(capability)) {
      throw new DomainError(
        "INVARIANT",
        `capability "${capability}" requires approval but is not allowed; approval cannot open a boundary, so list it under allowed first`,
        { field: "policy.access.capabilities.requireApproval" },
      );
    }
  }

  assertRefList(
    policy.filesystem.readableRoots,
    "policy.access.filesystem.readableRoots",
    { allowRoot: true },
  );
  assertRefList(
    policy.filesystem.writableRoots,
    "policy.access.filesystem.writableRoots",
    { allowRoot: true },
  );
  assertPatternList(
    policy.filesystem.deniedPatterns,
    "policy.access.filesystem.deniedPatterns",
  );

  assertCommandList(
    policy.process.allowedCommands,
    "policy.access.process.allowedCommands",
  );
  assertCommandList(
    policy.process.deniedCommands,
    "policy.access.process.deniedCommands",
  );
  assertPositiveInteger(
    policy.process.maxTimeoutMs,
    "policy.access.process.maxTimeoutMs",
  );
  if (policy.process.maxTimeoutMs > MAX_PROCESS_TIMEOUT_MS) {
    throw new DomainError(
      "VALIDATION",
      `policy.access.process.maxTimeoutMs must be at most ${MAX_PROCESS_TIMEOUT_MS}`,
      { field: "policy.access.process.maxTimeoutMs" },
    );
  }
  assertVariableList(
    policy.process.environmentAllowlist,
    "policy.access.process.environmentAllowlist",
  );

  if (typeof policy.network.enabled !== "boolean") {
    throw new DomainError(
      "VALIDATION",
      "policy.access.network.enabled must be a boolean",
      { field: "policy.access.network.enabled" },
    );
  }
  assertStringArray(
    policy.network.allowedHosts,
    "policy.access.network.allowedHosts",
  ).forEach((host, index) =>
    assertHost(host, `policy.access.network.allowedHosts[${index}]`),
  );
  assertStringArray(
    policy.network.providerHosts,
    "policy.access.network.providerHosts",
  ).forEach((host, index) =>
    assertHost(host, `policy.access.network.providerHosts[${index}]`),
  );
  if (policy.network.enabled && policy.network.allowedHosts.length === 0) {
    throw new DomainError(
      "INVARIANT",
      "policy.access.network.enabled is true but allowedHosts is empty; enable a target explicitly instead of opening the network",
      { field: "policy.access.network.allowedHosts" },
    );
  }

  assertVariableList(
    policy.environment.allowedVariables,
    "policy.access.environment.allowedVariables",
  );
  assertVariableList(
    policy.environment.deniedPatterns,
    "policy.access.environment.deniedPatterns",
  );
}

/** Parses and validates the `policy` block of a project configuration. */
export function assertAccessPolicy(
  value: unknown,
  field = "config.policy",
): AccessPolicy {
  if (value === undefined) {
    return DEFAULT_ACCESS_POLICY;
  }
  const candidate = objectAt(value, field);
  const capabilityRecord = objectAt(
    candidate["capabilities"] ?? {},
    `${field}.capabilities`,
  );
  const filesystem = objectAt(
    candidate["filesystem"] ?? {},
    `${field}.filesystem`,
  );
  const process = objectAt(candidate["process"] ?? {}, `${field}.process`);
  const network = objectAt(candidate["network"] ?? {}, `${field}.network`);
  const environment = objectAt(
    candidate["environment"] ?? {},
    `${field}.environment`,
  );

  const policy: AccessPolicy = {
    id: assertNonEmptyString(
      candidate["id"] ?? DEFAULT_ACCESS_POLICY.id,
      `${field}.id`,
    ),
    version:
      candidate["version"] === undefined
        ? ACCESS_POLICY_VERSION
        : (candidate["version"] as number),
    capabilities: {
      allowed: (capabilityRecord["allowed"] ?? []) as readonly Capability[],
      denied: (capabilityRecord["denied"] ?? []) as readonly Capability[],
      requireApproval: (capabilityRecord["requireApproval"] ??
        []) as readonly Capability[],
    },
    filesystem: {
      readableRoots: (filesystem["readableRoots"] ?? []) as readonly string[],
      writableRoots: (filesystem["writableRoots"] ?? []) as readonly string[],
      deniedPatterns: (filesystem["deniedPatterns"] ?? []) as readonly string[],
    },
    process: {
      allowedCommands: (process["allowedCommands"] ?? []) as readonly string[],
      deniedCommands: (process["deniedCommands"] ?? []) as readonly string[],
      maxTimeoutMs:
        (process["maxTimeoutMs"] as number | undefined) ??
        DEFAULT_ACCESS_POLICY.process.maxTimeoutMs,
      environmentAllowlist: (process["environmentAllowlist"] ??
        []) as readonly string[],
    },
    network: {
      enabled: (network["enabled"] as boolean | undefined) ?? false,
      allowedHosts: (network["allowedHosts"] ?? []) as readonly string[],
      providerHosts: (network["providerHosts"] ?? []) as readonly string[],
    },
    environment: {
      allowedVariables: (environment["allowedVariables"] ??
        []) as readonly string[],
      deniedPatterns: (environment["deniedPatterns"] ??
        []) as readonly string[],
    },
  };
  validateAccessPolicy(policy);
  return policy;
}

export interface AccessRequest {
  readonly capability: Capability;
  readonly target: OperationTarget;
  /** Capabilities declared for this attempt. Never widened by an approval. */
  readonly envelope: readonly Capability[];
}

export interface AccessDecision {
  /** Allowed *now*, with no approval outstanding. */
  readonly allowed: boolean;
  readonly capability: Capability;
  readonly operation: OperationKind;
  readonly reasonCode: PolicyReasonCode;
  readonly reason: string;
  readonly requiresApproval: boolean;
  readonly riskLevel: RiskLevel;
  readonly target: SafeTarget;
  /** The root, pattern or command that decided it. Absent when nothing matched. */
  readonly matchedRule?: string;
}

/** `example.com` matches `example.com` and `*.example.com`. */
export function hostMatches(pattern: string, host: string): boolean {
  const target = host.toLowerCase();
  const candidate = pattern.toLowerCase();
  if (candidate.startsWith("*.")) {
    const suffix = candidate.slice(2);
    return target.endsWith(`.${suffix}`);
  }
  return target === candidate;
}

export function hostAllowedBy(
  allowedHosts: readonly string[],
  host: string,
): string | undefined {
  return allowedHosts.find((pattern) => hostMatches(pattern, host));
}

function commandMatches(
  patterns: readonly string[],
  command: string,
): string | undefined {
  const basename = safeCommandName(command).toLowerCase();
  return patterns.find(
    (pattern) =>
      matchesPathPattern(pattern, command) ||
      pattern.toLowerCase() === basename ||
      pattern.toLowerCase() === command.toLowerCase(),
  );
}

function variableDenied(
  patterns: readonly string[],
  name: string,
): string | undefined {
  return patterns.find((pattern) =>
    pattern.includes("*")
      ? matchesPathPattern(pattern, name)
      : pattern === name,
  );
}

/**
 * The single deterministic evaluation point.
 *
 * Pure: no clock, no I/O, no provider, no filesystem. That is what makes it
 * testable exhaustively and impossible for an agent to influence. Real-path
 * resolution happens later, in the boundary, and can only ever *narrow* this
 * answer — never widen it.
 */
export function evaluateAccess(
  policy: AccessPolicy,
  request: AccessRequest,
): AccessDecision {
  const capability = request.capability;
  const target = describeTarget(request.target);
  const operation = operationKindForCapability(capability);
  const riskLevel = baselineRiskForCapability(capability);
  const base = {
    capability,
    operation,
    riskLevel,
    target,
    requiresApproval: false,
  } as const;

  const deny = (
    reasonCode: PolicyReasonCode,
    reason: string,
    matchedRule?: string,
  ): AccessDecision => ({
    ...base,
    allowed: false,
    reasonCode,
    reason,
    ...(matchedRule === undefined ? {} : { matchedRule }),
  });

  // The target must be the shape the capability acts on. A `network.connect`
  // carrying a path is not a request this layer will interpret for the caller.
  const expectedKind =
    capability === "process.execute"
      ? "command"
      : capability === "network.connect"
        ? "url"
        : capability === "environment.read"
          ? "variable"
          : "path";
  if (request.target.kind !== expectedKind) {
    return deny(
      "MALFORMED_REQUEST",
      `capability "${capability}" acts on a "${expectedKind}" target, not a "${request.target.kind}"`,
    );
  }

  /**
   * The target must be interpretable before anything else is decided.
   *
   * This function is *total*: a malformed target is a denial, never a thrown error.
   * A traversal, an absolute path or a URL with no host carries no answer about
   * policy — and an evaluation that threw would be one a caller could turn into an
   * unhandled failure instead of a recorded refusal (ADR-046).
   */
  try {
    switch (request.target.kind) {
      case "path":
        assertWorkspaceRef(request.target.ref, "target.ref");
        break;
      case "command":
        assertWorkspaceRef(request.target.command, "target.command");
        break;
      case "url":
        urlTarget(request.target.url, "target.url");
        break;
      case "variable":
        variableTarget(request.target.name, "target.name");
        break;
    }
  } catch {
    return deny(
      "TARGET_REFUSED",
      `the target for capability "${capability}" could not be interpreted`,
    );
  }

  // 1. Absolute denial. Nothing below this line can re-enable it.
  if (policy.capabilities.denied.includes(capability)) {
    return deny(
      "CAPABILITY_DENIED",
      `capability "${capability}" is denied by policy`,
      "policy.capabilities.denied",
    );
  }

  // 2. Declared envelope for this attempt. An approval cannot widen it.
  if (!request.envelope.includes(capability)) {
    return deny(
      "CAPABILITY_NOT_DECLARED",
      `capability "${capability}" is not declared for this attempt`,
    );
  }

  // 3. The project ceiling.
  if (!policy.capabilities.allowed.includes(capability)) {
    return deny(
      "CAPABILITY_DENIED",
      `capability "${capability}" is not allowed by project policy`,
      "policy.capabilities.allowed",
    );
  }

  // 4. Target-level checks.
  switch (request.target.kind) {
    case "path": {
      const ref = request.target.ref;
      if (isSecretShapedPath(ref)) {
        return deny(
          "SECRET_PATH_DENIED",
          `"${ref}" is a credential-shaped path; no capability makes it readable or writable`,
          "secret-shape",
        );
      }
      if (
        candidateDeniedByPattern(policy.filesystem.deniedPatterns, ref) !==
        undefined
      ) {
        return deny(
          "POLICY_DENIED",
          `"${ref}" is denied by policy.filesystem.deniedPatterns`,
          candidateDeniedByPattern(policy.filesystem.deniedPatterns, ref),
        );
      }
      const writing =
        capability === "filesystem.write" || capability === "git.write";
      if (writing && isRuntimeStateRef(ref)) {
        return deny(
          "RUNTIME_STATE_DENIED",
          `"${ref}" is platform runtime state; an operation may not write the log or policy that governs it`,
          "runtime-state",
        );
      }
      const roots = writing
        ? policy.filesystem.writableRoots
        : policy.filesystem.readableRoots;
      const matched = refWithinAnyRoot(ref, roots);
      if (matched === undefined) {
        return deny(
          "RESOURCE_OUTSIDE_BOUNDARY",
          `"${ref}" is outside the permitted ${writing ? "writable" : "readable"} roots`,
        );
      }
      break;
    }
    case "command": {
      const name = request.target.command;
      const deniedBy = commandMatches(policy.process.deniedCommands, name);
      if (deniedBy !== undefined) {
        return deny(
          "POLICY_DENIED",
          `command "${safeCommandName(name)}" is denied by policy`,
          deniedBy,
        );
      }
      const allowedBy = commandMatches(policy.process.allowedCommands, name);
      if (allowedBy === undefined) {
        return deny(
          "TARGET_NOT_ALLOWED",
          `command "${safeCommandName(name)}" is not on policy.process.allowedCommands`,
        );
      }
      break;
    }
    case "url": {
      if (!policy.network.enabled) {
        return deny(
          "POLICY_DENIED",
          "network access is disabled by policy",
          "policy.network.enabled",
        );
      }
      const host = new URL(request.target.url).hostname;
      const allowedBy = hostAllowedBy(policy.network.allowedHosts, host);
      if (allowedBy === undefined) {
        return deny(
          "TARGET_NOT_ALLOWED",
          `host "${host}" is not on policy.network.allowedHosts`,
        );
      }
      break;
    }
    case "variable": {
      const name = request.target.name;
      const deniedBy = variableDenied(policy.environment.deniedPatterns, name);
      if (deniedBy !== undefined) {
        return deny(
          "POLICY_DENIED",
          `environment variable "${name}" is denied by policy`,
          deniedBy,
        );
      }
      if (!policy.environment.allowedVariables.includes(name)) {
        return deny(
          "TARGET_NOT_ALLOWED",
          `environment variable "${name}" is not on policy.environment.allowedVariables`,
        );
      }
      break;
    }
  }

  // 5. Approval is a confirmation step, never an escalation.
  if (policy.capabilities.requireApproval.includes(capability)) {
    return {
      ...base,
      allowed: false,
      requiresApproval: true,
      reasonCode: "APPROVAL_REQUIRED",
      reason: `capability "${capability}" requires human approval`,
      matchedRule: "policy.capabilities.requireApproval",
    };
  }

  return {
    ...base,
    allowed: true,
    reasonCode: "ALLOWED",
    reason: `capability "${capability}" is allowed for this target`,
  };
}

function candidateDeniedByPattern(
  patterns: readonly string[],
  ref: string,
): string | undefined {
  return patterns.find((pattern) => matchesPathPattern(pattern, ref));
}

/** A deterministic, human-readable rendering of the capability ceiling. */
export function describePolicyCapabilities(
  policy: AccessPolicy,
): readonly { readonly capability: Capability; readonly effect: string }[] {
  return CAPABILITIES.map((capability) => {
    const effect = policy.capabilities.denied.includes(capability)
      ? "denied"
      : !policy.capabilities.allowed.includes(capability)
        ? "not-allowed"
        : policy.capabilities.requireApproval.includes(capability)
          ? "approval-required"
          : "allowed";
    return { capability, effect };
  });
}
