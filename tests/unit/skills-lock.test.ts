import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalSkillPayload,
  checkSkillsLock,
  computeCanonicalSkillPayloadHash,
  computeSkillPayloadHash,
  createNodeSkillsLockFiles,
  formatSkillsLockReport,
  ignoredDirectoryRules,
  parseSkillsLock,
  parseSkillsPins,
  SKILLS_IGNORE_FILE,
  SKILLS_LOCK_FILE,
  SKILLS_PAYLOAD_DIRECTORY,
  SKILLS_PINS_FILE,
  type SkillPayloadFile,
  type SkillsLockFiles,
} from "../../src/skills/skills-lock.js";

/**
 * Two contracts, and the tests keep them apart.
 *
 * `skills-lock.json` is the installer's file: it records a hash of a working tree, so
 * the value depends on the line endings the installing host produced. This repository
 * declares `* text=auto eol=lf`, which means a tracked payload can never satisfy such
 * a pin and an installed one only satisfies it on the host that wrote it.
 * `skills-lock.pins.json` is this repository's own record, canonicalised to LF, and it
 * is the record that decides every verdict here.
 *
 * Every fixture is built from bytes rather than strings, because the property under
 * test is byte-exact and a test that hands a runtime a string is trusting that runtime
 * not to normalise it.
 *
 * `tests/integration/skills-lock.test.ts` anchors the same functions against the real
 * recorded pins; the fixtures here are healthy by construction and would otherwise be
 * a tautology. Only `listTrackedFiles` is ever replaced, and always with a definite
 * answer — `[]` means git was consulted and found nothing, `undefined` means it could
 * not be consulted, and the check must say so rather than call it clean.
 */

const RETAINED: string[] = [];

afterEach(async () => {
  await Promise.all(
    RETAINED.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

const LF = Buffer.from([0x0a]);
const CRLF = Buffer.from([0x0d, 0x0a]);

/** Bytes for a file made of lines joined by an explicit terminator. */
function textFile(
  lines: readonly string[],
  terminator: Uint8Array = LF,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const line of lines) {
    parts.push(Buffer.from(line, "utf8"), terminator);
  }
  return Buffer.concat(parts);
}

const LF_SKILL = { "SKILL.md": textFile(["# alpha", "body"]) };
const CRLF_SKILL = { "SKILL.md": textFile(["# alpha", "body"], CRLF) };

function asPayloadFiles(
  files: Record<string, Uint8Array>,
): readonly SkillPayloadFile[] {
  return Object.entries(files).map(([path, bytes]) => ({ path, bytes }));
}

/** The canonical pin this repository would record for these bytes. */
function pinFor(files: Record<string, Uint8Array>): string {
  return computeCanonicalSkillPayloadHash(asPayloadFiles(files));
}

interface SkillSpec {
  readonly files: Record<string, Uint8Array>;
  /** The repository's canonical pin. Defaults to the hash of `files`. */
  readonly pin?: unknown;
  /** Replaces the lock entry, so a malformed one can be expressed. */
  readonly lockEntry?: unknown;
}

interface FixtureOptions {
  readonly ignore?: string;
  readonly skills?: Record<string, SkillSpec>;
  readonly lockVersion?: number;
  readonly lockText?: string;
  readonly pinsText?: string;
  readonly pinsVersion?: number;
  readonly pinsHash?: Record<string, unknown>;
  /** Payload directories with no lock entry behind them. */
  readonly strays?: readonly string[];
  /** Directory → tracked paths. A missing key means "git found nothing". */
  readonly tracked?: Record<string, readonly string[]>;
  /** Makes every tracking question unanswerable, as a git-less export would. */
  readonly trackingUnverifiable?: boolean;
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "skills-lock-"));
  RETAINED.push(root);
  const skills = options.skills ?? {};

  const lockEntries: Record<string, unknown> = {};
  const pins: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(skills)) {
    for (const [relativePath, bytes] of Object.entries(spec.files)) {
      const absolute = join(root, SKILLS_PAYLOAD_DIRECTORY, name, relativePath);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, bytes);
    }
    lockEntries[name] = spec.lockEntry ?? {
      source: `example/${name}`,
      sourceType: "github",
      skillPath: `skills/${name}/SKILL.md`,
      // The installer's own hash of the bytes as installed. Only ever reported.
      computedHash: computeSkillPayloadHash(asPayloadFiles(spec.files)),
    };
    pins[name] = spec.pin ?? pinFor(spec.files);
  }

  for (const name of options.strays ?? []) {
    const absolute = join(root, SKILLS_PAYLOAD_DIRECTORY, name, "SKILL.md");
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, textFile([`# ${name}`]));
  }

  await writeFile(
    join(root, SKILLS_LOCK_FILE),
    options.lockText ??
      `${JSON.stringify(
        { version: options.lockVersion ?? 1, skills: lockEntries },
        null,
        2,
      )}\n`,
  );

  await writeFile(
    join(root, SKILLS_PINS_FILE),
    options.pinsText ??
      `${JSON.stringify(
        {
          version: options.pinsVersion ?? 1,
          hash: options.pinsHash ?? { algorithm: "sha256", lineEndings: "lf" },
          skills: pins,
        },
        null,
        2,
      )}\n`,
  );

  await writeFile(
    join(root, SKILLS_IGNORE_FILE),
    options.ignore ?? `${SKILLS_PAYLOAD_DIRECTORY}/alpha/\n`,
  );

  const tracked = options.tracked ?? {};
  const files: SkillsLockFiles = {
    ...createNodeSkillsLockFiles(root),
    listTrackedFiles: async (path) =>
      options.trackingUnverifiable ? undefined : (tracked[path] ?? []),
  };

  return { root, files };
}

function payloadDirectory(root: string, name: string): string {
  return join(root, SKILLS_PAYLOAD_DIRECTORY, name);
}

/** Every file under a root, by relative path, as hex — so nothing can differ. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const seen: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      seen[relative(root, absolute).split("\\").join("/")] = (
        await readFile(absolute)
      ).toString("hex");
    }
  }
  await walk(root);
  return seen;
}

function codes(report: { problems: readonly { code: string }[] }): string[] {
  return report.problems.map((problem) => problem.code);
}

function failures(report: {
  problems: readonly { code: string; severity: string }[];
}): string[] {
  return report.problems
    .filter((problem) => problem.severity === "fail")
    .map((problem) => problem.code);
}

// ---------------------------------------------------------------------------
// The two contracts, stated as behaviour.
// ---------------------------------------------------------------------------

describe("skills lock: the external lock is read, never redefined", () => {
  it("verifies an installed payload whose installer hash matches its raw bytes", async () => {
    // The CRLF case: an untracked payload keeps whatever the installing host wrote, so
    // the installer's own hash of it is exact — and it is still the canonical pin that
    // the verdict is taken from.
    const { files } = await fixture({
      skills: { alpha: { files: CRLF_SKILL } },
    });

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(true);
    expect(report.skills[0]).toMatchObject({
      status: "ok",
      installerPinMatchesRawBytes: true,
    });
    expect(report.problems).toEqual([]);
  });

  it("keeps the verdict when the installer's hash matches no rendering at all", async () => {
    // Proves `computedHash` is reported and not enforced: a stale or hand-edited
    // external hash cannot make an unedited payload fail, and it cannot be used to
    // launder an edited one either, because the canonical pin decides.
    const { files } = await fixture({
      skills: {
        alpha: {
          files: LF_SKILL,
          lockEntry: {
            source: "example/alpha",
            sourceType: "github",
            skillPath: "skills/alpha/SKILL.md",
            computedHash: "b".repeat(64),
          },
        },
      },
    });

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(true);
    expect(report.skills[0]!.installerPinMatchesRawBytes).toBe(false);
    expect(codes(report)).toEqual(["installer-pin-differs"]);
    expect(report.problems[0]!.severity).toBe("note");
    expect(report.problems[0]!.message).toContain("matches neither");
  });

  it("names the rendering the installer recorded when the lock was written elsewhere", async () => {
    // The `typesafe-ai` situation: a pin taken from a host that recorded CRLF, against
    // the LF this repository stores.
    const { files } = await fixture({
      ignore: "# nothing ignored\n",
      skills: {
        alpha: {
          files: LF_SKILL,
          lockEntry: {
            source: "example/alpha",
            sourceType: "github",
            skillPath: "skills/alpha/SKILL.md",
            computedHash: computeSkillPayloadHash(asPayloadFiles(CRLF_SKILL)),
          },
        },
      },
    });

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(true);
    expect(report.skills[0]).toMatchObject({
      status: "ok",
      expectation: "tracked",
      installerPinMatchesRawBytes: false,
    });
    expect(report.problems[0]!.message).toContain("CRLF rendering");
    expect(formatSkillsLockReport(report)).toContain(
      computeSkillPayloadHash(asPayloadFiles(CRLF_SKILL)),
    );
  });

  it("fails clearly when the external lock is missing or unreadable", async () => {
    const { files } = await fixture();
    const report = await checkSkillsLock({
      files,
      lockPath: "no-such-lock.json",
    });

    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["lock-unreadable"]);
    expect(report.skills).toEqual([]);
  });
});

describe("skills lock: the repository pins decide the verdict", () => {
  it("accepts a payload whose canonical content matches the pin", async () => {
    const { files } = await fixture({ skills: { alpha: { files: LF_SKILL } } });

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.skills[0]).toMatchObject({
      name: "alpha",
      expectation: "installed",
      status: "ok",
    });
    expect(report.skills[0]!.actualHash).toBe(report.skills[0]!.expectedHash);
  });

  it("gives one pin for the same content spelt with either line ending", async () => {
    const lf = await fixture({ skills: { alpha: { files: LF_SKILL } } });
    const crlf = await fixture({
      ignore: "# nothing ignored\n",
      skills: { alpha: { files: CRLF_SKILL } },
    });

    const [left, right] = await Promise.all([
      checkSkillsLock({ files: lf.files }),
      checkSkillsLock({ files: crlf.files }),
    ]);

    // Installed and tracked, on opposite sides of `.gitattributes` — and verifiable
    // against one pin, which is the whole point of the canonical form.
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    expect(left.skills[0]!.expectation).toBe("installed");
    expect(right.skills[0]!.expectation).toBe("tracked");
    expect(pinFor(LF_SKILL)).toBe(pinFor(CRLF_SKILL));
    expect(left.skills[0]!.expectedHash).toBe(right.skills[0]!.expectedHash);
    expect(right.skills[0]!.installerHash).toBe(
      computeSkillPayloadHash(asPayloadFiles(CRLF_SKILL)),
    );
  });

  it("fails a payload whose content changed, naming both hashes", async () => {
    const { root, files } = await fixture({
      skills: { alpha: { files: LF_SKILL } },
    });
    const pin = pinFor(LF_SKILL);
    await writeFile(
      join(payloadDirectory(root, "alpha"), "SKILL.md"),
      textFile(["# alpha", "tampered"]),
    );

    const report = await checkSkillsLock({ files });
    const rendered = formatSkillsLockReport(report);

    expect(report.ok).toBe(false);
    expect(failures(report)).toEqual(["hash-mismatch"]);
    expect(report.problems[0]!.expectedHash).toBe(pin);
    expect(report.problems[0]!.payloadPath).toBe(".agents/skills/alpha");
    expect(rendered).toContain(pin);
    expect(rendered).toContain(report.skills[0]!.actualHash!);
    expect(rendered).toContain("RESULT: fail");
  });

  it("fails a payload whose files were renamed or moved", async () => {
    const { root, files } = await fixture({
      skills: {
        alpha: {
          files: {
            "SKILL.md": textFile(["# alpha"]),
            "references/guide.md": textFile(["# guide"]),
          },
        },
      },
    });
    const guide = join(
      payloadDirectory(root, "alpha"),
      "references",
      "guide.md",
    );
    const moved = join(
      payloadDirectory(root, "alpha"),
      "references",
      "other.md",
    );
    await writeFile(moved, await readFile(guide));
    await rm(guide);

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(false);
    expect(failures(report)).toEqual(["hash-mismatch"]);
  });

  it("fails a payload with an added file", async () => {
    const { root, files } = await fixture({
      skills: { alpha: { files: LF_SKILL } },
    });
    await writeFile(
      join(payloadDirectory(root, "alpha"), "extra.md"),
      textFile(["# extra"]),
    );

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(false);
    expect(failures(report)).toEqual(["hash-mismatch"]);
  });

  it("fails a payload with a removed file", async () => {
    const { root, files } = await fixture({
      skills: {
        alpha: {
          files: {
            "SKILL.md": textFile(["# alpha"]),
            "extra.md": textFile(["# x"]),
          },
        },
      },
    });
    await rm(join(payloadDirectory(root, "alpha"), "extra.md"));

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(false);
    expect(failures(report)).toEqual(["hash-mismatch"]);
  });

  it("fails when this repository has no pin for a locked skill", async () => {
    const { files } = await fixture({
      skills: { alpha: { files: LF_SKILL } },
      pinsText: `${JSON.stringify({ version: 1, hash: { algorithm: "sha256", lineEndings: "lf" }, skills: {} }, null, 2)}\n`,
    });

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(false);
    expect(failures(report)).toEqual(["pin-missing"]);
    expect(report.skills[0]!.expectedHash).toBeUndefined();
    expect(report.skills[0]!.status).toBe("fail");
  });

  it("fails when this repository pins a skill the external lock does not name", async () => {
    const { root, files } = await fixture({
      skills: { alpha: { files: LF_SKILL }, zeta: { files: LF_SKILL } },
      lockText: `${JSON.stringify(
        {
          version: 1,
          skills: {
            alpha: {
              source: "example/alpha",
              sourceType: "github",
              skillPath: "skills/alpha/SKILL.md",
              computedHash: computeSkillPayloadHash(asPayloadFiles(LF_SKILL)),
            },
          },
        },
        null,
        2,
      )}\n`,
    });

    // "zeta was dropped from the external lock" is the only finding under test, so its
    // payload goes too: leaving it would add the separate undeclared-payload finding
    // and blur which half is being asserted.
    await rm(payloadDirectory(root, "zeta"), { recursive: true });

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(false);
    expect(failures(report)).toEqual(["pin-undeclared"]);
    expect(report.problems[0]!.subject).toBe("zeta");
  });

  it("fails clearly when the pins file is missing, malformed, or unsupported", async () => {
    const missing = await fixture({ skills: { alpha: { files: LF_SKILL } } });
    expect(
      failures(
        await checkSkillsLock({ files: missing.files, pinsPath: "nope.json" }),
      ),
    ).toEqual(["pins-unreadable"]);
    expect(
      (await checkSkillsLock({ files: missing.files, pinsPath: "nope.json" }))
        .skills[0]!.detail,
    ).toContain("not verifiable");

    const broken = await fixture({
      skills: { alpha: { files: LF_SKILL } },
      pinsText: "{ not json",
    });
    expect(failures(await checkSkillsLock({ files: broken.files }))).toEqual([
      "pins-malformed",
    ]);

    const version = await fixture({
      skills: { alpha: { files: LF_SKILL } },
      pinsVersion: 99,
    });
    expect(failures(await checkSkillsLock({ files: version.files }))).toEqual([
      "pins-version-unsupported",
    ]);

    const badPin = await fixture({
      skills: { alpha: { files: LF_SKILL, pin: "not-a-digest" } },
    });
    expect(failures(await checkSkillsLock({ files: badPin.files }))).toEqual([
      "pins-malformed",
    ]);
  });

  it("refuses a pins file whose hash form this code does not implement", async () => {
    // The one failure mode worth being paranoid about: comparing a pin written under
    // some other form would give an answer that looks right and means something else.
    for (const hash of [
      { algorithm: "sha512", lineEndings: "lf" },
      { algorithm: "sha256", lineEndings: "crlf" },
      { algorithm: "sha256", lineEndings: "raw" },
      {},
    ]) {
      const { files } = await fixture({
        skills: { alpha: { files: LF_SKILL } },
        pinsHash: hash,
      });

      const report = await checkSkillsLock({ files });

      expect(report.ok, JSON.stringify(hash)).toBe(false);
      expect(failures(report), JSON.stringify(hash)).toEqual([
        "pins-form-unsupported",
      ]);
      expect(report.skills[0]!.detail).toContain("not verifiable");
    }
  });

  it("fails when a payload git is expected to hold is missing", async () => {
    const { root, files } = await fixture({
      ignore: "# nothing ignored\n",
      skills: { alpha: { files: LF_SKILL } },
    });
    await rm(payloadDirectory(root, "alpha"), { recursive: true });

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(false);
    expect(failures(report)).toEqual(["payload-missing"]);
    expect(report.skills[0]!.expectation).toBe("tracked");
  });

  it("does not fail when an ignored payload is simply not installed", async () => {
    const { root, files } = await fixture({
      skills: { alpha: { files: LF_SKILL } },
    });
    await rm(payloadDirectory(root, "alpha"), { recursive: true });

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(true);
    expect(report.skills[0]!.status).toBe("not-installed");
    expect(codes(report)).toEqual(["payload-not-installed"]);
    expect(report.problems[0]!.severity).toBe("note");
  });

  it("checks multiple locked skills independently, one at a time", async () => {
    const { root, files } = await fixture({
      ignore: `${SKILLS_PAYLOAD_DIRECTORY}/alpha/\n\n${SKILLS_PAYLOAD_DIRECTORY}/beta/\n`,
      skills: { alpha: { files: LF_SKILL }, beta: { files: LF_SKILL } },
    });
    await writeFile(
      join(payloadDirectory(root, "beta"), "SKILL.md"),
      textFile(["# beta"]),
    );

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(false);
    const byName = new Map(report.skills.map((skill) => [skill.name, skill]));
    expect(byName.get("alpha")!.status).toBe("ok");
    expect(byName.get("beta")!.status).toBe("fail");
    expect(report.problems.map((problem) => problem.subject)).toEqual(["beta"]);
  });
});

// ---------------------------------------------------------------------------
// The canonical form itself.
// ---------------------------------------------------------------------------

describe("skills lock: the canonical form", () => {
  it("collapses CRLF to LF and leaves every other byte alone", () => {
    const withLoneCr = Buffer.from([0x61, 0x0d, 0x62, 0x0d, 0x0a, 0x63]);
    const files = asPayloadFiles({ "a.md": withLoneCr });

    const canonical = canonicalSkillPayload(files);

    // 0x61 0x0d 0x62 survives; only the pair collapses.
    expect([...canonical[0]!.bytes]).toEqual([0x61, 0x0d, 0x62, 0x0a, 0x63]);
    // And the input is untouched.
    expect([...files[0]!.bytes]).toEqual([...withLoneCr]);
  });

  it("is idempotent, so canonicalising twice is the same as once", () => {
    const files = asPayloadFiles(CRLF_SKILL);

    expect(computeCanonicalSkillPayloadHash(canonicalSkillPayload(files))).toBe(
      computeCanonicalSkillPayloadHash(files),
    );
  });

  it("equals the installer's hash of the LF form, which is what makes it portable", () => {
    // The bridge, stated as an equation: the repository's pin for CRLF content is the
    // installer's hash of the same content as a Linux host would materialise it.
    const crlf = asPayloadFiles(CRLF_SKILL);
    const lf = asPayloadFiles(LF_SKILL);

    expect(computeCanonicalSkillPayloadHash(crlf)).toBe(
      computeSkillPayloadHash(lf),
    );
    expect(computeCanonicalSkillPayloadHash(crlf)).toBe(
      computeSkillPayloadHash(canonicalSkillPayload(crlf)),
    );
  });

  it("is stable under the file discovery order the walk happens to produce", () => {
    const files = asPayloadFiles({
      "SKILL.md": textFile(["# alpha"]),
      "references/b.md": textFile(["b"]),
      "references/a.md": textFile(["a"]),
    });

    expect(computeCanonicalSkillPayloadHash([...files].reverse())).toBe(
      computeCanonicalSkillPayloadHash(files),
    );
    expect(computeCanonicalSkillPayloadHash(files)).toBe(
      computeCanonicalSkillPayloadHash(files),
    );
  });

  it("still covers the path, so content moved between files is a different payload", () => {
    const named = asPayloadFiles({
      "a.md": textFile(["x"]),
      "b.md": textFile(["y"]),
    });
    const swapped = asPayloadFiles({
      "a.md": textFile(["y"]),
      "b.md": textFile(["x"]),
    });

    expect(computeCanonicalSkillPayloadHash(named)).not.toBe(
      computeCanonicalSkillPayloadHash(swapped),
    );
  });
});

// ---------------------------------------------------------------------------
// Committing, and the ignore rules the check is willing to read.
// ---------------------------------------------------------------------------

describe("skills lock: what must not be committed", () => {
  it("fails when a directory the ignore rules hand to something else has tracked files", async () => {
    const { files } = await fixture({
      ignore: `${SKILLS_PAYLOAD_DIRECTORY}/alpha/\n.claude/\n`,
      skills: { alpha: { files: LF_SKILL } },
      tracked: {
        ".claude": ["claude/skills/alpha"],
        ".agents/skills/alpha": [
          "agents/skills/alpha/SKILL.md",
          "agents/skills/alpha/references/faq.md",
        ],
      },
    });

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(false);
    expect(
      report.problems
        .filter((problem) => problem.code === "payload-tracked-while-ignored")
        .map((problem) => problem.subject),
    ).toEqual([".agents/skills/alpha", ".claude"]);
    expect(formatSkillsLockReport(report)).toContain("claude/skills/alpha");
  });

  it("accepts an ignored payload that is on disk and untracked", async () => {
    const { files } = await fixture({
      ignore: `${SKILLS_PAYLOAD_DIRECTORY}/alpha/\n.claude/\n`,
      skills: { alpha: { files: LF_SKILL } },
    });

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(true);
    expect(
      report.problems.filter(
        (problem) => problem.code === "payload-tracked-while-ignored",
      ),
    ).toEqual([]);
  });

  it("accepts the hand-kept tracked payload that no ignore rule covers", async () => {
    const { files } = await fixture({
      ignore: "# nothing ignored\n",
      skills: { "typesafe-ai": { files: LF_SKILL } },
      tracked: {
        ".agents/skills/typesafe-ai": ["agents/skills/typesafe-ai/SKILL.md"],
      },
    });

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(true);
    expect(report.skills[0]).toMatchObject({
      name: "typesafe-ai",
      expectation: "tracked",
      status: "ok",
    });
  });

  it("leaves unrelated tracked files and unrelated ignore rules alone", async () => {
    const { files } = await fixture({
      ignore: "dist/\ncoverage/\n",
      skills: { alpha: { files: LF_SKILL } },
      tracked: { dist: [], coverage: [], "src/alpha.ts": ["src/alpha.ts"] },
    });

    const report = await checkSkillsLock({ files });

    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("fails on a payload directory the lock does not name", async () => {
    const { files } = await fixture({
      skills: { alpha: { files: LF_SKILL } },
      strays: ["zeta"],
    });

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(false);
    expect(failures(report)).toEqual(["payload-undeclared"]);
    expect(report.problems[0]!.subject).toBe("zeta");
  });

  it("says tracking was unverifiable instead of calling it clean or dirty", async () => {
    const { files } = await fixture({
      skills: { alpha: { files: LF_SKILL } },
      trackingUnverifiable: true,
    });

    const report = await checkSkillsLock({ files });

    expect(report.ok).toBe(true);
    expect(codes(report)).toEqual(["tracking-unverifiable"]);
    expect(report.problems[0]!.severity).toBe("note");
  });

  it("takes directory rules and ignores everything it does not model", () => {
    expect(
      ignoredDirectoryRules(
        [
          "# a comment",
          "",
          "dist/",
          "/.claude/",
          "!dist/keep/",
          "node_modules",
          "*.log",
          ".vscode/*",
          "build/",
        ].join("\n"),
      ),
    ).toEqual(["dist", ".claude", "build"]);
  });
});

// ---------------------------------------------------------------------------
// Both records parse on their own terms.
// ---------------------------------------------------------------------------

describe("skills lock: the two documents", () => {
  it("reads a well-formed lock entry into the payload path it locks", async () => {
    const { files } = await fixture({ skills: { alpha: { files: LF_SKILL } } });
    const text = await files.readTextFile(SKILLS_LOCK_FILE);

    const parsed = parseSkillsLock(text!, SKILLS_PAYLOAD_DIRECTORY);

    expect(parsed.declarationsRead).toBe(true);
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries[0]!.payloadPath).toBe(".agents/skills/alpha");
  });

  it("names every skill the lock declares, including a malformed entry", () => {
    const parsed = parseSkillsLock(
      JSON.stringify({
        version: 1,
        skills: { broken: "not an object", fine: {} },
      }),
      SKILLS_PAYLOAD_DIRECTORY,
    );

    expect(parsed.declared).toEqual(["broken", "fine"]);
    expect(parsed.entries).toEqual([]);
    expect(parsed.problems.map((problem) => problem.code)).toEqual([
      "entry-malformed",
      "entry-malformed",
    ]);
  });

  it("reports a lock it cannot read without pretending the skills are gone", () => {
    for (const [text, code] of [
      ["{ not json", "lock-malformed"],
      [JSON.stringify({ version: 1 }), "lock-malformed"],
      [JSON.stringify({ skills: {} }), "lock-malformed"],
      [JSON.stringify({ version: 99, skills: {} }), "lock-version-unsupported"],
    ] as const) {
      const parsed = parseSkillsLock(text, SKILLS_PAYLOAD_DIRECTORY);
      expect(parsed.declarationsRead, code).toBe(false);
      expect(
        parsed.problems.map((problem) => problem.code),
        code,
      ).toEqual([code]);
    }
  });

  it("reports a lock hash that is not a bare lowercase digest", () => {
    const parsed = parseSkillsLock(
      JSON.stringify({
        version: 1,
        skills: {
          alpha: {
            source: "example/alpha",
            sourceType: "github",
            skillPath: "skills/alpha/SKILL.md",
            computedHash: "sha256:whatever",
          },
        },
      }),
      SKILLS_PAYLOAD_DIRECTORY,
    );

    expect(parsed.entries).toEqual([]);
    expect(parsed.problems.map((problem) => problem.code)).toEqual([
      "hash-format-unsupported",
    ]);
  });

  it("reads the pins file's own terms rather than assuming them", () => {
    const parsed = parseSkillsPins(
      JSON.stringify({
        version: 1,
        hash: { algorithm: "sha256", lineEndings: "lf" },
        skills: { alpha: "a".repeat(64) },
      }),
    );

    expect(parsed.declarationsRead).toBe(true);
    expect(parsed.pins.get("alpha")).toBe("a".repeat(64));
    expect(parsed.problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The check touches nothing, and reaches nothing.
// ---------------------------------------------------------------------------

describe("skills lock: the check is read-only", () => {
  it("writes neither record, nor the payload, nor the ignore file", async () => {
    const { root, files } = await fixture({
      skills: { alpha: { files: LF_SKILL }, beta: { files: LF_SKILL } },
      strays: ["zeta"],
    });
    const before = await snapshot(root);

    await checkSkillsLock({ files });

    expect(await snapshot(root)).toEqual(before);
  });

  it("reads only what it was asked about, through the injected port", async () => {
    const asked: string[] = [];
    const { files } = await fixture({ skills: { alpha: { files: LF_SKILL } } });
    const watched: SkillsLockFiles = {
      readTextFile: (path) => {
        asked.push(`read ${path}`);
        return files.readTextFile(path);
      },
      listDirectory: (path) => {
        asked.push(`list ${path}`);
        return files.listDirectory(path);
      },
      readPayload: (path) => {
        asked.push(`payload ${path}`);
        return files.readPayload(path);
      },
      listTrackedFiles: (path) => {
        asked.push(`tracked ${path}`);
        return files.listTrackedFiles(path);
      },
    };

    await checkSkillsLock({ files: watched });

    expect(asked).toEqual([
      `read ${SKILLS_LOCK_FILE}`,
      `read ${SKILLS_PINS_FILE}`,
      `read ${SKILLS_IGNORE_FILE}`,
      `payload ${SKILLS_PAYLOAD_DIRECTORY}/alpha`,
      `tracked ${SKILLS_PAYLOAD_DIRECTORY}/alpha`,
      `list ${SKILLS_PAYLOAD_DIRECTORY}`,
    ]);
  });
});
