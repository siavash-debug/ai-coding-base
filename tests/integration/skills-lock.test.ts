import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  canonicalSkillPayload,
  checkSkillsLock,
  computeCanonicalSkillPayloadHash,
  computeSkillPayloadHash,
  createNodeSkillsLockFiles,
  formatSkillsLockReport,
  ignoredDirectoryRules,
  SKILLS_IGNORE_FILE,
  SKILLS_LOCK_FILE,
  SKILLS_PAYLOAD_DIRECTORY,
  SKILLS_PINS_FILE,
  type SkillPayloadFile,
} from "../../src/skills/skills-lock.js";

/**
 * The invariant: `skills-lock.json`, `skills-lock.pins.json` and this checkout still
 * agree, and this repository's own record is the one that decides.
 *
 * `tests/unit/skills-lock.test.ts` proves the checker behaves. This suite proves the
 * *repository* obeys, and it is what allows the checker to be trusted at all — those
 * fixtures build their pins with the same function the checker uses, and only the pins
 * the real installer and the real payloads produce can show that function is the right
 * one and that the canonical bridging between the two records is faithful.
 *
 * Two directories are named explicitly because a previous phase decided their fate and
 * a silent reversal is the failure this guards: the installed payload is a local cache
 * the ignore rules hand to `skills add`, and the hand-kept `typesafe-ai` copy is
 * repository content git owns. If either answer changes, that change should have to
 * arrive with an edit here.
 *
 * The payload an ignore rule covers is legitimately absent from a fresh clone, so the
 * assertions hold whether or not it is installed — except where the absence itself is
 * the finding, which is true only of the tracked one.
 */

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const files = createNodeSkillsLockFiles(PROJECT_ROOT);

function read(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), "utf8");
}

const RETAINED: string[] = [];

afterAll(async () => {
  await Promise.all(
    RETAINED.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

const REPORT = await checkSkillsLock({ files });

/** The external lock as data, so its recorded hashes can be compared directly. */
const LOCK = JSON.parse(read(SKILLS_LOCK_FILE)) as {
  readonly version: number;
  readonly skills: Record<string, { readonly computedHash: string }>;
};

/** A payload re-rendered with one uniform line ending, built here from raw bytes. */
function rendered(
  payload: readonly SkillPayloadFile[],
  ending: "lf" | "crlf",
): readonly SkillPayloadFile[] {
  return payload.map((file) => {
    const asLf = Buffer.from(file.bytes)
      .toString("binary")
      .replace(/\r\n/g, "\n");
    const text = ending === "lf" ? asLf : asLf.replace(/\n/g, "\r\n");
    return { path: file.path, bytes: Buffer.from(text, "binary") };
  });
}

describe("skills lock: the repository and its two records agree", () => {
  it("nothing is missing, edited or committed", () => {
    // The rendered report, not the boolean, is the failure message: it names every
    // skill, its payload path, both hashes and what was found.
    expect(REPORT.ok, formatSkillsLockReport(REPORT)).toBe(true);
    expect(REPORT.exitCode).toBe(0);
    expect(REPORT.problems.filter((p) => p.severity === "fail")).toEqual([]);
  });

  it("pins exactly the skills the external lock names, and only those", () => {
    expect([...REPORT.skills.map((skill) => skill.name)].sort()).toEqual(
      Object.keys(LOCK.skills).sort(),
    );
    for (const skill of REPORT.skills) {
      expect(skill.expectedHash, skill.name).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(
      REPORT.problems.filter(
        (p) => p.code === "pin-undeclared" || p.code === "pin-missing",
      ),
    ).toEqual([]);
  });

  it("re-derives every verdict from the payload's canonical bytes alone", async () => {
    for (const skill of REPORT.skills) {
      if (skill.status === "not-installed") {
        continue;
      }
      const payload = await files.readPayload(skill.payloadPath);
      expect(payload, skill.name).toBeDefined();

      const canonical = computeCanonicalSkillPayloadHash(payload!);
      expect(canonical, skill.name).toBe(skill.actualHash);
      expect(canonical, skill.name).toBe(skill.expectedHash);
      expect(skill.status, skill.name).toBe("ok");
      // The repository's canonical form is the installer's algorithm over LF bytes, so
      // these two must be the same expression, checked from opposite directions.
      expect(canonical, skill.name).toBe(
        computeSkillPayloadHash(canonicalSkillPayload(payload!)),
      );
    }
  });

  it("reproduces the installer's own hash for every payload, rendering and all", async () => {
    // The external record is not redefined here, it is *explained*: for each payload
    // this test reproduces the exact value `skills` wrote, either from the raw bytes or
    // from a uniform line-ending rendering of them — and never from anything looser.
    // If a future payload made `computedHash` mean something else, this fails.
    for (const [name, entry] of Object.entries(LOCK.skills)) {
      const skill = REPORT.skills.find((s) => s.name === name);
      expect(skill, name).toBeDefined();
      expect(skill!.installerHash, name).toBe(entry.computedHash);

      const payload = await files.readPayload(skill!.payloadPath);
      if (payload === undefined) {
        continue;
      }
      const candidates = [
        computeSkillPayloadHash(payload),
        computeSkillPayloadHash(rendered(payload, "lf")),
        computeSkillPayloadHash(rendered(payload, "crlf")),
      ];
      expect(candidates, name).toContain(entry.computedHash);
      expect(skill!.installerPinMatchesRawBytes, name).toBe(
        candidates[0] === entry.computedHash,
      );
    }
  });
});

describe("skills lock: which payloads this repository commits", () => {
  const ignored = ignoredDirectoryRules(read(SKILLS_IGNORE_FILE));

  it("hands the installed payload to the ignore rules and the hand-kept copy to git", () => {
    expect(ignored).toContain(`${SKILLS_PAYLOAD_DIRECTORY}/hindsight-docs`);
    expect(ignored).not.toContain(`${SKILLS_PAYLOAD_DIRECTORY}/typesafe-ai`);
    expect(ignored).toContain(".claude");
  });

  it("has committed nothing under a directory the ignore rules hand away", () => {
    expect(
      REPORT.problems.filter((p) => p.code === "payload-tracked-while-ignored"),
    ).toEqual([]);
  });

  it("keeps the hand-kept payload present and matching its pin", () => {
    const skill = REPORT.skills.find((s) => s.name === "typesafe-ai");
    expect(skill, "typesafe-ai is no longer locked").toBeDefined();
    expect(skill!.expectation).toBe("tracked");
    expect(skill!.status).toBe("ok");
  });

  it("has no payload directory the lock does not name", () => {
    expect(
      REPORT.problems.filter((p) => p.code === "payload-undeclared"),
    ).toEqual([]);
  });

  it("actually consulted git, rather than reporting the question unanswerable", () => {
    // Without this, a `listTrackedFiles` that always failed would return `undefined`
    // for everything, every tracking answer would be a note, and every assertion above
    // would still pass.
    expect(
      REPORT.problems.filter((p) => p.code === "tracking-unverifiable"),
    ).toEqual([]);
  });
});

describe("skills lock: the check changes nothing", () => {
  it("leaves both records byte-identical after the check above has run", async () => {
    const lockBefore = read(SKILLS_LOCK_FILE);
    const pinsBefore = read(SKILLS_PINS_FILE);

    const again = await checkSkillsLock({ files });

    expect(read(SKILLS_LOCK_FILE)).toBe(lockBefore);
    expect(read(SKILLS_PINS_FILE)).toBe(pinsBefore);
    expect(again.exitCode).toBe(REPORT.exitCode);
    expect(again.problems).toEqual(REPORT.problems);
  });
});

describe("skills lock: the real git adapter", () => {
  it("catches a payload force-added under a directory the ignore rules cover", async () => {
    // The unit suite replaces `listTrackedFiles`; this is the only place the real one is
    // asked a question whose answer is not the empty list, and it is the exact
    // regression the `.gitignore` comment cannot prevent by itself: git neither untracks
    // a file a new rule covers nor refuses one that was added with `-f`.
    const root = await mkdtemp(join(tmpdir(), "skills-lock-git-"));
    RETAINED.push(root);

    await writeFile(
      join(root, SKILLS_LOCK_FILE),
      `${JSON.stringify(
        {
          version: 1,
          skills: {
            "hindsight-docs": {
              source: "vectorize-io/hindsight",
              sourceType: "github",
              skillPath: "skills/hindsight-docs/SKILL.md",
              computedHash: "0".repeat(64),
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(root, SKILLS_PINS_FILE),
      `${JSON.stringify(
        {
          version: 1,
          hash: { algorithm: "sha256", lineEndings: "lf" },
          skills: { "hindsight-docs": "1".repeat(64) },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(root, SKILLS_IGNORE_FILE),
      `${SKILLS_PAYLOAD_DIRECTORY}/hindsight-docs/\n.claude/\n`,
    );
    await mkdir(join(root, ".claude", "skills"), { recursive: true });
    await writeFile(
      join(root, ".claude", "skills", "hindsight-docs"),
      "an absolute path from one machine\n",
    );

    // The empty repository deliberately has no `.gitattributes`, so the `-c` keeps git
    // from announcing a line-ending rewrite this test has nothing to do with.
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "add",
        "-f",
        ".claude/skills/hindsight-docs",
      ],
      { cwd: root },
    );

    const report = await checkSkillsLock({
      files: createNodeSkillsLockFiles(root),
    });

    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    const failures = report.problems.filter((p) => p.severity === "fail");
    expect(failures.map((p) => p.code)).toEqual([
      "payload-tracked-while-ignored",
    ]);
    expect(failures[0]!.subject).toBe(".claude");
    expect(failures[0]!.message).toContain(".claude/skills/hindsight-docs");
    // The uninstalled payload is still only a note: absence is the normal state.
    expect(report.skills[0]!.status).toBe("not-installed");
    expect(report.problems.map((p) => p.code)).toEqual([
      "payload-not-installed",
      "payload-tracked-while-ignored",
    ]);
  });
});
