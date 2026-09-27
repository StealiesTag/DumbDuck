// ─────────────────────────────────────────────────────────────────────────────
// Health-check doctor
//
// Run with:  npm run doctor
//
// Checks and reports the status of every major system component.
// Does NOT modify any files.
//
// Statuses used:
//   OK      — component is correctly configured and working
//   WARNING — working but with caveats worth noting
//   ERROR   — component is missing, misconfigured, or not functional
//   INFO    — informational note, no action required
// ─────────────────────────────────────────────────────────────────────────────

import * as fs          from "fs";
import * as path        from "path";
import { spawnSync }    from "child_process";

import {
  loadConfig,
  validateWorkspacePath,
  PROJECT_ROOT,
  CONFIG_PATH,
  MCP_ENTRY_POINT,
} from "./config";

// ── Check result type ─────────────────────────────────────────────────────────

type CheckStatus = "OK" | "WARNING" | "ERROR" | "INFO";

interface CheckResult {
  label:   string;
  status:  CheckStatus;
  detail:  string;
  hint?:   string;
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const ICON: Record<CheckStatus, string> = {
  OK:      "✓",
  WARNING: "⚠",
  ERROR:   "✗",
  INFO:    "ℹ",
};

// ── Individual checks ─────────────────────────────────────────────────────────

function checkNodeVersion(): CheckResult {
  const v = process.version;
  const major = parseInt(v.replace("v", "").split(".")[0], 10);
  if (major >= 18) {
    return { label: "Node.js version", status: "OK", detail: v };
  }
  return {
    label:  "Node.js version",
    status: "ERROR",
    detail: `${v} — version 18+ required`,
    hint:   "Install from https://nodejs.org",
  };
}

function checkDependencies(): CheckResult {
  const tsxPath = path.join(PROJECT_ROOT, "node_modules", "tsx");
  const mcpPath = path.join(PROJECT_ROOT, "node_modules", "@modelcontextprotocol");
  if (fs.existsSync(tsxPath) && fs.existsSync(mcpPath)) {
    return { label: "Dependencies", status: "OK", detail: "node_modules present" };
  }
  return {
    label:  "Dependencies",
    status: "ERROR",
    detail: "node_modules missing or incomplete",
    hint:   "Run: npm install",
  };
}

function checkMLModel(): CheckResult {
  const modelPath = path.join(PROJECT_ROOT, "models", "decision_tree.json");
  if (!fs.existsSync(modelPath)) {
    return {
      label:  "ML model",
      status: "WARNING",
      detail: "decision_tree.json not found — using rule-based fallback",
      hint:   "Run: cd training && python train.py",
    };
  }
  try {
    const raw   = fs.readFileSync(modelPath, "utf-8");
    const model = JSON.parse(raw) as { version?: string; trained_at?: string };
    return {
      label:  "ML model",
      status: "OK",
      detail: `Loaded (v${model.version ?? "?"}, trained ${model.trained_at?.slice(0, 10) ?? "unknown"})`,
    };
  } catch {
    return {
      label:  "ML model",
      status: "ERROR",
      detail: "decision_tree.json exists but is not valid JSON",
      hint:   "Re-train: cd training && python train.py",
    };
  }
}

function checkMCPEntryPoint(): CheckResult {
  if (fs.existsSync(MCP_ENTRY_POINT)) {
    return {
      label:  "MCP server entry point",
      status: "OK",
      detail: MCP_ENTRY_POINT,
    };
  }
  return {
    label:  "MCP server entry point",
    status: "ERROR",
    detail: `Not found: ${MCP_ENTRY_POINT}`,
    hint:   "The project may be incomplete. Re-clone or check file integrity.",
  };
}

function checkMCPStartup(): CheckResult {
  // Attempt to start the MCP server and immediately send a list-tools request.
  // We capture the first line of stdout (the JSON response) with a short timeout.
  //
  // On Windows, node_modules/.bin/tsx is a .cmd wrapper — spawnSync without
  // shell:true cannot find it. We always use shell:true and quote the path.
  const tsxBin     = path.join(PROJECT_ROOT, "node_modules", ".bin", "tsx");
  const tsxBinCmd  = path.join(PROJECT_ROOT, "node_modules", ".bin", "tsx.cmd");
  const hasBin     = fs.existsSync(tsxBin) || fs.existsSync(tsxBinCmd);
  // Prefer the local bin over global npx to avoid version mismatch
  const tsxExpr    = hasBin
    ? `"${tsxBin.replace(/\\/g, "\\\\")}"`   // quoted for shell
    : "npx tsx";
  const serverExpr = `"${MCP_ENTRY_POINT.replace(/\\/g, "\\\\")}"`;
  const fullCmd    = `${tsxExpr} ${serverExpr}`;

  const input = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
  });

  const result = spawnSync(fullCmd, [], {
    input,
    encoding:  "utf-8",
    timeout:   8_000,
    maxBuffer: 512 * 1024,
    shell:     true,    // required on Windows for .cmd wrappers; safe here
  });

  if (result.error || result.status !== 0) {
    const msg = result.error?.message ?? (result.stderr?.slice(0, 200) ?? "non-zero exit");
    return {
      label:  "MCP server startup",
      status: "ERROR",
      detail: `Server failed to start: ${msg}`,
      hint:   "Check that tsx and @modelcontextprotocol/sdk are installed.",
    };
  }

  try {
    // Strip BOM and carriage returns, then find the first non-empty line
    const stdout    = (result.stdout ?? "").replace(/^\uFEFF/, "").replace(/\r/g, "");
    const firstLine = stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("{")) ?? "";
    const parsed    = JSON.parse(firstLine) as { result?: { tools?: unknown[] } };
    const toolCount = parsed.result?.tools?.length ?? 0;
    return {
      label:  "MCP server startup",
      status: "OK",
      detail: `Server started, ${toolCount} tools registered`,
    };
  } catch {
    // The server started (status=0) but the response was not parseable JSON.
    // Treat this as a soft warning rather than an error.
    return {
      label:  "MCP server startup",
      status: "WARNING",
      detail: "Server started but response could not be parsed — MCP may still work",
    };
  }
}

function checkRouterConfig(): CheckResult {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      label:  "Router configuration file",
      status: "INFO",
      detail: "router.config.json not found",
      hint:   "Run 'npm run setup' to create it.",
    };
  }
  const config = loadConfig(CONFIG_PATH);
  const parts: string[] = [
    `integration: ${config.integrationTarget ?? "not set"}`,
    `provider: ${config.simpleAiProvider ?? "not set"}`,
  ];
  if (config.lastSetupAt) parts.push(`setup: ${config.lastSetupAt.slice(0, 10)}`);
  return {
    label:  "Router configuration file",
    status: "OK",
    detail: parts.join(", "),
  };
}

function checkWorkspace(): CheckResult {
  const config = loadConfig(CONFIG_PATH);
  if (!config.workspacePath) {
    return {
      label:  "Default workspace",
      status: "INFO",
      detail: "No default workspace configured",
      hint:   "Call set_workspace via MCP, or re-run 'npm run setup'.",
    };
  }
  const validation = validateWorkspacePath(config.workspacePath);
  if (!validation.valid) {
    return {
      label:  "Default workspace",
      status: "ERROR",
      detail: `Configured path is invalid: ${validation.reason}`,
      hint:   "Re-run 'npm run setup' to update the workspace path.",
    };
  }
  return {
    label:  "Default workspace",
    status: "OK",
    detail: config.workspacePath,
  };
}

function checkSimpleAIProvider(): CheckResult {
  const provider = process.env.SIMPLE_AI_PROVIDER
    ?? loadConfig(CONFIG_PATH).simpleAiProvider
    ?? "mock";

  if (provider === "mock") {
    return {
      label:  "Simple AI provider",
      status: "INFO",
      detail: "mock mode — no real AI calls will be made",
      hint:   "Set SIMPLE_AI_PROVIDER=openai and OPENAI_API_KEY to use a real model.",
    };
  }

  if (provider === "openai") {
    const hasKey = !!process.env.OPENAI_API_KEY;
    if (!hasKey) {
      return {
        label:  "Simple AI provider",
        status: "WARNING",
        detail: "openai selected but OPENAI_API_KEY is not set in the environment",
        hint:   "Set OPENAI_API_KEY before starting the MCP server.",
      };
    }
    return {
      label:  "Simple AI provider",
      status: "OK",
      detail: `openai (model: ${process.env.SIMPLE_AI_MODEL ?? "gpt-4o-mini"})`,
    };
  }

  return {
    label:  "Simple AI provider",
    status: "WARNING",
    detail: `Unknown provider: "${provider}"`,
    hint:   "Supported: mock, openai",
  };
}

function checkExecutionMode(): CheckResult {
  const config    = loadConfig(CONFIG_PATH);
  const provider  = process.env.SIMPLE_AI_PROVIDER ?? config.simpleAiProvider ?? "mock";
  const modelPath = path.join(PROJECT_ROOT, "models", "decision_tree.json");
  const hasModel  = fs.existsSync(modelPath);

  const parts: string[] = [];
  if (!hasModel) parts.push("ML classifier: FALLBACK_HEURISTIC");
  else           parts.push("ML classifier: ML_MODEL");
  if (provider === "mock") parts.push("simple AI: MOCK");
  else                      parts.push(`simple AI: ${provider}`);
  parts.push("complex AI: DELEGATION (no model called)");

  const isFullMock = !hasModel && provider === "mock";
  return {
    label:  "Execution mode",
    status: isFullMock ? "INFO" : "OK",
    detail: parts.join(" | "),
    hint:   isFullMock
      ? "All AI paths are mocked or using fallback heuristics. Train the model and configure a provider for real execution."
      : undefined,
  };
}

function checkAgentEnforcement(): CheckResult {
  // We cannot detect from within this process whether Bob hooks are configured.
  // Be honest about what we know and don't know.
  const config = loadConfig(CONFIG_PATH);
  if (!config.integrationTarget || config.integrationTarget === "manual") {
    return {
      label:  "Agent hook / enforcement",
      status: "INFO",
      detail: "No integration target configured",
      hint:   "Routing is opt-in. The router does not intercept agent built-in tools.",
    };
  }
  if (config.integrationTarget === "bob") {
    return {
      label:  "Agent hook / enforcement",
      status: "INFO",
      detail: "Bob integration target set. MCP tools are available when Bob is connected.",
      hint:
        "Important: MCP alone does not prevent Bob from using its own file/terminal tools. " +
        "Routing is opt-in. Configure Bob's mode or system prompt to prefer router tools.",
    };
  }
  return {
    label:  "Agent hook / enforcement",
    status: "INFO",
    detail: `Generic MCP integration. Enforcement depends on your MCP host configuration.`,
  };
}

// ── Report printer ────────────────────────────────────────────────────────────

function printReport(checks: CheckResult[]): void {
  const w = 32;
  console.log("\n" + "=".repeat(58));
  console.log("  AI Execution Router — System Health Check");
  console.log("=".repeat(58));

  let errors = 0, warnings = 0;

  for (const c of checks) {
    const icon  = ICON[c.status];
    const label = (c.label + " ").padEnd(w, ".");
    console.log(`  ${icon} ${label} ${c.detail}`);
    if (c.hint) console.log(`      → ${c.hint}`);
    if (c.status === "ERROR")   errors++;
    if (c.status === "WARNING") warnings++;
  }

  console.log("\n" + "-".repeat(58));
  if (errors === 0 && warnings === 0) {
    console.log("  All checks passed.");
  } else {
    if (errors   > 0) console.log(`  ${errors} error(s) — fix before using the router in production.`);
    if (warnings > 0) console.log(`  ${warnings} warning(s) — review the hints above.`);
  }
  console.log("=".repeat(58) + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const checks: CheckResult[] = [
    checkNodeVersion(),
    checkDependencies(),
    checkMLModel(),
    checkMCPEntryPoint(),
    checkRouterConfig(),
    checkWorkspace(),
    checkSimpleAIProvider(),
    checkExecutionMode(),
    checkAgentEnforcement(),
    // MCP startup is the slowest check — run last
    checkMCPStartup(),
  ];

  printReport(checks);

  const hasError = checks.some((c) => c.status === "ERROR");
  process.exit(hasError ? 1 : 0);
}

/**
 * Exported for tests — runs all checks and returns results without printing.
 * Pass a custom configPath to isolate tests from real config files.
 */
export {
  CheckResult,
  CheckStatus,
  checkNodeVersion,
  checkDependencies,
  checkMLModel,
  checkMCPEntryPoint,
  checkRouterConfig,
  checkWorkspace,
  checkSimpleAIProvider,
  checkExecutionMode,
  checkAgentEnforcement,
  printReport,
};

// Only run when this file is the direct entry point (not when imported by tests)
if (require.main === module) {
  main().catch((err) => {
    console.error("Doctor error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
