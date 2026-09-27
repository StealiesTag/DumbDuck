// ─────────────────────────────────────────────────────────────────────────────
// Tests: Capability Matcher
// ─────────────────────────────────────────────────────────────────────────────

import { matchCapability, getDeterministicKinds } from "../router/capabilityMatcher";
import { Task } from "../types";
import { TestResult, assert, assertEqual } from "./helpers";

function makeTask(kind: Task["kind"], desc = "test"): Task {
  return { id: "t", description: desc, kind, args: {} };
}

export function runCapabilityMatcherTests(): TestResult[] {
  const results: TestResult[] = [];

  // ── Known deterministic kinds ──────────────────────────────────────────────
  const deterministicCases: Array<[Task["kind"], string]> = [
    ["SEARCH",      "searchFiles"],
    ["READ_FILE",   "readFile"],
    ["CALCULATION", "calculator"],
    ["RUN_TESTS",   "runTests"],
    ["CREATE_FILE", "createFile"],
    ["DELETE_FILE", "deleteFile"],
  ];

  for (const [kind, expectedTool] of deterministicCases) {
    const result = matchCapability(makeTask(kind));
    results.push(assertEqual(result.matched, true,        `${kind} matched`));
    results.push(assertEqual(result.toolName, expectedTool, `${kind} toolName`));
  }

  // ── Non-deterministic kinds ────────────────────────────────────────────────
  const aiKinds: Task["kind"][] = ["SUMMARIZE", "DIAGNOSE", "DESIGN", "UNKNOWN"];
  for (const kind of aiKinds) {
    const result = matchCapability(makeTask(kind));
    results.push(assertEqual(result.matched, false, `${kind} not matched`));
    results.push(assert(result.toolName === undefined, `${kind} has no toolName`));
    results.push(assert(result.reason.length > 0,      `${kind} has a reason string`));
  }

  // ── getDeterministicKinds ──────────────────────────────────────────────────
  const kinds = getDeterministicKinds();
  results.push(assert(kinds.length === 6,              "getDeterministicKinds returns 6 entries"));
  results.push(assert(kinds.includes("SEARCH"),        "getDeterministicKinds includes SEARCH"));
  results.push(assert(kinds.includes("CALCULATION"),   "getDeterministicKinds includes CALCULATION"));

  return results;
}
