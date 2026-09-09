import { describe, expect, it } from "vitest";
import {
  formatCheckResult,
  isOk,
  successRate,
  summarizeCounts,
  summarizeResults,
  validateCheckResult,
} from "../../src/result.js";
import type { CheckResult } from "../../src/result.js";

const passing: CheckResult[] = [
  { name: "format", status: "pass" },
  { name: "lint", status: "skip", detail: "not applicable" },
];

describe("isOk", () => {
  it("returns true when no check failed", () => {
    expect(isOk(passing)).toBe(true);
  });

  it("returns true for an empty set", () => {
    expect(isOk([])).toBe(true);
  });

  it("returns false when any check failed", () => {
    expect(isOk([...passing, { name: "test", status: "fail" }])).toBe(false);
  });
});

describe("formatCheckResult", () => {
  it("formats without detail", () => {
    expect(formatCheckResult({ name: "lint", status: "pass" })).toBe(
      "[PASS] lint",
    );
  });

  it("appends detail when present", () => {
    expect(
      formatCheckResult({ name: "lint", status: "skip", detail: "cached" }),
    ).toBe("[SKIP] lint: cached");
  });
});

describe("summarizeResults", () => {
  it("reports a stable message for empty input", () => {
    expect(summarizeResults([])).toBe("No checks recorded.");
  });

  it("ends with a passing verdict", () => {
    expect(summarizeResults(passing)).toBe(
      "[PASS] format\n[SKIP] lint: not applicable\nALL CHECKS PASSED",
    );
  });

  it("ends with a failing verdict", () => {
    expect(
      summarizeResults([{ name: "test", status: "fail", detail: "1 failed" }]),
    ).toBe("[FAIL] test: 1 failed\nCHECKS FAILED");
  });
});

describe("summarizeCounts", () => {
  it("handles empty input", () => {
    expect(summarizeCounts([])).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      ok: true,
    });
  });

  it("counts all-pass results", () => {
    const results: CheckResult[] = [
      { name: "format", status: "pass" },
      { name: "lint", status: "pass" },
    ];
    expect(summarizeCounts(results)).toEqual({
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
      ok: true,
    });
  });

  it("counts mixed results", () => {
    const results: CheckResult[] = [
      { name: "format", status: "pass" },
      { name: "test", status: "fail" },
      { name: "lint", status: "skip" },
    ];
    expect(summarizeCounts(results)).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      ok: false,
    });
  });

  it("counts all-fail results", () => {
    const results: CheckResult[] = [
      { name: "a", status: "fail" },
      { name: "b", status: "fail" },
    ];
    expect(summarizeCounts(results)).toEqual({
      total: 2,
      passed: 0,
      failed: 2,
      skipped: 0,
      ok: false,
    });
  });

  it("counts skip-only results", () => {
    const results: CheckResult[] = [
      { name: "a", status: "skip" },
      { name: "b", status: "skip" },
    ];
    expect(summarizeCounts(results)).toEqual({
      total: 2,
      passed: 0,
      failed: 0,
      skipped: 2,
      ok: true,
    });
  });

  it("does not mutate the input", () => {
    const results: CheckResult[] = [
      { name: "format", status: "pass" },
      { name: "test", status: "fail", detail: "1 failed" },
    ];
    const snapshot = structuredClone(results);
    summarizeCounts(results);
    expect(results).toEqual(snapshot);
  });
});

describe("validateCheckResult", () => {
  it("accepts a valid pass result", () => {
    expect(validateCheckResult({ name: "format", status: "pass" })).toBe(true);
  });

  it("accepts a valid fail result with detail", () => {
    expect(
      validateCheckResult({
        name: "test",
        status: "fail",
        detail: "1 failed",
      }),
    ).toBe(true);
  });

  it("accepts a valid skip result", () => {
    expect(validateCheckResult({ name: "lint", status: "skip" })).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(validateCheckResult({ name: "", status: "pass" })).toBe(false);
  });

  it("rejects a whitespace-only name", () => {
    expect(validateCheckResult({ name: "   ", status: "pass" })).toBe(false);
  });

  it("rejects an invalid status", () => {
    expect(
      validateCheckResult({
        name: "format",
        status: "unknown" as unknown as CheckResult["status"],
      }),
    ).toBe(false);
  });

  it("rejects a non-string detail", () => {
    expect(
      validateCheckResult({
        name: "format",
        status: "pass",
        detail: 42 as unknown as string,
      }),
    ).toBe(false);
  });

  it("accepts an empty detail", () => {
    expect(
      validateCheckResult({ name: "format", status: "pass", detail: "" }),
    ).toBe(true);
  });

  it("accepts a whitespace-only detail", () => {
    expect(
      validateCheckResult({ name: "format", status: "pass", detail: "   " }),
    ).toBe(true);
  });

  it("accepts leading/trailing whitespace in name", () => {
    expect(validateCheckResult({ name: "  format  ", status: "pass" })).toBe(
      true,
    );
  });

  it("accepts extra properties", () => {
    expect(
      validateCheckResult({
        name: "format",
        status: "pass",
        extra: true,
      } as CheckResult),
    ).toBe(true);
  });

  it("does not mutate the input object", () => {
    const input: CheckResult = {
      name: "format",
      status: "pass",
      detail: "ok",
    };
    const snapshot = structuredClone(input);
    validateCheckResult(input);
    expect(input).toEqual(snapshot);
  });

  it("rejects null, undefined, and primitives", () => {
    expect(validateCheckResult(null as unknown as CheckResult)).toBe(false);
    expect(validateCheckResult(undefined as unknown as CheckResult)).toBe(
      false,
    );
    expect(validateCheckResult("pass" as unknown as CheckResult)).toBe(false);
  });

  it("rejects objects with missing fields", () => {
    expect(validateCheckResult({} as unknown as CheckResult)).toBe(false);
  });
});

describe("successRate", () => {
  it("returns 0 for empty input", () => {
    expect(successRate([])).toBe(0);
  });

  it("returns 1 for all passing results", () => {
    expect(
      successRate([
        { name: "format", status: "pass" },
        { name: "lint", status: "pass" },
      ]),
    ).toBe(1);
  });

  it("returns 0 when nothing passes", () => {
    expect(
      successRate([
        { name: "test", status: "fail" },
        { name: "lint", status: "skip" },
      ]),
    ).toBe(0);
  });

  it("returns the correct ratio for mixed results", () => {
    expect(
      successRate([
        { name: "format", status: "pass" },
        { name: "test", status: "fail" },
        { name: "lint", status: "skip" },
        { name: "build", status: "pass" },
      ]),
    ).toBe(0.5);
  });

  it("includes skip results in the denominator", () => {
    expect(
      successRate([
        { name: "format", status: "pass" },
        { name: "lint", status: "skip" },
        { name: "docs", status: "skip" },
      ]),
    ).toBeCloseTo(1 / 3, 10);
  });

  it("does not mutate the input", () => {
    const results: CheckResult[] = [
      { name: "format", status: "pass" },
      { name: "test", status: "fail" },
    ];
    const snapshot = structuredClone(results);
    successRate(results);
    expect(results).toEqual(snapshot);
  });
});
