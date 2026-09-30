import { describe, expect, it } from "vitest";

import { normalizeText } from "../../src/core/text.js";

describe("end-to-end smoke", () => {
  it("executes repository source through the test runner", () => {
    expect(normalizeText("  end-to-end\t\nexecution  ")).toBe(
      "end-to-end execution",
    );
  });
});
