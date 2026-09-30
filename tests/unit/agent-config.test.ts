import { describe, expect, it } from "vitest";

import { assertAgentConfig } from "../../src/adapters/config/project-config.js";
import { DomainError } from "../../src/core/errors.js";

/**
 * The agent block's verification contract.
 *
 * A criterion can bind to a named check only if the operator declared that check with
 * a stable id, so the parse is load-bearing: a missing, empty or duplicated id would
 * make `verifiedBy.check` ambiguous or unbacked. These tests pin the accepted shape
 * and the refusals, without a workspace or any file I/O.
 */
describe("assertAgentConfig: verification", () => {
  it("keeps a bare verification command exactly as it was", () => {
    const config = assertAgentConfig({
      runner: "change-set",
      verification: { command: "node", args: ["-e", "process.exit(0)"] },
    });
    expect(config?.verification).toEqual({
      command: "node",
      args: ["-e", "process.exit(0)"],
    });
  });

  it("accepts a command alongside named checks", () => {
    const config = assertAgentConfig({
      runner: "change-set",
      verification: {
        command: "node",
        args: ["-e", "process.exit(0)"],
        checks: [
          { id: "check-a", command: "node", args: ["-e", "process.exit(0)"] },
          { id: "check-b", command: "node", args: ["-e", "process.exit(1)"] },
        ],
      },
    });
    expect(config?.verification?.checks?.map((check) => check.id)).toEqual([
      "check-a",
      "check-b",
    ]);
  });

  it("accepts checks without a whole-suite command", () => {
    const config = assertAgentConfig({
      runner: "change-set",
      verification: {
        checks: [
          { id: "check-a", command: "node", args: ["-e", "process.exit(0)"] },
        ],
      },
    });
    expect(config?.verification?.command).toBeUndefined();
    expect(config?.verification?.checks).toHaveLength(1);
  });

  it("rejects a verification block with neither a command nor a check", () => {
    expect(() =>
      assertAgentConfig({
        runner: "change-set",
        verification: { args: [] },
      }),
    ).toThrow(DomainError);
  });

  it("rejects a duplicated check id", () => {
    expect(() =>
      assertAgentConfig({
        runner: "change-set",
        verification: {
          checks: [
            { id: "check-a", command: "node", args: [] },
            { id: "check-a", command: "node", args: [] },
          ],
        },
      }),
    ).toThrow(DomainError);
  });

  it("rejects a check without a stable id", () => {
    expect(() =>
      assertAgentConfig({
        runner: "change-set",
        verification: { checks: [{ command: "node", args: [] }] },
      }),
    ).toThrow(DomainError);
  });
});
