// ─────────────────────────────────────────────────────────────────────────────
// Core domain types for the AI Execution Router
// ─────────────────────────────────────────────────────────────────────────────

// The three possible execution routes for any task
export type Route = "DETERMINISTIC" | "SIMPLE_AI" | "COMPLEX_AI";

// The kind of task — used by the classifier as a first-pass hint
export type TaskKind =
  | "SEARCH"        // repository / file search
  | "READ_FILE"     // reading a file from disk
  | "CALCULATION"   // arithmetic or formula evaluation
  | "RUN_TESTS"     // executing a test suite
  | "SUMMARIZE"     // condensing or explaining existing text
  | "DIAGNOSE"      // reasoning about a bug or failure
  | "DESIGN"        // proposing architecture / refactoring plans
  | "UNKNOWN";      // fallback — classifier will score from scratch

// A tool call argument: key/value pairs supplied by the agent
export type TaskArgs = Record<string, string | number | boolean | string[]>;

// The unit of work the router processes
export interface Task {
  id: string;
  description: string;
  kind: TaskKind;
  args: TaskArgs;
  // Optional metadata the agent may attach
  context?: {
    filesInvolved?: string[];   // file paths relevant to this task
    errorMessage?: string;      // verbatim error text, if any
    codeSnippet?: string;       // inline code fragment, if any
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature vector — the observable properties used by the classifier
// ─────────────────────────────────────────────────────────────────────────────

export type ReasoningLevel = 0 | 1 | 2 | 3;  // 0 = none, 3 = deep multi-step
export type GenerationLevel = 0 | 1 | 2 | 3;  // 0 = none, 3 = large open-ended generation
export type ContextSize = "none" | "small" | "medium" | "large";
export type AmbiguityLevel = "none" | "low" | "medium" | "high";

export interface TaskFeatures {
  deterministicAvailable: boolean;   // a known tool can fully handle this
  requiresLanguageUnderstanding: boolean;
  reasoningLevel: ReasoningLevel;
  generationLevel: GenerationLevel;
  contextSize: ContextSize;
  ambiguityLevel: AmbiguityLevel;
  filesInvolved: number;             // count of files the task touches
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification result — what the router receives back from the classifier
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassificationResult {
  route: Route;
  score: number;   // raw complexity score (0 = simplest, higher = more complex)
  reasons: string[];
  features: TaskFeatures;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution result — what each executor returns
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecutionResult {
  taskId: string;
  route: Route;
  output: string;
  durationMs: number;
}
