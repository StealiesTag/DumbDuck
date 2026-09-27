// ─────────────────────────────────────────────────────────────────────────────
// Tool: searchFiles
// Searches for a pattern string across all .ts / .js / .json files under a
// given root directory using Node's built-in fs module.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from "fs";
import * as path from "path";

export interface SearchResult {
  file:    string;
  line:    number;
  content: string;
}

// Recursively collect every readable file under `dir`
function walkFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
      files.push(...walkFiles(full));
    } else if (entry.isFile() && /\.(ts|js|json|md)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

export function searchFiles(pattern: string, root: string = process.cwd()): SearchResult[] {
  const results: SearchResult[] = [];

  let files: string[];
  try {
    files = walkFiles(root);
  } catch {
    return [];
  }

  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    const lines = text.split("\n");
    lines.forEach((content, idx) => {
      if (content.includes(pattern)) {
        results.push({ file, line: idx + 1, content: content.trim() });
      }
    });
  }

  return results;
}
