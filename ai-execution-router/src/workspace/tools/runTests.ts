// ─────────────────────────────────────────────────────────────────────────────
// Tool: runTests (workspace-aware, sandboxed)
//
// Runs a pre-configured, pre-approved test command in the workspace.
//
// SECURITY:
//   - The command is NOT constructed from task descriptions or user input.
//   - Only the pre-approved command stored in TEST_COMMANDS is ever executed.
//   - Arbitrary shell commands are not supported.
//   - A task whose args.suite does not match an approved entry gets
//     status NEEDS_APPROVAL and is not executed.
//
// Adding a new approved test command:
//   1. Add it to TEST_COMMANDS below.
//   2. The key is the suite name agents pass in task args.
//   3. Restart the MCP server.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from "child_process";
import { WorkspaceManager } from "../workspace/WorkspaceManager";

// ── Approved test commands ────────────────────────────────────────────────────
// Each entry: { cmd, args }
// cmd must be an executable name (not a shell string).
// NEVER interpolate user-supplied values into these args.

interface ApprovedCommand { cmd: string; args: string[] }

const TEST_COMMANDS: Record<string, ApprovedCommand> = {
  "npm-test":    { cmd: "npm",   args: ["test"] },
  "npm-test-ci": { cmd: "npm",   args: ["run", "test:ci"] },
  "vitest":      { cmd: "npx",   args: ["vitest", "run"] },
  "jest":        { cmd: "npx",   args: ["jest", "--passWithNoTests"] },
  "pytest":      { cmd: "python", args: ["-m", "pytest"] },
};

const MAX_OUTPUT_CHARS = 32 * 1024;
const TIMEOUT_MS       = 60_000;

export type TestRunStatus = "SUCCEEDED" | "FAILED" | "NEEDS_APPROVAL" | "ERROR";

export interface RunTestsResult {
  ok:        boolean;
  status:    TestRunStatus;
  exitCode:  number | null;
  stdout:    string;
  stderr:    string;
  durationMs: number;
  truncated: boolean;
  error?:    string;
  // When status === "NEEDS_APPROVAL":
  requestedSuite?: string;
  approvedSuites?: string[];
}

export function runWorkspaceTests(
  wsManager:  WorkspaceManager,
  suiteName:  string
): RunTestsResult {
  const approved = TEST_COMMANDS[suiteName];

  if (!approved) {
    return {
      ok:              false,
      status:          "NEEDS_APPROVAL",
      exitCode:        null,
      stdout:          "",
      stderr:          "",
      durationMs:      0,
      truncated:       false,
      error:           `Suite "${suiteName}" is not in the approved command list.`,
      requestedSuite:  suiteName,
      approvedSuites:  Object.keys(TEST_COMMANDS),
    };
  }

  let cwd: string;
  try {
    cwd = wsManager.resolveExisting(".");
  } catch (e) {
    return {
      ok: false, status: "ERROR", exitCode: null,
      stdout: "", stderr: "", durationMs: 0, truncated: false,
      error: (e as Error).message,
    };
  }

  const start  = Date.now();
  let command = approved.cmd;
  let args = approved.args;
  if (process.platform === "win32" && process.env.npm_execpath && (command === "npm" || command === "npx")) {
    const packageRunner = command;
    command = process.execPath;
    args = packageRunner === "npx"
      ? [process.env.npm_execpath, "exec", "--", ...args]
      : [process.env.npm_execpath, ...args];
  } else if (process.platform === "win32" && (command === "npm" || command === "npx")) {
    const executable = command;
    command = process.env.ComSpec ?? "cmd.exe";
    args = ["/d", "/s", "/c", `${executable} ${args.join(" ")}`];
  }
  const result = spawnSync(command, args, {
    cwd,
    encoding:  "utf-8",
    maxBuffer: 4 * 1024 * 1024,
    timeout:   TIMEOUT_MS,
    shell:     false,
  });
  const durationMs = Date.now() - start;

  if (result.error) {
    const isTimeout = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      ok: false, status: "ERROR", exitCode: null,
      stdout: "", stderr: "",
      durationMs,
      truncated: false,
      error: isTimeout
        ? `Test run timed out after ${TIMEOUT_MS}ms`
        : result.error.message,
    };
  }

  const rawOut = result.stdout ?? "";
  const rawErr = result.stderr ?? "";
  const truncated = rawOut.length > MAX_OUTPUT_CHARS || rawErr.length > MAX_OUTPUT_CHARS;

  return {
    ok:        result.status === 0,
    status:    result.status === 0 ? "SUCCEEDED" : "FAILED",
    exitCode:  result.status,
    stdout:    rawOut.length > MAX_OUTPUT_CHARS ? rawOut.slice(0, MAX_OUTPUT_CHARS) + "\n…(truncated)" : rawOut,
    stderr:    rawErr.length > MAX_OUTPUT_CHARS ? rawErr.slice(0, MAX_OUTPUT_CHARS) + "\n…(truncated)" : rawErr,
    durationMs,
    truncated,
  };
}
