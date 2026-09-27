// ─────────────────────────────────────────────────────────────────────────────
// Tool: listFiles (workspace-aware)
// Lists files under a workspace-relative directory.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from "fs";
import * as path from "path";
import { WorkspaceManager, WorkspaceError } from "../workspace/WorkspaceManager";

export interface ListFilesResult {
  ok:      boolean;
  entries: string[];   // workspace-relative paths
  count:   number;
  truncated: boolean;
  error?:  string;
}

const MAX_ENTRIES = 200;

export function listFiles(
  wsManager: WorkspaceManager,
  relativeDir: string = "."
): ListFilesResult {
  let dirAbs: string;
  try {
    dirAbs = wsManager.resolveExisting(relativeDir);
  } catch (e) {
    return { ok: false, entries: [], count: 0, truncated: false, error: (e as Error).message };
  }

  if (!fs.statSync(dirAbs).isDirectory()) {
    return {
      ok: false, entries: [], count: 0, truncated: false,
      error: `"${relativeDir}" is not a directory`,
    };
  }

  const collected: string[] = [];
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
      const full = path.join(dir, item.name);
      const rel  = wsManager.relative(full);
      if (item.isDirectory()) {
        collected.push(rel + "/");
        walk(full);
      } else if (item.isFile()) {
        collected.push(rel);
        if (collected.length >= MAX_ENTRIES) truncated = true;
      }
    }
  }

  walk(dirAbs);

  return { ok: true, entries: collected, count: collected.length, truncated };
}
