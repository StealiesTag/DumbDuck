// ─────────────────────────────────────────────────────────────────────────────
// Test runner
//
// Run with:  npm test
//            (or)  npx tsx src/tests/runner.ts
//
// No external test framework — just a loop, a comparison, and a pass/fail tally.
// ─────────────────────────────────────────────────────────────────────────────

import { classify }    from "../router/classifier";
import { TEST_CASES }  from "./cases";

const PASS = "✓ PASS";
const FAIL = "✗ FAIL";

let passed = 0;
let failed = 0;

console.log("\nAI Execution Router — Classifier Test Suite");
console.log("=".repeat(52));

for (const tc of TEST_CASES) {
  const result = classify(tc.task);
  const ok     = result.route === tc.expected;

  if (ok) {
    passed++;
    console.log(`${PASS}  [${tc.expected}]  ${tc.label}`);
  } else {
    failed++;
    console.log(`${FAIL}  ${tc.label}`);
    console.log(`       Expected: ${tc.expected}`);
    console.log(`       Got:      ${result.route}  (score=${result.score})`);
    console.log(`       Reasons:  ${result.reasons.join("; ")}`);
  }
}

console.log("=".repeat(52));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(52));

if (failed > 0) {
  process.exit(1);
}
