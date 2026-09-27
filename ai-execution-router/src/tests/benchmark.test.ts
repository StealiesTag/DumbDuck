import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  BenchmarkTaskResult,
  compareUsageRecords,
  persistBenchmarkRun,
  readBenchmarkRuns,
  runLocalBenchmark,
  summarizeBenchmarkTasks,
} from "../benchmark/benchmark";
import { UsageData } from "../types";
import { assert, assertEqual, TestResult } from "./helpers";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-benchmark-"));
}

function makeUsage(overrides: Partial<UsageData> = {}): UsageData {
  return {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    provider: "test-provider",
    model: "test-model",
    source: "provider_reported",
    measurementType: "provider_reported",
    ...overrides,
  };
}

function makeTask(overrides: Partial<BenchmarkTaskResult> = {}): BenchmarkTaskResult {
  const startedAt = "2026-01-01T00:00:00.000Z";
  const endedAt = "2026-01-01T00:00:00.010Z";
  return {
    runId: "run-a",
    taskId: "task-a",
    taskDefinitionId: "workspace.search.todo",
    description: "Search for TODO",
    routeOrTool: "searchRepository",
    startedAt,
    endedAt,
    durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    status: "SUCCEEDED",
    usage: {
      inputTokens: "UNAVAILABLE",
      outputTokens: "UNAVAILABLE",
      totalTokens: "UNAVAILABLE",
      source: "unavailable",
      measurementType: "unavailable",
    },
    ...overrides,
  };
}

export function runBenchmarkTests(): TestResult[] {
  const results: TestResult[] = [];
  const temp = makeTempDir();
  try {
    fs.writeFileSync(path.join(temp, "README.md"), "Private fixture contents");
    fs.writeFileSync(path.join(temp, "sample.ts"), "// TODO: fixture\n");
    const reportPath = path.join(temp, "reports", "nested", "benchmark.jsonl");
    const run = runLocalBenchmark({ workspaceRoot: temp, reportPath, includeGit: false, includeTests: false });
    results.push(assertEqual(run.summary.totalTasks, 3, "benchmark runs three local workspace tools"));
    results.push(assertEqual(run.summary.successfulTasks, 3, "benchmark tools succeed on the fixture"));
    results.push(assertEqual(run.summary.failedTasks, 0, "benchmark fixture has no failed tool calls"));
    results.push(assert(run.tasks.every((task) => task.runId === run.runId && task.taskId && Number.isFinite(Date.parse(task.startedAt)) && Number.isFinite(Date.parse(task.endedAt))), "benchmark tasks carry run/task IDs and ISO timestamps"));
    results.push(assertEqual(run.tasks.find((task) => task.routeOrTool === "listFiles")?.resultCount, 2, "list task records returned entry count"));
    results.push(assertEqual(run.tasks.find((task) => task.routeOrTool === "searchRepository")?.resultCount, 1, "search task records match count"));
    results.push(assertEqual(run.summary.routeToolUsageCounts.listFiles, 1, "summary aggregates route/tool usage counts"));
    results.push(assertEqual(run.summary.totalDurationMs, run.tasks.reduce((sum, task) => sum + task.durationMs, 0), "duration summary is the sum of task durations"));
    results.push(assertEqual(run.summary.averageDurationMs, run.summary.totalDurationMs / run.summary.totalTasks, "average duration is derived from task durations"));
    results.push(assertEqual(run.summary.actualTotalTokens, "UNAVAILABLE", "local tool timings do not become token counts"));
    results.push(assertEqual(run.report.savingsCanBeCalculated, false, "benchmark with no baseline cannot claim savings"));
    results.push(assert(run.report.explanation.includes("not measurable — no comparable baseline usage data"), "no-baseline report uses the required explanation"));
    results.push(assert(run.report.explanation.includes("Host-model token usage is unavailable"), "no-baseline report states host usage limitation"));
    results.push(assertEqual(run.report.cost, "unavailable — valid model pricing and actual usage are required", "cost remains unavailable without pricing and usage"));
    results.push(assert(fs.existsSync(reportPath), "benchmark creates the report parent directories"));
    const reportText = fs.readFileSync(reportPath, "utf8");
    results.push(assert(!reportText.includes("Private fixture contents"), "persisted report excludes file contents"));
    results.push(assertEqual(readBenchmarkRuns(reportPath).runs.length, 1, "JSONL report can be read"));
    results.push(assert(persistBenchmarkRun(run, reportPath), "duplicate persistence succeeds without an error"));
    results.push(assertEqual(readBenchmarkRuns(reportPath).runs.length, 1, "duplicate run ID is not appended twice"));

    const missingRoot = path.join(temp, "sk-abcdefghijklmnopqrstuvwxyz", "missing");
    const missing = runLocalBenchmark({ workspaceRoot: missingRoot, reportPath: path.join(temp, "failed.jsonl"), includeGit: false, includeTests: false });
    results.push(assertEqual(missing.summary.failedTasks, 3, "benchmark records failed tool tasks and continues"));
    results.push(assert(missing.tasks.every((task) => task.errorSummary), "failed benchmark tasks include concise error summaries"));
    results.push(assert(missing.tasks.every((task) => !task.errorSummary?.includes("sk-abcdefghijklmnopqrstuvwxyz")), "error summaries redact workspace paths that resemble secrets"));

    fs.appendFileSync(reportPath, "{malformed json\n");
    const reread = readBenchmarkRuns(reportPath);
    results.push(assertEqual(reread.runs.length, 1, "malformed JSONL record does not discard valid records"));
    results.push(assertEqual(reread.malformedLines, 1, "malformed JSONL line is counted"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const unavailable = summarizeBenchmarkTasks([makeTask()]);
  results.push(assertEqual(unavailable.actualTotalTokens, "UNAVAILABLE", "missing token usage remains unavailable"));
  const zero = summarizeBenchmarkTasks([makeTask({ usage: makeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }) })]);
  results.push(assertEqual(zero.actualTotalTokens, 0, "provider-reported zero is distinct from unavailable usage"));
  const actual = summarizeBenchmarkTasks([makeTask({ usage: makeUsage() })]);
  results.push(assertEqual(actual.actualInputTokens, 100, "provider-reported input usage aggregates as actual"));
  results.push(assertEqual(actual.actualOutputTokens, 50, "provider-reported output usage aggregates as actual"));
  results.push(assertEqual(actual.actualTotalTokens, 150, "provider-reported total usage aggregates as actual"));
  const hostActual = summarizeBenchmarkTasks([makeTask({ usage: makeUsage({ source: "host_reported", measurementType: "host_reported" }) })]);
  results.push(assertEqual(hostActual.actualTotalTokens, 150, "host-reported usage remains verified actual usage"));
  const estimate = summarizeBenchmarkTasks([makeTask({ usage: makeUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15, source: "locally_estimated", measurementType: "locally_estimated" }) })]);
  results.push(assertEqual(estimate.estimatedTotalTokens, 15, "local estimate is reported separately"));
  results.push(assertEqual(estimate.actualTotalTokens, "UNAVAILABLE", "estimate does not enter actual totals"));
  const synthetic = summarizeBenchmarkTasks([makeTask({ usage: makeUsage({ inputTokens: 900, outputTokens: 100, totalTokens: 1000, source: "synthetic_test", measurementType: "synthetic_test" }) })]);
  results.push(assertEqual(synthetic.actualTotalTokens, "UNAVAILABLE", "synthetic data is excluded from actual totals"));
  results.push(assertEqual(synthetic.syntheticUsageExcludedCount, 1, "excluded synthetic usage is counted"));

  const baseline = { runId: "base", taskId: "base-task", taskDefinitionId: "same-task", usage: makeUsage() };
  const routed = { runId: "routed", taskId: "routed-task", taskDefinitionId: "same-task", usage: makeUsage({ inputTokens: 60, outputTokens: 40, totalTokens: 100 }) };
  const comparison = compareUsageRecords(baseline, routed);
  results.push(assert(comparison.savingsCanBeCalculated, "compatible provider records allow comparison"));
  results.push(assertEqual(comparison.tokenSavings, 50, "savings use baseline minus routed token total"));
  results.push(assert(typeof comparison.savingsPercentage === "number" && Math.abs(comparison.savingsPercentage - (100 / 3)) < 1e-10, "savings percentage uses the baseline denominator"));
  results.push(assert(!compareUsageRecords(undefined, routed).available, "missing baseline is unavailable"));
  results.push(assert(!compareUsageRecords(baseline, { ...routed, taskDefinitionId: "different-task" }).available, "mismatched task definitions are rejected"));
  results.push(assert(!compareUsageRecords(baseline, { ...routed, usage: makeUsage({ source: "locally_estimated", measurementType: "locally_estimated" }) }).available, "estimated usage cannot produce verified savings"));
  results.push(assert(!compareUsageRecords(baseline, { ...routed, usage: makeUsage({ source: "synthetic_test", measurementType: "synthetic_test" }) }).available, "synthetic data cannot produce savings"));
  results.push(assert(!compareUsageRecords(baseline, { ...routed, usage: makeUsage({ totalTokens: 99 }) }).available, "inconsistent token fields are rejected"));
  results.push(assert(!compareUsageRecords(baseline, { ...routed, usage: makeUsage({ model: "different-model" }) }).available, "different model measurements are rejected"));
  results.push(assert(!compareUsageRecords(baseline, { ...routed, usage: makeUsage({ provider: undefined }) }).available, "missing provider identity is rejected"));
  const zeroRouted = compareUsageRecords(baseline, { ...routed, usage: makeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }) });
  results.push(assert(zeroRouted.available, "real zero usage is distinct and comparable when baseline is nonzero"));
  results.push(assertEqual(zeroRouted.tokenSavings, 150, "valid routed zero yields verified savings against nonzero baseline"));
  results.push(assertEqual(zeroRouted.savingsPercentage, 100, "zero routed usage yields 100 percent savings"));
  results.push(assert(!compareUsageRecords({ ...baseline, usage: makeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }) }, routed).available, "zero baseline has undefined savings percentage"));
  return results;
}