import { describe, expect, it } from "vitest";
import { add, subtract, multiply, divide, calculate, main } from "../../src/utils/calculator.js";

describe("calculator", () => {
  describe("add", () => {
    it("adds two positive numbers", () => {
      expect(add(2, 3)).toEqual({ success: true, value: 5 });
    });
    it("adds negative numbers", () => {
      expect(add(-1, -2)).toEqual({ success: true, value: -3 });
    });
    it("adds decimal numbers", () => {
      const result = add(0.1, 0.2);
      expect(result.success).toBe(true);
      expect(result.value).toBeCloseTo(0.3);
    });
  });

  describe("subtract", () => {
    it("subtracts two numbers", () => {
      expect(subtract(10, 4)).toEqual({ success: true, value: 6 });
    });
    it("handles negative results", () => {
      expect(subtract(3, 7)).toEqual({ success: true, value: -4 });
    });
  });

  describe("multiply", () => {
    it("multiplies two numbers", () => {
      expect(multiply(4, 5)).toEqual({ success: true, value: 20 });
    });
    it("multiplies by zero", () => {
      expect(multiply(7, 0)).toEqual({ success: true, value: 0 });
    });
    it("multiplies negative numbers", () => {
      expect(multiply(-3, 4)).toEqual({ success: true, value: -12 });
    });
  });

  describe("divide", () => {
    it("divides two numbers", () => {
      expect(divide(20, 4)).toEqual({ success: true, value: 5 });
    });
    it("returns error for division by zero", () => {
      expect(divide(5, 0)).toEqual({ success: false, error: "Division by zero" });
    });
    it("handles decimal results", () => {
      expect(divide(7, 2)).toEqual({ success: true, value: 3.5 });
    });
  });

  describe("calculate", () => {
    it("routes to add", () => {
      expect(calculate("add", 1, 2)).toEqual({ success: true, value: 3 });
    });
    it("routes to subtract", () => {
      expect(calculate("subtract", 5, 3)).toEqual({ success: true, value: 2 });
    });
    it("routes to multiply", () => {
      expect(calculate("multiply", 3, 4)).toEqual({ success: true, value: 12 });
    });
    it("routes to divide", () => {
      expect(calculate("divide", 15, 3)).toEqual({ success: true, value: 5 });
    });
    it("returns error for unknown operation", () => {
      expect(calculate("modulo" as any, 1, 2)).toEqual({ success: false, error: "Unknown operation: modulo" });
    });
  });

  describe("main (CLI entry)", () => {
    it("returns result for valid add", () => {
      expect(main(["add", "2", "3"])).toEqual({ success: true, value: 5 });
    });
    it("returns result for valid subtract", () => {
      expect(main(["subtract", "10", "4"])).toEqual({ success: true, value: 6 });
    });
    it("returns result for valid multiply", () => {
      expect(main(["multiply", "3", "7"])).toEqual({ success: true, value: 21 });
    });
    it("returns result for valid divide", () => {
      expect(main(["divide", "20", "4"])).toEqual({ success: true, value: 5 });
    });
    it("returns error for missing args", () => {
      expect(main(["add", "1"])).toEqual({ success: false, error: expect.stringContaining("Usage:") });
    });
    it("returns error for invalid operation", () => {
      expect(main(["power", "2", "3"])).toEqual({ success: false, error: expect.stringContaining("Usage:") });
    });
    it("returns error for non-numeric args", () => {
      expect(main(["add", "foo", "2"])).toEqual({ success: false, error: expect.stringContaining("Usage:") });
    });
  });
});