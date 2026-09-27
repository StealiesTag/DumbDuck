// ─────────────────────────────────────────────────────────────────────────────
// Feature Extractor
//
// Converts a Task into:
//   - a NamedFeatures record (for logging and human inspection)
//   - a FeatureVector (for ML inference)
//
// COLUMN ORDER CONTRACT
// The FeatureVector column order is the shared contract between this file and
// training/train.py. See the full specification in src/types.ts.
//
// If you add or remove a feature you MUST:
//   1. Update FEATURE_NAMES in src/types.ts
//   2. Update toNumericVector() below to match the new order
//   3. Update FEATURE_COLUMNS in training/train.py to match
//   4. Retrain the model from scratch
// ─────────────────────────────────────────────────────────────────────────────

import {
  Task,
  TaskKind,
  NamedFeatures,
  FeatureVector,
  FEATURE_NAMES,
  FEATURE_VECTOR_LENGTH,
} from "../types";

// ── Lookup tables keyed by TaskKind ─────────────────────────────────────────
// These reflect TYPICAL characteristics of each task kind.
// They are heuristics used to populate the feature vector.

const REASONING_BY_KIND: Record<TaskKind, number> = {
  SEARCH:      0,
  READ_FILE:   0,
  CALCULATION: 0,
  RUN_TESTS:   0,
  CREATE_FILE: 0,
  DELETE_FILE: 0,
  SUMMARIZE:   1,
  DIAGNOSE:    3,
  DESIGN:      3,
  UNKNOWN:     1,
};

const GENERATION_BY_KIND: Record<TaskKind, number> = {
  SEARCH:      0,
  READ_FILE:   0,
  CALCULATION: 0,
  RUN_TESTS:   0,
  CREATE_FILE: 1,
  DELETE_FILE: 0,
  SUMMARIZE:   1,
  DIAGNOSE:    2,
  DESIGN:      3,
  UNKNOWN:     1,
};

// ── Context size tier ────────────────────────────────────────────────────────
// none=0, small=1, medium=2, large=3

function contextSizeTier(task: Task): number {
  const n       = task.context?.filesInvolved?.length ?? 0;
  const hasErr  = task.context?.errorMessage ? 1 : 0;
  const hasCode = task.context?.codeSnippet  ? 1 : 0;

  if (n >= 4)                            return 3; // large
  if (n >= 2)                            return 2; // medium
  if (n === 1 || hasErr || hasCode)      return 1; // small
  return 0;                                        // none
}

// ── Ambiguity tier ────────────────────────────────────────────────────────────
// none=0, low=1, medium=2, high=3
// Counts vague/open-ended keywords in the task description.

const AMBIGUOUS_KEYWORDS = [
  "design", "refactor", "propose", "architecture", "plan", "best",
  "improve", "restructure", "consider", "suggest",
];

function ambiguityTier(task: Task): number {
  const lower = task.description.toLowerCase();
  const hits  = AMBIGUOUS_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  if (hits >= 3) return 3;
  if (hits >= 2) return 2;
  if (hits >= 1) return 1;
  return 0;
}

// ── Description length bucket ────────────────────────────────────────────────
// 0 (<20 chars), 1 (<50), 2 (<100), 3 (<200), 4 (≥200)

function descriptionLengthBucket(desc: string): number {
  const n = desc.length;
  if (n < 20)  return 0;
  if (n < 50)  return 1;
  if (n < 100) return 2;
  if (n < 200) return 3;
  return 4;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a NamedFeatures record for this task.
 * All values are numeric. Use this for logging and test assertions.
 */
export function extractNamedFeatures(task: Task): NamedFeatures {
  return {
    reasoningLevel:    REASONING_BY_KIND[task.kind],
    generationLevel:   GENERATION_BY_KIND[task.kind],
    contextSizeTier:   contextSizeTier(task),
    ambiguityTier:     ambiguityTier(task),
    filesInvolved:     task.context?.filesInvolved?.length ?? 0,
    hasErrorMessage:   task.context?.errorMessage ? 1 : 0,
    hasCodeSnippet:    task.context?.codeSnippet  ? 1 : 0,
    descriptionLength: descriptionLengthBucket(task.description),
  };
}

/**
 * Returns a FeatureVector (number[]) in the canonical column order defined
 * by FEATURE_NAMES in src/types.ts.
 *
 * This is the value passed to the decision tree at inference time.
 */
export function toNumericVector(features: NamedFeatures): FeatureVector {
  // Order MUST match FEATURE_NAMES exactly.
  const vec: FeatureVector = [
    features.reasoningLevel,     // 0
    features.generationLevel,    // 1
    features.contextSizeTier,    // 2
    features.ambiguityTier,      // 3
    features.filesInvolved,      // 4
    features.hasErrorMessage,    // 5
    features.hasCodeSnippet,     // 6
    features.descriptionLength,  // 7
  ];

  // Runtime guard — catches accidental column additions/removals
  if (vec.length !== FEATURE_VECTOR_LENGTH) {
    throw new Error(
      `Feature vector length mismatch: expected ${FEATURE_VECTOR_LENGTH}, got ${vec.length}. ` +
      `Update FEATURE_NAMES in types.ts and retrain the model.`
    );
  }

  return vec;
}

/**
 * Convenience function: extract named features and immediately convert to vector.
 */
export function extractFeatureVector(task: Task): { named: NamedFeatures; vector: FeatureVector } {
  const named  = extractNamedFeatures(task);
  const vector = toNumericVector(named);
  return { named, vector };
}

// Re-export the feature name list for use in logs and tests
export { FEATURE_NAMES };
