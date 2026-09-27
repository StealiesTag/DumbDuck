// ─────────────────────────────────────────────────────────────────────────────
// Router
//
// The router is the single entry point for executing a Task.
// It:
//   1. Calls the classifier to determine the route and features
//   2. Logs the classification in a structured, human-readable format
//   3. Dispatches the task to the correct executor
//   4. Returns the ExecutionResult
// ─────────────────────────────────────────────────────────────────────────────

import { Task, ExecutionResult, ClassificationResult, TaskFeatures, Route } from "../types";
import { classify }           from "./classifier";
import { runDeterministic }   from "../executors/deterministic";
import { runSimpleAI }        from "../executors/simpleAI";
import { runComplexAI }       from "../executors/complexAI";

// ── Formatting helpers ───────────────────────────────────────────────────────

const DIVIDER = "-".repeat(52);

function boolStr(v: boolean): string { return v ? "true" : "false"; }

function logClassification(
  task:   Task,
  index:  number,
  result: ClassificationResult
): void {
  const f: TaskFeatures = result.features;

  console.log(`\n${DIVIDER}`);
  console.log(`TASK ${index}`);
  console.log(`Description: ${task.description}`);
  console.log("\nFeatures:");
  console.log(`  Deterministic available:  ${boolStr(f.deterministicAvailable)}`);
  console.log(`  Language understanding:   ${boolStr(f.requiresLanguageUnderstanding)}`);
  console.log(`  Reasoning level:          ${f.reasoningLevel}`);
  console.log(`  Generation level:         ${f.generationLevel}`);
  console.log(`  Context size:             ${f.contextSize}`);
  console.log(`  Ambiguity:                ${f.ambiguityLevel}`);
  console.log(`  Files involved:           ${f.filesInvolved}`);

  if (!f.deterministicAvailable) {
    console.log(`\nComplexity score: ${result.score}`);
  }

  console.log(`\nROUTE: ${result.route}`);
  result.reasons.forEach((r) => console.log(`  • ${r}`));
  console.log(DIVIDER);
}

function logOutput(result: ExecutionResult): void {
  console.log(`Output: ${result.output}`);
  console.log(`Duration: ${result.durationMs} ms`);
}

// ── Main routing function ────────────────────────────────────────────────────

export async function routeTask(task: Task, index: number): Promise<ExecutionResult> {
  const classification = classify(task);

  logClassification(task, index, classification);

  let execResult: ExecutionResult;

  switch (classification.route) {
    case "DETERMINISTIC":
      execResult = runDeterministic(task);
      break;
    case "SIMPLE_AI":
      execResult = await runSimpleAI(task);
      break;
    case "COMPLEX_AI":
      execResult = await runComplexAI(task);
      break;
    default: {
      // TypeScript exhaustive check — should never happen
      const _exhaustive: never = classification.route;
      throw new Error(`Unknown route: ${_exhaustive}`);
    }
  }

  logOutput(execResult);
  return execResult;
}

// ── Summary printer ──────────────────────────────────────────────────────────

export function printSummary(results: ExecutionResult[]): void {
  const total       = results.length;
  const byRoute     = (r: Route) => results.filter((x) => x.route === r).length;

  const nDeterministic = byRoute("DETERMINISTIC");
  const nSimple        = byRoute("SIMPLE_AI");
  const nComplex       = byRoute("COMPLEX_AI");
  const nAI            = nSimple + nComplex;
  const aiPct          = total > 0 ? Math.round((nAI / total) * 100) : 0;
  const avoided        = nDeterministic;   // tasks that never touched an AI model

  console.log(`\n${"=".repeat(52)}`);
  console.log("ROUTING SUMMARY");
  console.log("=".repeat(52));
  console.log(`Total tasks:                ${total}`);
  console.log(`  DETERMINISTIC:            ${nDeterministic}`);
  console.log(`  SIMPLE_AI:                ${nSimple}`);
  console.log(`  COMPLEX_AI:               ${nComplex}`);
  console.log(`Total AI tasks:             ${nAI}`);
  console.log(`AI task percentage:         ${aiPct}%`);
  console.log(`Potentially avoided AI calls: ${avoided}`);
  console.log("=".repeat(52));
  console.log("Note: token/cost savings are not estimated in this MVP.");
  console.log("      Real measurements will be added in a future iteration.");
}
