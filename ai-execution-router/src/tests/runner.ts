// ─────────────────────────────────────────────────────────────────────────────
// Test runner
//
// Run with:  npm test
//            (or)  npx tsx src/tests/runner.ts
//
// Runs all test suites and reports a combined pass/fail summary.
// Exits with code 1 if any test fails.
// ─────────────────────────────────────────────────────────────────────────────

import { runCapabilityMatcherTests } from "./capabilityMatcher.test";
import { runFeatureTests }           from "./features.test";
import { runClassifierTests }        from "./classifier.test";
import { runRoutingTests }           from "./routing.test";
import { runWorkspaceTests }         from "./workspace.test";
import { runWorkspaceToolTests }     from "./workspaceTools.test";
import {
  runDelegationTests,
  runExecutionLogTests,
  runMCPInputTests,
} from "./integration.test";
import { runSuite } from "./helpers";

async function main(): Promise<void> {
  console.log("\nAI Execution Router — Test Suite (v0.3)");
  console.log("=".repeat(54));

  let totalPassed = 0;
  let totalFailed = 0;

  function tally(r: { passed: number; failed: number }): void {
    totalPassed += r.passed;
    totalFailed += r.failed;
  }

  // Suppress classifier "no model" warning to keep output clean
  const originalWarn = console.warn;
  const suppressedPrefixes = ["[classifier]"];
  console.warn = (...args: unknown[]) => {
    const msg = String(args[0] ?? "");
    if (suppressedPrefixes.some((p) => msg.startsWith(p))) return;
    originalWarn(...args);
  };

  // ── v0.2 suites (existing) ──────────────────────────────────────────────────
  tally(runSuite("Capability Matcher",  runCapabilityMatcherTests()));
  tally(runSuite("Feature Extractor",   runFeatureTests()));
  tally(runSuite("ML Classifier",       runClassifierTests()));
  tally(runSuite("Routing (E2E)",       await runRoutingTests()));

  // ── v0.3 suites (new) ───────────────────────────────────────────────────────
  tally(runSuite("Workspace Manager",   runWorkspaceTests()));
  tally(runSuite("Workspace Tools",     runWorkspaceToolTests()));
  tally(runSuite("Delegation & SimpleAI", await runDelegationTests()));
  tally(runSuite("Execution Log",       await runExecutionLogTests()));
  tally(runSuite("MCP Input Handling",  await runMCPInputTests()));

  console.warn = originalWarn;

  console.log("\n" + "=".repeat(54));
  console.log(`Results: ${totalPassed} passed, ${totalFailed} failed`);
  console.log("=".repeat(54));

  if (totalFailed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
