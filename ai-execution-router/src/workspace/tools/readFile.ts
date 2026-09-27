// ─────────────────────────────────────────────────────────────────────────────
// Tool: readFile (workspace-aware, safe)
// Reads a workspace-relative file with size limits and path-traversal checks.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import { WorkspaceManager } from "../workspace/WorkspaceManager";

const MAX_BYTES = 512 * 1024; // 512 KB

// File extensions considered readable as text
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".jsonc", ".yaml", ".yml",
  ".md", ".txt", ".sh", ".env", ".gitignore",
  ".html", ".css", ".scss", ".graphql", ".sql",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h",
  ".toml", ".ini", ".cfg", ".conf", ".lock",
]);

export interface ReadFileResult {
  ok:        boolean;
  content?:  string;
  truncated: boolean;
  sizeBytes: number;
  error?:    string;
}

export function readWorkspaceFile(
  wsManager: WorkspaceManager,
  relativePath: string
): ReadFileResult {
  let abs: string;
  try {
    abs = wsManager.resolveExisting(relativePath);
  } catch (e) {
    return { ok: false, truncated: false, sizeBytes: 0, error: (e as Error).message };
  }

  const stat = fs.statSync(abs);
  if (!stat.isFile()) {
    return { ok: false, truncated: false, sizeBytes: 0, error: `"${relativePath}" is not a file` };
  }

  const ext = require("path").extname(abs).toLowerCase();
  if (ext && !TEXT_EXTENSIONS.has(ext)) {
    return {
      ok: false, truncated: false, sizeBytes: stat.size,
      error: `Unsupported file type "${ext}". Only text files are readable.`,
    };
  }

  const readBytes = Math.min(stat.size, MAX_BYTES);
  const truncated = stat.size > MAX_BYTES;

  const buf = Buffer.allocUnsafe(readBytes);
  const fd  = fs.openSync(abs, "r");
  fs.readSync(fd, buf, 0, readBytes, 0);
  fs.closeSync(fd);

  return {
    ok:        true,
    content:   buf.toString("utf-8"),
    truncated,
    sizeBytes: stat.size,
  };
}
