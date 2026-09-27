import * as fs from "fs";
import * as path from "path";

const START_MARKER = "<!-- BEGIN AI EXECUTION ROUTER -->";
const END_MARKER = "<!-- END AI EXECUTION ROUTER -->";

const ROUTER_INSTRUCTIONS = `${START_MARKER}
## DumbDuck

For workspace or coding tasks in this repository, use the configured ai-execution-router MCP server by default. Before searching, reading, diagnosing, editing, testing, or checking Git, call route_task with the specific operation and relevant context. Set the workspace with set_workspace first if needed, then use the router's deterministic tools when available. Use CREATE_FILE with path and content for new files. Use DELETE_FILE only after the user explicitly authorizes deletion, setting confirm=true.

Do not route ordinary conversation, clarification, or explanation-only requests. A COMPLEX_AI result is a delegation recommendation, not an automatic handoff; continue the work as the host agent using the returned context. MCP guidance is not enforcement, so follow host-level restrictions and fall back to native tools when the router cannot perform the operation.
${END_MARKER}`;

export function installRouterAgentInstructions(workspacePath: string): string {
  const instructionsPath = path.join(workspacePath, "AGENTS.md");
  const existing = fs.existsSync(instructionsPath)
    ? fs.readFileSync(instructionsPath, "utf-8")
    : "";
  const start = existing.indexOf(START_MARKER);
  const end = existing.indexOf(END_MARKER);
  let updated: string;

  if (start >= 0 && end >= start) {
    updated = existing.slice(0, start) + ROUTER_INSTRUCTIONS + existing.slice(end + END_MARKER.length);
  } else {
    updated = `${existing.trimEnd()}${existing.trimEnd() ? "\n\n" : ""}${ROUTER_INSTRUCTIONS}\n`;
  }

  fs.writeFileSync(instructionsPath, updated, "utf-8");
  return instructionsPath;
}

export function hasRouterAgentInstructions(workspacePath: string): boolean {
  const instructionsPath = path.join(workspacePath, "AGENTS.md");
  if (!fs.existsSync(instructionsPath)) return false;
  const content = fs.readFileSync(instructionsPath, "utf-8");
  return content.includes(START_MARKER) && content.includes(END_MARKER);
}