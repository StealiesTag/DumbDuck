// ─────────────────────────────────────────────────────────────────────────────
// WorkspaceManager
//
// Manages a single selected workspace root directory.
// All workspace-aware tools use this to resolve and validate paths.
//
// Security contract:
//   - Only files under the registered workspace root are accessible.
//   - All paths are resolved to absolute before any operation.
//   - Any resolved path that is not a descendant of workspaceRoot is rejected.
//   - The manager never silently switches workspaces.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from "fs";
import * as path from "path";

export class WorkspaceError extends Error {
  constructor(
    public readonly code:
      | "NO_WORKSPACE"
      | "PATH_TRAVERSAL"
      | "NOT_FOUND"
      | "NOT_A_DIRECTORY"
      | "NOT_ACCESSIBLE",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export class WorkspaceManager {
  private _root: string | null = null;

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Set (or update) the workspace root.
   * Throws WorkspaceError if the path does not exist or is not a directory.
   */
  setWorkspace(rootPath: string): void {
    const abs = path.resolve(rootPath);
    if (!fs.existsSync(abs)) {
      throw new WorkspaceError(
        "NOT_FOUND",
        `Workspace path does not exist: ${abs}`
      );
    }
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) {
      throw new WorkspaceError(
        "NOT_A_DIRECTORY",
        `Workspace path is not a directory: ${abs}`
      );
    }
    this._root = abs;
  }

  /** Returns the current workspace root, or null if not set. */
  getRoot(): string | null {
    return this._root;
  }

  /** Returns true if a workspace has been set. */
  isSet(): boolean {
    return this._root !== null;
  }

  // ── Path resolution ───────────────────────────────────────────────────────

  /**
   * Resolve a workspace-relative (or absolute) path to an absolute path,
   * rejecting traversal outside the workspace root.
   *
   * Throws WorkspaceError("NO_WORKSPACE") if no workspace is set.
   * Throws WorkspaceError("PATH_TRAVERSAL") if the resolved path escapes the root.
   */
  resolve(relativePath: string): string {
    if (this._root === null) {
      throw new WorkspaceError(
        "NO_WORKSPACE",
        `No workspace set. Call set_workspace first.`
      );
    }
    const abs = path.resolve(this._root, relativePath);

    // Guard: abs must be inside _root (or equal to it)
    const rootNorm = this._root.endsWith(path.sep) ? this._root : this._root + path.sep;
    if (abs !== this._root && !abs.startsWith(rootNorm)) {
      throw new WorkspaceError(
        "PATH_TRAVERSAL",
        `Path "${relativePath}" resolves outside workspace root. Access denied.`
      );
    }
    return abs;
  }

  /**
   * Returns a path relative to the workspace root (for display purposes).
   */
  relative(absPath: string): string {
    return this._root ? path.relative(this._root, absPath) : absPath;
  }

  /**
   * Resolve and check that the path exists.
   * Throws WorkspaceError("NOT_FOUND") if missing.
   */
  resolveExisting(relativePath: string): string {
    const abs = this.resolve(relativePath);
    if (!fs.existsSync(abs)) {
      throw new WorkspaceError(
        "NOT_FOUND",
        `Path not found in workspace: ${relativePath}`
      );
    }
    return abs;
  }
}

// ── Singleton — shared across all workspace tools ─────────────────────────────
export const workspace = new WorkspaceManager();
