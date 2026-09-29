import { describe, expect, it } from "vitest";

import { normalizeText } from "../../src/core/text.js";

describe("normalizeText", () => {
  it("leaves already-normalized input unchanged", () => {
    expect(normalizeText("already normalized text")).toBe(
      "already normalized text",
    );
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeText(" \t normalized text \n")).toBe("normalized text");
  });

  it("collapses multiple internal whitespace characters", () => {
    expect(normalizeText("one \t\n two\u00a0three")).toBe("one two three");
  });

  it("returns an empty string for empty input", () => {
    expect(normalizeText("")).toBe("");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeText(" \t\n\r")).toBe("");
  });
});
