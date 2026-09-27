// ─────────────────────────────────────────────────────────────────────────────
// Core domain types for the AI Execution Router
// ─────────────────────────────────────────────────────────────────────────────

// The three possible execution routes for any task
export type Route = "DETERMINISTIC" | "SIMPLE_AI" | "COMPLEX_AI";

// Route labels used exclusively during ML training/inference (deterministic
// tasks are handled before ML is invoked, so they are not ML labels).
export type MLLabel = "SIMPLE_AI" | "COMPLEX_AI";

// The kind of task — used by the capability matcher and feature extractor
export type TaskKind =
  | "SEARCH"        // repository / file search
  | "READ_FILE"     // reading a file from disk
  | "CALCULATION"   // arithmetic or formula evaluation
  | "RUN_TESTS"     // executing a test suite
  | "SUMMARIZE"     // condensing or explaining existing text
  | "DIAGNOSE"      // reasoning about a bug or failure
  | "DESIGN"        // proposing architecture / refactoring plans
  | "UNKNOWN";      // fallback — feature extractor uses description heuristics

// A tool call argument: key/value pairs supplied by the agent
export type TaskArgs = Record<string, string | number | boolean | string[]>;

// The unit of work the router processes
export interface Task {
  id:          string;
  description: string;
  kind:        TaskKind;
  args:        TaskArgs;
  // Optional observable metadata the agent may attach
  context?: {
    filesInvolved?: string[];   // file paths relevant to this task
    errorMessage?:  string;     // verbatim error text, if any
    codeSnippet?:   string;     // inline code fragment, if any
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Numeric feature vector
//
// IMPORTANT: column order is the contract between training (Python) and
// inference (TypeScript). Any change here MUST be mirrored in:
//   training/train.py   — FEATURE_COLUMNS list
//   src/router/features.ts — toNumericVector() return order
//
// Index  Name                  Range   Description
//   0    reasoningLevel        0–3     Depth of multi-step reasoning required
//   1    generationLevel       0–3     Degree of open-ended text/code generation
//   2    contextSizeTier       0–3     none=0 small=1 medium=2 large=3
//   3    ambiguityTier         0–3     none=0 low=1  medium=2  high=3
//   4    filesInvolved         0–n     Count of files in context
//   5    hasErrorMessage       0|1     1 if task.context.errorMessage present
//   6    hasCodeSnippet        0|1     1 if task.context.codeSnippet present
//   7    descriptionLength     0–4     Bucketed: 0(<20) 1(<50) 2(<100) 3(<200) 4(≥200)
// ─────────────────────────────────────────────────────────────────────────────

export const FEATURE_NAMES = [
  "reasoningLevel",
  "generationLevel",
  "contextSizeTier",
  "ambiguityTier",
  "filesInvolved",
  "hasErrorMessage",
  "hasCodeSnippet",
  "descriptionLength",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

// A fixed-length numeric array — one element per feature in FEATURE_NAMES order
export type FeatureVector = [
  number, // 0 reasoningLevel
  number, // 1 generationLevel
  number, // 2 contextSizeTier
  number, // 3 ambiguityTier
  number, // 4 filesInvolved
  number, // 5 hasErrorMessage
  number, // 6 hasCodeSnippet
  number, // 7 descriptionLength
];

export const FEATURE_VECTOR_LENGTH = FEATURE_NAMES.length; // 8

// ─────────────────────────────────────────────────────────────────────────────
// Named feature record — used for logging and test assertions
// ─────────────────────────────────────────────────────────────────────────────

export interface NamedFeatures {
  reasoningLevel:    number;
  generationLevel:   number;
  contextSizeTier:   number;  // 0–3
  ambiguityTier:     number;  // 0–3
  filesInvolved:     number;
  hasErrorMessage:   number;  // 0 | 1
  hasCodeSnippet:    number;  // 0 | 1
  descriptionLength: number;  // bucketed 0–4
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability match — result of deterministic capability check
// ─────────────────────────────────────────────────────────────────────────────

export interface CapabilityMatch {
  matched:     boolean;
  toolName?:   string;   // which tool matched, if any
  reason:      string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ML classification result
// ─────────────────────────────────────────────────────────────────────────────

export type ClassifierSource = "ML_MODEL" | "FALLBACK_HEURISTIC";

export interface MLClassificationResult {
  label:          MLLabel;
  source:         ClassifierSource;
  confidence?:    number;         // present when model provides it
  decisionPath?:  string[];       // nodes traversed in the tree
  featureVector:  FeatureVector;
  namedFeatures:  NamedFeatures;
}

// ─────────────────────────────────────────────────────────────────────────────
// Full classification result — covers all three routes
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassificationResult {
  route:               Route;
  capabilityMatch:     CapabilityMatch;
  // Present only when route is SIMPLE_AI or COMPLEX_AI
  mlResult?:           MLClassificationResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution result — what each executor returns
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecutionResult {
  taskId:             string;
  route:              Route;
  output:             string;
  durationMs:         number;
  classifierSource?:  ClassifierSource;  // how the route was decided
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON decision tree model format
//
// A serialised sklearn DecisionTreeClassifier node.
// Leaf nodes have feature_index === -2 (sklearn's TREE_UNDEFINED).
// ─────────────────────────────────────────────────────────────────────────────

export interface TreeNode {
  feature_index: number;   // -2 = leaf
  threshold:     number;
  left:          TreeNode | null;
  right:         TreeNode | null;
  // Present on leaf nodes
  class_label?:  MLLabel;
  // Class distribution at this node (optional, for confidence)
  class_counts?: Record<string, number>;
}

export interface DecisionTreeModel {
  version:        string;
  trained_at:     string;
  feature_names:  string[];   // must match FEATURE_NAMES order
  class_labels:   MLLabel[];
  max_depth:      number;
  tree:           TreeNode;
}

// ─────────────────────────────────────────────────────────────────────────────
// v0.3 extensions — agent-agnostic task contract
// All types below are additive. Existing types above are unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle status of a single task as it moves through the pipeline.
 *
 * PLANNED       — received, not yet classified
 * CLASSIFIED    — route selected, awaiting execution
 * RUNNING       — executor is active
 * SUCCEEDED     — executor completed without error
 * FAILED        — executor returned an error or threw
 * DELEGATED     — COMPLEX_AI task returned to originating agent
 * NEEDS_APPROVAL — command requires explicit user approval before running
 */
export type TaskStatus =
  | "PLANNED"
  | "CLASSIFIED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "DELEGATED"
  | "NEEDS_APPROVAL";

/**
 * Normalised task submitted by an agent or MCP client.
 * Extends the existing Task interface with agent provenance and workspace info.
 */
export interface IncomingTask extends Task {
  // Which agent or client submitted this task (e.g. "bob", "cli", "mcp-client")
  originatingAgent?: string;
  // Workspace root path; if absent, workspace-aware tools are unavailable
  workspaceRoot?: string;
  // IDs of tasks this task depends on (outputs from prior tasks may be injected)
  dependsOn?: string[];
}

/**
 * Token usage returned by a model provider.
 * Only populated when a real API call was made.
 */
export interface TokenUsage {
  promptTokens:     number;
  completionTokens: number;
  totalTokens:      number;
}

/**
 * The structured result for COMPLEX_AI tasks that are delegated back
 * to the originating agent rather than executed locally.
 */
export interface DelegationResult {
  taskId:        string;
  description:   string;
  route:         "COMPLEX_AI";
  status:        "DELEGATED";
  // Why this task was routed to COMPLEX_AI
  classifierSource:  ClassifierSource;
  decisionPath?:     string[];
  confidence?:       number;
  // Context the agent needs to handle the task
  filesInvolved?:    string[];
  errorMessage?:     string;
  codeSnippet?:      string;
  priorResults?:     string[];   // summaries of prior task outputs
  // NOTE: the agent host must implement actual handoff; this router only
  // packages the delegation payload. Resumption is host-dependent.
  note: string;
}

/**
 * Full result record for a task, stored in the execution log.
 */
export interface TaskRecord {
  taskId:           string;
  description:      string;
  kind:             TaskKind;
  originatingAgent?: string;
  workspaceRoot?:   string;

  route:            Route;
  status:           TaskStatus;
  executorName:     string;    // "deterministic" | "simple-ai" | "complex-ai" | "fallback"
  classifierSource?: ClassifierSource;
  decisionPath?:    string[];
  confidence?:      number;
  featureVector?:   FeatureVector;

  startedAt:        string;    // ISO 8601
  endedAt:          string;    // ISO 8601
  durationMs:       number;

  output?:          string;
  delegation?:      DelegationResult;
  error?:           string;

  // Model metadata — only populated when a real AI call was made
  modelId?:         string;
  tokenUsage?:      TokenUsage;
  estimatedCostUsd?: never;    // never set until real pricing data is available
}
