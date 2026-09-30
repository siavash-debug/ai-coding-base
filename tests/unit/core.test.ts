import { describe, expect, it } from "vitest";
import {
  createFixedClock,
  createManualClock,
  createSystemClock,
  durationMsFrom,
  isValidIsoTimestamp,
  toIsoString,
} from "../../src/core/clock.js";
import {
  DomainError,
  hasDomainErrorCode,
  isDomainError,
} from "../../src/core/errors.js";
import {
  createSequentialIdFactory,
  createUuidIdFactory,
  isValidId,
  projectId,
  taskId,
  workspaceId,
} from "../../src/core/ids.js";
import {
  assertNoSecretLikeValue,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertOneOf,
  assertPositiveInteger,
  assertSafeAbsolutePath,
  assertStringArray,
  assertUnitInterval,
  containsSecretLikeValue,
} from "../../src/core/validation.js";
import { expectDomainError } from "../support/errors.js";

const INSTANT = "2026-09-20T10:00:00.000Z";

describe("ids", () => {
  it("brands a valid identifier", () => {
    expect(projectId("prj-1")).toBe("prj-1");
    expect(workspaceId("wsp:1")).toBe("wsp:1");
    expect(taskId("TASK-142")).toBe("TASK-142");
  });

  it("rejects identifiers that would be unsafe in logs or filenames", () => {
    for (const value of ["", " ", "-leading", "has space", "a/b", 42, null]) {
      expect(isValidId(value)).toBe(false);
      expectDomainError(() => taskId(value), "VALIDATION");
    }
  });

  it("rejects identifiers longer than 128 characters", () => {
    expect(isValidId("a".repeat(128))).toBe(true);
    expect(isValidId("a".repeat(129))).toBe(false);
  });

  it("generates deterministic sequential ids", () => {
    const factory = createSequentialIdFactory("TASK", 7);
    expect(factory.name).toBe("TASK");
    expect([factory.next(), factory.next(), factory.next()]).toEqual([
      "TASK-7",
      "TASK-8",
      "TASK-9",
    ]);
  });

  it("rejects an unusable sequential id factory configuration", () => {
    expectDomainError(() => createSequentialIdFactory(""), "VALIDATION");
    expectDomainError(() => createSequentialIdFactory("T", -1), "VALIDATION");
  });

  it("generates valid uuid ids", () => {
    const factory = createUuidIdFactory();
    expect(factory.name).toBe("uuid");
    expect(isValidId(factory.next())).toBe(true);
  });
});

describe("clock", () => {
  it("returns the same instant from a fixed clock", () => {
    const clock = createFixedClock(INSTANT);
    expect(toIsoString(clock.now())).toBe(INSTANT);
    expect(toIsoString(clock.now())).toBe(INSTANT);
  });

  it("advances a manual clock deterministically", () => {
    const clock = createManualClock(INSTANT);
    clock.advance(1500);
    expect(toIsoString(clock.now())).toBe("2026-09-20T10:00:01.500Z");
    clock.set("2026-09-21T00:00:00.000Z");
    expect(toIsoString(clock.now())).toBe("2026-09-21T00:00:00.000Z");
  });

  it("rejects an invalid clock start", () => {
    expectDomainError(() => createFixedClock("yesterday"), "VALIDATION");
    expectDomainError(() => createManualClock(""), "VALIDATION");
  });

  it("rejects a non-finite clock advance", () => {
    expectDomainError(
      () => createManualClock(INSTANT).advance(Number.NaN),
      "VALIDATION",
    );
  });

  it("provides a system clock", () => {
    expect(createSystemClock().now()).toBeInstanceOf(Date);
  });

  it("recognises ISO-8601 timestamps only", () => {
    expect(isValidIsoTimestamp(INSTANT)).toBe(true);
    expect(isValidIsoTimestamp("2026-09-20T10:00:00+02:00")).toBe(true);
    expect(isValidIsoTimestamp("2026-09-20")).toBe(false);
    expect(isValidIsoTimestamp("2026-09-20T10:00:00")).toBe(false);
    expect(isValidIsoTimestamp(1758362400000)).toBe(false);
  });

  it("refuses to convert an invalid Date", () => {
    expectDomainError(() => toIsoString(new Date(Number.NaN)), "VALIDATION");
  });

  it("computes non-negative durations", () => {
    expect(durationMsFrom(INSTANT, "2026-09-20T10:47:00.000Z")).toBe(2_820_000);
    expect(durationMsFrom(INSTANT, "2026-09-20T09:00:00.000Z")).toBe(0);
  });

  it("refuses to compute a duration from invalid timestamps", () => {
    expectDomainError(() => durationMsFrom(INSTANT, "nope"), "VALIDATION");
  });
});

describe("DomainError", () => {
  it("carries a stable code and details", () => {
    const error = new DomainError("INVARIANT", "boom", { field: "x" });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DomainError");
    expect(error.code).toBe("INVARIANT");
    expect(error.details).toEqual({ field: "x" });
    expect(error.message).toBe("boom");
  });

  it("is detectable at a boundary", () => {
    const error = new DomainError("NOT_FOUND", "missing");
    expect(isDomainError(error)).toBe(true);
    expect(hasDomainErrorCode(error, "NOT_FOUND")).toBe(true);
    expect(hasDomainErrorCode(error, "CONFLICT")).toBe(false);
    expect(isDomainError(new Error("plain"))).toBe(false);
    expect(isDomainError("nope")).toBe(false);
  });

  it("defaults details to an empty object", () => {
    expect(new DomainError("CONFLICT", "x").details).toEqual({});
  });
});

describe("validation", () => {
  it("requires non-empty strings", () => {
    expect(assertNonEmptyString("ok", "field")).toBe("ok");
    expectDomainError(() => assertNonEmptyString("   ", "field"), "VALIDATION");
    expectDomainError(() => assertNonEmptyString(1, "field"), "VALIDATION");
  });

  it("requires non-negative integers", () => {
    expect(assertNonNegativeInteger(0, "field")).toBe(0);
    expectDomainError(
      () => assertNonNegativeInteger(-1, "field"),
      "VALIDATION",
    );
    expectDomainError(
      () => assertNonNegativeInteger(1.5, "field"),
      "VALIDATION",
    );
    expectDomainError(
      () => assertNonNegativeInteger(Number.MAX_SAFE_INTEGER + 1, "field"),
      "VALIDATION",
    );
  });

  it("requires positive integers", () => {
    expect(assertPositiveInteger(3, "field")).toBe(3);
    expectDomainError(() => assertPositiveInteger(0, "field"), "VALIDATION");
  });

  it("requires fractions in the unit interval", () => {
    expect(assertUnitInterval(0, "field")).toBe(0);
    expect(assertUnitInterval(1, "field")).toBe(1);
    expectDomainError(() => assertUnitInterval(1.01, "field"), "VALIDATION");
  });

  it("requires membership of an allowed set", () => {
    expect(assertOneOf("b", ["a", "b"], "field")).toBe("b");
    expectDomainError(
      () => assertOneOf("c", ["a", "b"], "field"),
      "VALIDATION",
    );
  });

  it("requires arrays of non-empty strings", () => {
    expect(assertStringArray(["a", "b"], "field")).toEqual(["a", "b"]);
    expectDomainError(() => assertStringArray("a", "field"), "VALIDATION");
    expectDomainError(
      () => assertStringArray(["a", ""], "field"),
      "VALIDATION",
    );
  });

  it("requires safe absolute paths", () => {
    expect(assertSafeAbsolutePath("/srv/demo", "field")).toBe("/srv/demo");
    expectDomainError(
      () => assertSafeAbsolutePath("demo/ws", "field"),
      "VALIDATION",
    );
    expectDomainError(
      () => assertSafeAbsolutePath("/srv/../etc", "field"),
      "VALIDATION",
    );
    expectDomainError(() => assertSafeAbsolutePath("", "field"), "VALIDATION");
    expectDomainError(
      () => assertSafeAbsolutePath("/srv/de\0mo", "field"),
      "VALIDATION",
    );
  });

  it("detects secret-shaped values", () => {
    expect(containsSecretLikeValue("sk-abcdefghijklmnop")).toBe(true);
    expect(containsSecretLikeValue("-----BEGIN RSA PRIVATE KEY-----")).toBe(
      true,
    );
    expect(containsSecretLikeValue("regular text")).toBe(false);
    expect(containsSecretLikeValue("task-abcdefghijklmnop")).toBe(false);
    expect(() => assertNoSecretLikeValue("fine", "field")).not.toThrow();
    expectDomainError(
      () => assertNoSecretLikeValue("sk-abcdefghijklmnop", "field"),
      "VALIDATION",
    );
  });
});
