// ─────────────────────────────────────────────────────────────────────────────
// Executor: Simple AI
//
// Sends SIMPLE_AI tasks to a configured lightweight language model.
//
// Provider abstraction
// ────────────────────
// The provider is selected by the SIMPLE_AI_PROVIDER env var:
//   "openai"    — uses the OpenAI chat completions API
//   "mock"      — returns a clearly labelled stub (default when no key is set)
//
// Configuration via environment variables (never hardcoded):
//   SIMPLE_AI_PROVIDER   — "openai" | "mock"  (default: "mock")
//   OPENAI_API_KEY       — required when provider = "openai"
//   SIMPLE_AI_MODEL      — model id (default: "gpt-4o-mini" for OpenAI)
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

// ── Provider interface ────────────────────────────────────────────────────────

interface SimpleAIProvider {
  name:  string;
  call(prompt: string, modelId: string, timeoutMs: number): Promise<ProviderResponse>;
}

interface ProviderResponse {
  output:     string;
  modelId:    string;
  tokenUsage?: TokenUsage;
  isMock:     boolean;
}

// ── Mock provider ─────────────────────────────────────────────────────────────

const MockProvider: SimpleAIProvider = {
  name: "mock",
  async call(prompt, modelId) {
    return {
      output:  `[MOCK — no AI call made] Prompt received (${prompt.length} chars). ` +
               `Set SIMPLE_AI_PROVIDER=openai and OPENAI_API_KEY to use a real model.`,
      modelId: "mock",
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
      tokenUsage,
      isMock:     false,
    };
  },
};

// ── Provider registry ─────────────────────────────────────────────────────────

const PROVIDERS: Record<string, SimpleAIProvider> = {
  mock:   MockProvider,
  openai: OpenAIProvider,
};

function getProvider(): SimpleAIProvider {
  const name = (process.env.SIMPLE_AI_PROVIDER ?? "mock").toLowerCase();
  return PROVIDERS[name] ?? MockProvider;
}

function getModelId(): string {
  return process.env.SIMPLE_AI_MODEL ?? "gpt-4o-mini";
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
  const modelId   = getModelId();
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
      tokenUsage: resp.tokenUsage,
      isMock:     resp.isMock,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
