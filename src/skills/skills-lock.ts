import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Skill payload integrity: two contracts, kept apart on purpose.
 *
 * The repository installs skills from upstream repositories into
 * `.agents/skills/<name>/` with the third-party `skills` CLI and commits the
 * **lock**, not the payload (see ADR-044 for the tooling-state rule this follows
 * and ADR-064 for this check). Before this module the convention was documented in
 * `.gitignore` comments and `skills-lock.json` itself: the lock is the source of
 * truth, the payload is a local cache of it, and tracking 158 upstream files we do
 * not own would only produce drift. Nothing enforced any of that — a payload could
 * be edited, deleted, or committed, and the only way to notice was to read the
 * hashes by hand.
 *
 * This module is the enforcement, and it enforces two different things against two
 * different records, because conflating them is what made the first attempt at this
 * check either wrong or unfalsifiable:
 *
 * - **`skills-lock.json`** — the external, installer-owned file. It says which skills
 *   are installed and from which upstream revision. Its `computedHash` is the
 *   installer's own working-tree hash: this module reproduces it exactly and reports
 *   it, but never redefines what it means.
 * - **`skills-lock.pins.json`** — this repository's own canonical record of what each
 *   payload's *content* is, in a form that does not depend on the host that installed
 *   it. This is the record the check decides on.
 *
 * ## Why two records
 *
 * `skills-lock.json` v1 cannot carry a portable content pin, and that is a property
 * of the format rather than a defect in this repository.
 *
 * The installer's `computeSkillFolderHash`, reproduced exactly in
 * `computeSkillPayloadHash` below, hashes a **materialised working tree**, line
 * endings included. Those bytes come from whichever host ran `skills add`: the CLI
 * clones the upstream repository and hashes what that clone checked out, so a host
 * with `core.autocrlf` enabled records CRLF and a host without it records LF for the
 * same upstream revision. There is no canonicalisation switch to reach for —
 * `skills@1.5.26` and `skills@1.7.0` expose no line-ending, `eol` or `autocrlf`
 * option anywhere — so one skill installs to two different `computedHash` values,
 * and the value a lock carries says as much about the machine that wrote it as about
 * the content it pins.
 *
 * Under this repository's `* text=auto eol=lf` that stops being theoretical. The
 * installed payload is untracked and keeps whatever the installer wrote (CRLF here),
 * while a **tracked** payload is stored and checked out LF, so its `computedHash` pin
 * is unreachable on any platform. The two skills locked today sit on opposite sides
 * of exactly that line.
 *
 * The installer does contain a portable identity — `skillFolderHash`, the 40-hex git
 * tree SHA of the upstream folder, which its own update path prefers and falls back
 * from `computedHash` to reach. It is still the wrong identity for *this*
 * repository's guarantee: it pins the **upstream** folder rather than the payload in
 * this checkout, it belongs to the global-install flavour of the lock, and deriving
 * it needs the GitHub tree API or a clone. A guarantee that needs the network is not
 * one this check can make.
 *
 * So the two contracts stay separate: `skills-lock.json` keeps exactly the meaning
 * the installer gives it, and `skills-lock.pins.json` states this repository's own
 * canonical form — **CRLF normalised to LF, every other byte identical**, which is
 * the policy `.gitattributes` already declares for every file here. Enforcing that
 * form is what makes one pin verifiable from a Windows install, a Linux install and a
 * committed checkout alike.
 *
 * This module is **read-only by construction**: it opens files, hashes them, and
 * reports. It never rewrites either record, never repairs a payload, never installs
 * anything, and never reaches the network. A mismatch is a finding to act on, not
 * something the check is allowed to paper over.
 *
 * ## The installer's hash, reproduced exactly
 *
 * `skills-lock.json` is written by the `skills` CLI, so "does this payload match the
 * pin?" can only mean "does it hash the way the installer hashed it". The CLI's
 * `computeSkillFolderHash` is:
 *
 * ```js
 * files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
 * const hash = createHash("sha256");
 * for (const file of files) {
 *   hash.update(file.relativePath);   // POSIX-relative path, UTF-8
 *   hash.update(file.content);        // raw bytes, no normalisation
 * }
 * return hash.digest("hex");
 * ```
 *
 * where the walk is recursive and skips `.git` and `node_modules`. Three properties
 * of that are load-bearing and are reproduced rather than improved on:
 *
 * 1. **Raw bytes.** The hash covers exactly what was on disk, line endings
 *    included. Nothing is normalised before hashing, because normalising here would
 *    answer a different question than the one the lock asked.
 * 2. **Path and content are separate updates.** Concatenating them with a separator
 *    would be a different digest.
 * 3. **`localeCompare` ordering.** The installer sorts with `localeCompare`, not
 *    `<`. For this repository's payloads the two agree, but the point of this module
 *    is to reproduce the installer, not to have an opinion about collation.
 *
 * One weakness is inherited along with them, and is named here rather than fixed:
 * a path and its content are hashed with nothing between them, so two different
 * payloads can in principle collide — `{ "a.md": "b.md" }` and `"a.md"` +
 * `"b.md"` as a pair. Accepting that is the point of reproducing the installer
 * exactly: a "better" hash would disagree with every pin already written, which is
 * precisely the failure this module exists to catch.
 *
 * `computeSkillPayloadHash` is exported so the same function that reproduces the
 * installer can be exercised directly against a real `skills-lock.json` pin by a test.
 *
 * ## Which payloads must be there, and which must not be committed
 *
 * A lock entry's payload directory is `.agents/skills/<name>`. Whether its absence
 * is acceptable follows from `.gitignore`, which already states the repository's
 * intent, so this check derives it instead of holding a second list of paths that
 * could fall out of step with the first:
 *
 * - **Declared ignored** (`.agents/skills/hindsight-docs/`): a local install. Absent
 *   is normal on a fresh clone and is reported as `not-installed`; present must match
 *   the canonical content pin exactly.
 * - **Not declared ignored** (`.agents/skills/typesafe-ai/`, the hand-kept copy):
 *   repository content that git owns. Absent is a failure — git guarantees it.
 *
 * The same derivation answers the other half: a directory `.gitignore` declares
 * ignored must contain **nothing tracked**. Git neither untracks a file that a new
 * ignore rule covers nor refuses to commit one that already exists, so "ignored"
 * silently loses its meaning the moment a payload is added with `git add -f`. That
 * single rule covers `.claude/` and the vendored payload without naming either.
 *
 * ## What the canonical form permits, and what it does not
 *
 * `canonicalSkillPayload` is one rule applied to every payload, not a per-payload
 * allowance: `CRLF` becomes `LF` and **nothing else moves**. A lone `CR` that is not
 * part of a pair is left alone, so a payload that legitimately contains carriage
 * returns is not rewritten into different content. The transform is total and
 * deterministic, which is the whole property being bought — the same content
 * installed on a host with `core.autocrlf`, installed on one without it, and
 * committed to this repository all produce one hash.
 *
 * Everything else still fails, and fails on the canonical hash rather than on some
 * rendering of it: a changed byte, a renamed or moved file, an added file, a removed
 * file, and any change to the set of files. What it deliberately does **not** catch is
 * a pure line-ending rewrite, because under the policy this repository declares for
 * every file it owns, that is not a content change — it is the difference between how
 * two hosts spell the same file, and failing on it would put host-dependence back into
 * the guarantee.
 *
 * The installer's `computedHash` is still read, still reproduced and still reported,
 * as a **note** and never as a verdict. When it disagrees with a payload's raw bytes
 * the check says which rendering the installer recorded, so a reader can see that the
 * external lock was written on a different host instead of having to guess. That is a
 * diagnosis of the external record, and it is not part of this repository's guarantee.
 *
 * ## The honest limit
 *
 * A pin records content, not provenance. It cannot prove that a payload came from the
 * revision the external lock names; it proves that the payload is the content this
 * repository agreed to, and that an edit, a deletion or an addition is therefore a
 * visible, deliberate act rather than a silent one. The relationship to upstream is
 * asserted by the external lock's `source` and `skillPath`, checked here only for
 * shape.
 *
 * The check runs inside the existing `pnpm test` step rather than as a new
 * `scripts/verify.sh` step, so the pipeline's documented "1..7 (unchanged)" contract
 * (RFC §32.4) still holds — the same reasoning that put the repository's other drift
 * guards in `tests/`. See DECISIONS.md ADR-064, and ADR-044 for the rule that local
 * agent-tooling state is never committed.
 */

/**
 * The lock the installer reads and writes, at the project root. This file belongs to
 * the `skills` CLI; this repository reads it and never redefines it.
 */
export const SKILLS_LOCK_FILE = "skills-lock.json";

/**
 * This repository's own canonical record of what each locked payload's content is.
 *
 * Deliberately a separate file rather than an extra field inside the lock. The lock
 * is rewritten wholesale by the installer on every `skills add`, and its writer
 * happening to carry unknown fields through today is undocumented behaviour to bet a
 * repository guarantee on. A separate file makes the boundary visible instead of
 * implicit: everything in `skills-lock.json` is the installer's, everything in
 * `skills-lock.pins.json` is this repository's.
 */
export const SKILLS_PINS_FILE = "skills-lock.pins.json";

/** Where the installer materialises a payload, relative to the project root. */
export const SKILLS_PAYLOAD_DIRECTORY = ".agents/skills";

/** The repository's ignore rules, which decide what must not be committed. */
export const SKILLS_IGNORE_FILE = ".gitignore";

/**
 * The lock format this check understands. The installer's own reader treats an
 * older `version` as an empty lock rather than migrating it, so a version this
 * check does not know is reported instead of guessed at.
 */
export const SUPPORTED_SKILLS_LOCK_VERSION = 1;

/** The repository pins file's version, advanced only if its meaning changes. */
export const SUPPORTED_SKILLS_PINS_VERSION = 1;

/** The only digest the pins file may name. */
export const SKILLS_PIN_ALGORITHM = "sha256";

/**
 * The only canonicalisation the pins file may name.
 *
 * Named in the file rather than assumed by the reader, so that changing the
 * canonical form later is a loud, versioned act instead of a silent
 * reinterpretation of pins written under the old one.
 */
export const SKILLS_PIN_LINE_ENDINGS = "lf";

/** A bare lowercase hex digest, with no algorithm prefix. */
const CONTENT_HASH = /^[a-f0-9]{64}$/;

export interface SkillPayloadFile {
  /** POSIX-style path relative to the payload root, e.g. `references/faq.md`. */
  readonly path: string;
  /** The file's raw bytes, exactly as the filesystem holds them. */
  readonly bytes: Uint8Array;
}

/**
 * Everything this check needs from the outside world.
 *
 * Injected rather than imported so the check can be exercised against fixtures and
 * against the real repository with the same code, and so no test has to create a
 * git repository to test a hash. Every method answers `undefined` for "not there"
 * and is expected to throw only for a genuine read error.
 */
export interface SkillsLockFiles {
  readTextFile(relativePath: string): Promise<string | undefined>;
  /** Names of a directory's entries, or `undefined` when it does not exist. */
  listDirectory(relativePath: string): Promise<readonly string[] | undefined>;
  /**
   * Every file under a directory, recursively, or `undefined` when the directory
   * does not exist. Order is irrelevant: the hash sorts.
   */
  readPayload(
    relativePath: string,
  ): Promise<readonly SkillPayloadFile[] | undefined>;
  /**
   * Repository-relative paths git has tracked under a directory. `undefined` means
   * tracking could not be determined at all — not that nothing is tracked.
   */
  listTrackedFiles(
    relativePath: string,
  ): Promise<readonly string[] | undefined>;
}

export interface SkillsLockEntry {
  readonly name: string;
  readonly source: string;
  readonly sourceType: string;
  /** Where the skill lives in the upstream repository. */
  readonly skillPath: string;
  /** The installer's own working-tree hash. Reproduced and reported, never enforced. */
  readonly computedHash: string;
  /** This repository's payload directory for the skill. */
  readonly payloadPath: string;
}

export type SkillsLockProblemCode =
  | "lock-unreadable"
  | "lock-malformed"
  | "lock-version-unsupported"
  | "entry-malformed"
  | "hash-format-unsupported"
  | "pins-unreadable"
  | "pins-malformed"
  | "pins-version-unsupported"
  | "pins-form-unsupported"
  | "pin-missing"
  | "pin-undeclared"
  | "payload-missing"
  | "payload-not-installed"
  | "payload-unreadable"
  | "payload-undeclared"
  | "payload-tracked-while-ignored"
  | "hash-mismatch"
  | "installer-pin-differs"
  | "tracking-unverifiable";

export interface SkillsLockProblem {
  /**
   * `fail` means the lock and the checkout disagree and something has to change.
   * `note` records a fact the reader needs in order to read the check honestly —
   * an uninstalled payload, a line-ending rendering, an unverifiable one.
   */
  readonly severity: "fail" | "note";
  readonly code: SkillsLockProblemCode;
  /** The skill the problem is about, or the file when it is not about a skill. */
  readonly subject: string;
  readonly message: string;
  readonly payloadPath?: string;
  readonly expectedHash?: string;
  readonly actualHash?: string;
}

/** How a payload's presence is judged, derived from the ignore rules. */
export type SkillPayloadExpectation = "installed" | "tracked";

export interface SkillPayloadCheck {
  readonly name: string;
  readonly payloadPath: string;
  readonly expectation: SkillPayloadExpectation;
  /**
   * The repository's canonical pin. This is what the status is decided on, and it is
   * absent only when this repository has no pin for the skill at all.
   */
  readonly expectedHash?: string;
  readonly status: "ok" | "not-installed" | "fail";
  /** The payload's canonical hash. Present only when the payload exists. */
  readonly actualHash?: string;
  /** The installer's `computedHash`, for diagnosis. Never a verdict. */
  readonly installerHash?: string;
  /**
   * True when the payload's raw bytes also satisfy the installer's own pin, i.e.
   * this checkout was installed by a host whose line endings the lock records.
   */
  readonly installerPinMatchesRawBytes?: boolean;
  readonly detail: string;
}

export interface SkillsLockCheck {
  readonly lockPath: string;
  readonly pinsPath: string;
  readonly ignorePath: string;
  readonly lockVersion?: number;
  readonly pinsVersion?: number;
  readonly skills: readonly SkillPayloadCheck[];
  readonly problems: readonly SkillsLockProblem[];
  /** Every problem is a note. */
  readonly ok: boolean;
  /** 0 when the lock, the pins and the checkout agree. */
  readonly exitCode: number;
}

export interface SkillsLockCheckOptions {
  readonly files: SkillsLockFiles;
  readonly lockPath?: string;
  readonly pinsPath?: string;
  readonly payloadDirectory?: string;
  readonly ignorePath?: string;
}

// ---------------------------------------------------------------------------
// The hash. One implementation, and it is the installer's.
// ---------------------------------------------------------------------------

/**
 * The installer's `computeSkillFolderHash`, reproduced exactly.
 *
 * Exported because this is the repository's definition of "the same content" for a
 * skill payload: the check compares against it, and a test that wants to state a
 * pin's meaning directly should use it rather than re-deriving it.
 */
export function computeSkillPayloadHash(
  files: readonly SkillPayloadFile[],
): string {
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash("sha256");
  for (const file of ordered) {
    // Two updates, in this order. The installer does the same; joining them would
    // be a different digest for the same payload.
    hash.update(file.path);
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}

/**
 * This repository's canonical form for a payload: `CRLF` normalised to `LF`.
 *
 * The rule is applied to every file and changes nothing else. Bytes are moved through
 * latin-1, which round-trips all 256 values exactly, so a payload holding arbitrary
 * binary content survives unchanged apart from the pair being collapsed; a lone `CR`
 * is not a line ending here and is left alone. The transform is total and
 * deterministic — that is the entire reason it exists, because it is what lets one
 * pin cover the same content installed on a host with `core.autocrlf` and on one
 * without it.
 *
 * It is stated here once, and named in `skills-lock.pins.json` as
 * `hash.lineEndings`, so that a future change to it is a versioned act rather than a
 * silent reinterpretation of pins already written.
 */
export function canonicalSkillPayload(
  files: readonly SkillPayloadFile[],
): readonly SkillPayloadFile[] {
  return files.map((file) => ({
    path: file.path,
    bytes: Buffer.from(
      Buffer.from(file.bytes).toString("binary").replace(/\r\n/g, "\n"),
      "binary",
    ),
  }));
}

/**
 * The repository's content identity for a payload: the installer's algorithm over the
 * canonical form.
 *
 * Sharing the walk order, the sort and the update sequence with
 * `computeSkillPayloadHash` is deliberate — the two differ only in which bytes they
 * read, so there is one layout rule in this module and not two that could drift.
 */
export function computeCanonicalSkillPayloadHash(
  files: readonly SkillPayloadFile[],
): string {
  return computeSkillPayloadHash(canonicalSkillPayload(files));
}

// ---------------------------------------------------------------------------
// The lock document.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a lock document into entries and problems.
 *
 * A malformed *entry* is reported and skipped; it does not stop the entries around
 * it from being checked, because a lock with one bad entry is still a lock whose
 * other skills can be verified. A malformed *document* leaves nothing to check, so
 * it produces exactly one problem and no entries.
 */
export function parseSkillsLock(
  text: string,
  payloadDirectory: string,
): {
  readonly entries: readonly SkillsLockEntry[];
  readonly problems: readonly SkillsLockProblem[];
  readonly version?: number;
  /**
   * Every skill name the document lists, whether or not its entry parsed. A lock
   * whose entry is malformed still *declares* the skill: the problem is the entry,
   * not the presence of a payload directory.
   */
  readonly declared: readonly string[];
  /**
   * Whether the declarations were read at all. When they were not, nothing here is
   * a statement about a skill, so callers must not compare the checkout's payload
   * directories against the (empty) list and call every one of them undeclared.
   */
  readonly declarationsRead: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      declarationsRead: false,
      declared: [],
      entries: [],
      problems: [
        {
          severity: "fail",
          code: "lock-malformed",
          subject: SKILLS_LOCK_FILE,
          message: `not valid JSON: ${reason}`,
        },
      ],
    };
  }

  if (!isRecord(parsed)) {
    return {
      declarationsRead: false,
      declared: [],
      entries: [],
      problems: [
        {
          severity: "fail",
          code: "lock-malformed",
          subject: SKILLS_LOCK_FILE,
          message: "the document is not a JSON object",
        },
      ],
    };
  }

  const version = parsed["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return {
      declarationsRead: false,
      declared: [],
      entries: [],
      problems: [
        {
          severity: "fail",
          code: "lock-malformed",
          subject: SKILLS_LOCK_FILE,
          message: 'has no integer "version" field',
        },
      ],
    };
  }
  if (version > SUPPORTED_SKILLS_LOCK_VERSION) {
    return {
      declarationsRead: false,
      declared: [],
      version,
      entries: [],
      problems: [
        {
          severity: "fail",
          code: "lock-version-unsupported",
          subject: SKILLS_LOCK_FILE,
          message: `version ${version} is newer than the supported version ${SUPPORTED_SKILLS_LOCK_VERSION}`,
        },
      ],
    };
  }

  const skills = parsed["skills"];
  if (!isRecord(skills)) {
    return {
      declarationsRead: false,
      declared: [],
      version,
      entries: [],
      problems: [
        {
          severity: "fail",
          code: "lock-malformed",
          subject: SKILLS_LOCK_FILE,
          message: 'has no "skills" object',
        },
      ],
    };
  }

  const entries: SkillsLockEntry[] = [];
  const problems: SkillsLockProblem[] = [];

  for (const [name, value] of Object.entries(skills)) {
    const payloadPath = `${payloadDirectory}/${name}`;
    if (!isRecord(value)) {
      problems.push({
        severity: "fail",
        code: "entry-malformed",
        subject: name,
        message: "the entry is not an object",
        payloadPath,
      });
      continue;
    }

    const required = ["source", "sourceType", "skillPath"] as const;
    const missing = required.filter(
      (field) => typeof value[field] !== "string" || value[field] === "",
    );
    if (missing.length > 0) {
      problems.push({
        severity: "fail",
        code: "entry-malformed",
        subject: name,
        message: `the entry is missing ${missing.join(", ")}`,
        payloadPath,
      });
      continue;
    }

    const computedHash = value["computedHash"];
    if (typeof computedHash !== "string") {
      problems.push({
        severity: "fail",
        code: "entry-malformed",
        subject: name,
        message: "the entry has no computedHash",
        payloadPath,
      });
      continue;
    }
    if (!CONTENT_HASH.test(computedHash)) {
      problems.push({
        severity: "fail",
        code: "hash-format-unsupported",
        subject: name,
        message: `computedHash is not a bare lowercase SHA-256 (64 hex characters): ${JSON.stringify(computedHash)}`,
        payloadPath,
        expectedHash: computedHash,
      });
      continue;
    }

    entries.push({
      name,
      source: value["source"] as string,
      sourceType: value["sourceType"] as string,
      skillPath: value["skillPath"] as string,
      computedHash,
      payloadPath,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return {
    declarationsRead: true,
    declared: Object.keys(skills).sort(),
    version,
    entries,
    problems,
  };
}

// ---------------------------------------------------------------------------
// The repository's own pins.
// ---------------------------------------------------------------------------

export interface SkillsPinsParseResult {
  readonly version?: number;
  readonly pins: ReadonlyMap<string, string>;
  /** Every skill name the file lists, whether or not its pin parsed. */
  readonly declared: readonly string[];
  readonly problems: readonly SkillsLockProblem[];
  /**
   * Whether the pins could be read at all. False means the file's own terms are
   * unknown — an unsupported version, or a hash form this code does not implement —
   * in which case no pin may be compared against, and every locked skill is reported
   * as unverifiable rather than as missing.
   */
  readonly declarationsRead: boolean;
}

/**
 * Reads `skills-lock.pins.json` into a name → canonical hash map.
 *
 * The file states its own terms — algorithm and line endings — and both are checked
 * rather than assumed. A pins file whose terms this code does not implement is
 * reported and yields no pins: comparing a SHA-256-of-LF pin against a payload that
 * was pinned under some future form would be the one failure mode this whole design
 * exists to avoid, an answer that looks right and means something else.
 */
export function parseSkillsPins(text: string): SkillsPinsParseResult {
  const malformed = (message: string): SkillsPinsParseResult => ({
    declarationsRead: false,
    pins: new Map(),
    declared: [],
    problems: [
      {
        severity: "fail",
        code: "pins-malformed",
        subject: SKILLS_PINS_FILE,
        message,
      },
    ],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return malformed(`not valid JSON: ${reason}`);
  }
  if (!isRecord(parsed)) {
    return malformed("the document is not a JSON object");
  }

  const version = parsed["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return malformed('has no integer "version" field');
  }
  if (version > SUPPORTED_SKILLS_PINS_VERSION) {
    return {
      declarationsRead: false,
      pins: new Map(),
      declared: [],
      version,
      problems: [
        {
          severity: "fail",
          code: "pins-version-unsupported",
          subject: SKILLS_PINS_FILE,
          message: `version ${version} is newer than the supported version ${SUPPORTED_SKILLS_PINS_VERSION}`,
        },
      ],
    };
  }

  const hash = parsed["hash"];
  if (!isRecord(hash)) {
    return {
      declarationsRead: false,
      pins: new Map(),
      declared: [],
      version,
      problems: [
        {
          severity: "fail",
          code: "pins-malformed",
          subject: SKILLS_PINS_FILE,
          message: 'has no "hash" object describing how the pins were computed',
        },
      ],
    };
  }
  const algorithm = hash["algorithm"];
  const lineEndings = hash["lineEndings"];
  if (
    algorithm !== SKILLS_PIN_ALGORITHM ||
    lineEndings !== SKILLS_PIN_LINE_ENDINGS
  ) {
    return {
      declarationsRead: false,
      pins: new Map(),
      declared: [],
      version,
      problems: [
        {
          severity: "fail",
          code: "pins-form-unsupported",
          subject: SKILLS_PINS_FILE,
          message:
            `declares hash({algorithm: ${JSON.stringify(algorithm)}, lineEndings: ${JSON.stringify(lineEndings)}}), ` +
            `but this check implements hash({algorithm: ${JSON.stringify(SKILLS_PIN_ALGORITHM)}, lineEndings: ${JSON.stringify(SKILLS_PIN_LINE_ENDINGS)}})`,
        },
      ],
    };
  }

  const skills = parsed["skills"];
  if (!isRecord(skills)) {
    return {
      declarationsRead: false,
      pins: new Map(),
      declared: [],
      version,
      problems: [
        {
          severity: "fail",
          code: "pins-malformed",
          subject: SKILLS_PINS_FILE,
          message: 'has no "skills" object',
        },
      ],
    };
  }

  const pins = new Map<string, string>();
  const problems: SkillsLockProblem[] = [];
  for (const [name, value] of Object.entries(skills)) {
    if (typeof value !== "string" || !CONTENT_HASH.test(value)) {
      problems.push({
        severity: "fail",
        code: "pins-malformed",
        subject: name,
        message: `the pin is not a bare lowercase ${SKILLS_PIN_ALGORITHM} digest (64 hex characters): ${JSON.stringify(value)}`,
      });
      continue;
    }
    pins.set(name, value);
  }

  return {
    declarationsRead: true,
    pins,
    declared: Object.keys(skills).sort(),
    version,
    problems,
  };
}

// ---------------------------------------------------------------------------
// The ignore rules, read as the repository's statement of intent.
// ---------------------------------------------------------------------------

/**
 * Directory paths a `.gitignore` declares ignored, trimmed of the trailing `/`.
 *
 * Deliberately a documented subset, in the same spirit as the context engine's
 * gitignore reader (`src/context/ignore.ts`): comments, blanks and negations are
 * skipped, and a rule is only treated as a directory rule — and thus as a claim
 * that nothing beneath it is committed — when it arrives as a directory path with no
 * wildcard. A pattern this check does not model is skipped rather than
 * approximated, because a rule that quietly does not apply is how a committed
 * payload passes a check meant to catch it.
 */
export function ignoredDirectoryRules(ignoreText: string): readonly string[] {
  const directories: string[] = [];
  for (const raw of ignoreText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    if (!line.endsWith("/")) {
      continue;
    }
    const directory = line.slice(0, -1).replace(/^\//, "");
    if (directory === "" || /[*?[\]]/.test(directory)) {
      continue;
    }
    directories.push(directory);
  }
  return directories;
}

/** True when a path is an ignored directory, or anything inside one. */
function isIgnoredPath(
  ignoredDirectories: readonly string[],
  path: string,
): boolean {
  return ignoredDirectories.some(
    (directory) => path === directory || path.startsWith(`${directory}/`),
  );
}

// ---------------------------------------------------------------------------
// The check.
// ---------------------------------------------------------------------------

function failure(
  code: SkillsLockProblemCode,
  subject: string,
  message: string,
  extra: Omit<SkillsLockProblem, "severity" | "code" | "subject" | "message">,
): SkillsLockProblem {
  return { severity: "fail", code, subject, message, ...extra };
}

function note(
  code: SkillsLockProblemCode,
  subject: string,
  message: string,
  extra: Omit<SkillsLockProblem, "severity" | "code" | "subject" | "message">,
): SkillsLockProblem {
  return { severity: "note", code, subject, message, ...extra };
}

/**
 * Verifies every locked skill's payload against this repository's canonical pin, and
 * that nothing the ignore rules hand away has been committed.
 *
 * One function on purpose: these are one question — "is `skills-lock.json` still true
 * of this checkout?" — and splitting them would let a caller run only the half that
 * passes. The verdict is always the canonical hash; the installer's own hash is
 * reproduced and reported, and never decides anything.
 */
export async function checkSkillsLock(
  options: SkillsLockCheckOptions,
): Promise<SkillsLockCheck> {
  const lockPath = options.lockPath ?? SKILLS_LOCK_FILE;
  const pinsPath = options.pinsPath ?? SKILLS_PINS_FILE;
  const payloadDirectory = options.payloadDirectory ?? SKILLS_PAYLOAD_DIRECTORY;
  const ignorePath = options.ignorePath ?? SKILLS_IGNORE_FILE;
  const { files } = options;

  const problems: SkillsLockProblem[] = [];

  let lockText: string | undefined;
  let lockUnreadable: string | undefined;
  try {
    lockText = await files.readTextFile(lockPath);
  } catch (error) {
    lockUnreadable = describeError(error);
  }
  if (lockUnreadable !== undefined) {
    problems.push(
      failure(
        "lock-unreadable",
        lockPath,
        `could not be read: ${lockUnreadable}`,
        {},
      ),
    );
  } else if (lockText === undefined) {
    problems.push(failure("lock-unreadable", lockPath, "does not exist", {}));
  }

  if (lockText === undefined) {
    return {
      lockPath,
      pinsPath,
      ignorePath,
      skills: [],
      problems,
      ok: false,
      exitCode: 1,
    };
  }

  const parsed = parseSkillsLock(lockText, payloadDirectory);
  problems.push(...parsed.problems);

  // The repository's own record, read even when the lock itself failed to parse: a
  // reader should get both diagnoses from one run rather than one per run.
  let pinsText: string | undefined;
  let pinsUnreadable: string | undefined;
  try {
    pinsText = await files.readTextFile(pinsPath);
  } catch (error) {
    pinsUnreadable = describeError(error);
  }
  if (pinsUnreadable !== undefined) {
    problems.push(
      failure(
        "pins-unreadable",
        pinsPath,
        `could not be read: ${pinsUnreadable}`,
        {},
      ),
    );
  } else if (pinsText === undefined) {
    problems.push(failure("pins-unreadable", pinsPath, "does not exist", {}));
  }
  const pins = pinsText === undefined ? undefined : parseSkillsPins(pinsText);
  if (pins !== undefined) {
    problems.push(...pins.problems);
  }

  const ignoreText = (await safe(() => files.readTextFile(ignorePath))) ?? "";
  const ignoredDirectories = ignoredDirectoryRules(ignoreText);

  const skills: SkillPayloadCheck[] = [];
  for (const entry of parsed.entries) {
    const expectation: SkillPayloadExpectation = isIgnoredPath(
      ignoredDirectories,
      entry.payloadPath,
    )
      ? "installed"
      : "tracked";

    // A locked skill with no canonical pin is not verifiable at all, and that is a
    // failure rather than a skip: the external lock would then be the only record, and
    // it is precisely the record that cannot be checked portably.
    const pin = pins?.pins.get(entry.name);
    if (pin === undefined) {
      const declaredInPins =
        pins?.declarationsRead === true && pins.declared.includes(entry.name);
      const reason =
        pins === undefined
          ? `${pinsPath} could not be read`
          : !pins.declarationsRead
            ? `${pinsPath} could not be understood`
            : declaredInPins
              ? `the pin for ${entry.name} in ${pinsPath} is malformed`
              : `has no canonical pin in ${pinsPath}`;
      skills.push({
        name: entry.name,
        payloadPath: entry.payloadPath,
        expectation,
        installerHash: entry.computedHash,
        status: "fail",
        detail: `not verifiable: ${reason}`,
      });
      // One finding per cause, not one per skill. A problem with the whole record, and a
      // malformed entry that has already been named, are both reported once; repeating
      // them for every locked skill would bury the diagnosis in its own restatements.
      if (pins?.declarationsRead === true && !declaredInPins) {
        problems.push(
          failure(
            "pin-missing",
            entry.name,
            `${reason}; add the pin for the payload this repository has agreed to hold`,
            {
              payloadPath: entry.payloadPath,
              expectedHash: entry.computedHash,
            },
          ),
        );
      }
      continue;
    }

    let payload: readonly SkillPayloadFile[] | undefined;
    let unreadable: string | undefined;
    try {
      payload = await files.readPayload(entry.payloadPath);
    } catch (error) {
      unreadable = describeError(error);
    }

    if (unreadable !== undefined) {
      skills.push({
        name: entry.name,
        payloadPath: entry.payloadPath,
        expectation,
        expectedHash: pin,
        installerHash: entry.computedHash,
        status: "fail",
        detail: `the payload could not be read: ${unreadable}`,
      });
      problems.push(
        failure(
          "payload-unreadable",
          entry.name,
          `the payload could not be read: ${unreadable}`,
          { payloadPath: entry.payloadPath, expectedHash: pin },
        ),
      );
      continue;
    }

    if (payload === undefined || payload.length === 0) {
      // A payload git owns must be there; a payload the ignore rules hand to the
      // installer is a local cache, and a fresh clone legitimately has none.
      if (expectation === "tracked") {
        skills.push({
          name: entry.name,
          payloadPath: entry.payloadPath,
          expectation,
          expectedHash: pin,
          installerHash: entry.computedHash,
          status: "fail",
          detail: "the payload is missing, and git tracks it",
        });
        problems.push(
          failure(
            "payload-missing",
            entry.name,
            "the locked payload is missing, and this path is not ignored so git is expected to hold it",
            { payloadPath: entry.payloadPath, expectedHash: pin },
          ),
        );
      } else {
        skills.push({
          name: entry.name,
          payloadPath: entry.payloadPath,
          expectation,
          expectedHash: pin,
          installerHash: entry.computedHash,
          status: "not-installed",
          detail: "not installed in this checkout",
        });
        problems.push(
          note(
            "payload-not-installed",
            entry.name,
            `not installed at ${entry.payloadPath}; the pin is unchanged and the payload is reproducible from it`,
            { payloadPath: entry.payloadPath, expectedHash: pin },
          ),
        );
      }
      continue;
    }

    // The single verdict. Content, canonicalised by one declared rule, against one
    // repository-owned pin — no candidate renderings, no tolerance, nothing
    // approximate.
    const actualHash = computeCanonicalSkillPayloadHash(payload);
    const rawHash = computeSkillPayloadHash(payload);
    const installerPinMatchesRawBytes = rawHash === entry.computedHash;
    const rendered = installerPinMatchesRawBytes
      ? undefined
      : installerRendering(payload, entry.computedHash);

    const base = {
      name: entry.name,
      payloadPath: entry.payloadPath,
      expectation,
      expectedHash: pin,
      actualHash,
      installerHash: entry.computedHash,
      installerPinMatchesRawBytes,
    };

    if (actualHash !== pin) {
      skills.push({
        ...base,
        status: "fail",
        detail: "the payload's canonical content differs from the pin",
      });
      problems.push(
        failure(
          "hash-mismatch",
          entry.name,
          `the payload's canonical content hashes to ${actualHash} but ${pinsPath} pins ${pin}`,
          { payloadPath: entry.payloadPath, expectedHash: pin, actualHash },
        ),
      );
      continue;
    }

    skills.push({
      ...base,
      status: "ok",
      detail: installerPinMatchesRawBytes
        ? "the payload matches the repository pin, and the installer's own hash"
        : "the payload matches the repository pin; the installer's own hash records a different line-ending rendering of the same content",
    });

    // The external record, reported and never enforced. It records the line endings of
    // the host that ran `skills add`, so disagreement here is expected whenever this
    // checkout and that host spell line endings differently — and it is worth naming
    // which rendering, because "the lock was written elsewhere" and "the lock is stale"
    // look identical from the outside otherwise.
    if (!installerPinMatchesRawBytes) {
      problems.push(
        note(
          "installer-pin-differs",
          entry.name,
          rendered === undefined
            ? `the installer's recorded hash ${entry.computedHash} matches neither the raw bytes (${rawHash}) nor either uniform line-ending rendering of this payload; the repository pin is what is enforced, but the external lock may be stale`
            : `the installer's recorded hash is the ${rendered.toUpperCase()} rendering of this same content (raw ${rawHash}); ${pinsPath} is the enforced record`,
          {
            payloadPath: entry.payloadPath,
            expectedHash: entry.computedHash,
            actualHash: rawHash,
          },
        ),
      );
    }
  }

  // Nothing that the ignore rules hand to something else may be committed. Git does
  // not untrack a file a new rule covers, so this is the only place the intent
  // stated in `.gitignore` becomes a guarantee.
  for (const directory of ignoredDirectories) {
    const tracked = await safe(() => files.listTrackedFiles(directory));
    if (tracked === undefined) {
      problems.push(
        note(
          "tracking-unverifiable",
          directory,
          "tracking could not be determined; the ignored-directory rule is unverified here",
          { payloadPath: directory },
        ),
      );
      continue;
    }
    if (tracked.length > 0) {
      problems.push(
        failure(
          "payload-tracked-while-ignored",
          directory,
          `is declared ignored by ${ignorePath} but has ${tracked.length} tracked file(s), starting with ${tracked.slice(0, 3).join(", ")}`,
          { payloadPath: directory },
        ),
      );
    }
  }

  // A payload directory the lock does not name is noise: either an install whose
  // lock entry was never written, or something dropped in by hand. Only meaningful
  // when the lock itself could be read — otherwise there is no declaration for the
  // checkout's directories to contradict, and every one of them would be noise.
  const payloadEntries = parsed.declarationsRead
    ? await safe(() => files.listDirectory(payloadDirectory))
    : undefined;
  if (payloadEntries !== undefined) {
    const declared = new Set(parsed.declared);
    for (const name of [...payloadEntries].sort()) {
      if (!declared.has(name)) {
        problems.push(
          failure(
            "payload-undeclared",
            name,
            `is present under ${payloadDirectory} but is not named in ${lockPath}`,
            { payloadPath: `${payloadDirectory}/${name}` },
          ),
        );
      }
    }
  }

  // A pin the external lock does not name is the other half of the same question: the
  // repository would be holding a content identity for a skill it no longer installs,
  // and the next `skills add` would silently be the only thing that noticed.
  if (pins?.declarationsRead === true) {
    const locked = new Set(parsed.declared);
    for (const name of pins.declared) {
      if (!locked.has(name)) {
        problems.push(
          failure(
            "pin-undeclared",
            name,
            `is pinned in ${pinsPath} but is not named in ${lockPath}`,
            { payloadPath: `${payloadDirectory}/${name}` },
          ),
        );
      }
    }
  }

  const ok = problems.every((problem) => problem.severity !== "fail");
  return {
    lockPath,
    pinsPath,
    ignorePath,
    ...(parsed.version === undefined ? {} : { lockVersion: parsed.version }),
    ...(pins?.version === undefined ? {} : { pinsVersion: pins.version }),
    skills,
    problems,
    ok,
    exitCode: ok ? 0 : 1,
  };
}

/**
 * Which uniform line-ending rendering of a payload the installer's pin describes, if
 * any. **Diagnostic only** — it never decides a status; the canonical hash does that.
 *
 * It exists so that a note can say *why* the external record disagrees with what is on
 * disk — the lock was written by a host that recorded CRLF — instead of leaving a
 * reader to guess whether the lock is stale, the payload is edited, or the host is
 * simply different. Tried in a fixed order so the reported rendering cannot depend on
 * iteration.
 */
function installerRendering(
  payload: readonly SkillPayloadFile[],
  installerHash: string,
): "lf" | "crlf" | undefined {
  for (const ending of ["crlf", "lf"] as const) {
    if (
      computeSkillPayloadHash(toLineEnding(payload, ending)) === installerHash
    ) {
      return ending;
    }
  }
  return undefined;
}

function toLineEnding(
  files: readonly SkillPayloadFile[],
  ending: "lf" | "crlf",
): readonly SkillPayloadFile[] {
  if (ending === "lf") {
    return canonicalSkillPayload(files);
  }
  return canonicalSkillPayload(files).map((file) => ({
    path: file.path,
    bytes: Buffer.from(
      Buffer.from(file.bytes).toString("binary").replace(/\n/g, "\r\n"),
      "binary",
    ),
  }));
}

async function safe<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `${code}: ${error.message}`;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

/**
 * The check as text, for a test failure message or a terminal.
 *
 * Every line a reader needs to act on is present — the skill, its payload path, the
 * canonical pin, what was found, and how the two differ — because the difference
 * between "someone edited this payload" and "this payload is not installed" is the
 * difference between a fix and a no-op, and a reader should not have to re-run anything
 * to tell them apart.
 *
 * The installer's own hash is printed as a separate line rather than beside the pin,
 * so that the two records cannot be mistaken for two votes on one question.
 */
export function formatSkillsLockReport(report: SkillsLockCheck): string {
  const lines: string[] = [];
  const lockVersion =
    report.lockVersion === undefined ? "" : ` (version ${report.lockVersion})`;
  lines.push(
    `${report.lockPath}${lockVersion}: ${report.skills.length} locked skill(s)`,
  );
  lines.push(
    `${report.pinsPath}${report.pinsVersion === undefined ? "" : ` (version ${report.pinsVersion})`}: canonical pins, enforced`,
  );

  const width = report.skills.reduce(
    (widest, skill) => Math.max(widest, skill.status.length),
    0,
  );
  for (const skill of report.skills) {
    lines.push(
      `  ${skill.status.padEnd(width)}  ${skill.name}  ${skill.payloadPath}  [${skill.expectation}]`,
    );
    lines.push(`    pinned   ${skill.expectedHash ?? "(no pin)"}`);
    lines.push(`    actual   ${skill.actualHash ?? "(none)"}`);
    if (skill.installerHash !== undefined) {
      lines.push(
        `    installer ${skill.installerHash}${skill.installerPinMatchesRawBytes === true ? " (matches the raw bytes)" : " (a rendering of this content)"}`,
      );
    }
    lines.push(`    ${skill.detail}`);
  }

  if (report.problems.length > 0) {
    lines.push("problems:");
    for (const problem of report.problems) {
      const where =
        problem.payloadPath === undefined ? "" : ` [${problem.payloadPath}]`;
      lines.push(
        `  ${problem.severity.toUpperCase().padEnd(4)}  ${problem.code}  ${problem.subject}${where}: ${problem.message}`,
      );
    }
  } else {
    lines.push("problems: none");
  }

  lines.push(report.ok ? "RESULT: ok" : "RESULT: fail");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The filesystem and git adapter.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * The real filesystem, and the real git index, rooted at a project directory.
 *
 * `git ls-files -z` is used rather than a parsed `.gitignore`-style simulation
 * because the question is about *this* repository's index, which only git can
 * answer; `-z` because a path with a space or a quote would otherwise arrive quoted.
 * A directory that is not a repository, or a machine with no git, answers
 * `undefined` — the check then says tracking was unverified rather than implying it
 * was clean.
 */
export function createNodeSkillsLockFiles(
  projectRoot: string,
): SkillsLockFiles {
  async function readTextFile(
    relativePath: string,
  ): Promise<string | undefined> {
    try {
      return await readFile(join(projectRoot, relativePath), "utf8");
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async function listDirectory(
    relativePath: string,
  ): Promise<readonly string[] | undefined> {
    try {
      const entries = await readdir(join(projectRoot, relativePath), {
        withFileTypes: true,
      });
      return entries.map((entry) => entry.name);
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async function readPayload(
    relativePath: string,
  ): Promise<readonly SkillPayloadFile[] | undefined> {
    const files: SkillPayloadFile[] = [];

    async function walk(current: string, prefix: string): Promise<void> {
      const entries = await readdir(join(projectRoot, current), {
        withFileTypes: true,
      });
      for (const entry of entries) {
        const child = `${current}/${entry.name}`;
        const childPrefix =
          prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          // The installer's walk skips these two, so the hash of a payload equals
          // the hash of the same payload inside a checkout that has either.
          if (entry.name === ".git" || entry.name === "node_modules") {
            continue;
          }
          await walk(child, childPrefix);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        files.push({
          path: childPrefix.split("\\").join("/"),
          bytes: await readFile(join(projectRoot, child)),
        });
      }
    }

    try {
      await walk(relativePath, "");
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
    return files;
  }

  async function listTrackedFiles(
    relativePath: string,
  ): Promise<readonly string[] | undefined> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["ls-files", "-z", "--", relativePath],
        { cwd: projectRoot, maxBuffer: 32 * 1024 * 1024 },
      );
      return stdout.split("\0").filter((path) => path !== "");
    } catch {
      return undefined;
    }
  }

  return { readTextFile, listDirectory, readPayload, listTrackedFiles };
}
