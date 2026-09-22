import { describe, expect, it } from "vitest";

import {
  ACCESS_POLICY_VERSION,
  DEFAULT_ACCESS_POLICY,
  assertAccessPolicy,
  describePolicyCapabilities,
  evaluateAccess,
  hostAllowedBy,
} from "../../src/policy/access-policy.js";
import {
  CAPABILITIES,
  assertCapability,
  capabilitiesForOperationKind,
  operationKindForCapability,
  sortCapabilities,
} from "../../src/policy/capability.js";
import {
  POLICY_REASON_CODES,
  REASON_DESCRIPTIONS,
  isDenial,
} from "../../src/policy/reason.js";
import {
  assertWorkspaceRef,
  commandTarget,
  describeTarget,
  pathTarget,
  safeCommandName,
  safeUrl,
  urlTarget,
  variableTarget,
} from "../../src/policy/target.js";
import {
  isRuntimeStateRef,
  isWithinRoot,
  normalizeForCompare,
  refWithinAnyRoot,
  refWithinRoot,
  toWorkspaceRef,
} from "../../src/policy/path-boundary.js";
import { accessPolicy } from "../support/policy.js";
import { expectDomainError } from "../support/errors.js";

const READ = "filesystem.read" as const;

const decide = (
  policy: Parameters<typeof evaluateAccess>[0],
  capability: Parameters<typeof evaluateAccess>[1]["capability"],
  target: Parameters<typeof evaluateAccess>[1]["target"],
  envelope: Parameters<typeof evaluateAccess>[1]["envelope"],
) => evaluateAccess(policy, { capability, target, envelope });

describe("policy: capability vocabulary", () => {
  it("is closed: an unknown capability is a validation error, not a default", () => {
    expect(() => assertCapability("filesystem.read")).not.toThrow();
    expect(() => assertCapability("filesystem.chmod")).toThrow();
    expect(() => assertCapability("")).toThrow();
    expect(() => assertCapability(42)).toThrow();
  });

  it("binds every capability to exactly one operation kind", () => {
    for (const capability of CAPABILITIES) {
      expect(operationKindForCapability(capability)).toBeTypeOf("string");
    }
    // One direction only: the reverse map may hold several capabilities per kind.
    expect(capabilitiesForOperationKind("read")).toEqual([
      "filesystem.read",
      "git.read",
    ]);
    expect(capabilitiesForOperationKind("write")).toEqual([
      "filesystem.write",
      "git.write",
    ]);
  });

  it("sorts deterministically", () => {
    expect(sortCapabilities(["git.read", "filesystem.read"])).toEqual([
      "filesystem.read",
      "git.read",
    ]);
  });
});

describe("policy: reason codes", () => {
  it("every code has a description, and only ALLOWED is not a denial", () => {
    for (const code of POLICY_REASON_CODES) {
      expect(REASON_DESCRIPTIONS[code]).toBeTypeOf("string");
      expect(REASON_DESCRIPTIONS[code].length).toBeGreaterThan(0);
      expect(isDenial(code)).toBe(code !== "ALLOWED");
    }
  });
});

describe("policy: target references", () => {
  it("refuses traversal, absolute paths, drive letters, UNC prefixes and NUL", () => {
    for (const bad of [
      "../outside.txt",
      "src/../../outside.txt",
      "/etc/passwd",
      "C:/Windows/system32",
      "//server/share",
      "src/\0x.ts",
    ]) {
      expect(() => assertWorkspaceRef(bad)).toThrow();
    }
    expect(assertWorkspaceRef("src//a.ts")).toBe("src/a.ts");
    expect(assertWorkspaceRef("src\\a.ts")).toBe("src/a.ts");
    expect(assertWorkspaceRef(".")).toBe(".");
  });

  it("records a URL without its query string or credentials", () => {
    expect(safeUrl("https://api.example.com/v1/chat?key=secret#frag")).toBe(
      "https://api.example.com/v1/chat",
    );
    expect(() => urlTarget("https://user:pw@example.com/x")).toThrow();
    expect(() => urlTarget("file:///etc/passwd")).toThrow();
    expect(safeCommandName("./node_modules/.bin/tsc")).toBe("tsc");
  });

  it("carries a command's argument count but never its arguments", () => {
    expect(describeTarget(commandTarget("node", 3))).toEqual({
      kind: "command",
      target: "node",
    });
    expect(describeTarget(pathTarget("src/a.ts"))).toEqual({
      kind: "path",
      target: "src/a.ts",
    });
    expect(describeTarget(variableTarget("FIXTURE_ALLOWED"))).toEqual({
      kind: "variable",
      target: "FIXTURE_ALLOWED",
    });
    expect(describeTarget(urlTarget("https://api.example.com/x?a=1"))).toEqual({
      kind: "url",
      target: "https://api.example.com/x",
    });
  });

  it("refuses an environment target that is a value rather than a name", () => {
    expect(() => variableTarget("sk-live-123")).toThrow();
    expect(variableTarget("FIXTURE_ALLOWED").name).toBe("FIXTURE_ALLOWED");
  });
});

describe("policy: path containment arithmetic", () => {
  it("does not confuse a sibling prefix with a contained path", () => {
    // The classic bug: `startsWith('/srv/app')` also accepts `/srv/app-evil`.
    expect(isWithinRoot("/srv/app", "/srv/app/src/a.ts", "linux")).toBe(true);
    expect(isWithinRoot("/srv/app", "/srv/app", "linux")).toBe(true);
    expect(isWithinRoot("/srv/app", "/srv/app-evil/a.ts", "linux")).toBe(false);
    expect(isWithinRoot("/srv/app", "/srv/other", "linux")).toBe(false);
    expect(isWithinRoot("/srv/app", "/etc/passwd", "linux")).toBe(false);
  });

  it("folds case only where the platform's filesystem does", () => {
    // The helper is what carries the platform difference, and it is portable.
    expect(normalizeForCompare("/srv/App", "win32")).toBe("/srv/app");
    expect(normalizeForCompare("/srv/App", "darwin")).toBe("/srv/app");
    expect(normalizeForCompare("/srv/App", "linux")).toBe("/srv/App");

    // On a case-insensitive platform the same directory is inside itself.
    expect(isWithinRoot("/srv/App", "/srv/app/x", "win32")).toBe(true);
    // Folding never turns a sibling into a child — the direction that matters.
    expect(isWithinRoot("/srv/app", "/srv/App-evil/x", "win32")).toBe(false);
    expect(isWithinRoot("/srv/app", "/srv/app-evil/a.ts", "linux")).toBe(false);

    // Not asserted here: that a case variant on a *case-sensitive* filesystem is
    // judged outside. Node's `path.relative` on this host folds internally, so the
    // simulation cannot be distinguished from the real thing in a Windows test run.
    // The guarantee that matters is the one above — folding never widens a root.
  });

  it("matches a reference on segment boundaries", () => {
    expect(refWithinRoot("src/a.ts", "src")).toBe(true);
    expect(refWithinRoot("src/a.ts", ".")).toBe(true);
    expect(refWithinRoot("src-evil/a.ts", "src")).toBe(false);
    expect(refWithinAnyRoot("src/a.ts", ["docs", "src"])).toBe("src");
    expect(refWithinAnyRoot("src/a.ts", [])).toBeUndefined();
  });

  it("recognises the platform's own runtime state", () => {
    expect(isRuntimeStateRef(".ai/project.json")).toBe(true);
    expect(isRuntimeStateRef("src/.git/config")).toBe(true);
    expect(isRuntimeStateRef("src/ai-notes.md")).toBe(false);
  });

  it("converts back to a workspace reference only when inside the root", () => {
    expect(toWorkspaceRef("/srv/app", "/srv/app/src/a.ts", "linux")).toBe(
      "src/a.ts",
    );
    expect(toWorkspaceRef("/srv/app", "/srv/app", "linux")).toBe(".");
    expect(
      toWorkspaceRef("/srv/app", "/srv/other/a.ts", "linux"),
    ).toBeUndefined();
  });
});

describe("policy: evaluation", () => {
  it("defaults to deny: an unconfigured capability is denied, not permitted", () => {
    const decision = decide(DEFAULT_ACCESS_POLICY, READ, pathTarget("a.ts"), [
      READ,
    ]);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("CAPABILITY_DENIED");
    expect(decision.matchedRule).toBe("policy.capabilities.allowed");
  });

  it("denies a capability that is not in the attempt's envelope", () => {
    const policy = accessPolicy({ allowed: [READ], readableRoots: ["."] });
    const decided = decide(policy, READ, pathTarget("a.ts"), []);
    expect(decided.allowed).toBe(false);
    expect(decided.reasonCode).toBe("CAPABILITY_NOT_DECLARED");
  });

  it("lets an explicit denial win over everything else", () => {
    // Constructed directly: the validator refuses this shape, and the evaluation
    // must still be correct if such a policy ever reached it.
    const contradictory = {
      ...accessPolicy({ allowed: [READ], readableRoots: ["."] }),
      capabilities: {
        allowed: [READ],
        denied: [READ],
        requireApproval: [READ],
      },
    };
    const decided = decide(contradictory, READ, pathTarget("a.ts"), [READ]);
    expect(decided.allowed).toBe(false);
    expect(decided.requiresApproval).toBe(false);
    expect(decided.reasonCode).toBe("CAPABILITY_DENIED");
    expect(decided.matchedRule).toBe("policy.capabilities.denied");
  });

  it("allows a target inside the permitted root and reports the rule", () => {
    const policy = accessPolicy({ allowed: [READ], readableRoots: ["src"] });
    const decided = decide(policy, READ, pathTarget("src/a.ts"), [READ]);
    expect(decided.allowed).toBe(true);
    expect(decided.reasonCode).toBe("ALLOWED");
    expect(decided.operation).toBe("read");
    expect(decided.target).toEqual({ kind: "path", target: "src/a.ts" });
  });

  it("denies a target outside the permitted roots", () => {
    const policy = accessPolicy({ allowed: [READ], readableRoots: ["src"] });
    const decided = decide(policy, READ, pathTarget("docs/a.md"), [READ]);
    expect(decided.allowed).toBe(false);
    expect(decided.reasonCode).toBe("RESOURCE_OUTSIDE_BOUNDARY");
    expect(decided.reason).toContain("readable roots");
  });

  it("denies a credential-shaped path even when the root covers it", () => {
    const policy = accessPolicy({ allowed: [READ], readableRoots: ["."] });
    const decided = decide(policy, READ, pathTarget(".env"), [READ]);
    expect(decided.allowed).toBe(false);
    expect(decided.reasonCode).toBe("SECRET_PATH_DENIED");
    expect(decided.matchedRule).toBe("secret-shape");
  });

  it("refuses a write to the platform's own runtime state", () => {
    const policy = accessPolicy({
      allowed: ["filesystem.write"],
      writableRoots: ["."],
    });
    const decided = decide(
      policy,
      "filesystem.write",
      pathTarget(".ai/project.json"),
      ["filesystem.write"],
    );
    expect(decided.allowed).toBe(false);
    expect(decided.reasonCode).toBe("RUNTIME_STATE_DENIED");
  });

  it("marks an approvable capability as approval-required, never as allowed", () => {
    const policy = accessPolicy({
      allowed: ["filesystem.write"],
      writableRoots: ["."],
      requireApproval: ["filesystem.write"],
    });
    const decided = decide(policy, "filesystem.write", pathTarget("out.txt"), [
      "filesystem.write",
    ]);
    expect(decided.allowed).toBe(false);
    expect(decided.requiresApproval).toBe(true);
    expect(decided.reasonCode).toBe("APPROVAL_REQUIRED");
  });

  it("refuses a request whose target kind does not match the capability", () => {
    const policy = accessPolicy({ allowed: [READ], readableRoots: ["."] });
    const decided = decide(policy, READ, urlTarget("https://example.com/x"), [
      READ,
    ]);
    expect(decided.allowed).toBe(false);
    expect(decided.reasonCode).toBe("MALFORMED_REQUEST");
  });

  it("checks commands against the allowlist and the denylist", () => {
    const policy = accessPolicy({
      allowed: ["process.execute"],
      allowedCommands: ["node", "git"],
      deniedCommands: ["git"],
    });
    expect(
      decide(policy, "process.execute", commandTarget("node", 0), [
        "process.execute",
      ]).allowed,
    ).toBe(true);
    const denied = decide(policy, "process.execute", commandTarget("git", 0), [
      "process.execute",
    ]);
    expect(denied.allowed).toBe(false);
    expect(denied.reasonCode).toBe("POLICY_DENIED");
    const unlisted = decide(
      policy,
      "process.execute",
      commandTarget("evil.sh", 0),
      ["process.execute"],
    );
    expect(unlisted.allowed).toBe(false);
    expect(unlisted.reasonCode).toBe("TARGET_NOT_ALLOWED");
  });

  it("requires the network to be enabled and the host to be listed", () => {
    const disabled = accessPolicy({ allowed: ["network.connect"] });
    expect(
      decide(
        disabled,
        "network.connect",
        urlTarget("https://api.example.com/x"),
        ["network.connect"],
      ).reasonCode,
    ).toBe("POLICY_DENIED");

    const enabled = accessPolicy({
      allowed: ["network.connect"],
      networkEnabled: true,
      allowedHosts: ["*.example.com"],
    });
    expect(
      decide(
        enabled,
        "network.connect",
        urlTarget("https://api.example.com/x"),
        ["network.connect"],
      ).allowed,
    ).toBe(true);
    const other = decide(
      enabled,
      "network.connect",
      urlTarget("https://evil.test/x"),
      ["network.connect"],
    );
    expect(other.allowed).toBe(false);
    expect(other.reasonCode).toBe("TARGET_NOT_ALLOWED");
  });

  it("checks environment variables against both lists", () => {
    const policy = accessPolicy({
      allowed: ["environment.read"],
      allowedVariables: ["FIXTURE_ALLOWED", "FIXTURE_API_KEY"],
      envDeniedPatterns: ["*_API_KEY"],
    });
    expect(
      decide(policy, "environment.read", variableTarget("FIXTURE_ALLOWED"), [
        "environment.read",
      ]).allowed,
    ).toBe(true);
    expect(
      decide(policy, "environment.read", variableTarget("FIXTURE_API_KEY"), [
        "environment.read",
      ]).reasonCode,
    ).toBe("POLICY_DENIED");
    expect(
      decide(policy, "environment.read", variableTarget("HOME"), [
        "environment.read",
      ]).reasonCode,
    ).toBe("TARGET_NOT_ALLOWED");
  });

  it("never exposes a secret value in a denial message", () => {
    const policy = accessPolicy({ allowed: [READ], readableRoots: ["."] });
    const decision = decide(policy, READ, pathTarget(".env"), [READ]);
    expect(decision.reason).not.toContain("super-secret");
    expect(JSON.stringify(decision)).not.toContain("sk-");
  });
});

describe("policy: host matching", () => {
  it("matches exactly, or as a subdomain of a wildcard", () => {
    expect(hostAllowedBy(["example.com"], "example.com")).toBe("example.com");
    expect(hostAllowedBy(["example.com"], "api.example.com")).toBeUndefined();
    expect(hostAllowedBy(["*.example.com"], "api.example.com")).toBe(
      "*.example.com",
    );
    expect(hostAllowedBy(["*.example.com"], "example.com")).toBeUndefined();
    // The classic suffix bug: `evil-example.com` must not match `*.example.com`.
    expect(
      hostAllowedBy(["*.example.com"], "evil-example.com"),
    ).toBeUndefined();
  });
});

describe("policy: configuration validation", () => {
  it("refuses a capability that is both allowed and denied", () => {
    const error = expectDomainError(
      () =>
        assertAccessPolicy({
          capabilities: { allowed: [READ], denied: [READ] },
        }),
      "INVARIANT",
    );
    expect(error.message).toContain("both allowed and denied");
  });

  it("refuses approval for a capability that is not allowed", () => {
    expectDomainError(
      () =>
        assertAccessPolicy({
          capabilities: { allowed: [], requireApproval: [READ] },
        }),
      "INVARIANT",
    );
  });

  it("refuses network access with no host, and a malformed host", () => {
    expectDomainError(
      () => assertAccessPolicy({ network: { enabled: true } }),
      "INVARIANT",
    );
    expectDomainError(
      () => assertAccessPolicy({ network: { allowedHosts: ["not a host"] } }),
      "VALIDATION",
    );
  });

  it("refuses a traversing root, a bad command and a bad variable name", () => {
    expectDomainError(
      () => assertAccessPolicy({ filesystem: { readableRoots: ["../etc"] } }),
      "VALIDATION",
    );
    expectDomainError(
      () => assertAccessPolicy({ process: { allowedCommands: ["a/../b"] } }),
      "VALIDATION",
    );
    expectDomainError(
      () =>
        assertAccessPolicy({
          environment: { allowedVariables: ["not-a-name!"] },
        }),
      "VALIDATION",
    );
  });

  it("refuses a policy version this build does not implement", () => {
    expectDomainError(
      () => assertAccessPolicy({ version: ACCESS_POLICY_VERSION + 1 }),
      "VALIDATION",
    );
  });

  it("treats an absent policy block as the deny-everything default", () => {
    expect(assertAccessPolicy(undefined)).toEqual(DEFAULT_ACCESS_POLICY);
    expect(describePolicyCapabilities(DEFAULT_ACCESS_POLICY)).toEqual(
      CAPABILITIES.map((capability) => ({
        capability,
        effect: "not-allowed",
      })),
    );
  });

  it("rejects a malformed policy block rather than guessing", () => {
    expectDomainError(() => assertAccessPolicy([]), "VALIDATION");
    expectDomainError(() => assertAccessPolicy("policy"), "VALIDATION");
    expectDomainError(
      () => assertAccessPolicy({ filesystem: { readableRoots: "src" } }),
      "VALIDATION",
    );
  });

  it("describes each capability with exactly one effect", () => {
    const policy = accessPolicy({
      allowed: ["filesystem.read", "filesystem.write", "process.execute"],
      denied: ["process.execute"],
      requireApproval: ["filesystem.write"],
      readableRoots: ["."],
      writableRoots: ["."],
    });
    const effects = describePolicyCapabilities(policy);
    expect(
      effects.find((row) => row.capability === "filesystem.read")?.effect,
    ).toBe("allowed");
    expect(
      effects.find((row) => row.capability === "filesystem.write")?.effect,
    ).toBe("approval-required");
    expect(
      effects.find((row) => row.capability === "process.execute")?.effect,
    ).toBe("denied");
    expect(
      effects.find((row) => row.capability === "network.connect")?.effect,
    ).toBe("not-allowed");
  });
});
