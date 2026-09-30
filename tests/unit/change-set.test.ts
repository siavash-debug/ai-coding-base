import { describe, expect, it } from "vitest";

import {
  CHANGE_SET_REJECTION_CODES,
  extractJsonValue,
  parseChangeSet,
} from "../../src/adapters/agent/change-set.js";

function code(text: string, limits?: Parameters<typeof parseChangeSet>[1]) {
  const result = parseChangeSet(text, limits);
  if (result.ok) {
    throw new Error("expected a rejection");
  }
  return result.reasonCode;
}

describe("change-set: extraction", () => {
  it("finds a JSON object inside prose and fences", () => {
    const text =
      'Here you go:\n```json\n{"changes":[{"ref":"a.ts","content":"x"}]}\n```\nEnjoy.';
    const value = extractJsonValue(text) as { changes: unknown[] };
    expect(value.changes).toHaveLength(1);
  });

  it("returns undefined when there is no JSON value", () => {
    expect(extractJsonValue("no json here")).toBeUndefined();
  });
});

describe("change-set: parsing", () => {
  it("accepts an object with a changes array", () => {
    const result = parseChangeSet(
      '{"changes":[{"ref":"src/text/normalize.ts","content":"export const x = 1;\\n"}]}',
    );
    expect(result).toEqual({
      ok: true,
      changes: [
        { ref: "src/text/normalize.ts", content: "export const x = 1;\n" },
      ],
    });
  });

  it("accepts a bare array and normalises separators", () => {
    const result = parseChangeSet(
      JSON.stringify([{ ref: "src\\text\\normalize.ts", content: "x" }]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changes[0]?.ref).toBe("src/text/normalize.ts");
    }
  });

  it("rejects malformed output", () => {
    expect(code("I could not do that.")).toBe("malformed-output");
  });

  it("rejects a wrong shape", () => {
    expect(code('{"changes":"nope"}')).toBe("malformed-output");
  });

  it("rejects an empty change set", () => {
    expect(code('{"changes":[]}')).toBe("empty-change-set");
  });

  it("rejects a missing ref", () => {
    expect(code('{"changes":[{"content":"x"}]}')).toBe("malformed-change");
  });

  it("rejects a missing content", () => {
    expect(code('{"changes":[{"ref":"a.ts"}]}')).toBe("malformed-change");
  });

  it("rejects an absolute path", () => {
    expect(code('{"changes":[{"ref":"/etc/passwd","content":"x"}]}')).toBe(
      "invalid-ref",
    );
  });

  it("rejects parent-directory traversal", () => {
    expect(code('{"changes":[{"ref":"../secrets.txt","content":"x"}]}')).toBe(
      "invalid-ref",
    );
  });

  it("rejects a duplicate ref", () => {
    expect(
      code(
        '{"changes":[{"ref":"a.ts","content":"1"},{"ref":"a.ts","content":"2"}]}',
      ),
    ).toBe("duplicate-ref");
  });

  it("rejects a file over the per-write limit", () => {
    expect(
      code('{"changes":[{"ref":"a.ts","content":"12345"}]}', {
        maxWriteBytes: 4,
        maxChangeSetBytes: 1_000,
        maxChangeSetFiles: 10,
      }),
    ).toBe("write-too-large");
  });

  it("rejects a total change set over the limit", () => {
    expect(
      code(
        '{"changes":[{"ref":"a.ts","content":"1234"},{"ref":"b.ts","content":"1234"}]}',
        { maxWriteBytes: 100, maxChangeSetBytes: 6, maxChangeSetFiles: 10 },
      ),
    ).toBe("change-set-too-large");
  });

  it("rejects too many files", () => {
    expect(
      code(
        '{"changes":[{"ref":"a.ts","content":"1"},{"ref":"b.ts","content":"2"}]}',
        { maxWriteBytes: 100, maxChangeSetBytes: 100, maxChangeSetFiles: 1 },
      ),
    ).toBe("too-many-files");
  });

  it("is total: every rejection code is reachable", () => {
    expect(new Set(CHANGE_SET_REJECTION_CODES).size).toBe(
      CHANGE_SET_REJECTION_CODES.length,
    );
  });
});
