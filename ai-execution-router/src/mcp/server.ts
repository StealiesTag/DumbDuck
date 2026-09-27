// ─────────────────────────────────────────────────────────────────────────────
// MCP Server — DumbDuck  (v0.5)
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
// v0.5 additions:
//   - Per-call stderr diagnostics via src/mcp/diagnostics.ts
//   - record_baseline tool — stores a baseline measurement
//   - get_savings_report tool — computes and returns a savings comparison
//   - All stderr output uses mcpDiag — stdout is never touched by diagnostics
//
// LIMITATION: The MCP server manages a SINGLE workspace per process.
// Multiple concurrent clients sharing one server will share the workspace.
//
// LIMITATION: Bob's host-model token usage is NOT accessible from the MCP
// server. All token reporting here covers the router's own provider calls only.
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
import { mcpDiag }             from "./diagnostics";
import { IncomingTask, TaskKind, BaselineRecord, MeasuredUsage } from "../types";
import { TOOL_SCHEMAS }        from "./tools";
import { PRODUCT_NAME }        from "../branding";

// ── Server instance ───────────────────────────────────────────────────────────

const server = new Server(
  { name: PRODUCT_NAME, version: "0.5.0" },
  { capabilities: { tools: {} } }
);

// ── Tool listing ──────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_SCHEMAS,
}));

// ── Tool dispatch ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const execId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // Start diagnostic — writes to stderr, never stdout
  mcpDiag.start(execId, name, args as Record<string, unknown>);

  try {
    let result: ReturnType<typeof ok | typeof err>;

    switch (name) {
      // ── set_workspace ────────────────────────────────────────────────────────
      case "set_workspace": {
        const rootPath = String(args.path ?? "");
        if (!rootPath) { result = err("path is required"); break; }
        workspace.setWorkspace(rootPath);
        result = ok(`Workspace set to: ${workspace.getRoot()}`);
        break;
      }

      // ── list_files ───────────────────────────────────────────────────────────
      case "list_files": {
        const dir = String(args.directory ?? ".");
        const res = listFiles(workspace, dir);
        if (!res.ok) { result = err(res.error ?? "Unknown error"); break; }
        const trunc = res.truncated ? `\n(truncated at ${res.count} entries)` : "";
        result = ok(`${res.count} entries in "${dir}":\n${res.entries.join("\n")}${trunc}`);
        break;
      }

      // ── read_file ────────────────────────────────────────────────────────────
      case "read_file": {
        const filePath = String(args.path ?? "");
        if (!filePath) { result = err("path is required"); break; }
        const res = readWorkspaceFile(workspace, filePath);
        if (!res.ok) { result = err(res.error ?? "Unknown error"); break; }
        const trunc = res.truncated ? `\n(file truncated at 512 KB)` : "";
        result = ok(`${res.content}${trunc}`);
        break;
      }

      // ── search_repository ────────────────────────────────────────────────────
      case "search_repository": {
        const pattern = String(args.pattern ?? "");
        if (!pattern) { result = err("pattern is required"); break; }
        const subDir = String(args.directory ?? ".");
        const res    = searchRepository(workspace, pattern, subDir);
        if (!res.ok) { result = err(res.error ?? "Unknown error"); break; }
        if (res.matches.length === 0) { result = ok(`No matches for "${pattern}"`); break; }
        const lines  = res.matches
          .map((m) => `${m.file}:${m.line}: ${m.content}`)
          .join("\n");
        const trunc  = res.truncated ? `\n(results truncated at ${res.totalMatches})` : "";
        result = ok(`${res.totalMatches} match(es) for "${pattern}":\n${lines}${trunc}`);
        break;
      }

      // ── get_git_status ───────────────────────────────────────────────────────
      case "get_git_status": {
        const res = getGitStatus(workspace);
        if (!res.ok) { result = err(res.error ?? "Unknown error"); break; }
        result = ok(res.output || "(clean)");
        break;
      }

      // ── get_git_diff ─────────────────────────────────────────────────────────
      case "get_git_diff": {
        const staged = args.staged === true;
        const res    = getGitDiff(workspace, staged);
        if (!res.ok) { result = err(res.error ?? "Unknown error"); break; }
        result = ok(res.output || "(no diff)");
        break;
      }

      // ── run_tests ────────────────────────────────────────────────────────────
      case "run_tests": {
        const suite = String(args.suite ?? "npm-test");
        const res   = runWorkspaceTests(workspace, suite);
        if (res.status === "NEEDS_APPROVAL") {
          result = err(
            `Suite "${res.requestedSuite}" requires approval. ` +
            `Approved suites: ${res.approvedSuites?.join(", ")}`
          );
          break;
        }
        const out  = res.stdout.trim() || "(no stdout)";
        const serr = res.stderr.trim() ? `\nStderr:\n${res.stderr}` : "";
        result = ok(`[${res.status}] exit=${res.exitCode} ${res.durationMs}ms\n${out}${serr}`);
        break;
      }

      // ── route_task ───────────────────────────────────────────────────────────
      case "route_task": {
        const taskId      = String(args.taskId ?? `mcp-${Date.now()}`);
        const description = String(args.description ?? "");
        if (!description) { result = err("description is required"); break; }

        const kind          = (args.kind as TaskKind) ?? "UNKNOWN";
        const workspaceRoot = workspace.getRoot() ?? undefined;

        const task: IncomingTask = {
          id:          taskId,
          description,
          kind,
          args:        (args.taskArgs as IncomingTask["args"]) ?? {},
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

        // Report token usage in the completion diagnostic
        mcpDiag.complete(execId, {
          route:      record.route,
          providerId: record.providerId,
          modelId:    record.modelId,
          status:     record.status,
          durationMs: record.durationMs,
          tokenUsage: record.tokenUsage ?? null,
          isMock:     record.executorName === "simple-ai-mock",
        });

        return ok(JSON.stringify({
          taskId:           record.taskId,
          route:            record.route,
          status:           record.status,
          executorName:     record.executorName,
          providerId:       record.providerId,
          modelId:          record.modelId,
          classifierSource: record.classifierSource,
          confidence:       record.confidence,
          decisionPath:     record.decisionPath,
          durationMs:       record.durationMs,
          output:           record.output,
          delegation:       record.delegation,
          error:            record.error,
          tokenUsage:       record.tokenUsage ?? null,
          tokenCoverage:    record.tokenUsage
            ? "PARTIAL — router provider call only; host model usage unavailable"
            : "UNAVAILABLE",
          tokenSource:     record.tokenUsage ? "PROVIDER_REPORTED" : "UNAVAILABLE",
        }, null, 2));
      }

      // ── get_execution_report ─────────────────────────────────────────────────
      case "get_execution_report": {
        const report = executionLog.generateReport();
        result = ok(JSON.stringify(report, null, 2));
        break;
      }

      // ── record_baseline ──────────────────────────────────────────────────────
      case "record_baseline": {
        const id          = String(args.id ?? `baseline-${Date.now()}`);
        const description = String(args.description ?? "");
        if (!description) { result = err("description is required"); break; }

        const totalTokens  = args.totalTokens;
        const promptTokens = args.promptTokens;
        const completionTokens = args.completionTokens;

        const hasRealData = typeof totalTokens === "number" && totalTokens > 0;

        const usage: MeasuredUsage = {
          promptTokens:     typeof promptTokens     === "number" ? promptTokens     : "UNAVAILABLE",
          completionTokens: typeof completionTokens === "number" ? completionTokens : "UNAVAILABLE",
          totalTokens:      typeof totalTokens      === "number" ? totalTokens      : "UNAVAILABLE",
          source:           String(args.source ?? (hasRealData ? "HOST_REPORTED" : "UNAVAILABLE")) as MeasuredUsage["source"],
          providerId:       args.providerId ? String(args.providerId) : undefined,
          executionId:      args.executionId ? String(args.executionId) : undefined,
          recordedAt:       new Date().toISOString(),
        };

        const baseline: BaselineRecord = {
          id,
          description,
          recordedAt:  new Date().toISOString(),
          recordedBy:  String(args.recordedBy ?? "mcp-client"),
          usage,
          notes:       args.notes ? String(args.notes) : undefined,
        };

        executionLog.recordBaseline(baseline);

        result = ok(JSON.stringify({
          baselineId:  id,
          description,
          recorded:    true,
          usage,
          note:        hasRealData
            ? "Baseline recorded with real token data. Use get_savings_report to compare."
            : "Baseline recorded but total_tokens is missing or zero. " +
              "Savings cannot be calculated without a real baseline token count.",
        }, null, 2));
        break;
      }

      // ── get_savings_report ───────────────────────────────────────────────────
      case "get_savings_report": {
        const baselineId   = String(args.baselineId ?? "");
        const routedTaskId = String(args.routedTaskId ?? "");

        if (!baselineId)   { result = err("baselineId is required");   break; }
        if (!routedTaskId) { result = err("routedTaskId is required"); break; }

        const comparison = executionLog.calculateSavings(baselineId, routedTaskId);

        result = ok(JSON.stringify({
          ...comparison,
          interpreting: comparison.measurementType === "NOT_CALCULABLE"
            ? "Savings cannot be calculated with the available data. See caveats."
            : comparison.measurementType === "PARTIAL"
            ? "PARTIAL measurement only. Do NOT interpret as end-to-end savings. " +
              "Host model (Bob) usage is not included."
            : "END_TO_END measurement. Both baseline and routed cover the full workflow.",
        }, null, 2));
        break;
      }

      default:
        result = err(`Unknown tool: ${name}`);
    }

    // Complete diagnostic for all non-route_task tools
    // (route_task calls mcpDiag.complete itself to include token info)
    if (name !== "route_task") {
      mcpDiag.complete(execId, {
        status: result.isError ? "FAILED" : "SUCCEEDED",
      });
    }

    return result;

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    mcpDiag.fail(execId, e);
    return err(msg);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text" as const, text }] };
}

function err(message: string): { content: { type: "text"; text: string }[]; isError: true } {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Startup message to stderr only — never stdout
  process.stderr.write(
    `[${PRODUCT_NAME} MCP v0.5] Server started on STDIO\n` +
    `[${PRODUCT_NAME} MCP v0.5] Diagnostics: stderr${process.env.EXECUTION_LOG_PATH ? ` + ${process.env.EXECUTION_LOG_PATH}` : ""}\n` +
    `[${PRODUCT_NAME} MCP v0.5] Set MCP_DIAGNOSTICS=0 to suppress stderr output\n`
  );
}

main().catch((e) => {
  process.stderr.write(`[${PRODUCT_NAME} MCP] Fatal: ${e}\n`);
  process.exit(1);
});
