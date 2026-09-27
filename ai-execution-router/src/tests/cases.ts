// ─────────────────────────────────────────────────────────────────────────────
// Test cases for the classifier
//
// Each case is a minimal Task and the Route we expect the classifier to return.
// The runner is intentionally kept simple and dependency-free so that anyone
// can read the expected behaviour without knowing a test framework.
// ─────────────────────────────────────────────────────────────────────────────

import { Task, Route } from "../types";

export interface TestCase {
  label:    string;
  task:     Task;
  expected: Route;
}

export const TEST_CASES: TestCase[] = [
  // ── DETERMINISTIC ──────────────────────────────────────────────────────────
  {
    label:    "Search files for TODO",
    expected: "DETERMINISTIC",
    task: {
      id:          "test-001",
      description: "Search files for TODO",
      kind:        "SEARCH",
      args:        { pattern: "TODO" },
    },
  },
  {
    label:    "Read package.json",
    expected: "DETERMINISTIC",
    task: {
      id:          "test-002",
      description: "Read package.json",
      kind:        "READ_FILE",
      args:        { path: "package.json" },
    },
  },
  {
    label:    "Calculate 15 * 27",
    expected: "DETERMINISTIC",
    task: {
      id:          "test-003",
      description: "Calculate 15 * 27",
      kind:        "CALCULATION",
      args:        { expression: "15 * 27" },
    },
  },
  {
    label:    "Run tests",
    expected: "DETERMINISTIC",
    task: {
      id:          "test-004",
      description: "Run tests",
      kind:        "RUN_TESTS",
      args:        { suite: "unit" },
    },
  },

  // ── SIMPLE_AI ──────────────────────────────────────────────────────────────
  {
    label:    "Summarize this error",
    expected: "SIMPLE_AI",
    task: {
      id:          "test-005",
      description: "Summarize this error",
      kind:        "SUMMARIZE",
      args:        {},
      context: {
        errorMessage: "NullPointerException at line 42",
      },
    },
  },

  // ── COMPLEX_AI ─────────────────────────────────────────────────────────────
  {
    label:    "Diagnose a bug across five files",
    expected: "COMPLEX_AI",
    task: {
      id:          "test-006",
      description: "Diagnose a bug across five files",
      kind:        "DIAGNOSE",
      args:        {},
      context: {
        filesInvolved: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
        errorMessage:  "Crash under load",
      },
    },
  },
  {
    label:    "Design a large refactor",
    expected: "COMPLEX_AI",
    task: {
      id:          "test-007",
      description: "Design a large architectural refactor to improve scalability",
      kind:        "DESIGN",
      args:        {},
      context: {
        filesInvolved: ["src/auth/", "src/session/"],
      },
    },
  },
];
