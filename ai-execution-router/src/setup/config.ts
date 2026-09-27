// ─────────────────────────────────────────────────────────────────────────────
// Setup configuration manager
//
// Reads and writes `router.config.json` in the project root.
// This file is LOCAL to the user's machine — it is listed in .gitignore.
//
// What is stored here:
//   - workspace path
//   - MCP server path (absolute)
//   - simple AI provider name (NOT the API key)
//   - integration target ("bob" | "generic" | "manual")
//
// What is NEVER stored here:
//   - API keys or secrets (use environment variables for those)
//
// Callers should use loadConfig() to read and saveConfig() to write.
// Neither function crashes if the file is absent — it returns defaults.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from "fs";
import * as path from "path";

// ── Schema ────────────────────────────────────────────────────────────────────

export interface RouterConfig {
  /** Schema version — bump when breaking changes are made */
  version:           "1";
  /** Absolute path of the project root (where package.json lives) */
  projectRoot:       string;
  /** Default workspace directory used by MCP file tools */
  workspacePath?:    string;
  /** Integration target chosen during setup */
  integrationTarget?: "bob" | "generic" | "manual";
  /** Simple AI provider name — NOT a secret */
  simpleAiProvider?: "mock" | "openai" | "gemini" | string;
  /** ISO timestamp of last setup run */
  lastSetupAt?:      string;
}

// ── File location ─────────────────────────────────────────────────────────────

// PROJECT_ROOT is resolved relative to this file: src/setup/ → ../.. → project root
export const PROJECT_ROOT   = path.resolve(__dirname, "../..");
export const CONFIG_PATH    = path.join(PROJECT_ROOT, "router.config.json");
export const MCP_ENTRY_POINT = path.join(PROJECT_ROOT, "src", "mcp", "server.ts");

// ── Defaults ──────────────────────────────────────────────────────────────────

export function defaultConfig(): RouterConfig {
  return {
    version:     "1",
    projectRoot: PROJECT_ROOT,
  };
}

// ── Load ──────────────────────────────────────────────────────────────────────

/**
 * Load router.config.json.
 * Returns the default config if the file does not exist.
 * Returns the default config (plus a warning) if the file is corrupt.
 */
export function loadConfig(configPath = CONFIG_PATH): RouterConfig {
  if (!fs.existsSync(configPath)) {
    return defaultConfig();
  }
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as RouterConfig;
    // Ensure required fields are present
    return { ...defaultConfig(), ...parsed };
  } catch {
    return defaultConfig();
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────

/**
 * Persist a RouterConfig to router.config.json.
 * If a config already exists, it is merged with the new values — fields not
 * present in `updates` are preserved.
 *
 * @param updates   Partial config to merge into the existing config.
 * @param configPath  Override path (used by tests to avoid touching real files).
 */
export function saveConfig(
  updates:    Partial<RouterConfig>,
  configPath = CONFIG_PATH
): RouterConfig {
  const existing = loadConfig(configPath);
  const merged: RouterConfig = {
    ...existing,
    ...updates,
    version: "1",
    lastSetupAt: new Date().toISOString(),
  };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return merged;
}

// ── MCP config generators ─────────────────────────────────────────────────────

export interface McpConfigEntry {
  command: string;
  args:    string[];
  env?:    Record<string, string>;
}

/**
 * Generate the MCP server entry for Bob's mcp.json.
 * Returns a JS object suitable for serialising into the mcpServers map.
 */
export function generateBobMcpEntry(
  projectRoot:        string,
  simpleAiProvider:   string = "mock"
): Record<string, McpConfigEntry> {
  const serverPath = path.join(projectRoot, "src", "mcp", "server.ts")
    .replace(/\\/g, "/");  // forward slashes for JSON portability

  const entry: McpConfigEntry = {
    command: "npx",
    args:    ["tsx", serverPath],
    env:     { SIMPLE_AI_PROVIDER: simpleAiProvider },
  };

  if (simpleAiProvider === "openai") {
    entry.env!["OPENAI_API_KEY"] = "${env:OPENAI_API_KEY}";
  } else if (simpleAiProvider === "gemini") {
    entry.env!["GEMINI_API_KEY"] = "${env:GEMINI_API_KEY}";
  }

  return { "ai-execution-router": entry };
}

/**
 * Returns the full Bob mcp.json content as a pretty-printed string.
 * If existingContent is provided, the new entry is merged into it.
 * If the key already exists, returns the merged content and a conflict flag.
 */
export function mergeBobMcpJson(
  existingContent:  string | null,
  projectRoot:      string,
  simpleAiProvider: string = "mock"
): { json: string; conflict: boolean; existingEntry: McpConfigEntry | null } {
  const newEntry = generateBobMcpEntry(projectRoot, simpleAiProvider);

  let existing: { mcpServers?: Record<string, McpConfigEntry> } = {};
  if (existingContent) {
    try {
      existing = JSON.parse(existingContent);
    } catch {
      existing = {};
    }
  }

  const servers = existing.mcpServers ?? {};
  const existingEntry = servers["ai-execution-router"] ?? null;
  const conflict = existingEntry !== null;

  const merged = {
    ...existing,
    mcpServers: { ...servers, ...newEntry },
  };

  return {
    json:          JSON.stringify(merged, null, 2) + "\n",
    conflict,
    existingEntry,
  };
}

// ── Workspace validation ──────────────────────────────────────────────────────

export interface WorkspaceValidation {
  valid:   boolean;
  reason?: string;
}

export function validateWorkspacePath(wsPath: string): WorkspaceValidation {
  if (!wsPath || wsPath.trim() === "") {
    return { valid: false, reason: "Path is empty" };
  }
  const abs = path.resolve(wsPath);
  if (!fs.existsSync(abs)) {
    return { valid: false, reason: `Path does not exist: ${abs}` };
  }
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) {
    return { valid: false, reason: `Path is not a directory: ${abs}` };
  }
  return { valid: true };
}
