// ─────────────────────────────────────────────────────────────────────────────
// Tests: WorkspaceManager
// ─────────────────────────────────────────────────────────────────────────────

import * as os   from "os";
import * as fs   from "fs";
import * as path from "path";
import { WorkspaceManager, WorkspaceError } from "../workspace/WorkspaceManager";
import { TestResult, assert, assertEqual } from "./helpers";

// ── Temp directory helpers ────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-test-"));
}

function rmTempDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── Tests ─────────────────────────────────────────────────────────────────────

export function runWorkspaceTests(): TestResult[] {
  const results: TestResult[] = [];
  const tmpDir = makeTempDir();

  try {
    // ── setWorkspace accepts a valid directory ──────────────────────────────
    const wm = new WorkspaceManager();
    wm.setWorkspace(tmpDir);
    results.push(assertEqual(wm.getRoot(), tmpDir, "setWorkspace accepts valid directory"));
    results.push(assert(wm.isSet(), "isSet() returns true after setWorkspace"));

    // ── setWorkspace rejects a non-existent path ────────────────────────────
    let threw = false;
    try { wm.setWorkspace(path.join(tmpDir, "does_not_exist")); } catch { threw = true; }
    results.push(assert(threw, "setWorkspace rejects non-existent path"));

    // ── setWorkspace rejects a file ─────────────────────────────────────────
    const tmpFile = path.join(tmpDir, "a.txt");
    fs.writeFileSync(tmpFile, "hi");
    let threwFile = false;
    try { wm.setWorkspace(tmpFile); } catch { threwFile = true; }
    results.push(assert(threwFile, "setWorkspace rejects a file path"));

    // ── resolve inside workspace ────────────────────────────────────────────
    const sub = path.join(tmpDir, "sub");
    fs.mkdirSync(sub);
    const resolved = wm.resolve("sub");
    results.push(assertEqual(resolved, sub, "resolve returns absolute path inside workspace"));

    // ── path traversal is rejected ──────────────────────────────────────────
    let threwTraversal = false;
    try { wm.resolve("../../etc/passwd"); } catch (e) {
      threwTraversal = (e as WorkspaceError).code === "PATH_TRAVERSAL";
    }
    results.push(assert(threwTraversal, "resolve rejects ../.. path traversal (PATH_TRAVERSAL)"));

    // ── resolveExisting rejects a missing path ──────────────────────────────
    let threwMissing = false;
    try { wm.resolveExisting("no_such_file.txt"); } catch (e) {
      threwMissing = (e as WorkspaceError).code === "NOT_FOUND";
    }
    results.push(assert(threwMissing, "resolveExisting rejects missing path (NOT_FOUND)"));

    // ── relative returns workspace-relative path ────────────────────────────
    const rel = wm.relative(sub);
    results.push(assertEqual(rel, "sub", "relative() returns workspace-relative path"));

    // ── error without workspace set ─────────────────────────────────────────
    const fresh = new WorkspaceManager();
    let threwNoWs = false;
    try { fresh.resolve("anything"); } catch (e) {
      threwNoWs = (e as WorkspaceError).code === "NO_WORKSPACE";
    }
    results.push(assert(threwNoWs, "resolve throws NO_WORKSPACE when not set"));

  } finally {
    rmTempDir(tmpDir);
  }

  return results;
}
