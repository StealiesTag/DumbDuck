// ─────────────────────────────────────────────────────────────────────────────
// Executor: Simple AI
//
// Sends SIMPLE_AI tasks to a configured lightweight language model.
//
// Provider abstraction
// ────────────────────
// The provider is selected by SIMPLE_AI_PROVIDER, then router.config.json:
//   "openai"    — uses the OpenAI chat completions API
//   "gemini"    — uses Google's Gemini API through @google/genai
//   "mock"      — returns a clearly labelled stub when explicitly selected
//
// Configuration via environment variables (never hardcoded):
//   SIMPLE_AI_PROVIDER   — "openai" | "gemini" | "mock" (default: configured provider or "gemini")
//   OPENAI_API_KEY       — required when provider = "openai" (SIMPLE_AI_KEY is also accepted)
//   GEMINI_API_KEY       — required when provider = "gemini"
//   SIMPLE_AI_MODEL      — model id (default: "gemini-2.5-flash" for Gemini)
//   GEMINI_MODEL         — optional Gemini-specific model override
//   SIMPLE_AI_TIMEOUT_MS — request timeout in ms (default: 30000)
//
// Mock mode
// ─────────
// Mock mode is available only when explicitly selected. Missing credentials
// for a real provider return an error; they never silently switch to mock.
//
// Adding a new provider
// ─────────────────────
// 1. Add it to PROVIDERS below.
// 2. It must implement the SimpleAIProvider interface.
// 3. Nothing else changes — the executor, router, and MCP layer are unaffected.
// ─────────────────────────────────────────────────────────────────────────────

import { IncomingTask, ExecutionResult, TokenUsage, TaskStatus } from "../types";
import type { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import * as path from "path";
import { config as loadDotEnv } from "dotenv";
import { loadConfig } from "../setup/config";

loadDotEnv({ path: path.resolve(__dirname, "../../.env"), quiet: true });

// ── Provider interface ────────────────────────────────────────────────────────

export interface SimpleAIProvider {
  name:  string;
  call(prompt: string, modelId: string, timeoutMs: number): Promise<ProviderResponse>;
}

interface ProviderResponse {
  output:     string;
  modelId:    string;
  providerId: string;
  tokenUsage?: TokenUsage;
  isMock:     boolean;
}

// ── Mock provider ─────────────────────────────────────────────────────────────

const MockProvider: SimpleAIProvider = {
  name: "mock",
  async call(prompt, modelId) {
    return {
      output:  `[MOCK — no AI call made] Prompt received (${prompt.length} chars). ` +
               `Configure SIMPLE_AI_PROVIDER and its provider API key to use a real model.`,
      modelId: "mock",
      providerId: "mock",
      isMock:  true,
    };
  },
};

// ── OpenAI provider ───────────────────────────────────────────────────────────
// Only imported if SIMPLE_AI_PROVIDER=openai. The SDK is loaded dynamically
// so the module stays loadable even when the SDK is not installed.

const OpenAIProvider: SimpleAIProvider = {
  name: "openai",
  async call(prompt, modelId, timeoutMs) {
    const apiKey = process.env.OPENAI_API_KEY || process.env.SIMPLE_AI_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY or SIMPLE_AI_KEY environment variable is not set.");
    }

    let OpenAI: typeof import("openai").default;
    try {
      // Dynamic import — only works if 'openai' npm package is installed
      const mod = await import("openai");
      OpenAI = mod.default;
    } catch {
      throw new Error(
        "Package 'openai' is not installed. Run: npm install openai"
      );
    }

    const client = new OpenAI({ apiKey, timeout: timeoutMs });
    const resp   = await client.chat.completions.create({
      model:    modelId,
      messages: [{ role: "user", content: prompt }],
    });

    const content    = resp.choices[0]?.message?.content ?? "";
    const usage      = resp.usage;
    const tokenUsage: TokenUsage | undefined = usage
      ? {
          promptTokens:     usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens:      usage.total_tokens,
        }
      : undefined;

    return {
      output:     content,
      modelId:    resp.model,
      providerId: "openai",
      tokenUsage,
      isMock:     false,
    };
  },
};

type GeminiClient = Pick<GoogleGenAI, "models">;
type GeminiClientFactory = (apiKey: string, timeoutMs: number) => Promise<GeminiClient> | GeminiClient;

interface GeminiResponseLike {
  text?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

function readGeminiUsage(response: GeminiResponseLike): TokenUsage | undefined {
  const usage = response.usageMetadata;
  if (!usage) return undefined;
  const values = [usage.promptTokenCount, usage.candidatesTokenCount, usage.totalTokenCount];
  if (!values.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
    return undefined;
  }
  return {
    promptTokens: usage.promptTokenCount!,
    completionTokens: usage.candidatesTokenCount!,
    totalTokens: usage.totalTokenCount!,
  };
}

export function createGeminiProvider(createClient: GeminiClientFactory): SimpleAIProvider {
  return {
    name: "gemini",
    async call(prompt, modelId, timeoutMs) {
      const apiKey = process.env.GEMINI_API_KEY || process.env.SIMPLE_AI_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is not set.");

      const client = await createClient(apiKey, timeoutMs);
      const response: GenerateContentResponse | GeminiResponseLike = await client.models.generateContent({
        model: modelId,
        contents: prompt,
      });
      if (typeof response.text !== "string" || response.text.length === 0) {
        throw new Error("Gemini returned no text content.");
      }
      return {
        output: response.text,
        modelId,
        providerId: "gemini",
        tokenUsage: readGeminiUsage(response),
        isMock: false,
      };
    },
  };
}

const GeminiProvider = createGeminiProvider(async (apiKey, timeoutMs) => {
  try {
    const { GoogleGenAI } = await import("@google/genai");
    return new GoogleGenAI({ apiKey, httpOptions: { timeout: timeoutMs } });
  } catch (cause) {
    throw new Error("Gemini SDK could not be loaded.", { cause });
  }
});

// ── Provider registry ─────────────────────────────────────────────────────────

const PROVIDERS: Record<string, SimpleAIProvider> = {
  mock:   MockProvider,
  openai: OpenAIProvider,
  gemini: GeminiProvider,
};

function getConfiguredProviderName(): string {
  return (process.env.SIMPLE_AI_PROVIDER ?? loadConfig().simpleAiProvider ?? "gemini").toLowerCase();
}

function getProvider(): SimpleAIProvider {
  const name = getConfiguredProviderName();
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unsupported SIMPLE_AI_PROVIDER "${name}".`);
  return provider;
}

function getModelId(providerName: string): string {
  if (providerName === "gemini") return process.env.GEMINI_MODEL ?? process.env.SIMPLE_AI_MODEL ?? "gemini-2.5-flash";
  if (providerName === "openai") return process.env.SIMPLE_AI_MODEL ?? "gpt-4o-mini";
  return "mock";
}

export type ProviderErrorCategory =
  | "authentication"
  | "quota/rate limit"
  | "model/access"
  | "network/timeout"
  | "unknown";

export interface SafeProviderErrorDiagnostic {
  category: ProviderErrorCategory;
  httpStatus?: number;
  providerCode?: string;
  message?: string;
}

type ErrorRecord = Record<string, unknown>;

function collectErrorRecords(error: unknown): ErrorRecord[] {
  const records: ErrorRecord[] = [];
  const pending: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const seen = new Set<object>();
  const nestedFields = ["cause", "error", "response", "data", "details"] as const;

  while (pending.length > 0 && records.length < 12) {
    const current = pending.shift()!;
    if (current.depth > 4 || current.value === null || typeof current.value !== "object") continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    records.push(current.value as ErrorRecord);

    for (const field of nestedFields) {
      let nested: unknown;
      try { nested = (current.value as ErrorRecord)[field]; } catch { continue; }
      const values = Array.isArray(nested) ? nested.slice(0, 3) : [nested];
      for (const value of values) {
        if (value !== null && typeof value === "object") {
          pending.push({ value, depth: current.depth + 1 });
        }
      }
    }
  }

  return records;
}

function readHttpStatus(records: ErrorRecord[]): number | undefined {
  for (const record of records) {
    for (const field of ["status", "statusCode", "httpStatus"] as const) {
      const value = record[field];
      const status = typeof value === "number" ? value
        : typeof value === "string" && /^\d{3}$/.test(value) ? Number(value)
        : undefined;
      if (status !== undefined && status >= 100 && status <= 599) return status;
    }
  }
  return undefined;
}

function readProviderCode(records: ErrorRecord[]): string | undefined {
  for (const record of records) {
    for (const field of ["code", "reason", "status"] as const) {
      const value = record[field];
      if (typeof value === "string" && !/^\d{3}$/.test(value) && value.length <= 120) {
        return value;
      }
    }
  }
  return undefined;
}

function sanitizeDiagnosticMessage(message: string): string | undefined {
  let safe = message;

  for (const secret of [
    process.env.GEMINI_API_KEY,
    process.env.SIMPLE_AI_KEY,
    process.env.OPENAI_API_KEY,
  ]) {
    if (secret) safe = safe.split(secret).join("[REDACTED]");
  }

  safe = safe
    .replace(/\b((?:proxy-)?authorization)\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;]+/gi, "$1: [REDACTED]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "[REDACTED_AUTH]")
    .replace(/\b(x-goog-api-key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token)\s*[:=]\s*["']?[^\s,"';]+["']?/gi, "$1=[REDACTED]")
    .replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z._-]{16,}|sk-(?:proj-)?[0-9A-Za-z_-]{16,})\b/g, "[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL REDACTED]")
    .replace(/\b(?:prompt|contents|codeSnippet|request body)\s*[:=].*$/i, "[request data redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!safe) return undefined;
  return safe.slice(0, 300);
}

export function getSafeProviderErrorDiagnostic(error: unknown): SafeProviderErrorDiagnostic {
  const records = collectErrorRecords(error);
  const httpStatus = readHttpStatus(records);
  const providerCode = readProviderCode(records);
  const code = (providerCode ?? "").toUpperCase();
  const name = records.map((record) => record.name).find((value) => typeof value === "string") as string | undefined;
  const rawMessage = records
    .map((record) => record.message)
    .find((value) => typeof value === "string" && value.length > 0) as string | undefined;
  const message = rawMessage ? sanitizeDiagnosticMessage(rawMessage) : undefined;
  const signals = `${code} ${message ?? ""} ${name ?? ""}`.toUpperCase();

  let category: ProviderErrorCategory = "unknown";
  if (
    httpStatus === 401 ||
    code === "API_KEY_INVALID" ||
    code === "UNAUTHENTICATED" ||
    /API KEY.{0,40}(INVALID|NOT VALID|UNAUTHENTICATED|MISSING)|(?:INVALID|UNAUTHENTICATED).{0,40}API KEY|AUTHENTICATION FAILED/.test(signals)
  ) {
    category = "authentication";
  } else if (
    httpStatus === 429 ||
    code === "RESOURCE_EXHAUSTED" ||
    /QUOTA|RATE.?LIMIT|RESOURCE_EXHAUSTED/.test(signals)
  ) {
    category = "quota/rate limit";
  } else if (
    [502, 503, 504].includes(httpStatus ?? 0) ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code) ||
    ["ABORTERROR", "TIMEOUTERROR"].includes(String(name).toUpperCase()) ||
    /NETWORK REQUEST FAILED|REQUEST TIMED OUT|TIMEOUT|CONNECTION RESET/.test(signals)
  ) {
    category = "network/timeout";
  } else if (
    httpStatus === 404 ||
    code === "NOT_FOUND" ||
    code === "FAILED_PRECONDITION" ||
    code === "PERMISSION_DENIED" ||
    /MODEL.{0,60}(NOT FOUND|NOT AVAILABLE|UNAVAILABLE|UNSUPPORTED|ACCESS|PERMISSION)|PERMISSION_DENIED/.test(signals)
  ) {
    category = "model/access";
  }

  return { category, httpStatus, providerCode: providerCode ? sanitizeDiagnosticMessage(providerCode) : undefined, message };
}

export function describeProviderError(error: unknown, providerName: string): string {
  const diagnostic = getSafeProviderErrorDiagnostic(error);
  if (diagnostic.message === "GEMINI_API_KEY environment variable is not set.") {
    return "category=authentication; GEMINI_API_KEY or SIMPLE_AI_KEY environment variable is not set.";
  }
  if (diagnostic.message === "OPENAI_API_KEY or SIMPLE_AI_KEY environment variable is not set.") {
    return "category=authentication; OPENAI_API_KEY or SIMPLE_AI_KEY environment variable is not set.";
  }
  if (diagnostic.message === "Gemini returned no text content.") {
    return "category=unknown; Gemini returned no text content.";
  }

  const details = [`category=${diagnostic.category}`];
  if (diagnostic.httpStatus !== undefined) details.push(`httpStatus=${diagnostic.httpStatus}`);
  if (diagnostic.providerCode) details.push(`providerCode=${diagnostic.providerCode}`);
  const safeMessage = diagnostic.message ?? "No safe provider details available.";
  return `${providerName} request failed [${details.join(", ")}]: ${safeMessage}`;
}

export interface SimpleAIProviderStatus {
  provider: string;
  model: string;
  apiKeyPresent: boolean;
  supported: boolean;
}

export function getSimpleAIProviderStatus(providerOverride?: string): SimpleAIProviderStatus {
  const provider = (providerOverride ?? getConfiguredProviderName()).toLowerCase();
  const apiKeyPresent = provider === "openai" ? Boolean(process.env.OPENAI_API_KEY || process.env.SIMPLE_AI_KEY)
    : provider === "gemini" ? Boolean(process.env.GEMINI_API_KEY || process.env.SIMPLE_AI_KEY)
    : false;
  return {
    provider,
    model: getModelId(provider),
    apiKeyPresent,
    supported: Object.prototype.hasOwnProperty.call(PROVIDERS, provider),
  };
}

function getTimeoutMs(): number {
  const raw = parseInt(process.env.SIMPLE_AI_TIMEOUT_MS ?? "30000", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

// ── Build prompt from task ────────────────────────────────────────────────────

function buildPrompt(task: IncomingTask): string {
  const parts: string[] = [`Task: ${task.description}`];

  if (task.context?.errorMessage) {
    parts.push(`\nError message:\n${task.context.errorMessage}`);
  }
  if (task.context?.codeSnippet) {
    parts.push(`\nCode snippet:\n${task.context.codeSnippet}`);
  }
  if (task.context?.filesInvolved?.length) {
    parts.push(`\nRelevant files: ${task.context.filesInvolved.join(", ")}`);
  }

  return parts.join("\n");
}

// ── Extended result ────────────────────────────────────────────────────────────

export interface SimpleAIResult extends ExecutionResult {
  status:      TaskStatus;
  modelId?:    string;
  tokenUsage?: TokenUsage;
  isMock:      boolean;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runSimpleAI(task: IncomingTask): Promise<SimpleAIResult> {
  const start     = Date.now();
  let provider: SimpleAIProvider | undefined;

  try {
    provider = getProvider();
    const modelId   = getModelId(provider.name);
    const timeoutMs = getTimeoutMs();
    const prompt    = buildPrompt(task);
    const resp = await provider.call(prompt, modelId, timeoutMs);

    return {
      taskId:     task.id,
      route:      "SIMPLE_AI",
      output:     resp.output,
      durationMs: Date.now() - start,
      status:     "SUCCEEDED",
      modelId:    resp.modelId,
      providerId: resp.providerId,
      tokenUsage: resp.tokenUsage,
      isMock:     resp.isMock,
    };
  } catch (err) {
    const providerName = provider?.name ?? getConfiguredProviderName();
    const message = provider
      ? describeProviderError(err, providerName)
      : (err instanceof Error ? err.message : String(err));
    return {
      taskId:     task.id,
      route:      "SIMPLE_AI",
      output:     `[Simple AI error] ${message}`,
      durationMs: Date.now() - start,
      status:     "FAILED",
      isMock:     provider?.name === "mock",
    };
  }
}
