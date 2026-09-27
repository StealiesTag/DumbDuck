// ─────────────────────────────────────────────────────────────────────────────
// MCP Server — AI Execution Router
//
// Exposes the router as an MCP STDIO server using the official MCP TypeScript SDK.
// This is an integration layer around the existing router — it does not replace
// the router, classifier, or execution pipeline.
//
// Start with:  npm run mcp:start
//              (or)  npx tsx src/mcp/server.ts
//
// Connect from Bob or another MCP client via STDIO transport.
//
// LIMITATION: The MCP server manages a SINGLE workspace per process.
// Multiple concurrent clients sharing one server will share the workspace.
// ─────────────────────────────────────────────────────────────────────────────

import { Server }       from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { workspace }           from "../workspace/WorkspaceManager";
import { listFiles }           from "../workspace/tools/listFiles";
import { readWorkspaceFile }   from "../workspace/tools/readFile";
import { searchRepository }    from "../workspace/tools/searchRepository";
import { getGitStatus, getGitDiff } from "../workspace/tools/gitOps";
import { runWorkspaceTests }   from "../workspace/tools/runTests";
import { routeTask }           from "../router/router";
import { executionLog }        from "../log/executionLog";
import { IncomingTask, TaskKind } from "../types";
import { TOOL_SCHEMAS }        from "./tools";

// ── Server instance ───────────────────────────────────────────────────────────

const server = new Server(
  { name: "ai-execution-router", version: "0.3.0" },
  { capabilities: { tools: {} } }
);

// ── Tool listing ──────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_SCHEMAS,
}));

// ── Tool dispatch ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      // ── set_workspace ──────────────────────────────────────────────────────
      case "set_workspace": {
        const rootPath = String(args.path ?? "");
        if (!rootPath) return err("path is required");
        workspace.setWorkspace(rootPath);
        return ok(`Workspace set to: ${workspace.getRoot()}`);
      }

      // ── list_files ─────────────────────────────────────────────────────────
      case "list_files": {
        const dir = String(args.directory ?? ".");
        const res = listFiles(workspace, dir);
        if (!res.ok) return err(res.error ?? "Unknown error");
        const trunc = res.truncated ? `\n(truncated at ${res.count} entries)` : "";
        return ok(`${res.count} entries in "${dir}":\n${res.entries.join("\n")}${trunc}`);
      }

      // ── read_file ──────────────────────────────────────────────────────────
      case "read_file": {
        const filePath = String(args.path ?? "");
        if (!filePath) return err("path is required");
        const res = readWorkspaceFile(workspace, filePath);
        if (!res.ok) return err(res.error ?? "Unknown error");
        const trunc = res.truncated ? `\n(file truncated at 512 KB)` : "";
        return ok(`${res.content}${trunc}`);
      }

      // ── search_repository ──────────────────────────────────────────────────
      case "search_repository": {
        const pattern = String(args.pattern ?? "");
        if (!pattern) return err("pattern is required");
        const subDir = String(args.directory ?? ".");
        const res    = searchRepository(workspace, pattern, subDir);
        if (!res.ok) return err(res.error ?? "Unknown error");
        if (res.matches.length === 0) return ok(`No matches for "${pattern}"`);
        const lines  = res.matches
          .map((m) => `${m.file}:${m.line}: ${m.content}`)
          .join("\n");
        const trunc  = res.truncated ? `\n(results truncated at ${res.totalMatches})` : "";
        return ok(`${res.totalMatches} match(es) for "${pattern}":\n${lines}${trunc}`);
      }

      // ── get_git_status ─────────────────────────────────────────────────────
      case "get_git_status": {
        const res = getGitStatus(workspace);
        if (!res.ok) return err(res.error ?? "Unknown error");
        return ok(res.output || "(clean)");
      }

      // ── get_git_diff ───────────────────────────────────────────────────────
      case "get_git_diff": {
        const staged = args.staged === true;
        const res    = getGitDiff(workspace, staged);
        if (!res.ok) return err(res.error ?? "Unknown error");
        return ok(res.output || "(no diff)");
      }

      // ── run_tests ──────────────────────────────────────────────────────────
      case "run_tests": {
        const suite = String(args.suite ?? "npm-test");
        const res   = runWorkspaceTests(workspace, suite);
        if (res.status === "NEEDS_APPROVAL") {
          return err(
            `Suite "${res.requestedSuite}" requires approval. ` +
            `Approved suites: ${res.approvedSuites?.join(", ")}`
          );
        }
        const out  = res.stdout.trim() || "(no stdout)";
        const serr = res.stderr.trim() ? `\nStderr:\n${res.stderr}` : "";
        return ok(`[${res.status}] exit=${res.exitCode} ${res.durationMs}ms\n${out}${serr}`);
      }

      // ── route_task ─────────────────────────────────────────────────────────
      case "route_task": {
        const taskId      = String(args.taskId ?? `mcp-${Date.now()}`);
        const description = String(args.description ?? "");
        if (!description) return err("description is required");

        const kind          = (args.kind as TaskKind) ?? "UNKNOWN";
        const workspaceRoot = workspace.getRoot() ?? undefined;

        const task: IncomingTask = {
          id:          taskId,
          description,
          kind,
          args:        (args.taskArgs as Record<string, string>) ?? {},
          originatingAgent: String(args.originatingAgent ?? "mcp-client"),
          workspaceRoot,
          context: {
            filesInvolved: Array.isArray(args.filesInvolved)
              ? (args.filesInvolved as string[]) : undefined,
            errorMessage:  args.errorMessage ? String(args.errorMessage) : undefined,
            codeSnippet:   args.codeSnippet   ? String(args.codeSnippet)  : undefined,
          },
        };

        const record = await routeTask(task, 0);

        return ok(JSON.stringify({
          taskId:          record.taskId,
          route:           record.route,
          status:          record.status,
          executorName:    record.executorName,
          classifierSource: record.classifierSource,
          confidence:      record.confidence,
          decisionPath:    record.decisionPath,
          durationMs:      record.durationMs,
          output:          record.output,
          delegation:      record.delegation,
          error:           record.error,
        }, null, 2));
      }

      // ── get_execution_report ───────────────────────────────────────────────
      case "get_execution_report": {
        const report = executionLog.generateReport();
        return ok(JSON.stringify(report, null, 2));
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(msg);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is reserved for MCP protocol messages
  process.stderr.write("[ai-execution-router MCP] Server started on STDIO\n");
}

main().catch((err) => {
  process.stderr.write(`[ai-execution-router MCP] Fatal: ${err}\n`);
  process.exit(1);
});
