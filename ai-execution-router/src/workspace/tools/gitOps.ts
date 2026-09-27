// ─────────────────────────────────────────────────────────────────────────────
// Tool: git operations (workspace-aware, read-only)
// Provides git status and git diff for a workspace repository.
// Uses child_process.spawnSync — no shell injection; args are never user-supplied.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from "child_process";
import { WorkspaceManager } from "../workspace/WorkspaceManager";

const MAX_OUTPUT_CHARS = 32 * 1024; // 32 KB

export interface GitResult {
  ok:        boolean;
  output:    string;
  truncated: boolean;
  error?:    string;
}

function runGit(args: string[], cwd: string): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding:   "utf-8",
    maxBuffer:  2 * 1024 * 1024,
    timeout:    10_000,
  });

  if (result.error) {
    // git binary not found or OS error
    const msg = (result.error as NodeJS.ErrnoException).code === "ENOENT"
      ? "git is not installed or not in PATH"
      : result.error.message;
    return { ok: false, output: "", truncated: false, error: msg };
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    return {
      ok:    false,
      output: "",
      truncated: false,
      error: stderr || `git exited with code ${result.status}`,
    };
  }

  const raw      = result.stdout ?? "";
  const truncated = raw.length > MAX_OUTPUT_CHARS;
  return {
    ok:        true,
    output:    truncated ? raw.slice(0, MAX_OUTPUT_CHARS) + "\n… (truncated)" : raw,
    truncated,
  };
}

export function getGitStatus(wsManager: WorkspaceManager): GitResult {
  let root: string;
  try {
    root = wsManager.resolveExisting(".");
  } catch (e) {
    return { ok: false, output: "", truncated: false, error: (e as Error).message };
  }
  return runGit(["status", "--short", "--branch"], root);
}

export function getGitDiff(wsManager: WorkspaceManager, staged = false): GitResult {
  let root: string;
  try {
    root = wsManager.resolveExisting(".");
  } catch (e) {
    return { ok: false, output: "", truncated: false, error: (e as Error).message };
  }
  const args = staged ? ["diff", "--staged"] : ["diff"];
  return runGit(args, root);
}
