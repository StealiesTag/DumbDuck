// ─────────────────────────────────────────────────────────────────────────────
// ExecutionLog
//
// Append-only in-memory log of TaskRecords plus optional BaselineRecords.
// Optional NDJSON persistence via EXECUTION_LOG_PATH environment variable.
//
// v0.5 additions:
//   - BaselineRecord storage and retrieval
//   - calculateSavings() — honest savings comparison with explicit provenance
//   - SavingsReport in generateReport()
//   - Richer MeasuredUsage aggregation (source-aware)
//
// Token savings rules enforced here:
//   1. Never present PARTIAL savings as END_TO_END savings.
//   2. Never fabricate usage — unavailable means unavailable.
//   3. Never compare unrelated tasks.
//   4. Baseline must be non-zero for a percentage to be meaningful.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from "fs";
import * as path from "path";
import {
  TaskRecord,
  BaselineRecord,
  MeasuredUsage,
  SavingsComparison,
  SavingsMeasurementType,
  Route,
} from "../types";

// ── Report types ───────────────────────────────────────────────────────────────

/**
 * Per-task token breakdown in the report.
 * Clearly labels whether data came from the router/provider or the host.
 */
export interface TaskTokenBreakdown {
  taskId:            string;
  route:             Route;
  description:       string;
  /** Tokens consumed by the router's own provider call (SIMPLE_AI only). */
  routerTokens:      number | "UNAVAILABLE";
  /** Tokens consumed by the host model (Bob) — never accessible from here. */
  hostTokens:        "UNAVAILABLE — host model usage not accessible via MCP";
  /** Source of the router-token figure. */
  routerTokenSource: string;
}

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
  /** Tasks completed without any AI call at all. */
  handledWithoutLLM:    number;

  /** Real provider calls — only non-zero when a real API was used. */
  realAICallCount:      number;
  /** Tokens used by the router's own provider (SIMPLE_AI) — PROVIDER_REPORTED. */
  totalPromptTokens:    number;
  totalCompletionTokens: number;
  totalTokens:          number;

  // Explicitly not reported until real pricing data is available
  estimatedCostUsd:     "NOT_AVAILABLE — no pricing data yet";

  totalDurationMs:      number;

  // ── v0.5 additions ────────────────────────────────────────────────────────
  /** Per-task token breakdown — shows what the router measured and what it cannot. */
  tokenBreakdown:       TaskTokenBreakdown[];

  /**
   * Router-only partial token total.
   * Label: PARTIAL — this does NOT include Bob or other host model usage.
   */
  partialRouterTokens:  number;
  partialCoverage:      "PARTIAL — router provider calls only; host model usage unavailable";

  /** All savings comparisons computed in this session. */
  savingsComparisons:   SavingsComparison[];

  /** Baseline records recorded in this session. */
  baselineCount:        number;

  records:              TaskRecord[];
}

// ── Log class ──────────────────────────────────────────────────────────────────

class ExecutionLog {
  private _records:   TaskRecord[]    = [];
  private _baselines: BaselineRecord[] = [];
  private _logPath:   string | null   = null;

  constructor() {
    const envPath = process.env.EXECUTION_LOG_PATH;
    if (envPath) {
      this._logPath = path.resolve(envPath);
    }
  }

  // ── Task records ─────────────────────────────────────────────────────────────

  /** Append a task record to the in-memory log and optionally persist. */
  append(record: TaskRecord): void {
    this._records.push(record);
    this._persist({ type: "TASK_RECORD", ...record });
  }

  /** All task records accumulated in this process. */
  getRecords(): readonly TaskRecord[] {
    return this._records;
  }

  // ── Baseline records ─────────────────────────────────────────────────────────

  /**
   * Record a baseline measurement for a task completed WITHOUT the router.
   * The caller is responsible for supplying accurate usage data.
   */
  recordBaseline(baseline: BaselineRecord): void {
    this._baselines.push(baseline);
    this._persist({ type: "BASELINE_RECORD", ...baseline });
  }

  getBaselines(): readonly BaselineRecord[] {
    return this._baselines;
  }

  // ── Savings calculation ───────────────────────────────────────────────────────

  /**
   * Calculate savings between a baseline record and a routed task record.
   *
   * Honest rules:
   * - END_TO_END only when both baseline and routed have real numeric totals
   *   from PROVIDER_REPORTED or HOST_REPORTED sources covering the full workflow.
   * - PARTIAL when routed usage is from the router's provider only.
   * - NOT_CALCULABLE when baseline is zero, missing, or sources are incomparable.
   */
  calculateSavings(baselineId: string, routedTaskId: string): SavingsComparison {
    const baseline = this._baselines.find((b) => b.id === baselineId);
    const routed   = this._records.find((r) => r.taskId === routedTaskId);

    if (!baseline) {
      return {
        measurementType:   "NOT_CALCULABLE",
        baselineId,
        routedId:          routedTaskId,
        taskDescription:   routed?.description ?? "unknown",
        baselineTotalTokens: "UNAVAILABLE",
        routedTotalTokens:   "UNAVAILABLE",
        tokensSaved:         "NOT_CALCULABLE",
        percentSaved:        "NOT_CALCULABLE",
        explanation:         `Baseline record "${baselineId}" not found in this session.`,
        caveats:             ["Baseline was not recorded."],
      };
    }

    if (!routed) {
      return {
        measurementType:   "NOT_CALCULABLE",
        baselineId,
        routedId:          routedTaskId,
        taskDescription:   baseline.description,
        baselineTotalTokens: baseline.usage.totalTokens,
        routedTotalTokens:   "UNAVAILABLE",
        tokensSaved:         "NOT_CALCULABLE",
        percentSaved:        "NOT_CALCULABLE",
        explanation:         `Routed task "${routedTaskId}" not found in execution log.`,
        caveats:             ["Routed task was not recorded."],
      };
    }

    const caveats: string[] = [];
    const baseTotal = baseline.usage.totalTokens;
    const routedTotal = this._sumRoutedTokens(routed, caveats);

    // Check whether we have full end-to-end data for both sides
    const baseIsReal = typeof baseTotal === "number" &&
      (baseline.usage.source === "PROVIDER_REPORTED" || baseline.usage.source === "HOST_REPORTED");
    const routedIsReal = typeof routedTotal === "number" &&
      routed.tokenUsage !== undefined;

    let measurementType: SavingsMeasurementType;

    if (!baseIsReal || baseTotal === 0) {
      // Can't compute meaningful savings
      const why = baseTotal === 0
        ? "Baseline total tokens is zero — percentage would be undefined."
        : `Baseline source is "${baseline.usage.source}" — not a real provider measurement.`;
      caveats.push(why);
      return {
        measurementType:   "NOT_CALCULABLE",
        baselineId,
        routedId:          routedTaskId,
        taskDescription:   baseline.description,
        baselineTotalTokens: baseTotal,
        routedTotalTokens:   routedTotal,
        tokensSaved:         "NOT_CALCULABLE",
        percentSaved:        "NOT_CALCULABLE",
        explanation:         why,
        caveats,
      };
    }

    if (routedTotal === "UNAVAILABLE") {
      caveats.push("Routed task had no provider token usage (DETERMINISTIC or COMPLEX_AI delegation).");
      caveats.push("PARTIAL savings cannot be calculated when router usage is also unavailable.");
      return {
        measurementType:   "NOT_CALCULABLE",
        baselineId,
        routedId:          routedTaskId,
        taskDescription:   baseline.description,
        baselineTotalTokens: baseTotal,
        routedTotalTokens:   "UNAVAILABLE",
        tokensSaved:         "NOT_CALCULABLE",
        percentSaved:        "NOT_CALCULABLE",
        explanation:         "Router used no AI provider for this task — no token usage to compare.",
        caveats,
      };
    }

    // We have numeric values for both sides.
    // Determine whether this is END_TO_END or PARTIAL.
    if (!routedIsReal) {
      measurementType = "PARTIAL";
      caveats.push(
        "PARTIAL measurement: routed token count covers the router's provider call only. " +
        "Bob's host model usage is not accessible via MCP and is NOT included."
      );
    } else if (baseline.usage.source === "PROVIDER_REPORTED" && routedIsReal) {
      // Both sides have real provider data, but we still can't confirm Bob's
      // own usage was zero on the routed side.
      measurementType = "PARTIAL";
      caveats.push(
        "PARTIAL measurement: baseline covers full workflow; " +
        "routed total covers the router's provider call only. " +
        "Bob's model usage when handling the SIMPLE_AI result is not included."
      );
    } else {
      measurementType = "PARTIAL"; // Default conservative — we never have Bob's side
      caveats.push(
        "END_TO_END measurement is not possible because Bob's host model token usage " +
        "is not accessible to the MCP server. This is PARTIAL data only."
      );
    }

    const saved    = baseTotal - routedTotal;
    const pctSaved = Math.round((saved / baseTotal) * 100 * 10) / 10; // 1 decimal

    return {
      measurementType,
      baselineId,
      routedId:          routedTaskId,
      taskDescription:   baseline.description,
      baselineTotalTokens: baseTotal,
      routedTotalTokens:   routedTotal,
      tokensSaved:         saved,
      percentSaved:        pctSaved,
      explanation:
        `${measurementType}: baseline ${baseTotal} tokens vs router-provider ${routedTotal} tokens. ` +
        `Saved ${saved} tokens (${pctSaved}%). ${caveats[0] ?? ""}`,
      caveats,
    };
  }

  private _sumRoutedTokens(
    record: TaskRecord,
    caveats: string[]
  ): number | "UNAVAILABLE" {
    if (!record.tokenUsage) {
      if (record.route === "DETERMINISTIC") {
        caveats.push("DETERMINISTIC task used no AI provider — token count is 0 by definition.");
        return 0;
      }
      if (record.route === "COMPLEX_AI") {
        caveats.push(
          "COMPLEX_AI (DELEGATED) task: the router made no provider call. " +
          "Token usage for completing this task belongs to the host agent (Bob) and is UNAVAILABLE here."
        );
        return "UNAVAILABLE";
      }
      return "UNAVAILABLE";
    }
    return record.tokenUsage.totalTokens;
  }

  // ── Clear (tests) ─────────────────────────────────────────────────────────────

  /** Clear all in-memory records and baselines (used by tests). */
  clear(): void {
    this._records   = [];
    this._baselines = [];
  }

  // ── Report ────────────────────────────────────────────────────────────────────

  generateReport(): ExecutionReport {
    const records  = this._records;
    const total    = records.length;

    const byRoute  = { DETERMINISTIC: 0, SIMPLE_AI: 0, COMPLEX_AI: 0 };
    const byStatus = { SUCCEEDED: 0, FAILED: 0, DELEGATED: 0, NEEDS_APPROVAL: 0, other: 0 };

    let totalDuration     = 0;
    let realAICalls       = 0;
    let promptTokens      = 0;
    let completionTokens  = 0;
    const breakdown: TaskTokenBreakdown[] = [];

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

      let routerTok: number | "UNAVAILABLE" = "UNAVAILABLE";
      let tokSource = "UNAVAILABLE";

      if (r.tokenUsage) {
        realAICalls++;
        promptTokens     += r.tokenUsage.promptTokens;
        completionTokens += r.tokenUsage.completionTokens;
        routerTok = r.tokenUsage.totalTokens;
        tokSource = "PROVIDER_REPORTED";
      } else if (r.route === "DETERMINISTIC") {
        routerTok = 0;
        tokSource = "DETERMINISTIC — no AI call";
      }

      breakdown.push({
        taskId:            r.taskId,
        route:             r.route,
        description:       r.description,
        routerTokens:      routerTok,
        hostTokens:        "UNAVAILABLE — host model usage not accessible via MCP",
        routerTokenSource: tokSource,
      });
    }

    const aiCount  = byRoute.SIMPLE_AI + byRoute.COMPLEX_AI;
    const aiPct    = total > 0 ? Math.round((aiCount / total) * 100) : 0;
    const partialRouter = promptTokens + completionTokens;

    return {
      generatedAt:            new Date().toISOString(),
      totalTasks:             total,
      byRoute,
      byStatus,
      aiTaskCount:            aiCount,
      aiTaskPercent:          aiPct,
      deterministicCount:     byRoute.DETERMINISTIC,
      handledWithoutLLM:      byRoute.DETERMINISTIC,
      realAICallCount:        realAICalls,
      totalPromptTokens:      promptTokens,
      totalCompletionTokens:  completionTokens,
      totalTokens:            partialRouter,
      estimatedCostUsd:       "NOT_AVAILABLE — no pricing data yet",
      totalDurationMs:        totalDuration,
      tokenBreakdown:         breakdown,
      partialRouterTokens:    partialRouter,
      partialCoverage:        "PARTIAL — router provider calls only; host model usage unavailable",
      savingsComparisons:     [],  // populated by caller via calculateSavings()
      baselineCount:          this._baselines.length,
      records,
    };
  }

  // ── NDJSON persistence ────────────────────────────────────────────────────────

  private _persist(obj: Record<string, unknown>): void {
    if (!this._logPath) return;
    try {
      const dir = path.dirname(this._logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const line = JSON.stringify(obj) + "\n";
      fs.appendFileSync(this._logPath, line, "utf-8");
    } catch {
      // Never crash the routing pipeline due to a logging error
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
export const executionLog = new ExecutionLog();
