export interface CalculationResult {
  success: boolean;
  value?: number;
  error?: string;
}

export function add(a: number, b: number): CalculationResult {
  return { success: true, value: a + b };
}

export function subtract(a: number, b: number): CalculationResult {
  return { success: true, value: a - b };
}

export function multiply(a: number, b: number): CalculationResult {
  return { success: true, value: a * b };
}

export function divide(a: number, b: number): CalculationResult {
  if (b === 0) {
    return { success: false, error: "Division by zero" };
  }
  return { success: true, value: a / b };
}

export type Operation = "add" | "subtract" | "multiply" | "divide";

export function calculate(op: Operation, a: number, b: number): CalculationResult {
  switch (op) {
    case "add":
      return add(a, b);
    case "subtract":
      return subtract(a, b);
    case "multiply":
      return multiply(a, b);
    case "divide":
      return divide(a, b);
    default:
      return { success: false, error: `Unknown operation: ${op}` };
  }
}

function parseArgs(args: string[]): { op: Operation; a: number; b: number } | null {
  if (args.length < 3) {
    return null;
  }
  const op = args[0] as Operation;
  const a = Number(args[1]);
  const b = Number(args[2]);

  if (!["add", "subtract", "multiply", "divide"].includes(op)) {
    return null;
  }
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return null;
  }

  return { op, a, b };
}

export function main(args: string[]): CalculationResult {
  const parsed = parseArgs(args);
  if (!parsed) {
    return {
      success: false,
      error: "Usage: calculator <add|subtract|multiply|divide> <number> <number>",
    };
  }
  return calculate(parsed.op, parsed.a, parsed.b);
}

const isMainModule = import.meta.url === `file://${process.argv[1]}` || 
  import.meta.url.endsWith("calculator.ts") || 
  process.argv[1]?.endsWith("calculator.js");

if (isMainModule && !process.argv[1]?.includes("vitest")) {
  const result = main(process.argv.slice(2));
  if (result.success) {
    console.log(result.value);
  } else {
    console.error(result.error);
    process.exit(1);
  }
}