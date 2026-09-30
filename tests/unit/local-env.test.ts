import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  LOCAL_ENV_DISABLED_MODE,
  LOCAL_ENV_FILE_NAME,
  LOCAL_ENV_MODE_VARIABLE,
  loadLocalEnv,
} from "../../src/adapters/config/local-env.js";

/**
 * `.env.local` loading: what the file may change, and what it may never change.
 *
 * Every test injects its own `target` map, so nothing here reads, writes or depends
 * on the machine's real environment — the same reason the `Environment` port exists.
 * The probe names are deliberately not the real credential names: a test that used
 * `TYPESAFE_API_KEY` would make "the file supplied this value" indistinguishable from
 * "the developer's own key was already exported".
 */

const TYPESAFE_PROBE = "PROBE_TYPESAFE_CREDENTIAL";
const OPENROUTER_PROBE = "PROBE_OPENROUTER_CREDENTIAL";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-local-env-"));
  roots.push(root);
  return root;
}

async function withFile(root: string, content: string): Promise<void> {
  await writeFile(join(root, LOCAL_ENV_FILE_NAME), content, "utf8");
}

describe("local env file", () => {
  it("reports an absence and changes nothing when there is no file", async () => {
    const root = await scratchRoot();
    const target: Record<string, string | undefined> = {};
    const result = await loadLocalEnv({ projectRoot: root, target });
    expect(result.status).toBe("absent");
    expect(result.path).toBe(join(root, LOCAL_ENV_FILE_NAME));
    expect(result.applied).toEqual([]);
    expect(target).toEqual({});
  });

  it("applies the names the file declares, and reports only their names", async () => {
    const root = await scratchRoot();
    await withFile(
      root,
      `${TYPESAFE_PROBE}=value-one\n${OPENROUTER_PROBE}=value-two\n`,
    );
    const target: Record<string, string | undefined> = {};
    const result = await loadLocalEnv({ projectRoot: root, target });

    expect(result.status).toBe("loaded");
    expect(result.applied).toEqual([OPENROUTER_PROBE, TYPESAFE_PROBE]);
    expect(result.ignored).toEqual([]);
    expect(target[TYPESAFE_PROBE]).toBe("value-one");
    expect(target[OPENROUTER_PROBE]).toBe("value-two");

    // The result is metadata: no value can travel out of the loader, in any field.
    expect(Object.keys(result).sort()).toEqual([
      "applied",
      "ignored",
      "path",
      "status",
    ]);
    expect(JSON.stringify(result)).not.toContain("value-one");
    expect(JSON.stringify(result)).not.toContain("value-two");
  });

  it("never overwrites a value that is already in force", async () => {
    const root = await scratchRoot();
    await withFile(root, `${TYPESAFE_PROBE}=from-the-file\n`);
    const target: Record<string, string | undefined> = {
      [TYPESAFE_PROBE]: "from-the-environment",
    };
    const result = await loadLocalEnv({ projectRoot: root, target });

    expect(target[TYPESAFE_PROBE]).toBe("from-the-environment");
    expect(result.applied).toEqual([]);
    expect(result.ignored).toEqual([TYPESAFE_PROBE]);
  });

  it("treats an empty placeholder as a name with no value", async () => {
    const root = await scratchRoot();
    await withFile(root, `${TYPESAFE_PROBE}=\n${OPENROUTER_PROBE}=\n`);
    const target: Record<string, string | undefined> = {};
    const result = await loadLocalEnv({ projectRoot: root, target });

    expect(result.status).toBe("loaded");
    expect(result.applied).toEqual([]);
    expect(result.ignored).toEqual([OPENROUTER_PROBE, TYPESAFE_PROBE]);
    // Not merely falsy: the name is not created at all, so an adapter can never read
    // an empty string as "a credential is present".
    expect(Object.hasOwn(target, TYPESAFE_PROBE)).toBe(false);
    expect(Object.hasOwn(target, OPENROUTER_PROBE)).toBe(false);
  });

  it("fills a variable that is present but empty", async () => {
    const root = await scratchRoot();
    await withFile(root, `${TYPESAFE_PROBE}=from-the-file\n`);
    const target: Record<string, string | undefined> = { [TYPESAFE_PROBE]: "" };
    const result = await loadLocalEnv({ projectRoot: root, target });

    expect(target[TYPESAFE_PROBE]).toBe("from-the-file");
    expect(result.applied).toEqual([TYPESAFE_PROBE]);
  });

  it("gives one provider's credential to that provider only", async () => {
    const root = await scratchRoot();
    await withFile(root, `${TYPESAFE_PROBE}=typesafe-only\n`);
    const target: Record<string, string | undefined> = {};
    await loadLocalEnv({ projectRoot: root, target });

    expect(target[TYPESAFE_PROBE]).toBe("typesafe-only");
    // No alias, no inheritance, no fallback: OpenRouter's variable is untouched.
    expect(Object.hasOwn(target, OPENROUTER_PROBE)).toBe(false);
  });

  it("ignores names the environment cannot express", async () => {
    const root = await scratchRoot();
    // The parser passes `NOT-A-NAME` through; the environment cannot express it, so it
    // is reported as ignored rather than set as a variable no shell could read back.
    await withFile(root, `NOT-A-NAME=1\n${TYPESAFE_PROBE}=value\n`);
    const target: Record<string, string | undefined> = {};
    const result = await loadLocalEnv({ projectRoot: root, target });

    expect(result.applied).toEqual([TYPESAFE_PROBE]);
    expect(result.ignored).toEqual(["NOT-A-NAME"]);
    expect(Object.hasOwn(target, "NOT-A-NAME")).toBe(false);
  });

  it("does not load anything in a production process", async () => {
    const root = await scratchRoot();
    await withFile(root, `${TYPESAFE_PROBE}=from-the-file\n`);
    const target: Record<string, string | undefined> = {
      [LOCAL_ENV_MODE_VARIABLE]: LOCAL_ENV_DISABLED_MODE,
    };
    const result = await loadLocalEnv({ projectRoot: root, target });

    expect(result.status).toBe("disabled");
    expect(result.applied).toEqual([]);
    expect(target[TYPESAFE_PROBE]).toBeUndefined();
  });

  it("reports a file it cannot use by status, never by content", async () => {
    const root = await scratchRoot();
    // A directory where the file should be: readable in principle, unusable as a file.
    await mkdir(join(root, LOCAL_ENV_FILE_NAME));
    const target: Record<string, string | undefined> = {};
    const result = await loadLocalEnv({ projectRoot: root, target });

    expect(result.status).toBe("invalid");
    expect(result.applied).toEqual([]);
    expect(result.ignored).toEqual([]);
    // The path is named so an operator can fix it; the fact that it is unusable is
    // reported as a status, never as the contents of a file that may hold a key.
    expect(result.path).toBe(join(root, LOCAL_ENV_FILE_NAME));
  });
});
