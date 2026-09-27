// ─────────────────────────────────────────────────────────────────────────────
// Executor: Simple AI
//
// Sends SIMPLE_AI tasks to a configured lightweight language model.
//
// Provider abstraction
// ────────────────────
// The provider is selected by the SIMPLE_AI_PROVIDER env var:
//   "openai"    — uses the OpenAI chat completions API
//   "gemini"    — uses Google's Gemini API through @google/genai
//   "mock"      — returns a clearly labelled stub (default when no key is set)
//
// Configuration via environment variables (never hardcoded):
//   SIMPLE_AI_PROVIDER   — "openai" | "gemini" | "mock" (default: "mock")
//   OPENAI_API_KEY       — required when provider = "openai"
//   GEMINI_API_KEY       — required when provider = "gemini"
//   SIMPLE_AI_MODEL      — model id (default: "gpt-4o-mini" for OpenAI)
//   GEMINI_MODEL         — model id (default: "gemini-2.5-flash")
//   SIMPLE_AI_TIMEOUT_MS — request timeout in ms (default: 30000)
//
// Mock mode
// ─────────
// When no valid API key is available, or SIMPLE_AI_PROVIDER is not set,
// the executor runs in MOCK mode. Mock responses are clearly labelled
// "[MOCK — no AI call made]" so you can always tell the difference.
//
// Adding a new provider
// ─────────────────────
// 1. Add it to PROVIDERS below.
// 2. It must implement the SimpleAIProvider interface.
// 3. Nothing else changes — the executor, router, and MCP layer are unaffected.
// ─────────────────────────────────────────────────────────────────────────────

import { IncomingTask, ExecutionResult, TokenUsage, TaskStatus } from "../types";
import type { GoogleGenAI, GenerateContentResponse } from "@google/genai";

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
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is not set. " +
        "Set SIMPLE_AI_PROVIDER=mock to use mock mode."
      );
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
      const apiKey = process.env.GEMINI_API_KEY;
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
  } catch {
    throw new Error("Gemini SDK could not be loaded. Reinstall project dependencies.");
  }
});

// ── Provider registry ─────────────────────────────────────────────────────────

const PROVIDERS: Record<string, SimpleAIProvider> = {
  mock:   MockProvider,
  openai: OpenAIProvider,
  gemini: GeminiProvider,
};

function getProvider(): SimpleAIProvider {
  const name = (process.env.SIMPLE_AI_PROVIDER ?? "mock").toLowerCase();
  return PROVIDERS[name] ?? MockProvider;
}

function getModelId(providerName: string): string {
  if (providerName === "gemini") return process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  if (providerName === "openai") return process.env.SIMPLE_AI_MODEL ?? "gpt-4o-mini";
  return "mock";
}

export function describeProviderError(error: unknown, providerName: string): string {
  const failure = error as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown };
  const knownMessage = error instanceof Error ? error.message : "";
  const status = Number(failure?.status ?? failure?.statusCode);
  const code = typeof failure?.code === "string" ? failure.code.toUpperCase() : "";
  const name = typeof failure?.name === "string" ? failure.name : "";
  if (providerName === "gemini" && knownMessage === "GEMINI_API_KEY environment variable is not set.") {
    return "GEMINI_API_KEY environment variable is not set.";
  }
  if (providerName === "openai" && knownMessage === "OPENAI_API_KEY environment variable is not set. Set SIMPLE_AI_PROVIDER=mock to use mock mode.") {
    return "OPENAI_API_KEY environment variable is not set.";
  }
  if (knownMessage === "Gemini returned no text content.") return "Gemini returned a malformed response without text content.";
  const statusLabel = String(failure?.status ?? "").toUpperCase();
  if (status === 401 || status === 403 || ["PERMISSION_DENIED", "UNAUTHENTICATED"].includes(statusLabel) || ["PERMISSION_DENIED", "UNAUTHENTICATED", "API_KEY_INVALID"].includes(code)) {
    return `${providerName} authentication failed. Check the configured API key and access permissions.`;
  }
  if (status === 429 || statusLabel === "RESOURCE_EXHAUSTED" || code === "RESOURCE_EXHAUSTED" || code.includes("RATE_LIMIT")) {
    return `${providerName} quota or rate limit reached.`;
  }
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code) || name === "AbortError") {
    return `${providerName} network request failed or timed out.`;
  }
  return `${providerName} request failed; provider error details were omitted.`;
}

export interface SimpleAIProviderStatus {
  provider: string;
  model: string;
  apiKeyPresent: boolean;
  supported: boolean;
}

export function getSimpleAIProviderStatus(providerOverride?: string): SimpleAIProviderStatus {
  const provider = (providerOverride ?? process.env.SIMPLE_AI_PROVIDER ?? "mock").toLowerCase();
  const apiKeyPresent = provider === "openai" ? Boolean(process.env.OPENAI_API_KEY)
    : provider === "gemini" ? Boolean(process.env.GEMINI_API_KEY)
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
  const provider  = getProvider();
  const modelId   = getModelId(provider.name);
  const timeoutMs = getTimeoutMs();
  const prompt    = buildPrompt(task);

  try {
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
    const message = describeProviderError(err, provider.name);
    return {
      taskId:     task.id,
      route:      "SIMPLE_AI",
      output:     `[Simple AI error] ${message}`,
      durationMs: Date.now() - start,
      status:     "FAILED",
      isMock:     provider.name === "mock",
    };
  }
}
