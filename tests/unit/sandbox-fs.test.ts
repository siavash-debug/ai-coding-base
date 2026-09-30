import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSandboxFixture,
  readWritePolicy,
  symlinksAvailable,
  type SandboxFixture,
} from "../support/policy.js";
import { accessPolicy } from "../support/policy.js";

describe("sandbox: filesystem boundary", () => {
  const fixtures: SandboxFixture[] = [];

  async function fixture(
    options: Parameters<typeof createSandboxFixture>[0] = {},
  ): Promise<SandboxFixture> {
    const created = await createSandboxFixture(options);
    fixtures.push(created);
    return created;
  }

  afterEach(async () => {
    while (fixtures.length > 0) {
      await fixtures.pop()?.cleanup();
    }
  });

  it("reads a file inside the permitted root", async () => {
    const subject = await fixture({
      files: { "src/a.ts": "export const a = 1;" },
    });
    const outcome = await subject.sandbox.perform({
      kind: "fs.read",
      ref: "src/a.ts",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result).toEqual({
      content: "export const a = 1;",
      bytes: 19,
      truncated: false,
    });
  });

  it("refuses a read outside the readable roots, and names the rule", async () => {
    const subject = await fixture({
      policy: accessPolicy({
        allowed: ["filesystem.read"],
        readableRoots: ["src"],
      }),
      files: { "docs/a.md": "notes" },
    });
    const refusal = await subject.sandbox.admit({
      kind: "fs.read",
      ref: "docs/a.md",
    });
    expect(refusal?.reasonCode).toBe("RESOURCE_OUTSIDE_BOUNDARY");
  });

  it("writes inside a writable root and refuses outside it", async () => {
    const subject = await fixture({
      policy: accessPolicy({
        allowed: ["filesystem.write"],
        writableRoots: ["out"],
      }),
    });
    const allowed = await subject.sandbox.perform({
      kind: "fs.write",
      ref: "out/result.txt",
      content: "written",
    });
    expect(allowed.ok).toBe(true);
    expect(await subject.readFromDisk("out/result.txt")).toBe("written");

    const denied = await subject.sandbox.perform({
      kind: "fs.write",
      ref: "src/result.txt",
      content: "leaked",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) {
      return;
    }
    expect(denied.refusal.reasonCode).toBe("RESOURCE_OUTSIDE_BOUNDARY");
    // Nothing was created: a refusal is not a partial write.
    await expect(subject.readFromDisk("src/result.txt")).rejects.toThrow();
  });

  it("refuses traversal, absolute paths, drive letters, UNC prefixes and NUL", async () => {
    const subject = await fixture({ files: { "src/a.ts": "x" } });
    const attempts = [
      "../outside.txt",
      "src/../../outside.txt",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "//server/share/file",
      "src/evil\0.ts",
    ] as const;
    for (const ref of attempts) {
      const refusal = await subject.sandbox.admit({ kind: "fs.read", ref });
      expect(refusal?.reasonCode, ref).toBe("TARGET_REFUSED");
      const performed = await subject.sandbox.perform({ kind: "fs.read", ref });
      expect(performed.ok, ref).toBe(false);
    }
  });

  it("refuses a path that leaves the workspace through a link", async () => {
    if (!(await symlinksAvailable())) {
      // Windows without developer mode cannot create symlinks; the case is covered
      // by the containment arithmetic tests instead. Reported, not hidden.
      expect(process.platform).toBe("win32");
      return;
    }
    const subject = await fixture({ files: { "src/a.ts": "x" } });
    const outside = join(subject.projectRoot, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "outside-the-fence", "utf8");
    expect(await subject.link("src/escape", join(outside, "secret.txt"))).toBe(
      true,
    );

    const refusal = await subject.sandbox.admit({
      kind: "fs.read",
      ref: "src/escape",
    });
    expect(refusal?.reasonCode).toBe("SYMLINK_ESCAPE");
    const performed = await subject.sandbox.perform({
      kind: "fs.read",
      ref: "src/escape",
    });
    expect(performed.ok).toBe(false);
  });

  it("refuses a directory whose path leaves through a linked directory", async () => {
    if (!(await symlinksAvailable())) {
      expect(process.platform).toBe("win32");
      return;
    }
    const subject = await fixture();
    const outside = join(subject.projectRoot, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "outside-the-fence", "utf8");
    // A link to a *directory*: the file does not exist under the boundary at all.
    expect(await subject.link("peek", outside)).toBe(true);

    const refusal = await subject.sandbox.admit({
      kind: "fs.read",
      ref: "peek/secret.txt",
    });
    expect(["SYMLINK_ESCAPE", "OPERATION_FAILED"]).toContain(
      refusal?.reasonCode,
    );
  });

  it("allows a link that stays inside the boundary", async () => {
    if (!(await symlinksAvailable())) {
      expect(process.platform).toBe("win32");
      return;
    }
    const subject = await fixture({ files: { "src/a.ts": "inside" } });
    expect(
      await subject.link(
        "src/inside-link",
        join(subject.workspaceRoot, "src", "a.ts"),
      ),
    ).toBe(true);
    const outcome = await subject.sandbox.perform({
      kind: "fs.read",
      ref: "src/inside-link",
    });
    expect(outcome.ok).toBe(true);
  });

  it("refuses a configured root that is itself a link out of the workspace", async () => {
    if (!(await symlinksAvailable())) {
      expect(process.platform).toBe("win32");
      return;
    }
    const subject = await fixture({
      policy: accessPolicy({
        allowed: ["filesystem.read"],
        // The root the operator named resolves to somewhere else entirely.
        readableRoots: ["src"],
      }),
    });
    const outside = join(subject.projectRoot, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "passwd"), "outside-the-fence", "utf8");
    expect(await subject.link("src", outside)).toBe(true);

    // Containment measured against the root as it *really* is would accept this,
    // because the destination is inside the destination. The workspace fence is what
    // refuses it.
    const refusal = await subject.sandbox.admit({
      kind: "fs.read",
      ref: "src/passwd",
    });
    expect(refusal?.reasonCode).toBe("SYMLINK_ESCAPE");
    const performed = await subject.sandbox.perform({
      kind: "fs.read",
      ref: "src/passwd",
    });
    expect(performed.ok).toBe(false);
  });

  it("admits a path that does not exist yet, so a first write to a new root works", async () => {
    const subject = await fixture({
      policy: accessPolicy({
        allowed: ["filesystem.write", "filesystem.read"],
        writableRoots: ["out"],
        readableRoots: ["out"],
      }),
    });
    // The root and the file are both absent: the ancestor check is what proves
    // containment, and it still holds.
    expect(
      await subject.sandbox.admit({
        kind: "fs.write",
        ref: "out/result.txt",
        content: "",
      }),
    ).toBeUndefined();
    const written = await subject.sandbox.perform({
      kind: "fs.write",
      ref: "out/result.txt",
      content: "created with the directory",
    });
    expect(written.ok).toBe(true);
    expect(await subject.readFromDisk("out/result.txt")).toBe(
      "created with the directory",
    );

    // A read of a missing file inside an existing root is a missing file, not an
    // unresolvable boundary: the answer names the file.
    const missing = await subject.sandbox.perform({
      kind: "fs.read",
      ref: "out/absent.txt",
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) {
      return;
    }
    expect(missing.refusal.reasonCode).toBe("OPERATION_FAILED");
  });

  it("refuses a path whose ancestor is a link out of the workspace", async () => {
    if (!(await symlinksAvailable())) {
      expect(process.platform).toBe("win32");
      return;
    }
    const subject = await fixture({
      policy: accessPolicy({
        allowed: ["filesystem.write"],
        writableRoots: ["."],
      }),
    });
    const outside = join(subject.projectRoot, "outside");
    await mkdir(outside, { recursive: true });
    expect(await subject.link("nested", outside)).toBe(true);
    const refusal = await subject.sandbox.admit({
      kind: "fs.write",
      ref: "nested/new.txt",
      content: "x",
    });
    expect(refusal?.reasonCode).toBe("SYMLINK_ESCAPE");
  });

  it("never reaches a sibling workspace, even with the workspace root readable", async () => {
    const subject = await fixture();
    const sibling = join(subject.projectRoot, "ws-b");
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "secret.txt"), "another workspace", "utf8");

    // Every route to a sibling workspace is either a traversal (refused) or an
    // absolute path (refused); the fence is the workspace root itself.
    for (const ref of [
      "../ws-b/secret.txt",
      "..\\ws-b\\secret.txt",
      join(sibling, "secret.txt"),
    ]) {
      const refusal = await subject.sandbox.admit({ kind: "fs.read", ref });
      expect(refusal, ref).toBeDefined();
      expect(refusal?.reasonCode, ref).toBe("TARGET_REFUSED");
    }
  });

  it("refuses credential-shaped paths even when the root covers them", async () => {
    const subject = await fixture({
      policy: readWritePolicy(),
      files: {
        ".env": "API_KEY=sk-fixture-super-secret-value",
        "keys/id_rsa": "-----BEGIN PRIVATE KEY-----",
        "config/.env.local": "TOKEN=sk-fixture-super-secret-value",
        "src/ok.ts": "fine",
      },
    });
    for (const ref of [".env", "keys/id_rsa", "config/.env.local"]) {
      const refusal = await subject.sandbox.admit({ kind: "fs.read", ref });
      expect(refusal?.reasonCode, ref).toBe("SECRET_PATH_DENIED");
      const write = await subject.sandbox.admit({
        kind: "fs.write",
        ref,
        content: "",
      });
      expect(write?.reasonCode, ref).toBe("SECRET_PATH_DENIED");
    }
    const readable = await subject.sandbox.perform({
      kind: "fs.read",
      ref: "src/ok.ts",
    });
    expect(readable.ok).toBe(true);
  });

  it("cannot write the platform's own runtime state, and cannot be re-included", async () => {
    const subject = await fixture({
      policy: readWritePolicy({
        // A negation on the operator list must not open a hard exclusion.
        deniedPatterns: ["!keep.ts", "*.log"],
        readableRoots: ["."],
        writableRoots: ["."],
      }),
    });
    for (const ref of [
      ".ai/project.json",
      "src/.git/config",
      ".git/hooks/pre-commit",
    ]) {
      const refusal = await subject.sandbox.admit({
        kind: "fs.write",
        ref,
        content: "",
      });
      expect(refusal?.reasonCode, ref).toBe("RUNTIME_STATE_DENIED");
    }
    const denied = await subject.sandbox.admit({
      kind: "fs.read",
      ref: "build.log",
    });
    expect(denied?.reasonCode).toBe("POLICY_DENIED");
  });

  it("reports a missing file without leaking the absolute path", async () => {
    const subject = await fixture();
    const outcome = await subject.sandbox.perform({
      kind: "fs.read",
      ref: "src/missing.ts",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.refusal.reasonCode).toBe("OPERATION_FAILED");
    expect(outcome.refusal.reason).toContain("src/missing.ts");
    expect(outcome.refusal.reason).not.toContain(subject.workspaceRoot);
  });

  it("refuses a directory read and caps an oversized file", async () => {
    const subject = await fixture({
      files: { "src/big.ts": "x".repeat(2_000) },
      policy: readWritePolicy(),
      maxReadBytes: 100,
    });
    const oversized = await subject.sandbox.perform({
      kind: "fs.read",
      ref: "src/big.ts",
    });
    expect(oversized.ok).toBe(true);
    if (!oversized.ok) {
      return;
    }
    expect(oversized.result).toMatchObject({ truncated: true, bytes: 100 });

    const directory = await subject.sandbox.perform({
      kind: "fs.read",
      ref: "src",
    });
    expect(directory.ok).toBe(false);
  });

  it("lists names only, sorted, with directories marked", async () => {
    const subject = await fixture({
      files: { "src/a.ts": "a", "src/b.ts": "b" },
    });
    await mkdir(join(subject.workspaceRoot, "nested"), { recursive: true });
    const outcome = await subject.sandbox.perform({
      kind: "fs.list",
      ref: ".",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const result = outcome.result as { entries: readonly string[] };
    expect(result.entries).toContain("src/");
    expect(result.entries).toContain("nested/");
    expect(result.entries).toEqual([...result.entries].sort());
    for (const entry of result.entries) {
      expect(entry).not.toContain(subject.workspaceRoot);
      expect(entry.startsWith("/")).toBe(false);
    }
  });

  it("is deterministic: the same request over the same state gives the same answer", async () => {
    const subject = await fixture({ files: { "src/a.ts": "a" } });
    const first = await subject.sandbox.perform({
      kind: "fs.read",
      ref: "src/a.ts",
    });
    const second = await subject.sandbox.perform({
      kind: "fs.read",
      ref: "src/a.ts",
    });
    expect(first).toEqual(second);

    const deniedFirst = await subject.sandbox.admit({
      kind: "fs.read",
      ref: "../x",
    });
    const deniedSecond = await subject.sandbox.admit({
      kind: "fs.read",
      ref: "../x",
    });
    expect(deniedFirst).toEqual(deniedSecond);
  });

  it("reads what policy permits even when the file was written by another writer", async () => {
    const subject = await fixture({ files: { "src/a.ts": "from fixture" } });
    await writeFile(
      join(subject.workspaceRoot, "src", "a.ts"),
      "rewritten",
      "utf8",
    );
    const outcome = await subject.sandbox.perform({
      kind: "fs.read",
      ref: "src/a.ts",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result).toMatchObject({ content: "rewritten" });
    expect(
      await readFile(join(subject.workspaceRoot, "src", "a.ts"), "utf8"),
    ).toBe("rewritten");
  });
});
