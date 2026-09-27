// ─────────────────────────────────────────────────────────────────────────────
// Capability Matcher
//
// Determines whether a deterministic local tool can fully handle a task.
// This check runs BEFORE the ML classifier — if it matches, no model is called.
//
// Adding a new deterministic capability:
//   1. Add the TaskKind to DETERMINISTIC_CAPABILITIES below.
//   2. Add a corresponding executor case in src/executors/deterministic.ts.
//   3. Add a test case in src/tests/capabilityMatcher.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { Task, TaskKind, CapabilityMatch } from "../types";

// Each entry maps a task kind to a human-readable tool name.
// Only list kinds that have a fully working implementation in deterministic.ts.
const DETERMINISTIC_CAPABILITIES: Partial<Record<TaskKind, string>> = {
  SEARCH:      "searchFiles",
  READ_FILE:   "readFile",
  CALCULATION: "calculator",
  RUN_TESTS:   "runTests",
  CREATE_FILE: "createFile",
  DELETE_FILE: "deleteFile",
};

/**
 * Check whether a deterministic tool can fully handle this task.
 *
 * Returns { matched: true, toolName, reason } when a capability exists.
 * Returns { matched: false, reason } when ML classification is needed.
 */
export function matchCapability(task: Task): CapabilityMatch {
  const toolName = DETERMINISTIC_CAPABILITIES[task.kind];

  if (toolName !== undefined) {
    return {
      matched:  true,
      toolName,
      reason:   `Task kind "${task.kind}" is handled by the "${toolName}" tool`,
    };
  }

  return {
    matched: false,
    reason:  `No deterministic tool registered for task kind "${task.kind}" — routing to ML classifier`,
  };
}

/**
 * Returns the list of task kinds that have registered deterministic tools.
 * Used by tests to verify capability registration is exhaustive.
 */
export function getDeterministicKinds(): TaskKind[] {
  return Object.keys(DETERMINISTIC_CAPABILITIES) as TaskKind[];
}
