import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { UsageData, UsageMeasurementType } from "../types";
import { PRODUCT_NAME } from "../branding";
import { WorkspaceManager } from "../workspace/WorkspaceManager";
import { listFiles } from "../workspace/tools/listFiles";
import { readWorkspaceFile } from "../workspace/tools/readFile";
import { searchRepository } from "../workspace/tools/searchRepository";
import { getGitStatus } from "../workspace/tools/gitOps";
import { runWorkspaceTests } from "../workspace/tools/runTests";

export interface BenchmarkTaskResult {
  runId: string;
  taskId: string;
  taskDefinitionId: string;
  description: string;
  routeOrTool: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "SUCCEEDED" | "FAILED";
  errorSummary?: string;
  resultCount?: number;
  usage: UsageData;
}

export interface BenchmarkSummary {
  totalTasks: number;
  successfulTasks: number;
  failedTasks: number;
  totalDurationMs: number;
  averageDurationMs: number;
  routeToolUsageCounts: Record<string, number>;
  actualInputTokens: number | "UNAVAILABLE";
  actualOutputTokens: number | "UNAVAILABLE";
  actualTotalTokens: number | "UNAVAILABLE";
  estimatedInputTokens: number | "UNAVAILABLE";
  estimatedOutputTokens: number | "UNAVAILABLE";
  estimatedTotalTokens: number | "UNAVAILABLE";
  usageDataSources: string[];
  usageDataAvailability: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
  syntheticUsageExcludedCount: number;
}

export interface BenchmarkRun {
  runId: string;
  startedAt: string;
  endedAt: string;
  tasks: BenchmarkTaskResult[];
  summary: BenchmarkSummary;
  report: BenchmarkSavingsReport;
}

export interface BenchmarkSavingsReport {
  benchmarkRunId: string;
  dateTime: string;
  taskCount: number;
  successfulTasks: number;
  failedTasks: number;
  deterministicToolCalls: number;
  aiDelegations: number;
  totalExecutionDurationMs: number;
  actualInputTokens: number | "UNAVAILABLE";
  actualOutputTokens: number | "UNAVAILABLE";
  actualTotalTokens: number | "UNAVAILABLE";
  estimatedInputTokens: number | "UNAVAILABLE";
  estimatedOutputTokens: number | "UNAVAILABLE";
  estimatedTotalTokens: number | "UNAVAILABLE";
  usageDataSource: string;
  baselineComparisonAvailable: boolean;
  savingsCanBeCalculated: boolean;
  explanation: string;
  timingCaveat: string;
  tokenSavings: number | "not measurable — no comparable baseline usage data";
  savingsPercentage: number | "not measurable — no comparable baseline usage data";
  cost: "unavailable — valid model pricing and actual usage are required";
}

export interface UsageComparisonRecord {
  runId: string;
  taskId: string;
  taskDefinitionId: string;
  usage: UsageData;
  synthetic?: boolean;
}

export interface UsageComparison {
  available: boolean;
  savingsCanBeCalculated: boolean;
  baselineTokens: number | "UNAVAILABLE";
  routedTokens: number | "UNAVAILABLE";
  tokenSavings: number | "UNAVAILABLE";
  savingsPercentage: number | "UNAVAILABLE";
  explanation: string;
}

export const DEFAULT_BENCHMARK_REPORT_PATH = path.join(
  os.homedir(), ".ai-execution-router", "benchmark-results.jsonl"
);

export function getBenchmarkReportPath(): string {
  return path.resolve(process.env.BENCHMARK_REPORT_PATH || DEFAULT_BENCHMARK_REPORT_PATH);
}

const unavailableUsage = (): UsageData => ({
  inputTokens: "UNAVAILABLE",
  outputTokens: "UNAVAILABLE",
  totalTokens: "UNAVAILABLE",
  source: "unavailable",
  measurementType: "unavailable",
});

function sanitizeError(error: unknown, root: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replaceAll(root, "<workspace>")
    .replace(/(api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .slice(0, 240);
}

function runTask(
  runId: string,
  taskId: string,
  taskDefinitionId: string,
  description: string,
  routeOrTool: string,
  root: string,
  operation: (workspace: WorkspaceManager) => { ok: boolean; resultCount?: number; error?: string }
): BenchmarkTaskResult {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  let status: BenchmarkTaskResult["status"] = "SUCCEEDED";
  let resultCount: number | undefined;
  let errorSummary: string | undefined;
  try {
    const ws = new WorkspaceManager();
    ws.setWorkspace(root);
    const result = operation(ws);
    status = result.ok ? "SUCCEEDED" : "FAILED";
    resultCount = result.resultCount;
    if (!result.ok) errorSummary = sanitizeError(result.error ?? `${routeOrTool} failed`, root);
  } catch (error) {
    status = "FAILED";
    errorSummary = sanitizeError(error, root);
  }
  const endedAt = new Date().toISOString();
  return {
    runId,
    taskId,
    taskDefinitionId,
    description,
    routeOrTool,
    startedAt,
    endedAt,
    durationMs: Math.max(0, Date.now() - start),
    status,
    errorSummary,
    resultCount,
    usage: unavailableUsage(),
  };
}

function sumUsage(tasks: BenchmarkTaskResult[], measurementType: "provider_reported" | "host_reported" | "locally_estimated") {
  const matched = tasks.filter((task) => task.usage.measurementType === measurementType && task.usage.source === measurementType);
  if (matched.length === 0) return { input: "UNAVAILABLE" as const, output: "UNAVAILABLE" as const, total: "UNAVAILABLE" as const };
  if (matched.some((task) => !validTokens(task.usage))) return { input: "UNAVAILABLE" as const, output: "UNAVAILABLE" as const, total: "UNAVAILABLE" as const };
  const input = matched.reduce((sum, task) => sum + (typeof task.usage.inputTokens === "number" ? task.usage.inputTokens : 0), 0);
  const output = matched.reduce((sum, task) => sum + (typeof task.usage.outputTokens === "number" ? task.usage.outputTokens : 0), 0);
  const total = matched.reduce((sum, task) => sum + (typeof task.usage.totalTokens === "number" ? task.usage.totalTokens : 0), 0);
  return { input, output, total };
}

export function summarizeBenchmarkTasks(tasks: BenchmarkTaskResult[]): BenchmarkSummary {
  const usageTasks = tasks.filter((task) => task.usage.source !== "synthetic_test");
  const actual = ["provider_reported", "host_reported"] as const;
  const actualRecords = usageTasks.filter((task) => actual.includes(task.usage.measurementType as typeof actual[number]) && task.usage.source === task.usage.measurementType);
  const completeActualRecords = actualRecords.filter((task) => validTokens(task.usage));
  const estimates = sumUsage(usageTasks, "locally_estimated");
  const verified = completeActualRecords.length > 0;
  const hasUnavailable = usageTasks.some((task) => task.usage.measurementType === "unavailable") || completeActualRecords.length !== actualRecords.length;
  const actualInput = verified ? completeActualRecords.reduce((sum, task) => sum + (task.usage.inputTokens as number), 0) : "UNAVAILABLE";
  const actualOutput = verified ? completeActualRecords.reduce((sum, task) => sum + (task.usage.outputTokens as number), 0) : "UNAVAILABLE";
  const actualTotal = verified ? completeActualRecords.reduce((sum, task) => sum + (task.usage.totalTokens as number), 0) : "UNAVAILABLE";
  const durations = tasks.reduce((sum, task) => sum + task.durationMs, 0);
  const routeToolUsageCounts: Record<string, number> = {};
  for (const task of tasks) routeToolUsageCounts[task.routeOrTool] = (routeToolUsageCounts[task.routeOrTool] ?? 0) + 1;
  return {
    totalTasks: tasks.length,
    successfulTasks: tasks.filter((task) => task.status === "SUCCEEDED").length,
    failedTasks: tasks.filter((task) => task.status === "FAILED").length,
    totalDurationMs: durations,
    averageDurationMs: tasks.length ? durations / tasks.length : 0,
    routeToolUsageCounts,
    actualInputTokens: actualInput,
    actualOutputTokens: actualOutput,
    actualTotalTokens: actualTotal,
    estimatedInputTokens: estimates.input,
    estimatedOutputTokens: estimates.output,
    estimatedTotalTokens: estimates.total,
    usageDataSources: [...new Set(tasks.map((task) => task.usage.source))].sort(),
    usageDataAvailability: verified ? (hasUnavailable ? "PARTIAL" : "AVAILABLE") : "UNAVAILABLE",
    syntheticUsageExcludedCount: tasks.filter((task) => task.usage.source === "synthetic_test" || task.usage.measurementType === "synthetic_test").length,
  };
}

function makeSavingsReport(runId: string, endedAt: string, summary: BenchmarkSummary): BenchmarkSavingsReport {
  return {
    benchmarkRunId: runId,
    dateTime: endedAt,
    taskCount: summary.totalTasks,
    successfulTasks: summary.successfulTasks,
    failedTasks: summary.failedTasks,
    deterministicToolCalls: summary.totalTasks,
    aiDelegations: 0,
    totalExecutionDurationMs: summary.totalDurationMs,
    actualInputTokens: summary.actualInputTokens,
    actualOutputTokens: summary.actualOutputTokens,
    actualTotalTokens: summary.actualTotalTokens,
    estimatedInputTokens: summary.estimatedInputTokens,
    estimatedOutputTokens: summary.estimatedOutputTokens,
    estimatedTotalTokens: summary.estimatedTotalTokens,
    usageDataSource: `${summary.usageDataSources.join(", ") || "unavailable"}; host-model usage is not exposed to this MCP server`,
    baselineComparisonAvailable: false,
    savingsCanBeCalculated: false,
    explanation: "Token savings: not measurable — no comparable baseline usage data. Host-model token usage is unavailable unless the host explicitly supplies it.",
    timingCaveat: "Timing varies with operating system, filesystem cache, workspace size, Git state, installed dependencies, and system load; it is not evidence of token savings.",
    tokenSavings: "not measurable — no comparable baseline usage data",
    savingsPercentage: "not measurable — no comparable baseline usage data",
    cost: "unavailable — valid model pricing and actual usage are required",
  };
}

export function runLocalBenchmark(options: { workspaceRoot?: string; reportPath?: string; includeGit?: boolean; includeTests?: boolean } = {}): BenchmarkRun {
  const root = path.resolve(options.workspaceRoot ?? process.cwd());
  const runId = `benchmark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const tasks: BenchmarkTaskResult[] = [];
  tasks.push(runTask(runId, `${runId}-list`, "workspace.list-files.root", "List workspace entries", "listFiles", root,
    (ws) => { const result = listFiles(ws); return { ok: result.ok, resultCount: result.count, error: result.error }; }));
  tasks.push(runTask(runId, `${runId}-read`, "workspace.read-file.readme", "Read README metadata", "readWorkspaceFile", root,
    (ws) => { const result = readWorkspaceFile(ws, "README.md"); return { ok: result.ok, resultCount: result.ok ? 1 : undefined, error: result.error }; }));
  tasks.push(runTask(runId, `${runId}-search`, "workspace.search.todo", "Search source files for TODO", "searchRepository", root,
    (ws) => { const result = searchRepository(ws, "TODO"); return { ok: result.ok, resultCount: result.totalMatches, error: result.error }; }));
  if (options.includeGit !== false) {
    tasks.push(runTask(runId, `${runId}-git`, "workspace.git.status", "Read Git status", "getGitStatus", root,
      (ws) => { const result = getGitStatus(ws); return { ok: result.ok, resultCount: result.output ? result.output.trim().split(/\r?\n/).length : 0, error: result.error }; }));
  }
  if (options.includeTests !== false) {
    tasks.push(runTask(runId, `${runId}-tests`, "workspace.tests.npm-test", "Run approved npm test suite", "runWorkspaceTests:npm-test", root,
      (ws) => {
        const previousProvider = process.env.SIMPLE_AI_PROVIDER;
        const previousKey = process.env.OPENAI_API_KEY;
        process.env.SIMPLE_AI_PROVIDER = "mock";
        delete process.env.OPENAI_API_KEY;
        try {
          const result = runWorkspaceTests(ws, "npm-test");
          return { ok: result.ok, resultCount: result.ok ? 1 : 0, error: result.error ?? (result.ok ? undefined : `npm-test exited with ${result.exitCode}`) };
        } finally {
          if (previousProvider === undefined) delete process.env.SIMPLE_AI_PROVIDER;
          else process.env.SIMPLE_AI_PROVIDER = previousProvider;
          if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
          else process.env.OPENAI_API_KEY = previousKey;
        }
      }));
  }
  const endedAt = new Date().toISOString();
  const summary = summarizeBenchmarkTasks(tasks);
  const run: BenchmarkRun = { runId, startedAt, endedAt, tasks, summary, report: makeSavingsReport(runId, endedAt, summary) };
  persistBenchmarkRun(run, options.reportPath ?? getBenchmarkReportPath());
  return run;
}

function validRun(value: unknown): value is BenchmarkRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<BenchmarkRun>;
  return typeof run.runId === "string" && Array.isArray(run.tasks) && !!run.summary && !!run.report;
}

export function readBenchmarkRuns(reportPath = getBenchmarkReportPath()): { runs: BenchmarkRun[]; malformedLines: number } {
  if (!fs.existsSync(reportPath)) return { runs: [], malformedLines: 0 };
  const runs: BenchmarkRun[] = [];
  let malformedLines = 0;
  for (const line of fs.readFileSync(reportPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (validRun(value)) runs.push(value);
      else malformedLines++;
    } catch {
      malformedLines++;
    }
  }
  return { runs, malformedLines };
}

export function persistBenchmarkRun(run: BenchmarkRun, reportPath = getBenchmarkReportPath()): boolean {
  try {
    const existing = readBenchmarkRuns(reportPath).runs;
    if (existing.some((saved) => saved.runId === run.runId)) return true;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.appendFileSync(reportPath, `${JSON.stringify(run)}\n`, "utf8");
    return true;
  } catch (error) {
    process.stderr.write(`[${PRODUCT_NAME} benchmark] Could not persist report: ${sanitizeError(error, reportPath)}\n`);
    return false;
  }
}

function validTokens(usage: UsageData): boolean {
  return [usage.inputTokens, usage.outputTokens, usage.totalTokens].every((token) => typeof token === "number" && Number.isInteger(token) && token >= 0) &&
    usage.totalTokens === (usage.inputTokens as number) + (usage.outputTokens as number);
}

export function compareUsageRecords(
  baseline: UsageComparisonRecord | undefined,
  routed: UsageComparisonRecord | undefined
): UsageComparison {
  const unavailable = (explanation: string): UsageComparison => ({
    available: false, savingsCanBeCalculated: false,
    baselineTokens: "UNAVAILABLE", routedTokens: "UNAVAILABLE",
    tokenSavings: "UNAVAILABLE", savingsPercentage: "UNAVAILABLE", explanation,
  });
  if (!baseline || !routed) return unavailable("no comparable baseline usage data — one or both records were not found.");
  if (baseline.taskDefinitionId !== routed.taskDefinitionId) return unavailable("no comparable baseline usage data — task definitions do not match.");
  if (baseline.synthetic || routed.synthetic || baseline.usage.source === "synthetic_test" || routed.usage.source === "synthetic_test" || baseline.usage.measurementType === "synthetic_test" || routed.usage.measurementType === "synthetic_test") {
    return unavailable("Comparison unavailable: synthetic test usage cannot be used for savings.");
  }
  if (!validTokens(baseline.usage) || !validTokens(routed.usage)) return unavailable("Comparison unavailable: all non-negative input, output, and total token fields must be present and internally consistent.");
  const realTypes: UsageMeasurementType[] = ["provider_reported", "host_reported"];
  if (!realTypes.includes(baseline.usage.source) || !realTypes.includes(routed.usage.source) || baseline.usage.source !== routed.usage.source || baseline.usage.measurementType !== baseline.usage.source || routed.usage.measurementType !== routed.usage.source) {
    return unavailable("Comparison unavailable: both usage records must be compatible provider-reported or host-reported measurements.");
  }
  if (!baseline.usage.provider || !baseline.usage.model || baseline.usage.provider !== routed.usage.provider || baseline.usage.model !== routed.usage.model) {
    return unavailable("Comparison unavailable: both provider and model identifiers must be present and match.");
  }
  if (baseline.usage.totalTokens === 0) return unavailable("Comparison unavailable: baseline total is zero, so percentage savings is undefined.");
  const baselineTokens = baseline.usage.totalTokens as number;
  const routedTokens = routed.usage.totalTokens as number;
  const tokenSavings = baselineTokens - routedTokens;
  return {
    available: true,
    savingsCanBeCalculated: true,
    baselineTokens,
    routedTokens,
    tokenSavings,
    savingsPercentage: (tokenSavings / baselineTokens) * 100,
    explanation: `Comparable ${baseline.usage.source} usage for task definition "${baseline.taskDefinitionId}".`,
  };
}