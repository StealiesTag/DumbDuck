// ─────────────────────────────────────────────────────────────────────────────
// Interactive setup wizard
//
// Run with:  npm run setup
//
// Guides the user through:
//   1. Node.js / dependency check
//   2. Integration target selection (Bob / generic MCP / manual)
//   3. Project path confirmation
//   4. MCP config generation (with conflict detection)
//   5. Workspace path input and validation
//   6. Save config + print next steps
//
// Cross-platform: uses only Node.js built-ins (readline, fs, path, child_process).
// No external dependencies required.
// ─────────────────────────────────────────────────────────────────────────────

import * as readline from "readline";
import * as fs       from "fs";
import * as path     from "path";
import { spawnSync } from "child_process";

import {
  loadConfig,
  saveConfig,
  generateBobMcpEntry,
  mergeBobMcpJson,
  validateWorkspacePath,
  PROJECT_ROOT,
  CONFIG_PATH,
} from "./config";

// ── readline helper ────────────────────────────────────────────────────────────

function makeRl(): readline.Interface {
  return readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function askYN(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  return ask(rl, `${question} ${hint}: `).then((a) => {
    if (!a) return defaultYes;
    return /^y/i.test(a);
  });
}

// ── Checks ─────────────────────────────────────────────────────────────────────

function checkNode(): { ok: boolean; version: string } {
  const v = process.version;
  const major = parseInt(v.replace("v", "").split(".")[0], 10);
  return { ok: major >= 18, version: v };
}

function checkDepsInstalled(): boolean {
  return fs.existsSync(path.join(PROJECT_ROOT, "node_modules", ".package-lock.json"))
      || fs.existsSync(path.join(PROJECT_ROOT, "node_modules", "tsx"));
}

// ── Bob config path detection ─────────────────────────────────────────────────

/**
 * Return the best-guess path for Bob's workspace mcp.json.
 * This is always .bob/mcp.json relative to the user-supplied workspace,
 * or relative to PROJECT_ROOT as a fallback.
 */
function bobMcpConfigPath(workspacePath: string): string {
  return path.join(workspacePath || PROJECT_ROOT, ".bob", "mcp.json");
}

// ── Main wizard ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n" + "=".repeat(58));
  console.log("  AI Execution Router — Setup Wizard");
  console.log("=".repeat(58));
  console.log("This wizard configures the router for first use.");
  console.log("It will not overwrite unrelated settings without asking.\n");

  const rl = makeRl();

  // ── Step 1: Prerequisites ───────────────────────────────────────────────────
  console.log("── Step 1: Prerequisites ─────────────────────────────────");

  const node = checkNode();
  if (!node.ok) {
    console.log(`  ✗ Node.js ${node.version} detected. Version 18+ is required.`);
    console.log("    Install from: https://nodejs.org");
    rl.close();
    process.exit(1);
  }
  console.log(`  ✓ Node.js ${node.version}`);

  const depsInstalled = checkDepsInstalled();
  if (!depsInstalled) {
    console.log("  ✗ Dependencies not installed (node_modules missing).");
    console.log("    Run: npm install");
    const cont = await askYN(rl, "Continue anyway?", false);
    if (!cont) { rl.close(); process.exit(1); }
  } else {
    console.log("  ✓ Dependencies installed");
  }

  const existingConfig = loadConfig(CONFIG_PATH);
  if (existingConfig.lastSetupAt) {
    console.log(`\n  ℹ  Previous setup found (${existingConfig.lastSetupAt}).`);
    const redo = await askYN(rl, "Re-run setup?", true);
    if (!redo) {
      console.log("\nSetup skipped. Run 'npm run doctor' to check system status.");
      rl.close();
      return;
    }
  }

  // ── Step 2: Integration target ──────────────────────────────────────────────
  console.log("\n── Step 2: Integration target ────────────────────────────");
  console.log("  1) IBM Bob (recommended)");
  console.log("  2) Generic MCP-compatible client");
  console.log("  3) Manual — I will configure myself");

  let integrationTarget: "bob" | "generic" | "manual" = "manual";
  const targetInput = await ask(rl, "Choose [1/2/3] (default 1): ");
  if (targetInput === "" || targetInput === "1") {
    integrationTarget = "bob";
    console.log("  → IBM Bob selected.");
  } else if (targetInput === "2") {
    integrationTarget = "generic";
    console.log("  → Generic MCP client selected.");
  } else {
    integrationTarget = "manual";
    console.log("  → Manual configuration selected.");
  }

  // ── Step 3: Confirm project path ────────────────────────────────────────────
  console.log("\n── Step 3: Project path ──────────────────────────────────");
  console.log(`  Detected: ${PROJECT_ROOT}`);
  const confirmRoot = await askYN(rl, "Use this as the project root?", true);
  let projectRoot = PROJECT_ROOT;
  if (!confirmRoot) {
    const entered = await ask(rl, "Enter the absolute path to the project root: ");
    if (!entered || !fs.existsSync(entered)) {
      console.log(`  ✗ Path not found: ${entered}`);
      rl.close();
      process.exit(1);
    }
    projectRoot = path.resolve(entered);
  }
  console.log(`  ✓ Project root: ${projectRoot}`);

  // ── Step 4: Workspace path ──────────────────────────────────────────────────
  console.log("\n── Step 4: Default workspace ─────────────────────────────");
  console.log("  The workspace is the repository or project folder that MCP file");
  console.log("  tools (search, read, git) will operate on.");
  if (existingConfig.workspacePath) {
    console.log(`  Existing workspace: ${existingConfig.workspacePath}`);
  }

  let workspacePath: string | undefined = existingConfig.workspacePath;
  const changeWs = await askYN(rl, "Set or update default workspace now?", !existingConfig.workspacePath);
  if (changeWs) {
    const wsInput = await ask(rl, "Enter workspace path (leave blank to skip): ");
    if (wsInput) {
      const validation = validateWorkspacePath(wsInput);
      if (!validation.valid) {
        console.log(`  ✗ ${validation.reason}`);
        console.log("    Workspace not saved. You can set it later with set_workspace.");
      } else {
        workspacePath = path.resolve(wsInput);
        console.log(`  ✓ Workspace: ${workspacePath}`);
      }
    } else {
      console.log("  Workspace skipped. Use the set_workspace MCP tool at runtime.");
    }
  }

  // ── Step 5: Simple AI provider ──────────────────────────────────────────────
  console.log("\n── Step 5: Simple AI provider ────────────────────────────");
  console.log("  API keys are NOT stored in the config file.");
  console.log("  1) mock  — no real API calls (default)");
  console.log("  2) openai — requires OPENAI_API_KEY env variable");

  let simpleAiProvider = existingConfig.simpleAiProvider ?? "mock";
  const aiInput = await ask(rl, "Choose [1/2] (default 1 / current: " + simpleAiProvider + "): ");
  if (aiInput === "2") {
    simpleAiProvider = "openai";
    console.log("  → openai selected. Set OPENAI_API_KEY in your environment.");
    console.log("    IMPORTANT: never paste API keys into this wizard.");
  } else if (aiInput === "1" || aiInput === "") {
    simpleAiProvider = "mock";
    console.log("  → mock mode (no real AI calls).");
  }

  // ── Step 6: Save config ─────────────────────────────────────────────────────
  console.log("\n── Step 6: Saving configuration ──────────────────────────");
  const saved = saveConfig({
    projectRoot,
    workspacePath,
    integrationTarget,
    simpleAiProvider,
  });
  console.log(`  ✓ Saved to: ${CONFIG_PATH}`);

  // ── Step 7: MCP config generation ──────────────────────────────────────────
  console.log("\n── Step 7: MCP configuration ─────────────────────────────");

  if (integrationTarget === "bob") {
    const wsForBob = workspacePath ?? projectRoot;
    const bobMcpPath = bobMcpConfigPath(wsForBob);
    let existingBobContent: string | null = null;
    if (fs.existsSync(bobMcpPath)) {
      existingBobContent = fs.readFileSync(bobMcpPath, "utf-8");
    }

    const { json, conflict, existingEntry } = mergeBobMcpJson(
      existingBobContent, projectRoot, simpleAiProvider
    );

    if (conflict) {
      console.log(`\n  ⚠  Existing 'ai-execution-router' entry found in:\n  ${bobMcpPath}`);
      console.log("  Existing entry:");
      console.log("  " + JSON.stringify(existingEntry, null, 2).split("\n").join("\n  "));
      const overwrite = await askYN(rl, "Replace the existing entry?", false);
      if (!overwrite) {
        console.log("  Existing Bob MCP config preserved. No changes written.");
        console.log("  New entry for reference:\n");
        console.log(JSON.stringify(generateBobMcpEntry(projectRoot, simpleAiProvider), null, 2));
      } else {
        fs.mkdirSync(path.dirname(bobMcpPath), { recursive: true });
        fs.writeFileSync(bobMcpPath, json, "utf-8");
        console.log(`  ✓ Written to: ${bobMcpPath}`);
      }
    } else {
      const write = await askYN(rl, `Write Bob MCP config to ${bobMcpPath}?`, true);
      if (write) {
        fs.mkdirSync(path.dirname(bobMcpPath), { recursive: true });
        fs.writeFileSync(bobMcpPath, json, "utf-8");
        console.log(`  ✓ Written to: ${bobMcpPath}`);
      } else {
        console.log("  Skipped. Config for manual use:\n");
        console.log(JSON.stringify(generateBobMcpEntry(projectRoot, simpleAiProvider), null, 2));
      }
    }
  } else if (integrationTarget === "generic") {
    console.log("\n  Generic MCP configuration (STDIO transport):");
    console.log("  Configuration format varies by MCP host. Use these values:\n");
    const entry = generateBobMcpEntry(projectRoot, simpleAiProvider);
    console.log(JSON.stringify({ mcpServers: entry }, null, 2));
    console.log("\n  Add this to your MCP host's server list.");
  } else {
    console.log("  Manual mode — no config file written.");
    console.log("  MCP server entry point:", path.join(projectRoot, "src", "mcp", "server.ts"));
    console.log("  Command: npx tsx <above path>");
  }

  // ── Step 8: Next steps ──────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(58));
  console.log("  Setup complete. Next steps:");
  console.log("=".repeat(58));
  console.log("");

  if (integrationTarget === "bob") {
    console.log("  1. Restart Bob (or reload the MCP panel) to pick up the new server.");
    console.log("  2. In Bob, call:  set_workspace  with your project path.");
  } else if (integrationTarget === "generic") {
    console.log("  1. Add the MCP config shown above to your MCP host.");
    console.log("  2. Restart the host to connect the server.");
    console.log("  3. Call set_workspace with your project path.");
  } else {
    console.log("  1. Start the MCP server:  npm run mcp:start");
    console.log("  2. Connect your MCP client manually.");
  }

  if (simpleAiProvider === "openai") {
    console.log("");
    console.log("  3. Set OPENAI_API_KEY in your environment before starting the server.");
    console.log("     Example (PowerShell): $env:OPENAI_API_KEY='sk-...'");
    console.log("     Example (bash):       export OPENAI_API_KEY=sk-...");
  }

  if (!workspacePath) {
    console.log("");
    console.log("  • No default workspace set. Use the set_workspace MCP tool at runtime.");
  }

  console.log("");
  console.log("  Run 'npm run doctor' to verify the system is healthy.");
  console.log("  Run 'npm test'       to run the test suite.");
  console.log("");

  rl.close();
}

main().catch((err) => {
  console.error("Setup error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
