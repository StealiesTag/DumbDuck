// ─────────────────────────────────────────────────────────────────────────────
// Executor: Simple AI
//
// Placeholder for a lightweight/cheap language model (e.g. a small local model
// or a low-cost API endpoint).
//
// HOW TO REPLACE THIS WITH A REAL MODEL:
//   1. Install the model SDK (e.g. `npm install openai`).
//   2. Construct the prompt from task.description + task.context.
//   3. Call the model and return its response as `output`.
//   4. Nothing in the router or classifier needs to change.
// ─────────────────────────────────────────────────────────────────────────────

import { Task, ExecutionResult } from "../types";

export async function runSimpleAI(task: Task): Promise<ExecutionResult> {
  const start = Date.now();

  // ── Placeholder — swap this block for a real model call ───────────────────
  const output =
    `[Simple AI placeholder] Task "${task.description}" would be sent to a ` +
    `lightweight model. ` +
    `Stub response: task acknowledged, analysis pending real model integration.`;
  // ─────────────────────────────────────────────────────────────────────────

  return {
    taskId:     task.id,
    route:      "SIMPLE_AI",
    output,
    durationMs: Date.now() - start,
  };
}
