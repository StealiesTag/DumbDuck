// ─────────────────────────────────────────────────────────────────────────────
// Executor: Deterministic
//
// Routes deterministic tasks to the appropriate workspace-aware tool.
// If a workspaceRoot is provided on the task, workspace tools are used.
// If not, the legacy standalone tools (calculator, etc.) are still available.
//
// No AI model is called here under any circumstance.
// ─────────────────────────────────────────────────────────────────────────────

import * as path from "path";
import { IncomingTask, ExecutionResult, TaskStatus } from "../types";
import { WorkspaceManager }    from "../workspace/WorkspaceManager";
import { listFiles }           from "../workspace/tools/listFiles";
import { readWorkspaceFile }   from "../workspace/tools/readFile";
import { searchRepository }    from "../workspace/tools/searchRepository";
import { getGitStatus, getGitDiff } from "../workspace/tools/gitOps";
import { runWorkspaceTests }   from "../workspace/tools/runTests";
import { createWorkspaceFile, deleteWorkspaceFile } from "../workspace/tools/fileOperations";

// Legacy tools (still used when no workspace is set)
import { calculate }           from "../tools/calculator";

export interface DeterministicResult extends ExecutionResult {
  status: TaskStatus;
}

export function runDeterministic(task: IncomingTask): DeterministicResult {
  const start = Date.now();
  let output = "";
  let status: TaskStatus = "SUCCEEDED";

  // Build a per-task workspace manager if a root is supplied
  const wsm = new WorkspaceManager();
  if (task.workspaceRoot) {
    try {
      wsm.setWorkspace(task.workspaceRoot);
    } catch (e) {
      return {
        taskId:     task.id,
        route:      "DETERMINISTIC",
        output:     `Workspace error: ${(e as Error).message}`,
        durationMs: Date.now() - start,
        status:     "FAILED",
      };
    }
  }

  try {
    switch (task.kind) {
      // ── list_files ──────────────────────────────────────────────────────────
      case "SEARCH": {
        if (wsm.isSet()) {
          // Workspace search
          const pattern = String(task.args.pattern ?? "TODO");
          const subDir  = String(task.args.subDir ?? ".");
          const res     = searchRepository(wsm, pattern, subDir);
          if (!res.ok) {
            output = `Search error: ${res.error}`;
            status = "FAILED";
          } else if (res.matches.length === 0) {
            output = `Search for "${pattern}": no matches found.`;
          } else {
            const lines = res.matches
              .slice(0, 20)
              .map((m) => `  ${m.file}:${m.line}  ${m.content}`)
              .join("\n");
            const trunc = res.truncated ? `\n  … results truncated at ${res.totalMatches}` : "";
            output = `Search for "${pattern}" — ${res.totalMatches} match(es):\n${lines}${trunc}`;
          }
        } else {
          // Legacy fallback (no workspace)
          const { searchFiles } = require("../tools/searchFiles");
          const pattern = String(task.args.pattern ?? "TODO");
          const root    = String(task.args.root ?? process.cwd());
          const results = searchFiles(pattern, root);
          if (results.length === 0) {
            output = `Search for "${pattern}": no matches found.`;
          } else {
            const preview = results
              .slice(0, 5)
              .map((r: { file: string; line: number; content: string }) =>
                `  ${path.relative(process.cwd(), r.file)}:${r.line}  ${r.content}`)
              .join("\n");
            const more = results.length > 5 ? `\n  … and ${results.length - 5} more` : "";
            output = `Search for "${pattern}" — ${results.length} match(es):\n${preview}${more}`;
          }
        }
        break;
      }

      // ── read_file ────────────────────────────────────────────────────────────
      case "READ_FILE": {
        const filePath = String(task.args.path ?? "");
        if (wsm.isSet() && filePath) {
          const res = readWorkspaceFile(wsm, filePath);
          if (!res.ok) {
            output = `Read error: ${res.error}`;
            status = "FAILED";
          } else {
            const trunc = res.truncated ? `\n… (file truncated at 512 KB)` : "";
            output = `Contents of "${filePath}" (${res.sizeBytes} bytes):\n${res.content}${trunc}`;
          }
        } else {
          // Legacy fallback
          const { readFile } = require("../tools/readFile");
          const content  = readFile(filePath || "package.json");
          const preview  = content.length > 500 ? content.slice(0, 500) + "\n… (truncated)" : content;
          output = `Contents of "${filePath}":\n${preview}`;
        }
        break;
      }

      // ── calculation ─────────────────────────────────────────────────────────
      case "CALCULATION": {
        const expr   = String(task.args.expression ?? "0");
        const result = calculate(expr);
        output = result.error
          ? `Calculation error: ${result.error}`
          : `${result.expression} = ${result.result}`;
        break;
      }

      case "CREATE_FILE": {
        const filePath = String(task.args.path ?? "");
        const content = task.args.content;
        const res = typeof content === "string"
          ? createWorkspaceFile(wsm, filePath, content)
          : { ok: false, error: "taskArgs.content must be a string." };
        if (!res.ok) {
          output = `Create error: ${res.error}`;
          status = "FAILED";
        } else {
          output = `Created "${res.path}" (${res.sizeBytes} bytes).`;
        }
        break;
      }

      case "DELETE_FILE": {
        const filePath = String(task.args.path ?? "");
        const res = deleteWorkspaceFile(wsm, filePath, task.args.confirm === true);
        if (!res.ok) {
          output = `Delete error: ${res.error}`;
          status = res.needsApproval ? "NEEDS_APPROVAL" : "FAILED";
        } else {
          output = `Deleted "${res.path}".`;
        }
        break;
      }

      // ── run_tests ────────────────────────────────────────────────────────────
      case "RUN_TESTS": {
        const suite = String(task.args.suite ?? "npm-test");
        if (wsm.isSet()) {
          const res = runWorkspaceTests(wsm, suite);
          if (res.status === "NEEDS_APPROVAL") {
            output = [
              `Test suite "${res.requestedSuite}" requires approval.`,
              `Approved suites: ${res.approvedSuites?.join(", ")}`,
            ].join("\n");
            status = "NEEDS_APPROVAL";
          } else {
            const out = res.stdout.trim() || "(no stdout)";
            const err = res.stderr.trim() ? `\nStderr:\n${res.stderr.trim()}` : "";
            output = `Test run [${res.status}] exit=${res.exitCode} ${res.durationMs}ms\n${out}${err}`;
            status = res.ok ? "SUCCEEDED" : "FAILED";
          }
        } else {
          // Legacy mock fallback
          const { runTests } = require("../tools/runTests");
          const result = runTests(suite);
          output = result.summary;
        }
        break;
      }

      // ── git_status ───────────────────────────────────────────────────────────
      case "SEARCH" as never: break;  // handled above — TypeScript narrowing helper

      default: {
        // Handle git operations dispatched as UNKNOWN kind via args.operation
        const op = String(task.args.operation ?? "");
        if (op === "git_status" && wsm.isSet()) {
          const res = getGitStatus(wsm);
          output = res.ok ? res.output : `Git error: ${res.error}`;
          status = res.ok ? "SUCCEEDED" : "FAILED";
        } else if (op === "git_diff" && wsm.isSet()) {
          const staged = task.args.staged === true;
          const res = getGitDiff(wsm, staged);
          output = res.ok ? res.output : `Git error: ${res.error}`;
          status = res.ok ? "SUCCEEDED" : "FAILED";
        } else if (op === "list_files" && wsm.isSet()) {
          const dir = String(task.args.path ?? ".");
          const res = listFiles(wsm, dir);
          if (!res.ok) {
            output = `List error: ${res.error}`;
            status = "FAILED";
          } else {
            const trunc = res.truncated ? `\n… (truncated at ${res.count})` : "";
            output = `Files in "${dir}" (${res.count} entries):\n${res.entries.join("\n")}${trunc}`;
          }
        } else {
          output = `[Deterministic executor] No tool registered for kind "${task.kind}"${op ? ` / op="${op}"` : ""}`;
          status = "FAILED";
        }
      }
    }
  } catch (err) {
    output = `Executor error: ${err instanceof Error ? err.message : String(err)}`;
    status = "FAILED";
  }

  return {
    taskId:     task.id,
    route:      "DETERMINISTIC",
    output,
    durationMs: Date.now() - start,
    status,
  };
}
