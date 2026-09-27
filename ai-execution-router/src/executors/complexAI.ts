// ─────────────────────────────────────────────────────────────────────────────
// Executor: Complex AI — Delegation
//
// COMPLEX_AI tasks are NOT executed locally. Instead, they are packaged as a
// structured DelegationResult and returned to the originating agent.
//
// This design is intentional:
//   - The router does not call a powerful model on its own.
//   - The originating agent (Bob, or another host) receives the delegation
//     payload and decides how to proceed.
//   - Actual agent resumption is host-dependent. The MCP client or agent
//     host must implement the handoff. This router only prepares the package.
//
// The delegation result includes:
//   - task description and ID
//   - routing decision and decision path
//   - relevant context (files, errors, code)
//   - outputs from prior tasks when available
// ─────────────────────────────────────────────────────────────────────────────

import {
  IncomingTask,
  ExecutionResult,
  DelegationResult,
  ClassifierSource,
  TaskStatus,
} from "../types";

export interface ComplexAIResult extends ExecutionResult {
  status:     TaskStatus;
  delegation: DelegationResult;
}

export async function runComplexAI(
  task:            IncomingTask,
  classifierSource: ClassifierSource = "FALLBACK_HEURISTIC",
  decisionPath?:   string[],
  confidence?:     number,
  priorResults?:   string[]
): Promise<ComplexAIResult> {
  const start = Date.now();

  const delegation: DelegationResult = {
    taskId:          task.id,
    description:     task.description,
    route:           "COMPLEX_AI",
    status:          "DELEGATED",
    classifierSource,
    decisionPath,
    confidence,
    filesInvolved:   task.context?.filesInvolved,
    errorMessage:    task.context?.errorMessage,
    codeSnippet:     task.context?.codeSnippet,
    priorResults,
    note:
      "This task requires complex AI reasoning. It has been returned to the originating agent " +
      "with full context. The agent host is responsible for handling this delegation. " +
      "Automatic resumption of agent reasoning is not performed by this router.",
  };

  const output = JSON.stringify(delegation, null, 2);

  return {
    taskId:     task.id,
    route:      "COMPLEX_AI",
    output,
    durationMs: Date.now() - start,
    status:     "DELEGATED",
    delegation,
  };
}
