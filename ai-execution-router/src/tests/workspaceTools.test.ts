// ─────────────────────────────────────────────────────────────────────────────
// Tests: Workspace-Aware Tools
// (listFiles, readFile, searchRepository, runTests approval gate)
// ─────────────────────────────────────────────────────────────────────────────

import * as os   from "os";
import * as fs   from "fs";
import * as path from "path";
import { WorkspaceManager } from "../workspace/WorkspaceManager";
import { listFiles }        from "../workspace/tools/listFiles";
import { readWorkspaceFile } from "../workspace/tools/readFile";
import { searchRepository } from "../workspace/tools/searchRepository";
import { runWorkspaceTests } from "../workspace/tools/runTests";
import { createWorkspaceFile, deleteWorkspaceFile } from "../workspace/tools/fileOperations";
import { TestResult, assert, assertEqual } from "./helpers";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-tools-"));
}
function rmTempDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeWs(dir: string): WorkspaceManager {
  const wm = new WorkspaceManager();
  wm.setWorkspace(dir);
  return wm;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

export function runWorkspaceToolTests(): TestResult[] {
  const results: TestResult[] = [];
  const tmpDir = makeTempDir();

  try {
    // Create a small test tree
    fs.writeFileSync(path.join(tmpDir, "hello.ts"),  "// TODO: finish this\nconst x = 1;");
    fs.writeFileSync(path.join(tmpDir, "data.json"), '{"name":"test"}');
    fs.writeFileSync(path.join(tmpDir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]));
    fs.mkdirSync(path.join(tmpDir, "sub"));
    fs.writeFileSync(path.join(tmpDir, "sub", "inner.ts"), "export const y = 2; // TODO nested");
    fs.mkdirSync(path.join(tmpDir, "node_modules"));
    fs.writeFileSync(path.join(tmpDir, "node_modules", "skip.ts"), "// should be excluded");

    const wm = makeWs(tmpDir);

    // ── listFiles: lists files ──────────────────────────────────────────────
    const listResult = listFiles(wm, ".");
    results.push(assert(listResult.ok, "listFiles succeeds"));
    results.push(assert(listResult.count > 0, "listFiles returns entries"));
    results.push(assert(
      listResult.entries.some((e) => e.includes("hello.ts")),
      "listFiles includes hello.ts"
    ));
    results.push(assert(
      listResult.entries.some((e) => e.includes("binary.bin")),
      "listFiles lists all files including binary (non-discriminatory by design)"
    ));

    // ── listFiles: error on missing dir ─────────────────────────────────────
    const listMissing = listFiles(wm, "no_such_dir");
    results.push(assert(!listMissing.ok, "listFiles fails on missing directory"));
    results.push(assert(!!listMissing.error, "listFiles returns error message"));

    // ── readWorkspaceFile: reads a text file ────────────────────────────────
    const readResult = readWorkspaceFile(wm, "hello.ts");
    results.push(assert(readResult.ok, "readWorkspaceFile succeeds for .ts"));
    results.push(assert(readResult.content?.includes("TODO") ?? false, "readWorkspaceFile returns content"));
    results.push(assert(!readResult.truncated, "small file is not truncated"));

    // ── readWorkspaceFile: rejects binary extension ─────────────────────────
    const readBin = readWorkspaceFile(wm, "binary.bin");
    results.push(assert(!readBin.ok, "readWorkspaceFile rejects .bin extension"));
    results.push(assert(!!readBin.error, "readWorkspaceFile returns error for binary"));

    // ── readWorkspaceFile: missing file ─────────────────────────────────────
    const readMissing = readWorkspaceFile(wm, "not_there.ts");
    results.push(assert(!readMissing.ok, "readWorkspaceFile fails on missing file"));

    // ── readWorkspaceFile: path traversal rejected ──────────────────────────
    const readTraversal = readWorkspaceFile(wm, "../../etc/passwd");
    results.push(assert(!readTraversal.ok, "readWorkspaceFile rejects path traversal"));

    // ── File mutations: create without overwrite, delete with approval ────────
    const created = createWorkspaceFile(wm, "created.txt", "5*8 = 40\n");
    results.push(assert(created.ok, "createWorkspaceFile creates a workspace file"));
    results.push(assertEqual(fs.readFileSync(path.join(tmpDir, "created.txt"), "utf-8"), "5*8 = 40\n",
      "createWorkspaceFile writes exact content"));

    const overwrite = createWorkspaceFile(wm, "created.txt", "replacement");
    results.push(assert(!overwrite.ok, "createWorkspaceFile refuses to overwrite"));
    results.push(assertEqual(fs.readFileSync(path.join(tmpDir, "created.txt"), "utf-8"), "5*8 = 40\n",
      "refused overwrite leaves existing content unchanged"));

    const traversalCreate = createWorkspaceFile(wm, "../outside-router-file.txt", "blocked");
    results.push(assert(!traversalCreate.ok, "createWorkspaceFile rejects workspace traversal"));

    const oversized = createWorkspaceFile(wm, "oversized.txt", "x".repeat(1024 * 1024 + 1));
    results.push(assert(!oversized.ok, "createWorkspaceFile enforces the 1 MiB size limit"));

    const outsideFile = path.join(path.dirname(tmpDir), `${path.basename(tmpDir)}-protected.txt`);
    fs.writeFileSync(outsideFile, "protected");
    const traversalDelete = deleteWorkspaceFile(wm, `../${path.basename(outsideFile)}`, true);
    results.push(assert(!traversalDelete.ok && fs.existsSync(outsideFile),
      "deleteWorkspaceFile rejects traversal and preserves outside files"));
    fs.unlinkSync(outsideFile);

    const outsideDir = makeTempDir();
    const linkedDir = path.join(tmpDir, "outside-link");
    let symlinkSupported = false;
    try {
      fs.symlinkSync(outsideDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
      symlinkSupported = true;
    } catch {}
    if (symlinkSupported) {
      const symlinkWrite = createWorkspaceFile(wm, "outside-link/escaped.txt", "blocked");
      results.push(assert(!symlinkWrite.ok && !fs.existsSync(path.join(outsideDir, "escaped.txt")),
        "createWorkspaceFile rejects symlinked parents"));
    } else {
      results.push(assert(true, "symlink mutation test skipped because links are unavailable"));
    }
    rmTempDir(outsideDir);

    const unapprovedDelete = deleteWorkspaceFile(wm, "created.txt", false);
    results.push(assert(!unapprovedDelete.ok && unapprovedDelete.needsApproval === true,
      "deleteWorkspaceFile requires confirmation"));
    results.push(assert(fs.existsSync(path.join(tmpDir, "created.txt")),
      "unapproved delete preserves the file"));

    const deleted = deleteWorkspaceFile(wm, "created.txt", true);
    results.push(assert(deleted.ok, "deleteWorkspaceFile deletes a confirmed regular file"));
    results.push(assert(!fs.existsSync(path.join(tmpDir, "created.txt")),
      "confirmed delete removes the file"));

    const deleteDirectory = deleteWorkspaceFile(wm, "sub", true);
    results.push(assert(!deleteDirectory.ok && fs.existsSync(path.join(tmpDir, "sub")),
      "deleteWorkspaceFile refuses to delete directories"));

    // ── searchRepository: finds matches ────────────────────────────────────
    const searchResult = searchRepository(wm, "TODO");
    results.push(assert(searchResult.ok, "searchRepository succeeds"));
    results.push(assert(searchResult.matches.length >= 2, "searchRepository finds both TODO comments"));
    results.push(assert(
      searchResult.matches.every((m) => m.file && m.line > 0),
      "searchRepository matches have file and line"
    ));

    // ── searchRepository: excludes node_modules ─────────────────────────────
    results.push(assert(
      !searchResult.matches.some((m) => m.file.includes("node_modules")),
      "searchRepository excludes node_modules"
    ));

    // ── searchRepository: no matches ────────────────────────────────────────
    const noMatch = searchRepository(wm, "XYZZY_NOT_FOUND_12345");
    results.push(assert(noMatch.ok, "searchRepository succeeds with no matches"));
    results.push(assertEqual(noMatch.matches.length, 0, "searchRepository returns 0 matches"));

    // ── searchRepository: empty pattern ─────────────────────────────────────
    const emptyPattern = searchRepository(wm, "");
    results.push(assert(!emptyPattern.ok, "searchRepository rejects empty pattern"));

    // ── runWorkspaceTests: unknown suite → NEEDS_APPROVAL ───────────────────
    const approvalResult = runWorkspaceTests(wm, "dangerous-command");
    results.push(assertEqual(approvalResult.status, "NEEDS_APPROVAL", "Unknown suite → NEEDS_APPROVAL"));
    results.push(assert(
      Array.isArray(approvalResult.approvedSuites) && approvalResult.approvedSuites!.length > 0,
      "NEEDS_APPROVAL includes list of approved suites"
    ));
    results.push(assert(!approvalResult.ok, "NEEDS_APPROVAL result is not ok"));

  } finally {
    rmTempDir(tmpDir);
  }

  return results;
}
