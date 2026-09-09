export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
}

export interface ResultSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
}

export function isOk(results: readonly CheckResult[]): boolean {
  return results.every((result) => result.status !== "fail");
}

export function formatCheckResult(result: CheckResult): string {
  const label = result.status.toUpperCase();
  const suffix = result.detail === undefined ? "" : `: ${result.detail}`;
  return `[${label}] ${result.name}${suffix}`;
}

export function validateCheckResult(result: CheckResult): boolean {
  if (typeof result !== "object" || result === null) {
    return false;
  }
  const candidate = result as unknown as Record<string, unknown>;
  if (typeof candidate["name"] !== "string") {
    return false;
  }
  if ((candidate["name"] as string).trim().length === 0) {
    return false;
  }
  if (
    candidate["status"] !== "pass" &&
    candidate["status"] !== "fail" &&
    candidate["status"] !== "skip"
  ) {
    return false;
  }
  if (
    candidate["detail"] !== undefined &&
    typeof candidate["detail"] !== "string"
  ) {
    return false;
  }
  return true;
}

export function summarizeCounts(
  results: readonly CheckResult[],
): ResultSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const result of results) {
    if (result.status === "pass") {
      passed += 1;
    } else if (result.status === "fail") {
      failed += 1;
    } else {
      skipped += 1;
    }
  }
  return {
    total: results.length,
    passed,
    failed,
    skipped,
    ok: failed === 0,
  };
}

export function summarizeResults(results: readonly CheckResult[]): string {
  if (results.length === 0) {
    return "No checks recorded.";
  }
  const lines = results.map(formatCheckResult);
  const verdict = isOk(results) ? "ALL CHECKS PASSED" : "CHECKS FAILED";
  return `${lines.join("\n")}\n${verdict}`;
}
