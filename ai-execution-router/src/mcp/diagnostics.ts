// ─────────────────────────────────────────────────────────────────────────────
// MCP Diagnostics
//
// Human-readable per-call reports written to STDERR only.
// stdout is reserved exclusively for MCP JSON-RPC protocol messages.
//
// Usage:
//   import { mcpDiag } from "./diagnostics";
//   mcpDiag.start(execId, toolName, inputArgs);
//   ...
//   mcpDiag.complete(execId, { route, status, durationMs, tokenUsage });
//   mcpDiag.fail(execId, error);
//
// Optional JSONL persistence:
//   Set EXECUTION_LOG_PATH to a file path in the MCP server's environment.
//   The executionLog module writes all records to that file.
//   The diagnostics module writes its own structured events to the same file
//   if the log path is configured, so you get a unified timeline.
//
// MCP STDIO protocol safety:
//   ALL output here uses process.stderr.write — never console.log or stdout.
//   This module never touches stdout.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from "fs";
import * as path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Secret redaction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keys whose values must always be redacted.
 * Case-insensitive matching against argument key names.
 */
const REDACTED_KEYS = new Set([
  "api_key", "apikey", "api-key",
  "openai_api_key", "openaikey",
  "password", "passwd", "secret",
  "token", "access_token", "auth_token", "bearer",
  "authorization", "credential", "credentials",
  "private_key", "privatekey",
]);

const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * Remove secret values from an argument object before logging.
 * Returns a new object — never mutates the input.
 */
export function redactSecrets(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const normalised = k.toLowerCase().replace(/[-_\s]/g, "_");
    if (REDACTED_KEYS.has(normalised)) {
      out[k] = REDACTED_PLACEHOLDER;
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactSecrets(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic event types
// ─────────────────────────────────────────────────────────────────────────────

export type DiagEventType = "TOOL_STARTED" | "TOOL_COMPLETED" | "TOOL_FAILED";

export interface DiagEvent {
  type:        DiagEventType;
  execId:      string;
  toolName:    string;
  timestamp:   string;   // ISO 8601
  /** Redacted input summary — safe to write to logs */
  inputSummary?: string;
  route?:       string;
  providerId?:  string;
  modelId?:     string;
  status?:      string;
  durationMs?:  number;
  promptTokens?:    number | "unavailable";
  completionTokens?: number | "unavailable";
  totalTokens?:     number | "unavailable";
  tokenSource?:     string;
  error?:           string;
}

export interface CompleteOptions {
  route?:       string;
  providerId?:  string;
  modelId?:     string;
  status?:      string;
  durationMs?:  number;
  tokenUsage?:  { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  isMock?:      boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-flight request tracker
// ─────────────────────────────────────────────────────────────────────────────

interface PendingCall {
  toolName:    string;
  startedAt:   string;
  startMs:     number;
  inputSummary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics class
// ─────────────────────────────────────────────────────────────────────────────

class MCPDiagnostics {
  private _pending = new Map<string, PendingCall>();
  private _logPath: string | null = null;
  private _enabled: boolean;

  constructor() {
    const envPath = process.env.EXECUTION_LOG_PATH;
    this._logPath = envPath ? path.resolve(envPath) : null;
    // Diagnostics are enabled by default unless explicitly disabled.
    this._enabled = process.env.MCP_DIAGNOSTICS !== "0";
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Call when a tool invocation begins.
   * Writes "started" line to stderr and emits a TOOL_STARTED JSONL event.
   */
  start(execId: string, toolName: string, args: Record<string, unknown>): void {
    const redacted     = redactSecrets(args);
    const inputSummary = this._summariseInput(toolName, redacted);
    const startedAt    = new Date().toISOString();

    this._pending.set(execId, {
      toolName,
      startedAt,
      startMs:     Date.now(),
      inputSummary,
    });

    if (!this._enabled) return;

    const event: DiagEvent = {
      type:         "TOOL_STARTED",
      execId,
      toolName,
      timestamp:    startedAt,
      inputSummary,
    };

    this._writeStderr(this._formatStarted(event));
    this._persistEvent(event);
  }

  /**
   * Call when a tool invocation completes successfully.
   * Writes a full formatted report to stderr.
   */
  complete(execId: string, opts: CompleteOptions): void {
    const pending = this._pending.get(execId);
    this._pending.delete(execId);

    const timestamp  = new Date().toISOString();
    const durationMs = opts.durationMs ??
      (pending ? Date.now() - pending.startMs : 0);

    let promptTok:     number | "unavailable" = "unavailable";
    let completionTok: number | "unavailable" = "unavailable";
    let totalTok:      number | "unavailable" = "unavailable";
    let tokenSource = "unavailable";

    if (opts.isMock) {
      tokenSource = "MOCK — no AI call made";
    } else if (opts.tokenUsage) {
      promptTok     = opts.tokenUsage.promptTokens;
      completionTok = opts.tokenUsage.completionTokens;
      totalTok      = opts.tokenUsage.totalTokens;
      tokenSource   = "PROVIDER_REPORTED";
    }

    const event: DiagEvent = {
      type:             "TOOL_COMPLETED",
      execId,
      toolName:         pending?.toolName ?? "unknown",
      timestamp,
      inputSummary:     pending?.inputSummary,
      route:            opts.route,
      providerId:       opts.providerId,
      modelId:          opts.modelId,
      status:           opts.status,
      durationMs,
      promptTokens:     promptTok,
      completionTokens: completionTok,
      totalTokens:      totalTok,
      tokenSource,
    };

    if (!this._enabled) {
      this._persistEvent(event);
      return;
    }

    this._writeStderr(this._formatCompleted(event));
    this._persistEvent(event);
  }

  /**
   * Call when a tool invocation fails.
   * Writes error details to stderr.
   */
  fail(execId: string, error: unknown): void {
    const pending   = this._pending.get(execId);
    this._pending.delete(execId);

    const timestamp  = new Date().toISOString();
    const durationMs = pending ? Date.now() - pending.startMs : 0;
    const errorMsg   = error instanceof Error ? error.message : String(error);

    const event: DiagEvent = {
      type:        "TOOL_FAILED",
      execId,
      toolName:    pending?.toolName ?? "unknown",
      timestamp,
      inputSummary: pending?.inputSummary,
      durationMs,
      status:      "FAILED",
      error:       errorMsg,
    };

    if (!this._enabled) {
      this._persistEvent(event);
      return;
    }

    this._writeStderr(this._formatFailed(event));
    this._persistEvent(event);
  }

  // ── Formatters ───────────────────────────────────────────────────────────────

  private _formatStarted(e: DiagEvent): string {
    return (
      `[AI Execution Router]\n` +
      `Time:         ${e.timestamp}\n` +
      `Execution ID: ${e.execId}\n` +
      `Tool:         ${e.toolName}\n` +
      `Input:        ${e.inputSummary ?? "(none)"}\n` +
      `Status:       started\n` +
      `${"─".repeat(32)}\n`
    );
  }

  private _formatCompleted(e: DiagEvent): string {
    const tok = (v: number | "unavailable"): string =>
      typeof v === "number" ? String(v) : "unavailable";

    return (
      `[AI Execution Router]\n` +
      `Time:         ${e.timestamp}\n` +
      `Execution ID: ${e.execId}\n` +
      `Tool:         ${e.toolName}\n` +
      `Input:        ${e.inputSummary ?? "(none)"}\n` +
      `Route:        ${e.route ?? "n/a"}\n` +
      `Provider:     ${e.providerId ?? "n/a"}\n` +
      `Model:        ${e.modelId ?? "n/a"}\n` +
      `Status:       ${e.status ?? "completed"}\n` +
      `Duration:     ${e.durationMs ?? 0} ms\n` +
      `Input tokens: ${tok(e.promptTokens ?? "unavailable")}\n` +
      `Output tokens:${tok(e.completionTokens ?? "unavailable")}\n` +
      `Total tokens: ${tok(e.totalTokens ?? "unavailable")}\n` +
      `Token source: ${e.tokenSource ?? "unavailable"}\n` +
      `Cost:         unavailable — no pricing data\n` +
      `${"─".repeat(32)}\n`
    );
  }

  private _formatFailed(e: DiagEvent): string {
    return (
      `[AI Execution Router]\n` +
      `Time:         ${e.timestamp}\n` +
      `Execution ID: ${e.execId}\n` +
      `Tool:         ${e.toolName}\n` +
      `Input:        ${e.inputSummary ?? "(none)"}\n` +
      `Status:       FAILED\n` +
      `Duration:     ${e.durationMs ?? 0} ms\n` +
      `Error:        ${e.error ?? "unknown"}\n` +
      `${"─".repeat(32)}\n`
    );
  }

  // ── Input summariser ─────────────────────────────────────────────────────────

  private _summariseInput(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case "set_workspace":
        return `path=${args.path ?? "(none)"}`;
      case "list_files":
        return `directory=${args.directory ?? "."}`;
      case "read_file":
        return `path=${args.path ?? "(none)"}`;
      case "search_repository":
        return `pattern="${args.pattern ?? ""}" dir=${args.directory ?? "."}`;
      case "get_git_status":
        return "(no args)";
      case "get_git_diff":
        return `staged=${args.staged ?? false}`;
      case "run_tests":
        return `suite=${args.suite ?? "npm-test"}`;
      case "route_task": {
        const desc   = String(args.description ?? "").slice(0, 80);
        const kind   = args.kind ?? "UNKNOWN";
        const agent  = args.originatingAgent ?? "unknown";
        return `kind=${kind} agent=${agent} desc="${desc}${desc.length >= 80 ? "…" : ""}"`;
      }
      case "get_execution_report":
        return "(no args)";
      default:
        return Object.keys(args).slice(0, 4).join(", ") || "(no args)";
    }
  }

  // ── Stderr writer ────────────────────────────────────────────────────────────

  /** Write to stderr only — never stdout. */
  private _writeStderr(text: string): void {
    try {
      process.stderr.write(text);
    } catch {
      // If stderr is broken, fail silently — never affect the MCP protocol
    }
  }

  // ── JSONL persistence ────────────────────────────────────────────────────────

  private _persistEvent(event: DiagEvent): void {
    if (!this._logPath) return;
    try {
      const dir = path.dirname(this._logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const line = JSON.stringify(event) + "\n";
      fs.appendFileSync(this._logPath, line, "utf-8");
    } catch {
      // Never crash the MCP server due to a logging error
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
export const mcpDiag = new MCPDiagnostics();

// Named class export for tests that need to instantiate isolated instances
export { MCPDiagnostics };
