import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hasDomainErrorCode } from "../../src/core/errors.js";
import { projectId, workspaceId } from "../../src/core/ids.js";
import type { TaskId } from "../../src/core/ids.js";
import { createFileTaskRepository } from "../../src/adapters/storage/file-task-repository.js";
import { createTestProject, type TestProject } from "../support/project.js";

/**
 * The task repository is a projection, not the source of truth, but it is the
 * projection the CLI reads without touching the event log, so its version guard
 * and its scope checks are load-bearing.
 */
const projects: TestProject[] = [];

async function project(): Promise<TestProject> {
  const created = await createTestProject();
  projects.push(created);
  return created;
}

function recordPath(root: string, workspace: string, task: TaskId): string {
  return join(root, ".ai", "runtime", "tasks", workspace, `${task}.json`);
}

afterEach(async () => {
  while (projects.length > 0) {
    await projects.pop()?.cleanup();
  }
});

describe("file task repository: records and versions", () => {
  it("creates a record at version 1 and reads it back", async () => {
    const { runtime, root } = await project();
    const scope = {
      projectId: runtime.project.id,
      workspaceId: runtime.workspace.id,
    };
    const stored = await runtime.tasks.create(
      { title: "Add validation", description: "Reject invalid input" },
      { project: runtime.project, workspace: runtime.workspace },
    );

    expect(stored.version).toBe(1);
    expect(stored.task.status).toBe("created");

    const found = await runtime.repository.find(scope, stored.task.id);
    expect(found?.version).toBe(1);
    expect(found?.task.title).toBe("Add validation");

    const raw = JSON.parse(
      await readFile(
        recordPath(root, runtime.workspace.id, stored.task.id),
        "utf8",
      ),
    );
    expect(raw.schemaVersion).toBe(1);
    expect(raw.version).toBe(1);
  });

  it("increments the version on each lifecycle transition", async () => {
    const { runtime } = await project();
    const scope = {
      projectId: runtime.project.id,
      workspaceId: runtime.workspace.id,
    };
    let stored = await runtime.tasks.create(
      { title: "Task", description: "Description" },
      { project: runtime.project, workspace: runtime.workspace },
    );
    for (const status of [
      "planning",
      "in_progress",
      "verification",
      "review",
    ] as const) {
      stored = await runtime.tasks.transition(stored, status);
    }
    expect(stored.version).toBe(5);
    expect(
      (await runtime.repository.find(scope, stored.task.id))?.task.status,
    ).toBe("review");
  });

  it("rejects a stale write instead of overwriting", async () => {
    const { runtime } = await project();
    const scope = {
      projectId: runtime.project.id,
      workspaceId: runtime.workspace.id,
    };
    const stored = await runtime.tasks.create(
      { title: "Task", description: "Description" },
      { project: runtime.project, workspace: runtime.workspace },
    );
    const advanced = await runtime.tasks.transition(stored, "planning");

    // A second writer holding the original version must not clobber the first.
    await expect(
      runtime.repository.save(
        scope,
        { ...stored.task, status: "cancelled" },
        {
          expectedVersion: stored.version,
        },
      ),
    ).rejects.toSatisfy((error) => hasDomainErrorCode(error, "CONFLICT"));
    expect(
      (await runtime.repository.find(scope, advanced.task.id))?.task.status,
    ).toBe("planning");
  });

  it("rejects a create over an existing record and an update of a missing one", async () => {
    const { runtime } = await project();
    const scope = {
      projectId: runtime.project.id,
      workspaceId: runtime.workspace.id,
    };
    const stored = await runtime.tasks.create(
      { title: "Task", description: "Description" },
      { project: runtime.project, workspace: runtime.workspace },
    );

    await expect(
      runtime.repository.save(scope, stored.task, {
        expectedVersion: undefined,
      }),
    ).rejects.toSatisfy((error) => hasDomainErrorCode(error, "CONFLICT"));

    await expect(
      runtime.repository.save(scope, stored.task, { expectedVersion: 3 }),
    ).rejects.toSatisfy((error) => hasDomainErrorCode(error, "CONFLICT"));
  });

  it("leaves no temporary file behind", async () => {
    const { runtime, root } = await project();
    const stored = await runtime.tasks.create(
      { title: "Task", description: "Description" },
      { project: runtime.project, workspace: runtime.workspace },
    );
    const files = await readdir(
      join(root, ".ai", "runtime", "tasks", runtime.workspace.id),
    );
    expect(files).toEqual([`${stored.task.id}.json`]);
  });

  it("lists every record in the scope, ordered by task id", async () => {
    const { runtime } = await project();
    const scope = { projectId: runtime.project.id };
    const created: TaskId[] = [];
    for (const title of ["A", "B", "C"]) {
      const stored = await runtime.tasks.create(
        { title, description: `Description of ${title}` },
        { project: runtime.project, workspace: runtime.workspace },
      );
      created.push(stored.task.id);
    }
    const listed = await runtime.repository.list(scope);
    // Ordering is by id, which is what makes listings stable across runs even
    // though ids are generated.
    expect(listed.map((entry) => entry.task.id)).toEqual([...created].sort());
    expect(listed.map((entry) => entry.task.title).sort()).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
});

describe("file task repository: untrusted records", () => {
  it("rejects a hand-edited record that is not valid JSON", async () => {
    const { runtime, root } = await project();
    const stored = await runtime.tasks.create(
      { title: "Task", description: "Description" },
      { project: runtime.project, workspace: runtime.workspace },
    );
    await writeFile(
      recordPath(root, runtime.workspace.id, stored.task.id),
      "{ not json",
      "utf8",
    );
    await expect(
      runtime.repository.find(
        { projectId: runtime.project.id },
        stored.task.id,
      ),
    ).rejects.toSatisfy((error) => hasDomainErrorCode(error, "VALIDATION"));
  });

  it("rejects a hand-edited record carrying an invalid task", async () => {
    const { runtime, root } = await project();
    const stored = await runtime.tasks.create(
      { title: "Task", description: "Description" },
      { project: runtime.project, workspace: runtime.workspace },
    );
    const path = recordPath(root, runtime.workspace.id, stored.task.id);
    const record = JSON.parse(await readFile(path, "utf8"));
    record.task.status = "almost-done";
    await writeFile(path, JSON.stringify(record), "utf8");

    await expect(
      runtime.repository.find(
        { projectId: runtime.project.id },
        stored.task.id,
      ),
    ).rejects.toSatisfy((error) => hasDomainErrorCode(error, "VALIDATION"));
  });

  it("rejects a record whose task belongs to another project", async () => {
    const { runtime, root } = await project();
    const stored = await runtime.tasks.create(
      { title: "Task", description: "Description" },
      { project: runtime.project, workspace: runtime.workspace },
    );
    const path = recordPath(root, runtime.workspace.id, stored.task.id);
    const record = JSON.parse(await readFile(path, "utf8"));
    record.task.projectId = "prj-elsewhere";
    await writeFile(path, JSON.stringify(record), "utf8");

    await expect(
      runtime.repository.find(
        { projectId: runtime.project.id },
        stored.task.id,
      ),
    ).rejects.toSatisfy((error) => hasDomainErrorCode(error, "INVARIANT"));
  });

  it("rejects an unsupported record schema version", async () => {
    const { runtime, root } = await project();
    const stored = await runtime.tasks.create(
      { title: "Task", description: "Description" },
      { project: runtime.project, workspace: runtime.workspace },
    );
    const path = recordPath(root, runtime.workspace.id, stored.task.id);
    const record = JSON.parse(await readFile(path, "utf8"));
    record.schemaVersion = 99;
    await writeFile(path, JSON.stringify(record), "utf8");

    await expect(
      runtime.repository.find(
        { projectId: runtime.project.id },
        stored.task.id,
      ),
    ).rejects.toSatisfy((error) => hasDomainErrorCode(error, "VALIDATION"));
  });
});

describe("file task repository: project and workspace isolation", () => {
  it("refuses a scope for another project", async () => {
    const { runtime } = await project();
    const stored = await runtime.tasks.create(
      { title: "Task", description: "Description" },
      { project: runtime.project, workspace: runtime.workspace },
    );

    await expect(
      runtime.repository.find(
        { projectId: projectId("prj-other") },
        stored.task.id,
      ),
    ).rejects.toSatisfy((error) => hasDomainErrorCode(error, "FORBIDDEN"));

    await expect(
      runtime.repository.save(
        {
          projectId: projectId("prj-other"),
          workspaceId: runtime.workspace.id,
        },
        stored.task,
        { expectedVersion: undefined },
      ),
    ).rejects.toSatisfy((error) => hasDomainErrorCode(error, "FORBIDDEN"));
  });

  it("does not reach another project's records even on the same disk", async () => {
    const first = await project();
    const second = await project();
    const stored = await first.runtime.tasks.create(
      { title: "Task in A", description: "Description" },
      { project: first.runtime.project, workspace: first.runtime.workspace },
    );

    const secondStore = createFileTaskRepository({
      projectRoot: second.root,
      projectId: second.runtime.project.id,
      knownWorkspaceIds: [second.runtime.workspace.id],
    });
    expect(
      await secondStore.find(
        { projectId: second.runtime.project.id },
        stored.task.id,
      ),
      // Task ids are not authorization: the id exists, but not in this project.
    ).toBeUndefined();
  });

  it("does not find a task through a different workspace of the same project", async () => {
    const { runtime, root } = await project();
    const stored = await runtime.tasks.create(
      { title: "Task", description: "Description" },
      { project: runtime.project, workspace: runtime.workspace },
    );
    const otherWorkspace = workspaceId("wsp-elsewhere");
    const scoped = createFileTaskRepository({
      projectRoot: root,
      projectId: runtime.project.id,
      knownWorkspaceIds: [runtime.workspace.id, otherWorkspace],
    });

    expect(
      await scoped.find(
        { projectId: runtime.project.id, workspaceId: otherWorkspace },
        stored.task.id,
      ),
    ).toBeUndefined();
    // Project-wide reads do find it: the project is the isolation boundary.
    expect(
      (await scoped.find({ projectId: runtime.project.id }, stored.task.id))
        ?.task.title,
    ).toBe("Task");
  });

  it("refuses a workspace that is not part of the project", async () => {
    const { runtime } = await project();
    await expect(
      runtime.repository.list({
        projectId: runtime.project.id,
        workspaceId: workspaceId("wsp-not-configured"),
      }),
    ).rejects.toSatisfy((error) => hasDomainErrorCode(error, "FORBIDDEN"));
  });

  it("rejects a task id that is not usable as a filename component", async () => {
    const { runtime } = await project();
    await expect(
      runtime.repository.find(
        { projectId: runtime.project.id },
        "../../escape" as TaskId,
      ),
    ).rejects.toSatisfy(
      (error) =>
        hasDomainErrorCode(error, "VALIDATION") ||
        hasDomainErrorCode(error, "FORBIDDEN"),
    );
  });
});
