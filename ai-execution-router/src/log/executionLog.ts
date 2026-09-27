// ─────────────────────────────────────────────────────────────────────────────
// ExecutionLog
//
// Append-only in-memory log of TaskRecords, with optional JSON file persistence.
// The log is reset each process startup — there is no database.
//
// Persistence:
//   Set EXECUTION_LOG_PATH=./execution_log.json to persist records to disk.
//   Each run appends to the file (one record per line, NDJSON format).
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from "fs";
import * as path from "path";
import { TaskRecord, Route, TaskStatus } from "../types";

// ── Report types ──────────────────────────────────────────────────────────────

export interface ExecutionReport {
  generatedAt:          string;
  totalTasks:           number;
  byRoute: {
    DETERMINISTIC:      number;
    SIMPLE_AI:          number;
    COMPLEX_AI:         number;
  };
  byStatus: {
    SUCCEEDED:          number;
    FAILED:             number;
    DELEGATED:          number;
    NEEDS_APPROVAL:     number;
    other:              number;
  };
  aiTaskCount:          number;
  aiTaskPercent:        number;
  deterministicCount:   number;
  // Tasks that completed without any AI call
  handledWithoutLLM:    number;

  // Real AI calls — only non-zero if a real provider was used
  realAICallCount:      number;
  totalPromptTokens:    number;
  totalCompletionTokens: number;
  totalTokens:          number;

  // Explicitly not reported until real data exists
  estimatedCostUsd:     "NOT_AVAILABLE — no pricing data yet";

  totalDurationMs:      number;
  records:              TaskRecord[];
}

// ── Log class ──────────────────────────────────────────────────────────────────

class ExecutionLog {
  private _records: TaskRecord[] = [];
  private _logPath: string | null = null;

  constructor() {
    const envPath = process.env.EXECUTION_LOG_PATH;
    if (envPath) {
      this._logPath = path.resolve(envPath);
    }
  }

  /** Append a task record to the in-memory log and optionally persist. */
  append(record: TaskRecord): void {
    this._records.push(record);

    if (this._logPath) {
      try {
        const line = JSON.stringify(record) + "\n";
        fs.appendFileSync(this._logPath, line, "utf-8");
      } catch {
        // Never crash the routing pipeline due to a logging error
      }
    }
  }

  /** All records accumulated in this process. */
  getRecords(): readonly TaskRecord[] {
    return this._records;
  }

  /** Clear in-memory records (used by tests). */
  clear(): void {
    this._records = [];
  }

  /** Generate a summary report. */
  generateReport(): ExecutionReport {
    const records   = this._records;
    const total     = records.length;

    const byRoute   = { DETERMINISTIC: 0, SIMPLE_AI: 0, COMPLEX_AI: 0 };
    const byStatus  = { SUCCEEDED: 0, FAILED: 0, DELEGATED: 0, NEEDS_APPROVAL: 0, other: 0 };

    let totalDuration   = 0;
    let realAICalls     = 0;
    let promptTokens    = 0;
    let completionTokens = 0;

    for (const r of records) {
      byRoute[r.route]++;
      totalDuration += r.durationMs;

      switch (r.status) {
        case "SUCCEEDED":       byStatus.SUCCEEDED++;       break;
        case "FAILED":          byStatus.FAILED++;          break;
        case "DELEGATED":       byStatus.DELEGATED++;       break;
        case "NEEDS_APPROVAL":  byStatus.NEEDS_APPROVAL++;  break;
        default:                byStatus.other++;
      }

      if (r.tokenUsage) {
        realAICalls++;
        promptTokens     += r.tokenUsage.promptTokens;
        completionTokens += r.tokenUsage.completionTokens;
      }
    }

    const aiCount  = byRoute.SIMPLE_AI + byRoute.COMPLEX_AI;
    const aiPct    = total > 0 ? Math.round((aiCount / total) * 100) : 0;

    return {
      generatedAt:           new Date().toISOString(),
      totalTasks:            total,
      byRoute,
      byStatus,
      aiTaskCount:           aiCount,
      aiTaskPercent:         aiPct,
      deterministicCount:    byRoute.DETERMINISTIC,
      handledWithoutLLM:     byRoute.DETERMINISTIC,
      realAICallCount:       realAICalls,
      totalPromptTokens:     promptTokens,
      totalCompletionTokens: completionTokens,
      totalTokens:           promptTokens + completionTokens,
      estimatedCostUsd:      "NOT_AVAILABLE — no pricing data yet",
      totalDurationMs:       totalDuration,
      records,
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
export const executionLog = new ExecutionLog();
