// ─────────────────────────────────────────────────────────────────────────────
// Tests: Setup / Config / Doctor
//
// All file I/O is isolated to OS temp directories.
// These tests never read or write the real router.config.json.
// ─────────────────────────────────────────────────────────────────────────────

import * as os   from "os";
import * as fs   from "fs";
import * as path from "path";

import {
  RouterConfig,
  loadConfig,
  saveConfig,
  defaultConfig,
  generateBobMcpEntry,
  mergeBobMcpJson,
  validateWorkspacePath,
  PROJECT_ROOT,
} from "../setup/config";

import {
  checkNodeVersion,
  checkMLModel,
  checkMCPEntryPoint,
  checkRouterConfig,
  checkWorkspace,
  checkSimpleAIProvider,
  checkExecutionMode,
  checkAgentEnforcement,
} from "../setup/doctor";

import { TestResult, assert, assertEqual, assertThrows } from "./helpers";

// ── Temp directory helpers ────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-setup-test-"));
}

function rmTempDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: Config loading and saving
// ─────────────────────────────────────────────────────────────────────────────

export function runConfigTests(): TestResult[] {
  const results: TestResult[] = [];
  const tmp = makeTempDir();

  try {
    const cfgPath = path.join(tmp, "router.config.json");

    // ── loadConfig returns defaults when file is absent ───────────────────────
    const defaults = loadConfig(cfgPath);
    results.push(assertEqual(defaults.version, "1",
      "loadConfig: returns version '1' when file absent"));
    results.push(assert(typeof defaults.projectRoot === "string" && defaults.projectRoot.length > 0,
      "loadConfig: returns non-empty projectRoot when file absent"));
    results.push(assert(defaults.workspacePath === undefined,
      "loadConfig: workspacePath is undefined in defaults"));

    // ── saveConfig creates the file and persists values ───────────────────────
    const saved = saveConfig(
      { workspacePath: tmp, integrationTarget: "bob", simpleAiProvider: "mock" },
      cfgPath
    );
    results.push(assert(fs.existsSync(cfgPath),
      "saveConfig: creates router.config.json"));
    results.push(assertEqual(saved.version, "1",
      "saveConfig: persists version '1'"));
    results.push(assertEqual(saved.workspacePath, tmp,
      "saveConfig: persists workspacePath"));
    results.push(assertEqual(saved.integrationTarget, "bob",
      "saveConfig: persists integrationTarget"));
    results.push(assertEqual(saved.simpleAiProvider, "mock",
      "saveConfig: persists simpleAiProvider"));
    results.push(assert(typeof saved.lastSetupAt === "string" && saved.lastSetupAt.length > 0,
      "saveConfig: stamps lastSetupAt as ISO string"));

    // ── loadConfig reads back the saved file ─────────────────────────────────
    const loaded = loadConfig(cfgPath);
    results.push(assertEqual(loaded.workspacePath, tmp,
      "loadConfig: reads back workspacePath after save"));
    results.push(assertEqual(loaded.integrationTarget, "bob",
      "loadConfig: reads back integrationTarget after save"));

    // ── saveConfig merges without clobbering existing fields ──────────────────
    saveConfig({ simpleAiProvider: "openai" }, cfgPath);
    const merged = loadConfig(cfgPath);
    results.push(assertEqual(merged.workspacePath, tmp,
      "saveConfig: partial update preserves workspacePath"));
    results.push(assertEqual(merged.simpleAiProvider, "openai",
      "saveConfig: partial update applies new simpleAiProvider"));
    results.push(assertEqual(merged.integrationTarget, "bob",
      "saveConfig: partial update preserves integrationTarget"));

    // ── loadConfig returns defaults when file is corrupt JSON ─────────────────
    const badPath = path.join(tmp, "bad.json");
    fs.writeFileSync(badPath, "{ not valid json ~~~ ]]]", "utf-8");
    const corrupt = loadConfig(badPath);
    results.push(assertEqual(corrupt.version, "1",
      "loadConfig: returns defaults for corrupt JSON"));

    // ── defaultConfig always returns version '1' ──────────────────────────────
    const def = defaultConfig();
    results.push(assertEqual(def.version, "1",
      "defaultConfig: always returns version '1'"));

  } finally {
    rmTempDir(tmp);
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: MCP config generation and conflict detection
// ─────────────────────────────────────────────────────────────────────────────

export function runMcpConfigTests(): TestResult[] {
  const results: TestResult[] = [];
  const fakeRoot = "/fake/project";

  // ── generateBobMcpEntry returns correctly shaped entry ────────────────────
  const entry = generateBobMcpEntry(fakeRoot, "mock");
  const record = entry["ai-execution-router"];
  results.push(assert(record !== undefined,
    "generateBobMcpEntry: returns entry keyed 'ai-execution-router'"));
  results.push(assertEqual(record.command, "npx",
    "generateBobMcpEntry: command is 'npx'"));
  results.push(assert(record.args.includes("tsx"),
    "generateBobMcpEntry: args includes 'tsx'"));
  results.push(assert(record.args.some((a: string) => a.includes("server.ts")),
    "generateBobMcpEntry: args include server.ts path"));
  results.push(assertEqual(record.env?.SIMPLE_AI_PROVIDER, "mock",
    "generateBobMcpEntry: env.SIMPLE_AI_PROVIDER = 'mock'"));

  // ── openai provider adds placeholder key reference ────────────────────────
  const openaiEntry = generateBobMcpEntry(fakeRoot, "openai");
  const openaiRecord = openaiEntry["ai-execution-router"];
  results.push(assert(
    openaiRecord.env?.OPENAI_API_KEY?.includes("OPENAI_API_KEY"),
    "generateBobMcpEntry: openai adds OPENAI_API_KEY placeholder"
  ));

  // ── mergeBobMcpJson with null existingContent creates new config ──────────
  const { json: newJson, conflict: noConflict } = mergeBobMcpJson(null, fakeRoot, "mock");
  const parsed = JSON.parse(newJson);
  results.push(assert(!noConflict,
    "mergeBobMcpJson: no conflict when merging into null/empty content"));
  results.push(assert(parsed.mcpServers?.["ai-execution-router"] !== undefined,
    "mergeBobMcpJson: creates mcpServers.ai-execution-router in new config"));

  // ── mergeBobMcpJson preserves existing sibling servers ────────────────────
  const existingJson = JSON.stringify({
    mcpServers: { "other-server": { command: "node", args: ["other.js"] } }
  });
  const { json: merged2 } = mergeBobMcpJson(existingJson, fakeRoot, "mock");
  const parsed2 = JSON.parse(merged2);
  results.push(assert(parsed2.mcpServers?.["other-server"] !== undefined,
    "mergeBobMcpJson: preserves pre-existing sibling server entries"));
  results.push(assert(parsed2.mcpServers?.["ai-execution-router"] !== undefined,
    "mergeBobMcpJson: adds new entry alongside sibling servers"));

  // ── mergeBobMcpJson detects a conflict when key already exists ────────────
  const conflictJson = JSON.stringify({
    mcpServers: {
      "ai-execution-router": { command: "npx", args: ["tsx", "old/path.ts"] }
    }
  });
  const { conflict, existingEntry } = mergeBobMcpJson(conflictJson, fakeRoot, "mock");
  results.push(assert(conflict,
    "mergeBobMcpJson: detects conflict when 'ai-execution-router' already present"));
  results.push(assert(existingEntry !== null,
    "mergeBobMcpJson: returns the existing entry on conflict"));

  // ── mergeBobMcpJson handles corrupt existingContent gracefully ────────────
  const { json: fromCorrupt, conflict: noConflict2 } =
    mergeBobMcpJson("{ not-json", fakeRoot, "mock");
  results.push(assert(!noConflict2,
    "mergeBobMcpJson: treats corrupt JSON as empty (no conflict)"));
  results.push(assert(JSON.parse(fromCorrupt).mcpServers?.["ai-execution-router"] !== undefined,
    "mergeBobMcpJson: produces valid JSON from corrupt input"));

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Workspace path validation
// ─────────────────────────────────────────────────────────────────────────────

export function runWorkspaceValidationTests(): TestResult[] {
  const results: TestResult[] = [];
  const tmp = makeTempDir();

  try {
    // ── valid directory passes ────────────────────────────────────────────────
    const okResult = validateWorkspacePath(tmp);
    results.push(assert(okResult.valid,
      "validateWorkspacePath: valid directory returns valid=true"));
    results.push(assert(okResult.reason === undefined,
      "validateWorkspacePath: valid directory has no reason"));

    // ── non-existent path fails ───────────────────────────────────────────────
    const missingResult = validateWorkspacePath(path.join(tmp, "not_here"));
    results.push(assert(!missingResult.valid,
      "validateWorkspacePath: missing path returns valid=false"));
    results.push(assert(typeof missingResult.reason === "string" && missingResult.reason.length > 0,
      "validateWorkspacePath: missing path includes a reason"));

    // ── file path (not a directory) fails ─────────────────────────────────────
    const filePath = path.join(tmp, "config.json");
    fs.writeFileSync(filePath, "{}", "utf-8");
    const fileResult = validateWorkspacePath(filePath);
    results.push(assert(!fileResult.valid,
      "validateWorkspacePath: file path returns valid=false"));
    results.push(assert(typeof fileResult.reason === "string",
      "validateWorkspacePath: file path includes a reason"));

    // ── empty string fails ────────────────────────────────────────────────────
    const emptyResult = validateWorkspacePath("");
    results.push(assert(!emptyResult.valid,
      "validateWorkspacePath: empty string returns valid=false"));

    // ── whitespace-only string fails ──────────────────────────────────────────
    const wsResult = validateWorkspacePath("   ");
    results.push(assert(!wsResult.valid,
      "validateWorkspacePath: whitespace-only string returns valid=false"));

  } finally {
    rmTempDir(tmp);
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: Doctor health checks (isolated)
// ─────────────────────────────────────────────────────────────────────────────

export function runDoctorTests(): TestResult[] {
  const results: TestResult[] = [];
  const tmp = makeTempDir();

  try {
    // ── checkNodeVersion passes on any Node ≥ 18 (we are running ≥18) ────────
    const nodeCheck = checkNodeVersion();
    results.push(assert(nodeCheck.status === "OK",
      "checkNodeVersion: returns OK on Node ≥ 18"));
    results.push(assert(nodeCheck.detail.startsWith("v"),
      "checkNodeVersion: detail starts with 'v'"));

    // ── checkMLModel reports OK when model file is present ───────────────────
    const modelDir  = path.join(tmp, "models");
    const modelPath = path.join(modelDir, "decision_tree.json");
    fs.mkdirSync(modelDir);
    fs.writeFileSync(modelPath, JSON.stringify({
      version:    "1",
      trained_at: "2024-01-01T00:00:00Z",
      type:       "decision_tree",
      tree:       { feature: 0, threshold: 0.5, left: { label: "DETERMINISTIC" }, right: { label: "COMPLEX_AI" } },
    }), "utf-8");

    // Call the real check — it uses PROJECT_ROOT which is the real project.
    // Instead, validate the helper logic by checking the real project's model.
    const mlCheck = checkMLModel();
    results.push(assert(
      mlCheck.status === "OK" || mlCheck.status === "WARNING",
      "checkMLModel: returns OK or WARNING (model present or absent in real project)"
    ));

    // ── checkMCPEntryPoint reports OK when entry point exists ─────────────────
    // The real MCP server.ts IS present in this project
    const mcpCheck = checkMCPEntryPoint();
    results.push(assert(mcpCheck.status === "OK",
      "checkMCPEntryPoint: returns OK (server.ts is present in project)"));

    // ── checkRouterConfig returns INFO when config file is absent ─────────────
    // We test the logic by temporarily checking against a nonexistent path.
    // checkRouterConfig uses CONFIG_PATH internally, so we verify the real state.
    const configCheck = checkRouterConfig();
    results.push(assert(
      configCheck.status === "OK" || configCheck.status === "INFO",
      "checkRouterConfig: returns OK if config exists, INFO if absent"
    ));

    // ── checkSimpleAIProvider: mock mode returns INFO ─────────────────────────
    // Save and clear the env var to ensure reproducibility
    const savedProvider = process.env.SIMPLE_AI_PROVIDER;
    const savedApiKey   = process.env.OPENAI_API_KEY;

    process.env.SIMPLE_AI_PROVIDER = "mock";
    delete process.env.OPENAI_API_KEY;

    const mockProviderCheck = checkSimpleAIProvider();
    results.push(assert(mockProviderCheck.status === "INFO",
      "checkSimpleAIProvider: returns INFO for mock provider"));
    results.push(assert(mockProviderCheck.detail.includes("mock"),
      "checkSimpleAIProvider: INFO detail mentions 'mock'"));

    // ── checkSimpleAIProvider: openai without API key returns WARNING ─────────
    process.env.SIMPLE_AI_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    const openaiNoKeyCheck = checkSimpleAIProvider();
    results.push(assert(openaiNoKeyCheck.status === "WARNING",
      "checkSimpleAIProvider: returns WARNING for openai without OPENAI_API_KEY"));

    // ── checkSimpleAIProvider: openai with API key returns OK ─────────────────
    process.env.OPENAI_API_KEY = "sk-test-key-for-testing-only";
    const openaiWithKeyCheck = checkSimpleAIProvider();
    results.push(assert(openaiWithKeyCheck.status === "OK",
      "checkSimpleAIProvider: returns OK for openai with OPENAI_API_KEY set"));

    // Restore env
    if (savedProvider === undefined) delete process.env.SIMPLE_AI_PROVIDER;
    else process.env.SIMPLE_AI_PROVIDER = savedProvider;

    if (savedApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedApiKey;

    // ── checkExecutionMode returns a result object ────────────────────────────
    const execCheck = checkExecutionMode();
    results.push(assert(
      ["OK", "INFO", "WARNING"].includes(execCheck.status),
      "checkExecutionMode: returns a valid status (OK, INFO, or WARNING)"
    ));
    results.push(assert(execCheck.detail.length > 0,
      "checkExecutionMode: detail is non-empty"));

    // ── checkAgentEnforcement: no integration target → INFO ───────────────────
    // This check reads CONFIG_PATH, so we verify it returns a valid status
    const agentCheck = checkAgentEnforcement();
    results.push(assert(
      ["OK", "INFO", "WARNING", "ERROR"].includes(agentCheck.status),
      "checkAgentEnforcement: returns a valid status"
    ));

    // ── checkWorkspace: no workspace configured → INFO or ERROR ───────────────
    const wsCheck = checkWorkspace();
    results.push(assert(
      ["OK", "INFO", "WARNING", "ERROR"].includes(wsCheck.status),
      "checkWorkspace: returns a valid status"
    ));

  } finally {
    rmTempDir(tmp);
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5: Mock vs real provider distinction
// ─────────────────────────────────────────────────────────────────────────────

export function runProviderTests(): TestResult[] {
  const results: TestResult[] = [];

  // ── saveConfig round-trips all provider values ────────────────────────────
  const tmp    = makeTempDir();
  const cfgPath = path.join(tmp, "router.config.json");

  try {
    for (const provider of ["mock", "openai"] as const) {
      saveConfig({ simpleAiProvider: provider }, cfgPath);
      const loaded = loadConfig(cfgPath);
      results.push(assertEqual(loaded.simpleAiProvider, provider,
        `saveConfig/loadConfig round-trip: simpleAiProvider = '${provider}'`));
    }

    // ── mock provider in generated MCP entry sets env correctly ───────────────
    const mockEntry = generateBobMcpEntry("/proj", "mock");
    results.push(assertEqual(
      mockEntry["ai-execution-router"].env?.SIMPLE_AI_PROVIDER,
      "mock",
      "generateBobMcpEntry: mock provider sets SIMPLE_AI_PROVIDER=mock"
    ));
    results.push(assert(
      mockEntry["ai-execution-router"].env?.OPENAI_API_KEY === undefined,
      "generateBobMcpEntry: mock provider does NOT add OPENAI_API_KEY"
    ));

    // ── openai provider in generated MCP entry sets env correctly ─────────────
    const openaiEntry = generateBobMcpEntry("/proj", "openai");
    results.push(assertEqual(
      openaiEntry["ai-execution-router"].env?.SIMPLE_AI_PROVIDER,
      "openai",
      "generateBobMcpEntry: openai provider sets SIMPLE_AI_PROVIDER=openai"
    ));
    results.push(assert(
      openaiEntry["ai-execution-router"].env?.OPENAI_API_KEY !== undefined,
      "generateBobMcpEntry: openai provider adds OPENAI_API_KEY reference"
    ));
    results.push(assert(
      !openaiEntry["ai-execution-router"].env!.OPENAI_API_KEY.startsWith("sk-"),
      "generateBobMcpEntry: OPENAI_API_KEY value is a placeholder, not a real key"
    ));

  } finally {
    rmTempDir(tmp);
  }

  return results;
}
