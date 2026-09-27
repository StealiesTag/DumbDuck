// ─────────────────────────────────────────────────────────────────────────────
// Feature extractor
//
// Given a Task, produce a TaskFeatures object that the classifier can score.
// All logic here is deterministic and rule-based — no AI involved.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Task,
  TaskFeatures,
  TaskKind,
  ReasoningLevel,
  GenerationLevel,
  ContextSize,
  AmbiguityLevel,
} from "../types";

// ── Lookup tables keyed by TaskKind ─────────────────────────────────────────
// Each value reflects the *typical* characteristics of that kind of task.
// These are intentional heuristics, not scientifically validated weights.

const REASONING_BY_KIND: Record<TaskKind, ReasoningLevel> = {
  SEARCH:      0,
  READ_FILE:   0,
  CALCULATION: 0,
  RUN_TESTS:   0,
  SUMMARIZE:   1,
  DIAGNOSE:    3,
  DESIGN:      3,
  UNKNOWN:     1,
};

const GENERATION_BY_KIND: Record<TaskKind, GenerationLevel> = {
  SEARCH:      0,
  READ_FILE:   0,
  CALCULATION: 0,
  RUN_TESTS:   0,
  SUMMARIZE:   1,
  DIAGNOSE:    2,
  DESIGN:      3,
  UNKNOWN:     1,
};

const LANGUAGE_UNDERSTANDING_BY_KIND: Record<TaskKind, boolean> = {
  SEARCH:      false,
  READ_FILE:   false,
  CALCULATION: false,
  RUN_TESTS:   false,
  SUMMARIZE:   true,
  DIAGNOSE:    true,
  DESIGN:      true,
  UNKNOWN:     false,
};

const DETERMINISTIC_KINDS: Set<TaskKind> = new Set([
  "SEARCH",
  "READ_FILE",
  "CALCULATION",
  "RUN_TESTS",
]);

// ── Context size heuristic ───────────────────────────────────────────────────

function inferContextSize(task: Task): ContextSize {
  const fileCount = task.context?.filesInvolved?.length ?? 0;
  const hasError  = !!task.context?.errorMessage;
  const hasCode   = !!task.context?.codeSnippet;

  if (fileCount >= 4)          return "large";
  if (fileCount >= 2)          return "medium";
  if (fileCount === 1 || hasError || hasCode) return "small";
  return "none";
}

// ── Ambiguity heuristic ──────────────────────────────────────────────────────
// Tasks whose descriptions contain vague or open-ended language are rated higher.

const AMBIGUOUS_KEYWORDS = [
  "design", "refactor", "propose", "architecture", "plan", "best",
  "improve", "restructure", "consider", "suggest",
];

function inferAmbiguity(task: Task): AmbiguityLevel {
  const lower = task.description.toLowerCase();
  const hits = AMBIGUOUS_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  if (hits >= 3) return "high";
  if (hits >= 2) return "medium";
  if (hits >= 1) return "low";
  return "none";
}

// ── Public API ───────────────────────────────────────────────────────────────

export function extractFeatures(task: Task): TaskFeatures {
  const fileCount = task.context?.filesInvolved?.length ?? 0;

  return {
    deterministicAvailable:       DETERMINISTIC_KINDS.has(task.kind),
    requiresLanguageUnderstanding: LANGUAGE_UNDERSTANDING_BY_KIND[task.kind],
    reasoningLevel:               REASONING_BY_KIND[task.kind],
    generationLevel:              GENERATION_BY_KIND[task.kind],
    contextSize:                  inferContextSize(task),
    ambiguityLevel:               inferAmbiguity(task),
    filesInvolved:                fileCount,
  };
}
