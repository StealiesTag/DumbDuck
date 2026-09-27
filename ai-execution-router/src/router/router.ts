// ─────────────────────────────────────────────────────────────────────────────
// Router
//
// Orchestrates the full pipeline for a single IncomingTask:
//   1. Capability matching  — is there a deterministic tool for this?
//   2. Feature extraction   — build the numeric feature vector
//   3. ML classification    — predict SIMPLE_AI or COMPLEX_AI
//   4. Execution            — dispatch to the correct executor
//   5. Logging              — write a TaskRecord to the execution log
//   6. Return               — TaskRecord with full provenance
// ─────────────────────────────────────────────────────────────────────────────

import {
  IncomingTask,
  ExecutionResult,
  ClassificationResult,
  Route,
  NamedFeatures,
  FEATURE_NAMES,
  TaskRecord,
  TaskStatus,
} from "../types";
import { matchCapability }       from "./capabilityMatcher";
import { extractFeatureVector }  from "./features";
import { classifyWithML, getModelStatus } from "./classifier";
import { runDeterministic }      from "../executors/deterministic";
import { runSimpleAI }           from "../executors/simpleAI";
import { runComplexAI }          from "../executors/complexAI";
import { executionLog }          from "../log/executionLog";

// ── Formatting helpers ────────────────────────────────────────────────────────

const DIVIDER = "-".repeat(54);

function pad(label: string, width = 28): string {
  return label.padEnd(width);
}

function logClassification(task: IncomingTask, index: number, result: ClassificationResult): void {
  const f: NamedFeatures | undefined = result.mlResult?.namedFeatures;

  console.log(`\n${DIVIDER}`);
  console.log(`TASK ${index}`);
  console.log(`Description: ${task.description}`);

  console.log(`\nCapability match: ${result.capabilityMatch.matched ? "YES" : "NO"}`);
  console.log(`  ${result.capabilityMatch.reason}`);

  if (f && result.mlResult) {
    console.log("\nFeature vector:");
    FEATURE_NAMES.forEach((name, i) => {
      const val = result.mlResult!.featureVector[i];
      console.log(`  [${i}] ${pad(name)} ${val}`);
    });

    console.log(`\nClassifier source: ${result.mlResult.source}`);
    if (result.mlResult.confidence !== undefined) {
      console.log(`Confidence: ${(result.mlResult.confidence * 100).toFixed(1)}%`);
    }
    if (result.mlResult.decisionPath && result.mlResult.decisionPath.length > 0) {
      console.log("Decision path:");
      result.mlResult.decisionPath.forEach((step) => console.log(`  → ${step}`));
    }
  }

  console.log(`\nROUTE: ${result.route}`);
  console.log(DIVIDER);
}

function logOutput(result: ExecutionResult & { status?: TaskStatus }): void {
  const sourceLabel = result.classifierSource
    ? ` [${result.classifierSource}]`
    : "";
  const status = result.status ?? "SUCCEEDED";
  console.log(`Status: ${status}`);
  console.log(`Output${sourceLabel}: ${result.output.slice(0, 300)}${result.output.length > 300 ? "…" : ""}`);
  console.log(`Duration: ${result.durationMs} ms`);
}

// ── Main routing function ─────────────────────────────────────────────────────

export async function routeTask(
  task:  IncomingTask,
  index: number = 0
): Promise<TaskRecord> {
  const startedAt = new Date().toISOString();

  // Step 1 — capability matching
  const capabilityMatch = matchCapability(task);

  let classification: ClassificationResult;
  let record: TaskRecord;

  if (capabilityMatch.matched) {
    classification = { route: "DETERMINISTIC", capabilityMatch };
    logClassification(task, index, classification);

    const execResult = runDeterministic(task);
    const endedAt = new Date().toISOString();
    const status = execResult.status ?? "SUCCEEDED";

    record = {
      taskId:        task.id,
      description:   task.description,
      kind:          task.kind,
      originatingAgent: task.originatingAgent,
      workspaceRoot: task.workspaceRoot,
      route:         "DETERMINISTIC",
      status,
      executorName:  "deterministic",
      startedAt,
      endedAt,
      durationMs:    execResult.durationMs,
      output:        execResult.output,
    };

    logOutput(execResult);

  } else {
    // Step 2 — feature extraction
    const { named, vector } = extractFeatureVector(task);

    // Step 3 — ML classification
    const mlResult = classifyWithML(vector, named);
    const route: Route = mlResult.label;

    classification = { route, capabilityMatch, mlResult };
    logClassification(task, index, classification);

    if (route === "SIMPLE_AI") {
      const execResult = await runSimpleAI(task);
      const endedAt = new Date().toISOString();

      record = {
        taskId:        task.id,
        description:   task.description,
        kind:          task.kind,
        originatingAgent: task.originatingAgent,
        workspaceRoot: task.workspaceRoot,
        route:         "SIMPLE_AI",
        status:        execResult.status,
        executorName:  execResult.isMock ? "simple-ai-mock" : "simple-ai",
        classifierSource: mlResult.source,
        decisionPath:  mlResult.decisionPath,
        confidence:    mlResult.confidence,
        featureVector: vector,
        startedAt,
        endedAt,
        durationMs:    execResult.durationMs,
        output:        execResult.output,
        modelId:       execResult.modelId,
        providerId:    execResult.providerId,
        tokenUsage:    execResult.tokenUsage,
      };

      logOutput({ ...execResult, classifierSource: mlResult.source });

    } else {
      // COMPLEX_AI — delegate
      const execResult = await runComplexAI(
        task,
        mlResult.source,
        mlResult.decisionPath,
        mlResult.confidence
      );
      const endedAt = new Date().toISOString();

      record = {
        taskId:        task.id,
        description:   task.description,
        kind:          task.kind,
        originatingAgent: task.originatingAgent,
        workspaceRoot: task.workspaceRoot,
        route:         "COMPLEX_AI",
        status:        "DELEGATED",
        executorName:  "complex-ai-delegation",
        classifierSource: mlResult.source,
        decisionPath:  mlResult.decisionPath,
        confidence:    mlResult.confidence,
        featureVector: vector,
        startedAt,
        endedAt,
        durationMs:    execResult.durationMs,
        output:        execResult.output,
        delegation:    execResult.delegation,
      };

      logOutput({ ...execResult, classifierSource: mlResult.source });
    }
  }

  // Step 5 — append to execution log
  executionLog.append(record);

  return record;
}

// ── Legacy ExecutionResult adapter ────────────────────────────────────────────
// Preserves backward compatibility for the CLI demo and old tests.

export async function routeTaskLegacy(
  task:  IncomingTask,
  index: number
): Promise<ExecutionResult> {
  const record = await routeTask(task, index);
  return {
    taskId:          record.taskId,
    route:           record.route,
    output:          record.output ?? "",
    durationMs:      record.durationMs,
    classifierSource: record.classifierSource,
  };
}

// ── Summary printer ───────────────────────────────────────────────────────────

export function printSummary(results: ExecutionResult[]): void {
  const total          = results.length;
  const byRoute        = (r: Route) => results.filter((x) => x.route === r).length;

  const nDeterministic = byRoute("DETERMINISTIC");
  const nSimple        = byRoute("SIMPLE_AI");
  const nComplex       = byRoute("COMPLEX_AI");
  const nAI            = nSimple + nComplex;
  const aiPct          = total > 0 ? Math.round((nAI / total) * 100) : 0;

  const nML       = results.filter((r) => r.classifierSource === "ML_MODEL").length;
  const nFallback = results.filter((r) => r.classifierSource === "FALLBACK_HEURISTIC").length;

  console.log(`\n${"=".repeat(54)}`);
  console.log("ROUTING SUMMARY");
  console.log("=".repeat(54));
  console.log(`Total tasks:                  ${total}`);
  console.log(`  DETERMINISTIC:              ${nDeterministic}`);
  console.log(`  SIMPLE_AI:                  ${nSimple}`);
  console.log(`  COMPLEX_AI (delegated):     ${nComplex}`);
  console.log(`Total AI tasks:               ${nAI}  (${aiPct}% of total)`);
  console.log(`Potentially avoided AI calls: ${nDeterministic}`);
  console.log(`─`.repeat(54));
  console.log(`AI classification source:`);
  console.log(`  ML_MODEL:                   ${nML}`);
  console.log(`  FALLBACK_HEURISTIC:         ${nFallback}`);
  console.log(`─`.repeat(54));
  console.log(`Model status: ${getModelStatus()}`);
  console.log("=".repeat(54));
  if (nFallback > 0) {
    console.log("⚠  Some tasks used FALLBACK_HEURISTIC — not ML predictions.");
    console.log("   Train the model to enable true ML routing.");
  }
  console.log("Note: Token/cost savings not measured. No baseline yet.");
}
