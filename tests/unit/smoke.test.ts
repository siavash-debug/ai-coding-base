import { describe, expect, it } from "vitest";
import { getWorkspaceStatus } from "../../src/index.js";

describe("getWorkspaceStatus", () => {
  it("reports the workspace name", () => {
    expect(getWorkspaceStatus().name).toBe("ai-coding-base");
  });

  it("reports ok", () => {
    expect(getWorkspaceStatus().ok).toBe(true);
  });
});
