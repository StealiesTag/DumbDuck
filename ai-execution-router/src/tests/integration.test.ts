// ─────────────────────────────────────────────────────────────────────────────
// Tests: Delegation, SimpleAI mock mode, Execution Log, MCP input validation
// ─────────────────────────────────────────────────────────────────────────────

import { runComplexAI }   from "../executors/complexAI";
import { createGeminiProvider, describeProviderError, getSimpleAIProviderStatus, runSimpleAI } from "../executors/simpleAI";
import { executionLog }   from "../log/executionLog";
import { routeTask }      from "../router/router";
import { clearModelCache } from "../router/classifier";
import { IncomingTask, TaskRecord } from "../types";
import { TestResult, assert, assertEqual } from "./helpers";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<IncomingTask> = {}): IncomingTask {
  return {
    id:          "test-del-001",
    description: "Test task",
    kind:        "DIAGNOSE",
    args:        {},
    ...overrides,
  };
}

// ── Complex AI delegation tests ───────────────────────────────────────────────

export async function runDelegationTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // ── Delegation result structure ─────────────────────────────────────────────
  const task = makeTask({
    id:          "del-001",
    description: "Diagnose a race condition",
    context: {
      filesInvolved: ["auth.ts", "session.ts"],
      errorMessage:  "Intermittent 401",
    },
  });

  const result = await runComplexAI(task, "ML_MODEL", ["reasoningLevel > 2 → right"], 1.0);

  results.push(assertEqual(result.route,  "COMPLEX_AI", "delegation route=COMPLEX_AI"));
  results.push(assertEqual(result.status, "DELEGATED",  "delegation status=DELEGATED"));
  results.push(assert(!!result.delegation,              "delegation field is present"));

  const d = result.delegation;
  results.push(assertEqual(d.taskId,      "del-001",    "delegation.taskId"));
  results.push(assertEqual(d.route,       "COMPLEX_AI", "delegation.route"));
  results.push(assertEqual(d.status,      "DELEGATED",  "delegation.status"));
  results.push(assertEqual(d.classifierSource, "ML_MODEL", "delegation.classifierSource"));
  results.push(assert(Array.isArray(d.filesInvolved) && d.filesInvolved!.length === 2, "delegation.filesInvolved"));
  results.push(assert(typeof d.note === "string" && d.note.length > 10,                "delegation.note present"));
  results.push(assert(Array.isArray(d.decisionPath),   "delegation.decisionPath present"));

  // The output should be valid JSON (the delegation payload)
  let parsed: unknown = null;
  try { parsed = JSON.parse(result.output); } catch {}
  results.push(assert(parsed !== null, "delegation output is valid JSON"));

  // ── SimpleAI mock mode ────────────────────────────────────────────────────
  // Ensure SIMPLE_AI_PROVIDER is not set to openai for this test
  const origProvider = process.env.SIMPLE_AI_PROVIDER;
  delete process.env.SIMPLE_AI_PROVIDER;

  const simpleTask = makeTask({ id: "simple-001", kind: "SUMMARIZE",
    description: "Summarize the error" });
  const simpleResult = await runSimpleAI(simpleTask);

  results.push(assertEqual(simpleResult.route,  "SIMPLE_AI", "simpleAI route=SIMPLE_AI"));
  results.push(assertEqual(simpleResult.status, "SUCCEEDED", "simpleAI mock succeeds"));
  results.push(assert(simpleResult.isMock,                   "simpleAI is in mock mode"));
  results.push(assert(
    simpleResult.output.includes("[MOCK"),
    "simpleAI mock output is clearly labelled"
  ));
  results.push(assert(
    simpleResult.tokenUsage === undefined,
    "simpleAI mock has no token usage"
  ));

  // Restore env
  if (origProvider !== undefined) process.env.SIMPLE_AI_PROVIDER = origProvider;

  // ── Missing credentials error ─────────────────────────────────────────────
  process.env.SIMPLE_AI_PROVIDER = "openai";
  delete process.env.OPENAI_API_KEY;

  const credTask = makeTask({ id: "cred-001", kind: "SUMMARIZE",
    description: "Summarize with missing credentials" });
  const credResult = await runSimpleAI(credTask);

  results.push(assertEqual(credResult.status, "FAILED", "missing API key → FAILED"));
  results.push(assert(
    credResult.output.includes("[Simple AI error]"),
    "missing API key output is labelled as error"
  ));

  delete process.env.SIMPLE_AI_PROVIDER;

  return results;
}

export async function runGeminiProviderTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const previousKey = process.env.GEMINI_API_KEY;
  const previousProvider = process.env.SIMPLE_AI_PROVIDER;
  const previousModel = process.env.GEMINI_MODEL;
  process.env.GEMINI_API_KEY = "unit-test-key-not-a-credential";
  process.env.SIMPLE_AI_PROVIDER = "gemini";
  process.env.GEMINI_MODEL = "gemini-test-model";

  try {
    let observedTimeout = 0;
    const provider = createGeminiProvider((_key, timeoutMs) => {
      observedTimeout = timeoutMs;
      return {
        models: {
          generateContent: async (params: { model: string; contents: string }) => ({
            text: `Generated for ${params.model}`,
            usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 8, totalTokenCount: 25 },
          }),
        },
      } as never;
    });
    const response = await provider.call("test prompt", "gemini-test-model", 1234);
    results.push(assertEqual(response.output, "Generated for gemini-test-model", "Gemini provider returns generated text"));
    results.push(assertEqual(response.providerId, "gemini", "Gemini response identifies provider"));
    results.push(assertEqual(response.modelId, "gemini-test-model", "Gemini response identifies configured model"));
    results.push(assertEqual(response.tokenUsage?.promptTokens, 17, "Gemini prompt tokens map to input usage"));
    results.push(assertEqual(response.tokenUsage?.completionTokens, 8, "Gemini candidate tokens map to output usage"));
    results.push(assertEqual(response.tokenUsage?.totalTokens, 25, "Gemini total token usage is preserved"));
    results.push(assertEqual(observedTimeout, 1234, "Gemini request receives configured timeout"));
    results.push(assert(!response.isMock, "Gemini provider result is not marked mock"));

    const noUsageProvider = createGeminiProvider(() => ({
      models: { generateContent: async () => ({ text: "No metadata" }) },
    } as never));
    const noUsage = await noUsageProvider.call("prompt", "gemini-test-model", 1000);
    results.push(assertEqual(noUsage.tokenUsage, undefined, "missing Gemini usage metadata remains unavailable"));

    const incompleteProvider = createGeminiProvider(() => ({
      models: { generateContent: async () => ({ text: "Partial metadata", usageMetadata: { promptTokenCount: 1 } }) },
    } as never));
    const incomplete = await incompleteProvider.call("prompt", "gemini-test-model", 1000);
    results.push(assertEqual(incomplete.tokenUsage, undefined, "incomplete Gemini usage metadata remains unavailable"));

    const malformedProvider = createGeminiProvider(() => ({
      models: { generateContent: async () => ({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }) },
    } as never));
    let malformedError = "";
    try { await malformedProvider.call("prompt", "gemini-test-model", 1000); }
    catch (error) { malformedError = error instanceof Error ? error.message : ""; }
    results.push(assert(malformedError.includes("no text content"), "malformed response without text is rejected safely"));

    delete process.env.GEMINI_API_KEY;
    const missingKeyResult = await runSimpleAI(makeTask({ id: "gemini-no-key", kind: "SUMMARIZE" }));
    results.push(assertEqual(missingKeyResult.status, "FAILED", "Gemini without a key fails without making a request"));
    results.push(assert(missingKeyResult.output.includes("GEMINI_API_KEY") && !missingKeyResult.output.includes("unit-test-key"),
      "missing-key failure names the variable without exposing credentials"));
    process.env.GEMINI_API_KEY = "unit-test-key-not-a-credential";

    const authMessage = describeProviderError({ status: 401, message: "bad key unit-test-key-not-a-credential" }, "Gemini");
    const invalidKeyMessage = describeProviderError({ code: "API_KEY_INVALID", message: "credential details" }, "Gemini");
    const quotaMessage = describeProviderError({ status: "RESOURCE_EXHAUSTED", message: "quota detail" }, "Gemini");
    const networkMessage = describeProviderError({ code: "ECONNRESET", message: "socket detail" }, "Gemini");
    results.push(assert(authMessage.includes("authentication") && !authMessage.includes("unit-test-key"), "authentication errors are categorized without raw details"));
    results.push(assert(invalidKeyMessage.includes("authentication") && !invalidKeyMessage.includes("credential details"), "invalid Gemini key errors are categorized safely"));
    results.push(assert(quotaMessage.includes("quota or rate limit"), "quota errors are categorized safely"));
    results.push(assert(networkMessage.includes("network request"), "network errors are categorized safely"));
    const status = getSimpleAIProviderStatus();
    results.push(assertEqual(status.provider, "gemini", "provider status reports Gemini"));
    results.push(assertEqual(status.model, "gemini-test-model", "provider status reports configured model"));
    results.push(assert(status.apiKeyPresent, "provider status reports key presence"));
    results.push(assert(!JSON.stringify(status).includes("unit-test-key"), "provider status never includes key value"));
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousProvider === undefined) delete process.env.SIMPLE_AI_PROVIDER;
    else process.env.SIMPLE_AI_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previousModel;
  }
  return results;
}

// ── Execution log tests ───────────────────────────────────────────────────────

export async function runExecutionLogTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  executionLog.clear();
  clearModelCache();

  // Route two tasks and verify records appear
  const t1: IncomingTask = {
    id: "log-001", description: "Calculate 2+2", kind: "CALCULATION",
    args: { expression: "2+2" },
  };
  const t2: IncomingTask = {
    id: "log-002", description: "Summarize error", kind: "SUMMARIZE",
    args: {}, context: { errorMessage: "boom" },
  };

  await routeTask(t1);
  await routeTask(t2);

  const records = executionLog.getRecords();
  results.push(assertEqual(records.length, 2, "log has 2 records after 2 tasks"));

  const rec1 = records.find((r: TaskRecord) => r.taskId === "log-001");
  results.push(assert(!!rec1, "log contains record for task log-001"));
  results.push(assertEqual(rec1?.route, "DETERMINISTIC", "log-001 route=DETERMINISTIC"));
  results.push(assert(typeof rec1?.startedAt === "string", "startedAt is ISO string"));
  results.push(assert(typeof rec1?.endedAt   === "string", "endedAt is ISO string"));
  results.push(assert(typeof rec1?.durationMs === "number" && rec1.durationMs >= 0, "durationMs >= 0"));

  // ── Report structure ───────────────────────────────────────────────────────
  const report = executionLog.generateReport();
  results.push(assertEqual(report.totalTasks,        2,  "report totalTasks=2"));
  results.push(assertEqual(report.deterministicCount, 1, "report deterministicCount=1"));
  results.push(assert(report.aiTaskCount >= 1,            "report aiTaskCount>=1"));
  results.push(assertEqual(
    report.estimatedCostUsd,
    "NOT_AVAILABLE — no pricing data yet",
    "report costUsd = NOT_AVAILABLE"
  ));
  results.push(assert(typeof report.generatedAt === "string", "report.generatedAt is string"));

  executionLog.clear();
  return results;
}

// ── MCP input validation tests ────────────────────────────────────────────────
// Validates that route_task correctly handles missing/invalid inputs without crashing.
// These tests call the router directly rather than going through the MCP server
// (the MCP server's dispatch logic is the same code path).

export async function runMCPInputTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  executionLog.clear();
  clearModelCache();

  // route_task with valid minimal input
  const minTask: IncomingTask = {
    id: "mcp-min-001", description: "Calculate 1+1",
    kind: "CALCULATION", args: { expression: "1+1" },
  };
  const minRecord = await routeTask(minTask);
  results.push(assert(!!minRecord.taskId,  "route_task: taskId present"));
  results.push(assert(!!minRecord.route,   "route_task: route present"));
  results.push(assert(!!minRecord.status,  "route_task: status present"));
  results.push(assert(!!minRecord.startedAt, "route_task: startedAt present"));

  // route_task with COMPLEX_AI kind — delegation result
  const complexTask: IncomingTask = {
    id: "mcp-complex-001",
    description: "Diagnose a multi-module bug",
    kind: "DIAGNOSE", args: {},
    originatingAgent: "test-agent",
    context: { filesInvolved: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] },
  };
  const complexRecord = await routeTask(complexTask);
  results.push(assertEqual(complexRecord.route,  "COMPLEX_AI", "complex task routed to COMPLEX_AI"));
  results.push(assertEqual(complexRecord.status, "DELEGATED",  "complex task status=DELEGATED"));
  results.push(assert(!!complexRecord.delegation,              "complex task has delegation payload"));
  results.push(assertEqual(complexRecord.originatingAgent, "test-agent", "originatingAgent preserved in record"));

  executionLog.clear();
  return results;
}
