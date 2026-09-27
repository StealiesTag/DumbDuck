// ─────────────────────────────────────────────────────────────────────────────
// executionLog.internal.ts
//
// Exports the ExecutionLog class (not just the singleton) for isolated tests.
// DO NOT import this in production code — use executionLog from executionLog.ts.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from "fs";
import * as path from "path";
import {
  TaskRecord,
  BaselineRecord,
  SavingsComparison,
  SavingsMeasurementType,
  Route,
} from "../types";
import { TaskTokenBreakdown, ExecutionReport } from "./executionLog";

// Re-export everything so tests can use either file
export { TaskTokenBreakdown, ExecutionReport };

export class ExecutionLog {
  private _records:   TaskRecord[]    = [];
  private _baselines: BaselineRecord[] = [];
  private _logPath:   string | null;

  constructor(logPath?: string) {
    this._logPath = logPath ?? null;
  }

  append(record: TaskRecord): void {
    this._records.push(record);
    this._persist({ type: "TASK_RECORD", ...record });
  }

  getRecords(): readonly TaskRecord[] { return this._records; }

  recordBaseline(baseline: BaselineRecord): void {
    this._baselines.push(baseline);
    this._persist({ type: "BASELINE_RECORD", ...baseline });
  }

  getBaselines(): readonly BaselineRecord[] { return this._baselines; }

  clear(): void {
    this._records   = [];
    this._baselines = [];
  }

  generateReport(): ExecutionReport {
    const records  = this._records;
    const total    = records.length;
    const byRoute  = { DETERMINISTIC: 0, SIMPLE_AI: 0, COMPLEX_AI: 0 };
    const byStatus = { SUCCEEDED: 0, FAILED: 0, DELEGATED: 0, NEEDS_APPROVAL: 0, other: 0 };
    let totalDuration = 0, realAICalls = 0, promptTokens = 0, completionTokens = 0;
    const breakdown: TaskTokenBreakdown[] = [];

    for (const r of records) {
      byRoute[r.route]++;
      totalDuration += r.durationMs;
      switch (r.status) {
        case "SUCCEEDED": byStatus.SUCCEEDED++; break;
        case "FAILED": byStatus.FAILED++; break;
        case "DELEGATED": byStatus.DELEGATED++; break;
        case "NEEDS_APPROVAL": byStatus.NEEDS_APPROVAL++; break;
        default: byStatus.other++;
      }
      let routerTok: number | "UNAVAILABLE" = "UNAVAILABLE";
      let tokSource = "UNAVAILABLE";
      if (r.tokenUsage) {
        realAICalls++;
        promptTokens += r.tokenUsage.promptTokens;
        completionTokens += r.tokenUsage.completionTokens;
        routerTok = r.tokenUsage.totalTokens;
        tokSource = "PROVIDER_REPORTED";
      } else if (r.route === "DETERMINISTIC") {
        routerTok = 0;
        tokSource = "DETERMINISTIC — no AI call";
      }
      breakdown.push({
        taskId: r.taskId, route: r.route, description: r.description,
        routerTokens: routerTok,
        hostTokens: "UNAVAILABLE — host model usage not accessible via MCP",
        routerTokenSource: tokSource,
      });
    }

    const aiCount = byRoute.SIMPLE_AI + byRoute.COMPLEX_AI;
    const partial = promptTokens + completionTokens;
    return {
      generatedAt: new Date().toISOString(), totalTasks: total, byRoute, byStatus,
      aiTaskCount: aiCount, aiTaskPercent: total > 0 ? Math.round(aiCount/total*100) : 0,
      deterministicCount: byRoute.DETERMINISTIC, handledWithoutLLM: byRoute.DETERMINISTIC,
      realAICallCount: realAICalls, totalPromptTokens: promptTokens,
      totalCompletionTokens: completionTokens, totalTokens: partial,
      estimatedCostUsd: "NOT_AVAILABLE — no pricing data yet", totalDurationMs: totalDuration,
      tokenBreakdown: breakdown, partialRouterTokens: partial,
      partialCoverage: "PARTIAL — router provider calls only; host model usage unavailable",
      savingsComparisons: [], baselineCount: this._baselines.length, records,
    };
  }

  private _persist(obj: Record<string, unknown>): void {
    if (!this._logPath) return;
    try {
      const dir = path.dirname(this._logPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this._logPath, JSON.stringify(obj) + "\n", "utf-8");
    } catch { /* never crash */ }
  }
}
