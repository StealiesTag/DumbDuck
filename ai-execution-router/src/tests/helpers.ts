// ─────────────────────────────────────────────────────────────────────────────
// Test helpers — minimal assertion utilities used by all test files.
// No external dependencies needed.
// ─────────────────────────────────────────────────────────────────────────────

export interface TestResult {
  label:   string;
  passed:  boolean;
  message: string;
}

export function assert(condition: boolean, label: string, detail = ""): TestResult {
  return {
    label,
    passed:  condition,
    message: condition ? "OK" : (detail || `assertion failed`),
  };
}

export function assertEqual<T>(
  actual: T,
  expected: T,
  label: string
): TestResult {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  return {
    label,
    passed:  ok,
    message: ok ? "OK" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  };
}

export function assertThrows(fn: () => void, label: string): TestResult {
  try {
    fn();
    return { label, passed: false, message: "Expected a throw but function returned normally" };
  } catch {
    return { label, passed: true, message: "OK" };
  }
}

export function runSuite(suiteName: string, results: TestResult[]): { passed: number; failed: number } {
  const P = "✓ PASS";
  const F = "✗ FAIL";
  let passed = 0;
  let failed = 0;

  console.log(`\n── ${suiteName} ${"─".repeat(Math.max(0, 44 - suiteName.length))}`);

  for (const r of results) {
    if (r.passed) {
      passed++;
      console.log(`  ${P}  ${r.label}`);
    } else {
      failed++;
      console.log(`  ${F}  ${r.label}`);
      console.log(`         ${r.message}`);
    }
  }
  return { passed, failed };
}
