// ─────────────────────────────────────────────────────────────────────────────
// Mock Agent
//
// Simulates an AI agent decomposing a user request into a sequence of
// observable tasks. In a real system this list would be produced dynamically
// by an actual planning agent. Here we hard-code a representative sequence
// so the router can be exercised without spending AI credits.
//
// The tasks deliberately span all three execution tiers:
//   Tasks 1–4  → expect DETERMINISTIC
//   Task  5    → expect SIMPLE_AI
//   Tasks 6–7  → expect COMPLEX_AI
//
// The route is NOT stored in the task — it is determined by the router.
// ─────────────────────────────────────────────────────────────────────────────

import * as path from "path";
import { Task }  from "../types";

// Point searches at the project's own source tree for a realistic result
const PROJECT_ROOT = path.resolve(__dirname, "../../");

export function getMockTasks(): Task[] {
  return [
    // ── Task 1: repository search ──────────────────────────────────────────
    {
      id:          "task-001",
      description: "Search the repository for TODO comments",
      kind:        "SEARCH",
      args: {
        pattern: "TODO",
        root:    PROJECT_ROOT,
      },
    },

    // ── Task 2: read a configuration file ──────────────────────────────────
    {
      id:          "task-002",
      description: "Read package.json to inspect dependencies",
      kind:        "READ_FILE",
      args: {
        path: path.join(PROJECT_ROOT, "package.json"),
      },
    },

    // ── Task 3: arithmetic ─────────────────────────────────────────────────
    {
      id:          "task-003",
      description: "Calculate the value of (15 * 27) + 42",
      kind:        "CALCULATION",
      args: {
        expression: "(15 * 27) + 42",
      },
    },

    // ── Task 4: run tests ──────────────────────────────────────────────────
    {
      id:          "task-004",
      description: "Run the test suite to check for regressions",
      kind:        "RUN_TESTS",
      args: {
        suite: "unit",
      },
    },

    // ── Task 5: summarise an error (light NLP) ─────────────────────────────
    {
      id:          "task-005",
      description: "Summarize the authentication error from the latest logs",
      kind:        "SUMMARIZE",
      args: {},
      context: {
        errorMessage:
          "Error: JWT signature verification failed — token issued at 2024-01-01 has expired. " +
          "Expected audience: api.example.com. Received: web.example.com.",
      },
    },

    // ── Task 6: multi-file bug diagnosis (deep reasoning) ──────────────────
    {
      id:          "task-006",
      description: "Diagnose a bug causing race conditions across the auth and session modules",
      kind:        "DIAGNOSE",
      args: {},
      context: {
        filesInvolved: [
          "src/auth/tokenValidator.ts",
          "src/session/sessionStore.ts",
          "src/middleware/authMiddleware.ts",
          "src/api/userController.ts",
          "src/config/jwtConfig.ts",
        ],
        errorMessage:
          "Intermittent 401 errors observed under high concurrency. " +
          "Token validation and session lookup appear to conflict.",
      },
    },

    // ── Task 7: architectural design proposal (high generation + ambiguity) ─
    {
      id:          "task-007",
      description: "Propose and design an architectural refactor to improve scalability of the auth pipeline",
      kind:        "DESIGN",
      args: {},
      context: {
        filesInvolved: [
          "src/auth/",
          "src/session/",
          "src/middleware/",
        ],
      },
    },
  ];
}
