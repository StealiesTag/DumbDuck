// ─────────────────────────────────────────────────────────────────────────────
// Entry point
//
// Run with:  npm start
//            (or)  npx tsx src/index.ts
// ─────────────────────────────────────────────────────────────────────────────

import { getMockTasks }  from "./agent/mockAgent";
import { routeTask, printSummary } from "./router/router";
import { ExecutionResult } from "./types";

async function main(): Promise<void> {
  console.log("=".repeat(52));
  console.log("AI EXECUTION ROUTER — Prototype v0.1");
  console.log("=".repeat(52));
  console.log("Mock agent producing 7 tasks for classification and routing...");

  const tasks   = getMockTasks();
  const results: ExecutionResult[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const result = await routeTask(tasks[i], i + 1);
    results.push(result);
  }

  printSummary(results);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
