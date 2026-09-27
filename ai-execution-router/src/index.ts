// ─────────────────────────────────────────────────────────────────────────────
// Entry point
//
// Run with:  npm start
//            (or)  npx tsx src/index.ts
// ─────────────────────────────────────────────────────────────────────────────

import { getMockTasks }                    from "./agent/mockAgent";
import { routeTaskLegacy, printSummary }   from "./router/router";
import { getModelStatus }                  from "./router/classifier";
import { executionLog }                    from "./log/executionLog";
import { ExecutionResult, IncomingTask }   from "./types";

async function main(): Promise<void> {
  console.log("=".repeat(54));
  console.log("AI EXECUTION ROUTER — v0.3.0");
  console.log("=".repeat(54));

  const modelStatus = getModelStatus();
  console.log(`Classifier: ${modelStatus}`);
  console.log(`Simple AI:  provider=${process.env.SIMPLE_AI_PROVIDER ?? "mock"}`);
  console.log("=".repeat(54));
  console.log("Mock agent producing 7 tasks...\n");

  // getMockTasks returns Task[] — cast to IncomingTask[] (compatible, no new fields required)
  const tasks   = getMockTasks() as IncomingTask[];
  const results: ExecutionResult[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const result = await routeTaskLegacy(tasks[i], i + 1);
    results.push(result);
  }

  printSummary(results);

  // Print execution log report
  const report = executionLog.generateReport();
  console.log("\n--- Execution Log ---");
  console.log(`Total: ${report.totalTasks}  Det: ${report.deterministicCount}  AI: ${report.aiTaskCount}`);
  console.log(`Real AI calls with tokens: ${report.realAICallCount}`);
  console.log(`Cost: ${report.estimatedCostUsd}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
