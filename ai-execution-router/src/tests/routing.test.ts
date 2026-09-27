// ─────────────────────────────────────────────────────────────────────────────
// Tests: Router (end-to-end routing for each task type)
// ─────────────────────────────────────────────────────────────────────────────

import { routeTask, routeTaskLegacy } from "../router/router";
import { clearModelCache }  from "../router/classifier";
import { executionLog }     from "../log/executionLog";
import { IncomingTask, Route } from "../types";
import { TestResult, assertEqual, assert } from "./helpers";
import * as os from "os";
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

  const mutationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "router-mutations-"));
  try {
    const created = await routeTask(makeTask("CREATE_FILE", "Create a calculation result file", {
      id: "route-create-file",
      args: { path: "answer.txt", content: "5*8 = 40\n" },
      workspaceRoot: mutationRoot,
    }));
    results.push(assertEqual(created.route, "DETERMINISTIC", "CREATE_FILE routes deterministically"));
    results.push(assertEqual(created.status, "SUCCEEDED", "CREATE_FILE succeeds"));
    results.push(assertEqual(fs.readFileSync(path.join(mutationRoot, "answer.txt"), "utf-8"), "5*8 = 40\n",
      "CREATE_FILE writes requested contents through the router"));

    const pendingDelete = await routeTask(makeTask("DELETE_FILE", "Delete the calculation result file", {
      id: "route-delete-file-pending",
      args: { path: "answer.txt" },
      workspaceRoot: mutationRoot,
    }));
    results.push(assertEqual(pendingDelete.route, "DETERMINISTIC", "DELETE_FILE routes deterministically"));
    results.push(assertEqual(pendingDelete.status, "NEEDS_APPROVAL", "DELETE_FILE without confirmation needs approval"));
    results.push(assert(fs.existsSync(path.join(mutationRoot, "answer.txt")),
      "unapproved routed delete leaves file intact"));

    const deleted = await routeTask(makeTask("DELETE_FILE", "Delete the approved calculation result file", {
      id: "route-delete-file-approved",
      args: { path: "answer.txt", confirm: true },
      workspaceRoot: mutationRoot,
    }));
    results.push(assertEqual(deleted.status, "SUCCEEDED", "confirmed DELETE_FILE succeeds"));
    results.push(assert(!fs.existsSync(path.join(mutationRoot, "answer.txt")),
      "confirmed routed delete removes the file"));
  } finally {
    fs.rmSync(mutationRoot, { recursive: true, force: true });
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
