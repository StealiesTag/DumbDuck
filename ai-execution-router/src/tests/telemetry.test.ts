// ─────────────────────────────────────────────────────────────────────────────
// Tests: v0.5 — Token savings, diagnostics, JSONL logging, MCP safety
//
// Test groups:
//   1. Token aggregation — correct totals across multiple tasks
//   2. Baseline recording and retrieval
//   3. Savings calculation — all SavingsMeasurementType branches
//   4. Zero / missing / unavailable usage edges
//   5. Partial vs end-to-end measurement labels
//   6. Host model usage — always UNAVAILABLE
//   7. Secret redaction
//   8. JSONL persistence (writes to OS temp dir, cleaned up after)
//   9. MCP protocol safety — diagnostics NEVER write to stdout
//  10. No duplicate execution records
// ─────────────────────────────────────────────────────────────────────────────

import * as os   from "os";
import * as fs   from "fs";
import * as path from "path";

import { executionLog }                    from "../log/executionLog";
import { redactSecrets, MCPDiagnostics }   from "../mcp/diagnostics";
import { ExecutionLog as IsolatedLog }     from "../log/executionLog.internal";
import { routeTask }                       from "../router/router";
import { clearModelCache }                 from "../router/classifier";
import {
  TaskRecord,
  BaselineRecord,
  IncomingTask,
} from "../types";
import { TestResult, assert, assertEqual } from "./helpers";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-v05-test-"));
}

function rmTempDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeTask(overrides: Partial<IncomingTask> = {}): IncomingTask {
  return {
    id:          "t-001",
    description: "Calculate 1+1",
    kind:        "CALCULATION",
    args:        { expression: "1+1" },
    ...overrides,
  };
}

function makeBaseline(overrides: Partial<BaselineRecord> = {}): BaselineRecord {
  return {
    id:          "bl-001",
    description: "Summarize the authentication error",
    recordedAt:  new Date().toISOString(),
    recordedBy:  "manual",
    usage: {
      promptTokens:     500,
      completionTokens: 150,
      totalTokens:      650,
      source:           "PROVIDER_REPORTED",
      recordedAt:       new Date().toISOString(),
    },
    ...overrides,
  };
}

// ── Suite 1: Token aggregation ─────────────────────────────────────────────────

export async function runTokenAggregationTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  executionLog.clear();
  clearModelCache();

  // Route a DETERMINISTIC task — should contribute 0 router tokens
  const t1 = makeTask({ id: "agg-det-001", description: "Calculate 2+2",
    kind: "CALCULATION", args: { expression: "2+2" } });
  await routeTask(t1);

  // Route a SUMMARIZE task (mock SIMPLE_AI) — mock has no token usage
  const t2 = makeTask({ id: "agg-sum-001", description: "Summarize the error",
    kind: "SUMMARIZE", args: {}, context: { errorMessage: "boom" } });
  await routeTask(t2);

  const report = executionLog.generateReport();

  // Counts
  results.push(assertEqual(report.totalTasks, 2,
    "aggregation: totalTasks=2 after two tasks"));
  results.push(assertEqual(report.deterministicCount, 1,
    "aggregation: deterministicCount=1"));
  results.push(assert(report.aiTaskCount >= 1,
    "aggregation: at least one AI task"));

  // Token totals
  results.push(assertEqual(report.totalTokens, "UNAVAILABLE",
    "aggregation: totalTokens is unavailable when the mock provider reports no usage"));
  results.push(assertEqual(report.totalPromptTokens, "UNAVAILABLE",
    "aggregation: prompt total is unavailable when AI task usage is missing"));
  results.push(assertEqual(report.realAICallCount, 0,
    "aggregation: realAICallCount=0 (mock has no real calls)"));

  // Per-task breakdown present
  results.push(assertEqual(report.tokenBreakdown.length, 2,
    "aggregation: tokenBreakdown has 2 entries"));

  const detBreakdown = report.tokenBreakdown.find((b) => b.taskId === "agg-det-001");
  results.push(assert(!!detBreakdown,
    "aggregation: DETERMINISTIC task appears in breakdown"));
  results.push(assertEqual(detBreakdown?.routerTokens, 0,
    "aggregation: DETERMINISTIC task routerTokens=0"));
  results.push(assertEqual(detBreakdown?.routerTokenSource, "DETERMINISTIC — no AI call",
    "aggregation: DETERMINISTIC task routerTokenSource label"));

  const aiBreakdown = report.tokenBreakdown.find((b) => b.taskId === "agg-sum-001");
  results.push(assert(!!aiBreakdown,
    "aggregation: SIMPLE_AI task appears in breakdown"));
  results.push(assertEqual(aiBreakdown?.routerTokens, "UNAVAILABLE",
    "aggregation: mock SIMPLE_AI task routerTokens=UNAVAILABLE (no real call)"));

  // Host tokens are always unavailable
  for (const b of report.tokenBreakdown) {
    results.push(assert(
      b.hostTokens === "UNAVAILABLE — host model usage not accessible via MCP",
      `aggregation: hostTokens always unavailable (task ${b.taskId})`
    ));
  }

  // Coverage label
  results.push(assertEqual(
    report.partialCoverage,
    "PARTIAL — router provider calls only; host model usage unavailable",
    "aggregation: partialCoverage label correct"
  ));

  executionLog.clear();
  return results;
}

// ── Suite 2: Baseline recording ────────────────────────────────────────────────

export function runBaselineTests(): TestResult[] {
  const results: TestResult[] = [];
  executionLog.clear();

  // Record a baseline
  const bl = makeBaseline();
  executionLog.recordBaseline(bl);

  const baselines = executionLog.getBaselines();
  results.push(assertEqual(baselines.length, 1,
    "baseline: one record after recordBaseline"));
  results.push(assertEqual(baselines[0].id, "bl-001",
    "baseline: id preserved"));
  results.push(assertEqual(baselines[0].description, "Summarize the authentication error",
    "baseline: description preserved"));
  results.push(assertEqual(baselines[0].usage.totalTokens, 650,
    "baseline: totalTokens preserved"));
  results.push(assertEqual(baselines[0].usage.source, "PROVIDER_REPORTED",
    "baseline: source preserved"));
  results.push(assertEqual(baselines[0].recordedBy, "manual",
    "baseline: recordedBy preserved"));

  // Second baseline
  executionLog.recordBaseline(makeBaseline({ id: "bl-002", description: "Other task" }));
  results.push(assertEqual(executionLog.getBaselines().length, 2,
    "baseline: two records after two recordBaseline calls"));

  executionLog.clear();
  return results;
}

// ── Suite 3: Savings calculation ───────────────────────────────────────────────

export async function runSavingsTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  executionLog.clear();
  clearModelCache();

  // ── 3a. NOT_CALCULABLE — baseline not found ──────────────────────────────────
  const noBaseline = executionLog.calculateSavings("missing-id", "any-task");
  results.push(assertEqual(noBaseline.measurementType, "NOT_CALCULABLE",
    "savings: missing baseline → NOT_CALCULABLE"));
  results.push(assert(noBaseline.explanation.includes("not found"),
    "savings: explanation mentions 'not found' for missing baseline"));
  results.push(assertEqual(noBaseline.tokensSaved, "NOT_CALCULABLE",
    "savings: tokensSaved=NOT_CALCULABLE when baseline missing"));
  results.push(assertEqual(noBaseline.percentSaved, "NOT_CALCULABLE",
    "savings: percentSaved=NOT_CALCULABLE when baseline missing"));

  // ── 3b. NOT_CALCULABLE — routed task not found ───────────────────────────────
  executionLog.recordBaseline(makeBaseline({ id: "bl-sc-001" }));
  const noRouted = executionLog.calculateSavings("bl-sc-001", "nonexistent-task");
  results.push(assertEqual(noRouted.measurementType, "NOT_CALCULABLE",
    "savings: missing routed task → NOT_CALCULABLE"));
  results.push(assertEqual(noRouted.baselineTotalTokens, 650,
    "savings: baseline total shown even when routed task missing"));

  // ── 3c. DETERMINISTIC task — routerTokens=0 → PARTIAL with 0 cost ───────────
  const detTask = makeTask({ id: "sc-det-001", description: "Calculate 3+3",
    kind: "CALCULATION", args: { expression: "3+3" } });
  await routeTask(detTask);
  executionLog.recordBaseline(makeBaseline({ id: "bl-sc-002" }));

  const detSavings = executionLog.calculateSavings("bl-sc-002", "sc-det-001");
  // DETERMINISTIC: router used 0 tokens; baseline had 650; saved = 650
  results.push(assertEqual(detSavings.routedTotalTokens, 0,
    "savings: DETERMINISTIC routed task shows 0 router tokens"));
  results.push(assert(
    detSavings.measurementType === "NOT_CALCULABLE",
    "savings: deterministic usage is not comparable to a model baseline"
  ));
  results.push(assertEqual(detSavings.tokensSaved, "NOT_CALCULABLE",
    "savings: no partial token savings number is emitted"));

  // ── 3d. NOT_CALCULABLE — baseline source is UNAVAILABLE ──────────────────────
  executionLog.recordBaseline(makeBaseline({
    id: "bl-unavail",
    usage: {
      promptTokens:     "UNAVAILABLE",
      completionTokens: "UNAVAILABLE",
      totalTokens:      "UNAVAILABLE",
      source:           "UNAVAILABLE",
      recordedAt:       new Date().toISOString(),
    },
  }));
  const unavailSavings = executionLog.calculateSavings("bl-unavail", "sc-det-001");
  results.push(assertEqual(unavailSavings.measurementType, "NOT_CALCULABLE",
    "savings: UNAVAILABLE baseline source → NOT_CALCULABLE"));

  // ── 3e. NOT_CALCULABLE — baseline zero ───────────────────────────────────────
  executionLog.recordBaseline(makeBaseline({
    id: "bl-zero",
    usage: {
      promptTokens:     0,
      completionTokens: 0,
      totalTokens:      0,
      source:           "PROVIDER_REPORTED",
      recordedAt:       new Date().toISOString(),
    },
  }));
  const zeroSavings = executionLog.calculateSavings("bl-zero", "sc-det-001");
  results.push(assertEqual(zeroSavings.measurementType, "NOT_CALCULABLE",
    "savings: zero baseline totalTokens → NOT_CALCULABLE"));
  results.push(assert(zeroSavings.explanation.includes("zero"),
    "savings: explanation mentions 'zero' for zero baseline"));

  // ── 3f. COMPLEX_AI delegation — router tokens UNAVAILABLE ────────────────────
  const complexTask = makeTask({
    id: "sc-complex-001",
    description: "Diagnose a multi-module bug",
    kind: "DIAGNOSE",
    args: {},
    context: { filesInvolved: ["a.ts","b.ts","c.ts","d.ts","e.ts"] },
  });
  await routeTask(complexTask);
  executionLog.recordBaseline(makeBaseline({ id: "bl-sc-complex" }));

  const complexSavings = executionLog.calculateSavings("bl-sc-complex", "sc-complex-001");
  results.push(assertEqual(complexSavings.measurementType, "NOT_CALCULABLE",
    "savings: COMPLEX_AI delegation has UNAVAILABLE router tokens → NOT_CALCULABLE"));
  results.push(assert(complexSavings.caveats.some((c) => c.includes("DELEGATED") || c.includes("host")),
    "savings: COMPLEX_AI caveats mention delegation/host model"));

  executionLog.clear();
  return results;
}

// ── Suite 4: Zero / missing / unavailable usage ────────────────────────────────

export function runUsageEdgeCaseTests(): TestResult[] {
  const results: TestResult[] = [];
  executionLog.clear();

  // calculateSavings with no data at all
  const empty = executionLog.calculateSavings("no-bl", "no-task");
  results.push(assertEqual(empty.measurementType, "NOT_CALCULABLE",
    "edge: empty log → NOT_CALCULABLE"));
  results.push(assertEqual(empty.baselineTotalTokens, "UNAVAILABLE",
    "edge: empty baseline → baselineTotalTokens=UNAVAILABLE"));
  results.push(assertEqual(empty.routedTotalTokens, "UNAVAILABLE",
    "edge: empty routed → routedTotalTokens=UNAVAILABLE"));

  // recordBaseline with no token fields → source UNAVAILABLE
  executionLog.recordBaseline({
    id:          "bl-edge-001",
    description: "Task with no token data",
    recordedAt:  new Date().toISOString(),
    recordedBy:  "test",
    usage: {
      promptTokens:     "UNAVAILABLE",
      completionTokens: "UNAVAILABLE",
      totalTokens:      "UNAVAILABLE",
      source:           "UNAVAILABLE",
      recordedAt:       new Date().toISOString(),
    },
  });
  const bl = executionLog.getBaselines().find((b) => b.id === "bl-edge-001");
  results.push(assert(!!bl, "edge: baseline with UNAVAILABLE usage is stored"));
  results.push(assertEqual(bl?.usage.source, "UNAVAILABLE",
    "edge: UNAVAILABLE usage source preserved"));

  // generateReport with empty log
  const emptyReport = executionLog.generateReport();
  results.push(assertEqual(emptyReport.totalTasks, 0,
    "edge: empty report totalTasks=0"));
  results.push(assertEqual(emptyReport.totalTokens, 0,
    "edge: empty report totalTokens=0"));
  results.push(assertEqual(emptyReport.tokenBreakdown.length, 0,
    "edge: empty report tokenBreakdown=[]"));
  results.push(assertEqual(emptyReport.baselineCount, 1,
    "edge: baselineCount=1 after recordBaseline with UNAVAILABLE usage"));

  executionLog.clear();
  return results;
}

// ── Suite 5: Partial vs end-to-end labels ─────────────────────────────────────

export async function runMeasurementLabelTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  executionLog.clear();
  clearModelCache();

  // Route a SIMPLE_AI task (mock — no real token usage)
  const sumTask = makeTask({
    id: "lbl-sum-001", description: "Summarize the error",
    kind: "SUMMARIZE", args: {}, context: { errorMessage: "crash" },
  });
  await routeTask(sumTask);

  // Baseline with real data
  executionLog.recordBaseline(makeBaseline({ id: "bl-lbl-001" }));

  const savings = executionLog.calculateSavings("bl-lbl-001", "lbl-sum-001");

  // Mock SIMPLE_AI has no token usage → UNAVAILABLE on routed side → NOT_CALCULABLE
  results.push(assertEqual(savings.measurementType, "NOT_CALCULABLE",
    "label: mock SIMPLE_AI (no tokens) → NOT_CALCULABLE"));

  // The report's partialCoverage label must never say END_TO_END
  const report = executionLog.generateReport();
  results.push(assert(
    !report.partialCoverage.includes("END_TO_END"),
    "label: partialCoverage never claims END_TO_END"
  ));
  results.push(assert(
    report.partialCoverage.includes("PARTIAL"),
    "label: partialCoverage always says PARTIAL"
  ));

  executionLog.clear();
  return results;
}

// ── Suite 6: Host model usage always UNAVAILABLE ──────────────────────────────

export async function runHostUsageTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  executionLog.clear();
  clearModelCache();

  // Route any task
  await routeTask(makeTask({ id: "host-001" }));

  const report = executionLog.generateReport();

  for (const b of report.tokenBreakdown) {
    results.push(assertEqual(
      b.hostTokens,
      "UNAVAILABLE — host model usage not accessible via MCP",
      `host: hostTokens always has the standard UNAVAILABLE label (task ${b.taskId})`
    ));
  }

  // Savings never produce END_TO_END
  executionLog.recordBaseline(makeBaseline({ id: "bl-host-001" }));
  const s = executionLog.calculateSavings("bl-host-001", "host-001");
  results.push(assert(
    s.measurementType !== "END_TO_END",
    "host: calculateSavings never produces END_TO_END (host usage not available)"
  ));

  executionLog.clear();
  return results;
}

// ── Suite 7: Secret redaction ─────────────────────────────────────────────────

export function runRedactionTests(): TestResult[] {
  const results: TestResult[] = [];

  // Direct key matches
  const apiKeyArgs = { OPENAI_API_KEY: "sk-abc123", description: "task" };
  const redacted = redactSecrets(apiKeyArgs as Record<string, unknown>);
  results.push(assertEqual(redacted["OPENAI_API_KEY"], "[REDACTED]",
    "redaction: OPENAI_API_KEY is redacted"));
  results.push(assertEqual(redacted["description"], "task",
    "redaction: non-secret field preserved"));

  // All secret key patterns
  const secretKeys: Record<string, string> = {
    api_key: "secret1",
    apikey: "secret2",
    password: "pass123",
    token: "tok456",
    access_token: "acc789",
    auth_token: "auth000",
    secret: "sec111",
    private_key: "priv222",
    authorization: "Bearer xyz",
    credential: "cred999",
  };
  const redactedAll = redactSecrets(secretKeys as Record<string, unknown>);
  for (const k of Object.keys(secretKeys)) {
    results.push(assertEqual(redactedAll[k], "[REDACTED]",
      `redaction: key '${k}' is redacted`));
  }

  // Non-secret fields are preserved
  const safe = { path: "/some/path", pattern: "TODO", staged: false, suite: "jest" };
  const redactedSafe = redactSecrets(safe as Record<string, unknown>);
  results.push(assertEqual(redactedSafe["path"], "/some/path",
    "redaction: path field not redacted"));
  results.push(assertEqual(redactedSafe["pattern"], "TODO",
    "redaction: pattern field not redacted"));
  results.push(assertEqual(redactedSafe["staged"], false,
    "redaction: boolean field not redacted"));

  // Nested secrets are redacted
  const nested = { env: { OPENAI_API_KEY: "sk-nested", other: "ok" } };
  const redactedNested = redactSecrets(nested as Record<string, unknown>);
  const env = redactedNested["env"] as Record<string, unknown>;
  results.push(assertEqual(env["OPENAI_API_KEY"], "[REDACTED]",
    "redaction: nested OPENAI_API_KEY is redacted"));
  results.push(assertEqual(env["other"], "ok",
    "redaction: nested non-secret field preserved"));

  // Original object is not mutated
  results.push(assertEqual(apiKeyArgs["OPENAI_API_KEY"], "sk-abc123",
    "redaction: original object not mutated"));

  return results;
}

// ── Suite 8: JSONL persistence ────────────────────────────────────────────────

export async function runJsonlPersistenceTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const tmp = makeTempDir();

  try {
    const logPath = path.join(tmp, "logs", "execution.ndjson");

    // Temporarily override the env var and rebuild a fresh ExecutionLog
    // We do this by importing directly and using the private _logPath path.
    // Instead, we test via the public executionLog with a custom EXECUTION_LOG_PATH.
    const origLogPath = process.env.EXECUTION_LOG_PATH;
    process.env.EXECUTION_LOG_PATH = logPath;

    // Construct a fresh isolated instance pointing at logPath.
    // (The singleton was constructed at import time; IsolatedLog lets tests
    //  create instances with a custom path without touching the singleton.)
    const ExecutionLogForTest = new IsolatedLog(logPath);

    // Append a task record
    const record: TaskRecord = {
      taskId:       "jsonl-001",
      description:  "Test JSONL persistence",
      kind:         "CALCULATION",
      route:        "DETERMINISTIC",
      status:       "SUCCEEDED",
      executorName: "deterministic",
      startedAt:    new Date().toISOString(),
      endedAt:      new Date().toISOString(),
      durationMs:   5,
      output:       "2+2=4",
    };
    ExecutionLogForTest.append(record);

    // Parent directory should have been created
    results.push(assert(fs.existsSync(path.dirname(logPath)),
      "jsonl: parent directory created automatically"));
    results.push(assert(fs.existsSync(logPath),
      "jsonl: log file created after append"));

    // File should contain valid NDJSON
    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    results.push(assert(lines.length >= 1,
      "jsonl: at least one line written"));

    const parsed = JSON.parse(lines[0]);
    results.push(assertEqual(parsed.taskId, "jsonl-001",
      "jsonl: taskId preserved in NDJSON record"));
    results.push(assertEqual(parsed.type, "TASK_RECORD",
      "jsonl: type field is TASK_RECORD"));

    // Baseline also persisted
    ExecutionLogForTest.recordBaseline(makeBaseline());
    const lines2 = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    results.push(assert(lines2.length >= 2,
      "jsonl: baseline appended as second line"));

    const baselineLine = lines2.find((l) => l.includes("BASELINE_RECORD"));
    results.push(assert(!!baselineLine,
      "jsonl: baseline record has type=BASELINE_RECORD"));

    // No duplicate records — same record appended only once
    const before = fs.readFileSync(logPath, "utf-8").trim().split("\n").length;
    ExecutionLogForTest.append(record); // append same record again
    const after = fs.readFileSync(logPath, "utf-8").trim().split("\n").length;
    results.push(assertEqual(after, before + 1,
      "jsonl: each append adds exactly one line (no silent duplicates)"));

    // File-write errors do not crash the process
    // (Test this by writing to a path where the dir is a file, not a dir)
    const badBase = path.join(tmp, "not-a-dir");
    fs.writeFileSync(badBase, "I am a file, not a directory");
    const badLogPath = path.join(badBase, "log.ndjson");
    let threw = false;
    try {
      const errLog = new IsolatedLog(badLogPath);
      errLog.append(record);
    } catch {
      threw = true;
    }
    results.push(assert(!threw,
      "jsonl: write error does not crash the process"));

    // Restore env
    if (origLogPath === undefined) delete process.env.EXECUTION_LOG_PATH;
    else process.env.EXECUTION_LOG_PATH = origLogPath;

  } finally {
    rmTempDir(tmp);
  }

  return results;
}

// ── Suite 9: MCP protocol safety — diagnostics never go to stdout ──────────────

export function runMCPProtocolSafetyTests(): TestResult[] {
  const results: TestResult[] = [];

  // Capture stdout writes
  const stdoutWrites: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  // @ts-expect-error — override for test
  process.stdout.write = (chunk: unknown, ...rest: unknown[]) => {
    stdoutWrites.push(String(chunk));
    return origWrite(chunk as never, ...(rest as never[]));
  };

  // Capture stderr writes
  const stderrWrites: string[] = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  // @ts-expect-error — override for test
  process.stderr.write = (chunk: unknown, ...rest: unknown[]) => {
    stderrWrites.push(String(chunk));
    return origStderrWrite(chunk as never, ...(rest as never[]));
  };

  // Run diagnostics using the exported MCPDiagnostics class directly.
  // A fresh instance avoids interfering with the MCP server's singleton.
  const diag = new MCPDiagnostics();
  const execId = "safety-test-001";

  diag.start(execId, "read_file", { path: "/some/file.ts" });
  diag.complete(execId, { route: "DETERMINISTIC", status: "SUCCEEDED", durationMs: 5 });

  // Restore
  // @ts-expect-error — restore
  process.stdout.write = origWrite;
  // @ts-expect-error — restore
  process.stderr.write = origStderrWrite;

  // Diagnostics must NOT have written to stdout
  results.push(assert(stdoutWrites.length === 0,
    "mcp-safety: diagnostics write nothing to stdout"));

  // Diagnostics MUST have written to stderr
  results.push(assert(stderrWrites.length > 0,
    "mcp-safety: diagnostics write to stderr"));

  // Stderr content must contain expected fields, not raw JSON-RPC
  const stderrContent = stderrWrites.join("");
  results.push(assert(stderrContent.includes("DumbDuck"),
    "mcp-safety: stderr contains [DumbDuck] header"));
  results.push(assert(stderrContent.includes("read_file"),
    "mcp-safety: stderr contains tool name"));
  results.push(assert(stderrContent.includes("completed") || stderrContent.includes("SUCCEEDED"),
    "mcp-safety: stderr contains completion status"));
  results.push(assert(!stderrContent.includes('"jsonrpc"'),
    "mcp-safety: stderr does not contain raw JSON-RPC protocol messages"));

  return results;
}

// ── Suite 10: No duplicate execution records ───────────────────────────────────

export async function runNoDuplicatesTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  executionLog.clear();
  clearModelCache();

  const task = makeTask({ id: "nodup-001", description: "Calculate 5+5",
    kind: "CALCULATION", args: { expression: "5+5" } });

  // Route the same task once
  await routeTask(task);

  const records = executionLog.getRecords();
  const dupes = records.filter((r) => r.taskId === "nodup-001");
  results.push(assertEqual(dupes.length, 1,
    "no-duplicates: routing a task once produces exactly one record"));

  // Route again with a different ID — should produce exactly 2 total
  const task2 = makeTask({ id: "nodup-002", description: "Calculate 6+6",
    kind: "CALCULATION", args: { expression: "6+6" } });
  await routeTask(task2);

  results.push(assertEqual(executionLog.getRecords().length, 2,
    "no-duplicates: two tasks produce exactly two records"));

  // The same record does not appear twice in the report
  const report = executionLog.generateReport();
  results.push(assertEqual(report.totalTasks, 2,
    "no-duplicates: report totalTasks=2 with 2 distinct tasks"));

  executionLog.clear();
  return results;
}
