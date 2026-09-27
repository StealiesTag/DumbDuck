// ─────────────────────────────────────────────────────────────────────────────
// Tool: readFile
// Reads and returns the contents of a file from disk.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";

export function readFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `[readFile error] Could not read "${filePath}": ${message}`;
  }
}
