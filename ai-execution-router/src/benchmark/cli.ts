import * as fs from "fs";
import {
  compareUsageRecords,
  readBenchmarkRuns,
  runLocalBenchmark,
  getBenchmarkReportPath,
} from "./benchmark";

function printRun(): void {
  const run = runLocalBenchmark();
  console.log(`Benchmark ${run.runId}`);
  console.log(`Tasks: ${run.summary.totalTasks} total, ${run.summary.successfulTasks} succeeded, ${run.summary.failedTasks} failed`);
  console.log(`Duration: ${run.summary.totalDurationMs} ms total, ${run.summary.averageDurationMs.toFixed(1)} ms average`);
  console.log(`Usage: ${run.report.usageDataSource}; actual tokens unavailable`);
  console.log(run.report.explanation);
  console.log(`Timing note: ${run.report.timingCaveat}`);
  console.log(`Report: ${getBenchmarkReportPath()}`);
  for (const task of run.tasks) console.log(`  ${task.status.padEnd(9)} ${task.routeOrTool}: ${task.resultCount ?? "n/a"} result(s), ${task.durationMs} ms`);
}

function printComparison(baselineRunId: string, routedRunId: string, taskDefinitionId: string): void {
  const { runs, malformedLines } = readBenchmarkRuns();
  const baseline = runs.find((run) => run.runId === baselineRunId)?.tasks.find((task) => task.taskDefinitionId === taskDefinitionId);
  const routed = runs.find((run) => run.runId === routedRunId)?.tasks.find((task) => task.taskDefinitionId === taskDefinitionId);
  const comparison = compareUsageRecords(baseline && {
    runId: baseline.runId, taskId: baseline.taskId, taskDefinitionId: baseline.taskDefinitionId, usage: baseline.usage,
  }, routed && {
    runId: routed.runId, taskId: routed.taskId, taskDefinitionId: routed.taskDefinitionId, usage: routed.usage,
  });
  console.log(`Baseline available: ${comparison.available ? "yes" : "no"}`);
  console.log(`Savings calculable: ${comparison.savingsCanBeCalculated ? "yes" : "no"}`);
  if (comparison.savingsCanBeCalculated) console.log(`Token savings: ${comparison.tokenSavings} (${comparison.savingsPercentage}%)`);
  else console.log(`Token savings: not measurable — ${comparison.explanation}`);
  if (malformedLines) console.error(`Skipped ${malformedLines} malformed report line(s).`);
}

function readUsageRecord(filePath: string) {
  const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!value || typeof value !== "object") throw new Error("Imported record must be a JSON object.");
  const record = value as {
    runId?: unknown; taskId?: unknown; taskDefinitionId?: unknown;
    usage?: unknown; synthetic?: unknown;
  };
  if (typeof record.runId !== "string" || typeof record.taskId !== "string" ||
      typeof record.taskDefinitionId !== "string" || !record.usage || typeof record.usage !== "object") {
    throw new Error("Imported record requires runId, taskId, taskDefinitionId, and usage fields.");
  }
  return record as Parameters<typeof compareUsageRecords>[0];
}

function printImportedComparison(baselinePath: string, routedPath: string): void {
  try {
    const comparison = compareUsageRecords(readUsageRecord(baselinePath), readUsageRecord(routedPath));
    console.log(`Baseline available: ${comparison.available ? "yes" : "no"}`);
    console.log(`Savings calculable: ${comparison.savingsCanBeCalculated ? "yes" : "no"}`);
    if (comparison.savingsCanBeCalculated) console.log(`Token savings: ${comparison.tokenSavings} (${comparison.savingsPercentage}%)`);
    else console.log(`Token savings: not measurable — ${comparison.explanation}`);
  } catch (error) {
    console.error(`Could not compare imported usage records: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

const [command, ...args] = process.argv.slice(2);
if (!command || command === "run") printRun();
else if (command === "compare" && args.length === 3) printComparison(args[0], args[1], args[2]);
else if (command === "compare-usage" && args.length === 2) printImportedComparison(args[0], args[1]);
else {
  console.error("Usage: npm run benchmark [-- run | compare <baseline-run-id> <routed-run-id> <task-definition-id> | compare-usage <baseline.json> <routed.json>]");
  process.exitCode = 2;
}