// ─────────────────────────────────────────────────────────────────────────────
// Tool: runTests
// Simulates running a project test suite and returning a result.
// In this prototype the test run is mocked so the project has no dependency
// on a specific test framework. Replace the body of runTests() with a real
// child-process spawn when you are ready to wire up a live suite.
// ─────────────────────────────────────────────────────────────────────────────

export interface TestRunResult {
  passed:  number;
  failed:  number;
  skipped: number;
  summary: string;
}

export function runTests(suiteLabel: string = "default"): TestRunResult {
  // ── Mock result — replace with real test runner later ─────────────────────
  const result: TestRunResult = {
    passed:  12,
    failed:  0,
    skipped: 1,
    summary: `[Mock] Suite "${suiteLabel}": 12 passed, 0 failed, 1 skipped`,
  };

  return result;
}
