// ─────────────────────────────────────────────────────────────────────────────
// Tool: searchRepository (workspace-aware)
// Text search within workspace files, excluding common generated directories.
// Returns file paths, line numbers, and matching lines.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from "fs";
import * as path from "path";
import { WorkspaceManager } from "../workspace/WorkspaceManager";

// Directories excluded by default — never exposed to search
const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next",
  ".nuxt", "coverage", ".nyc_output", "__pycache__", ".venv",
  "venv", ".tox", ".pytest_cache",
]);

// File extensions searched for text
const SEARCHABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".yaml", ".yml", ".md", ".txt",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h",
  ".sh", ".css", ".scss", ".html", ".graphql", ".sql",
  ".toml", ".ini", ".cfg", ".conf", ".env",
]);

export interface SearchMatch {
  file:    string;   // workspace-relative
  line:    number;
  content: string;   // the matching line (trimmed)
}

export interface SearchRepositoryResult {
  ok:        boolean;
  matches:   SearchMatch[];
  totalMatches: number;
  truncated: boolean;
  error?:    string;
}

const MAX_MATCHES     = 100;
const MAX_FILE_BYTES  = 1024 * 1024;  // 1 MB per file

export function searchRepository(
  wsManager: WorkspaceManager,
  pattern:   string,
  subDir:    string = "."
): SearchRepositoryResult {
  if (!pattern || pattern.trim() === "") {
    return { ok: false, matches: [], totalMatches: 0, truncated: false, error: "Search pattern is empty" };
  }

  let rootAbs: string;
  try {
    rootAbs = wsManager.resolveExisting(subDir);
  } catch (e) {
    return { ok: false, matches: [], totalMatches: 0, truncated: false, error: (e as Error).message };
  }

  const matches: SearchMatch[] = [];
  let truncated = false;

  function walk(dir: string): void {
    if (truncated) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (truncated) break;
      if (item.isDirectory()) {
        if (!EXCLUDED_DIRS.has(item.name)) walk(path.join(dir, item.name));
        continue;
      }
      if (!item.isFile()) continue;
      const ext = path.extname(item.name).toLowerCase();
      if (!SEARCHABLE_EXTENSIONS.has(ext)) continue;

      const full = path.join(dir, item.name);
      const stat = fs.statSync(full);
      if (stat.size > MAX_FILE_BYTES) continue;

      let text: string;
      try {
        text = fs.readFileSync(full, "utf-8");
      } catch {
        continue;
      }

      const rel   = wsManager.relative(full);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && !truncated; i++) {
        if (lines[i].includes(pattern)) {
          matches.push({ file: rel, line: i + 1, content: lines[i].trim() });
          if (matches.length >= MAX_MATCHES) truncated = true;
        }
      }
    }
  }

  walk(rootAbs);

  return { ok: true, matches, totalMatches: matches.length, truncated };
}
