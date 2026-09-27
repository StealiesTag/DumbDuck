// ─────────────────────────────────────────────────────────────────────────────
// Tests: Router (end-to-end routing for each task type)
// ─────────────────────────────────────────────────────────────────────────────

import { routeTaskLegacy } from "../router/router";
import { clearModelCache }  from "../router/classifier";
import { executionLog }     from "../log/executionLog";
import { IncomingTask, Route } from "../types";
import { TestResult, assertEqual, assert } from "./helpers";
import * as fs   from "fs";
import * as path from "path";

function makeTask(kind: IncomingTask["kind"], desc: string, extra: Partial<IncomingTask> = {}): IncomingTask {
  return { id: "route-test", description: desc, kind, args: {}, ...extra };
}

const TEMP_MODEL_PATH = path.resolve(__dirname, "../../models/decision_tree.json");

export async function runRoutingTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Ensure no stale model is cached between tests
  clearModelCache();
  executionLog.clear();

  // ── Deterministic tasks must NOT invoke ML ─────────────────────────────────
  const deterministicCases: Array<[IncomingTask["kind"], string]> = [
    ["SEARCH",      "Search files for TODO"],
    ["READ_FILE",   "Read package.json"],
    ["CALCULATION", "Calculate 2 + 2"],
    ["RUN_TESTS",   "Run tests"],
  ];

  for (const [kind, desc] of deterministicCases) {
    const task = makeTask(kind, desc, { args: { pattern: "x", path: "x", expression: "2+2", suite: "x" } });
    const result = await routeTaskLegacy(task, 0);
    results.push(assertEqual(result.route, "DETERMINISTIC" as Route, `${kind} → DETERMINISTIC`));
    results.push(assert(
      result.classifierSource === undefined,
      `${kind}: no classifierSource (ML not invoked)`
    ));
  }

  // ── SUMMARIZE → SIMPLE_AI (via fallback when no model present) ─────────────
  // Remove model file to force fallback path
  let savedModel: string | null = null;
  if (fs.existsSync(TEMP_MODEL_PATH)) {
    savedModel = fs.readFileSync(TEMP_MODEL_PATH, "utf-8");
    fs.unlinkSync(TEMP_MODEL_PATH);
  }
  clearModelCache();

  const summarizeTask = makeTask(
    "SUMMARIZE", "Summarize this error",
    { context: { errorMessage: "NullPointerException at line 42" } }
  );
  const summarizeResult = await routeTaskLegacy(summarizeTask, 0);
  results.push(assert(
    summarizeResult.route === "SIMPLE_AI" || summarizeResult.route === "COMPLEX_AI",
    "SUMMARIZE → AI route (SIMPLE_AI or COMPLEX_AI)"
  ));
  results.push(assertEqual(
    summarizeResult.classifierSource,
    "FALLBACK_HEURISTIC",
    "SUMMARIZE without model → FALLBACK_HEURISTIC"
  ));

  // ── DIAGNOSE → COMPLEX_AI via fallback ────────────────────────────────────
  clearModelCache();
  const diagnoseTask = makeTask(
    "DIAGNOSE", "Diagnose race condition across five files",
    { context: { filesInvolved: ["a.ts","b.ts","c.ts","d.ts","e.ts"], errorMessage: "crash" } }
  );
  const diagnoseResult = await routeTaskLegacy(diagnoseTask, 0);
  results.push(assertEqual(
    diagnoseResult.route,
    "COMPLEX_AI",
    "DIAGNOSE (many files, high reasoning) → COMPLEX_AI via fallback"
  ));

  // ── DESIGN → COMPLEX_AI via fallback ──────────────────────────────────────
  clearModelCache();
  const designTask = makeTask(
    "DESIGN", "Propose and design an architectural refactor to improve scalability",
    { context: { filesInvolved: ["src/auth/", "src/session/"] } }
  );
  const designResult = await routeTaskLegacy(designTask, 0);
  results.push(assertEqual(
    designResult.route,
    "COMPLEX_AI",
    "DESIGN → COMPLEX_AI via fallback"
  ));

  // ── Restore model if it existed ────────────────────────────────────────────
  if (savedModel !== null) {
    fs.writeFileSync(TEMP_MODEL_PATH, savedModel, "utf-8");
  }
  clearModelCache();

  return results;
}
