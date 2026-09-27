import * as fs from "fs";
import * as path from "path";
import { WorkspaceManager } from "../WorkspaceManager";

const MAX_FILE_BYTES = 1024 * 1024;

export interface WorkspaceMutationResult {
  ok: boolean;
  path?: string;
  sizeBytes?: number;
  needsApproval?: boolean;
  error?: string;
}

interface CheckedTarget {
  absolutePath: string;
  relativePath: string;
  stat: fs.Stats | null;
}

function resolveCheckedTarget(
  workspace: WorkspaceManager,
  filePath: string,
  allowMissingLeaf: boolean
): CheckedTarget {
  if (!filePath || path.isAbsolute(filePath)) {
    throw new Error("A workspace-relative file path is required.");
  }

  const root = workspace.getRoot();
  if (!root) throw new Error("No workspace set. Call set_workspace first.");

  const resolved = workspace.resolve(filePath);
  const relativePath = path.relative(root, resolved);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) {
    throw new Error("The workspace root cannot be used as a file path.");
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  const realRoot = fs.realpathSync(root);
  let current = realRoot;

  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && allowMissingLeaf && index === segments.length - 1) {
        return { absolutePath: current, relativePath, stat: null };
      }
      if (code === "ENOENT") throw new Error("Parent directory or file does not exist.");
      throw error;
    }

    if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed for file mutations.");
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error("A parent path component is not a directory.");
    }
    if (index === segments.length - 1) {
      return { absolutePath: current, relativePath, stat };
    }
  }

  throw new Error("Invalid workspace-relative file path.");
}

export function createWorkspaceFile(
  workspace: WorkspaceManager,
  filePath: string,
  content: string
): WorkspaceMutationResult {
  try {
    if (typeof content !== "string") throw new Error("File content must be a string.");
    const sizeBytes = Buffer.byteLength(content, "utf-8");
    if (sizeBytes > MAX_FILE_BYTES) throw new Error(`File content exceeds the ${MAX_FILE_BYTES}-byte limit.`);

    const target = resolveCheckedTarget(workspace, filePath, true);
    if (target.stat) throw new Error("File already exists; create_file will not overwrite it.");

    fs.writeFileSync(target.absolutePath, content, { encoding: "utf-8", flag: "wx" });
    return { ok: true, path: target.relativePath, sizeBytes };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function deleteWorkspaceFile(
  workspace: WorkspaceManager,
  filePath: string,
  confirmed: boolean
): WorkspaceMutationResult {
  if (!confirmed) {
    return {
      ok: false,
      needsApproval: true,
      error: "File deletion requires explicit confirmation. Set confirm=true after user authorization.",
    };
  }

  try {
    const target = resolveCheckedTarget(workspace, filePath, false);
    if (!target.stat?.isFile()) throw new Error("Only regular files can be deleted.");

    fs.unlinkSync(target.absolutePath);
    return { ok: true, path: target.relativePath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}