import { describe, expect, it } from "vitest";
import {
  createFixedClock,
  createManualClock,
  toIsoString,
} from "../../src/core/clock.js";
import { projectId, workspaceId } from "../../src/core/ids.js";
import {
  type ProjectStatus,
  archiveProject,
  createProject,
  restoreProject,
  validateProject,
} from "../../src/projects/project.js";
import {
  HIGH_CONSEQUENCE_DIMENSIONS,
  ISOLATION_DIMENSIONS,
  type IsolationProfile,
  defaultIsolationProfile,
  isolationFindings,
  isDimensionEnforced,
  unenforcedDimensions,
  validateIsolationProfile,
  withIsolationModes,
} from "../../src/workspaces/isolation.js";
import {
  type WorkspaceStatus,
  assertWorkspaceBelongsToProject,
  createWorkspace,
  isPathWithin,
  isWorkspaceWithinProject,
  setWorkspaceStatus,
  validateWorkspace,
} from "../../src/workspaces/workspace.js";
import { expectDomainError } from "../support/errors.js";

const INSTANT = "2026-09-20T10:00:00.000Z";
const ROOT = "/srv/projects/demo";

function makeProject(
  overrides: Partial<Parameters<typeof createProject>[0]> = {},
  id = "prj-1",
) {
  return createProject(
    { name: "Demo", slug: "demo", rootPath: ROOT, ...overrides },
    { id: projectId(id), clock: createFixedClock(INSTANT) },
  );
}

function makeWorkspace(
  project = makeProject(),
  rootPath = `${ROOT}/ws-1`,
  options: { allowOutsideProject?: boolean } = {},
) {
  return createWorkspace(
    { name: "ws-1", rootPath },
    {
      id: workspaceId("wsp-1"),
      project,
      clock: createFixedClock(INSTANT),
      ...options,
    },
  );
}

describe("createProject", () => {
  it("derives an active project with a stable identity", () => {
    const project = makeProject();
    expect(project).toEqual({
      id: "prj-1",
      name: "Demo",
      slug: "demo",
      rootPath: ROOT,
      status: "active",
      createdAt: INSTANT,
      updatedAt: INSTANT,
    });
    expect(() => validateProject(project)).not.toThrow();
  });

  it("rejects slugs that are not filesystem and url safe", () => {
    for (const slug of ["Demo", "1demo", "demo_api", "demo api", "-demo", ""]) {
      expectDomainError(() => makeProject({ slug }), "VALIDATION");
    }
  });

  it("requires an absolute, non-traversing project root", () => {
    expectDomainError(
      () => makeProject({ rootPath: "relative/demo" }),
      "VALIDATION",
    );
    expectDomainError(
      () => makeProject({ rootPath: "/srv/../etc" }),
      "VALIDATION",
    );
  });

  it("rejects an unknown status", () => {
    expectDomainError(
      () => makeProject({ status: "deleted" as unknown as ProjectStatus }),
      "VALIDATION",
    );
  });
});

describe("project lifecycle", () => {
  it("archives without losing the record and bumps updatedAt", () => {
    const clock = createManualClock(INSTANT);
    const project = createProject(
      { name: "Demo", slug: "demo", rootPath: ROOT },
      { id: projectId("prj-1"), clock },
    );
    clock.advance(60_000);
    const archived = archiveProject(project, clock);
    expect(archived.status).toBe("archived");
    expect(archived.createdAt).toBe(project.createdAt);
    expect(toIsoString(clock.now())).toBe(archived.updatedAt);
    expect(archived.updatedAt).not.toBe(project.updatedAt);
  });

  it("is idempotent", () => {
    const clock = createFixedClock(INSTANT);
    const archived = archiveProject(makeProject(), clock);
    expect(archiveProject(archived, clock)).toBe(archived);
    const active = restoreProject(makeProject(), clock);
    expect(restoreProject(active, clock)).toBe(active);
  });

  it("restores an archived project", () => {
    const clock = createFixedClock(INSTANT);
    expect(
      restoreProject(archiveProject(makeProject(), clock), clock).status,
    ).toBe("active");
  });

  it("detects a project whose timestamps went backwards", () => {
    const project = makeProject();
    expectDomainError(
      () =>
        validateProject({ ...project, updatedAt: "2026-09-19T00:00:00.000Z" }),
      "INVARIANT",
    );
  });
});

describe("isolation profile", () => {
  it("covers every isolation dimension", () => {
    const profile = defaultIsolationProfile();
    expect(Object.keys(profile).sort()).toEqual(
      [...ISOLATION_DIMENSIONS].sort(),
    );
  });

  it("is isolated by default, not permissive", () => {
    const profile = defaultIsolationProfile();
    expect(profile.network.mode).toBe("none");
    expect(profile.filesystem.mode).toBe("scoped");
    expect(profile.secrets.mode).toBe("scoped");
    expect(profile.processes.mode).toBe("process");
    expect(profile.resourceLimits.mode).toBe("scoped");
  });

  it("declares enforcement honestly rather than claiming it", () => {
    const profile = defaultIsolationProfile();
    expect(isDimensionEnforced(profile, "filesystem")).toBe(false);
    expect(unenforcedDimensions(profile)).toHaveLength(
      ISOLATION_DIMENSIONS.length,
    );
  });

  it("reports high-consequence dimensions that are not enforced", () => {
    const findings = isolationFindings(defaultIsolationProfile());
    expect(findings).toHaveLength(HIGH_CONSEQUENCE_DIMENSIONS.length);
    for (const finding of findings) {
      expect(finding).toContain("not independently enforced");
    }
    expect(findings.join("\n")).toContain("secrets");
    expect(findings.join("\n")).toContain("network");
  });

  it("stops reporting a finding once a dimension is enforced", () => {
    const profile: IsolationProfile = {
      ...defaultIsolationProfile(),
      secrets: { mode: "container", enforcement: "enforced" },
    };
    expect(isDimensionEnforced(profile, "secrets")).toBe(true);
    expect(isolationFindings(profile).join("\n")).not.toContain("secrets:");
    expect(isolationFindings(profile)).toHaveLength(
      HIGH_CONSEQUENCE_DIMENSIONS.length - 1,
    );
  });

  it("overrides modes without claiming enforcement", () => {
    const base = defaultIsolationProfile();
    const updated = withIsolationModes(base, {
      network: "container",
      filesystem: "container",
    });
    expect(updated.network.mode).toBe("container");
    expect(updated.network.enforcement).toBe("declared");
    expect(updated.filesystem.mode).toBe("container");
    expect(base.network.mode).toBe("none");
  });

  it("rejects malformed profiles", () => {
    const profile = defaultIsolationProfile();
    expectDomainError(
      () =>
        validateIsolationProfile({
          ...profile,
          network: { mode: "airgap" } as unknown as (typeof profile)["network"],
        }),
      "VALIDATION",
    );
    expectDomainError(
      () =>
        validateIsolationProfile({
          ...profile,
          secrets: undefined,
        } as unknown as IsolationProfile),
      "VALIDATION",
    );
  });
});

describe("workspace", () => {
  it("is created provisioning, inside its project, with the default isolation", () => {
    const workspace = makeWorkspace();
    expect(workspace.projectId).toBe("prj-1");
    expect(workspace.status).toBe("provisioning");
    expect(workspace.isolation).toEqual(defaultIsolationProfile());
    expect(() => validateWorkspace(workspace)).not.toThrow();
  });

  it("refuses to escape the project root by default", () => {
    expectDomainError(
      () => makeWorkspace(makeProject(), "/srv/projects/other"),
      "INVARIANT",
    );
  });

  it("allows an outside root only with an explicit allowance", () => {
    expect(
      makeWorkspace(makeProject(), "/srv/projects/other", {
        allowOutsideProject: true,
      }).rootPath,
    ).toBe("/srv/projects/other");
  });

  it("checks containment without prefix false positives", () => {
    expect(isPathWithin(ROOT, `${ROOT}/ws-1`)).toBe(true);
    expect(isPathWithin(ROOT, ROOT)).toBe(true);
    expect(isPathWithin(ROOT, "/srv/projects/demo-evil")).toBe(false);
    expect(isPathWithin(ROOT, "/srv/projects")).toBe(false);
  });

  it("reports containment for a workspace", () => {
    const project = makeProject();
    expect(isWorkspaceWithinProject(makeWorkspace(project), project)).toBe(
      true,
    );
    expect(
      isWorkspaceWithinProject(
        makeWorkspace(project, "/srv/projects/other", {
          allowOutsideProject: true,
        }),
        project,
      ),
    ).toBe(false);
  });

  it("refuses a workspace from a different project", () => {
    const project = makeProject();
    const other = makeProject({}, "prj-2");
    expect(() =>
      assertWorkspaceBelongsToProject(makeWorkspace(project), project),
    ).not.toThrow();
    expectDomainError(
      () => assertWorkspaceBelongsToProject(makeWorkspace(project), other),
      "INVARIANT",
    );
  });

  it("changes status idempotently", () => {
    const clock = createManualClock(INSTANT);
    const workspace = makeWorkspace();
    clock.advance(1000);
    const ready = setWorkspaceStatus(workspace, "ready", clock);
    expect(ready.status).toBe("ready");
    expect(ready.updatedAt).not.toBe(workspace.updatedAt);
    expect(setWorkspaceStatus(ready, "ready", clock)).toBe(ready);
  });

  it("treats archived as terminal", () => {
    const clock = createFixedClock(INSTANT);
    const archived = setWorkspaceStatus(makeWorkspace(), "archived", clock);
    expectDomainError(
      () => setWorkspaceStatus(archived, "ready", clock),
      "INVARIANT",
    );
  });

  it("rejects an unknown status", () => {
    expectDomainError(
      () =>
        setWorkspaceStatus(
          makeWorkspace(),
          "broken" as unknown as WorkspaceStatus,
          createFixedClock(INSTANT),
        ),
      "VALIDATION",
    );
  });

  it("detects a workspace whose timestamps went backwards", () => {
    const workspace = makeWorkspace();
    expectDomainError(
      () =>
        validateWorkspace({
          ...workspace,
          updatedAt: "2026-09-19T00:00:00.000Z",
        }),
      "INVARIANT",
    );
  });
});
