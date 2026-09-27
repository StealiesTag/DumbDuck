// ─────────────────────────────────────────────────────────────────────────────
// Rule-based classifier
//
// Decision pipeline:
//   1. If deterministicAvailable → DETERMINISTIC immediately (no scoring)
//   2. Otherwise, compute a complexity score from the feature vector
//   3. Map the score to SIMPLE_AI or COMPLEX_AI via configurable thresholds
//
// All weights and thresholds are centralised in CLASSIFIER_CONFIG so they
// can be tuned without changing the classification logic.
// ─────────────────────────────────────────────────────────────────────────────

import { Task, ClassificationResult, TaskFeatures, ContextSize, AmbiguityLevel } from "../types";
import { extractFeatures } from "./features";

// ── Configuration — change weights here, not in the scoring function ─────────

export const CLASSIFIER_CONFIG = {
  weights: {
    // Each unit of reasoning depth contributes this much to the score
    reasoningLevel:  2,
    // Each unit of open-ended generation contributes this much
    generationLevel: 2,
    // Context-size bonus (see CONTEXT_SCORE below)
    contextSize:     1,   // multiplied by a tier value
    // Ambiguity bonus (see AMBIGUITY_SCORE below)
    ambiguityLevel:  1,   // multiplied by a tier value
    // Each additional file touched adds this to the score
    filesInvolved:   0.5,
  },
  // Tier values for ordinal features
  contextTiers: { none: 0, small: 1, medium: 2, large: 3 } as Record<ContextSize, number>,
  ambiguityTiers: { none: 0, low: 1, medium: 2, high: 3 } as Record<AmbiguityLevel, number>,
  // Score thresholds
  thresholds: {
    // score < simpleAiMax  → SIMPLE_AI
    // score >= simpleAiMax → COMPLEX_AI
    // A SUMMARIZE task with a small context scores 5 (1×2 + 1×2 + 1×1).
    // Setting the boundary at 6 keeps SUMMARIZE in SIMPLE_AI while
    // DIAGNOSE (score ≥ 7) and DESIGN (score ≥ 9) remain COMPLEX_AI.
    simpleAiMax: 6,
  },
} as const;

// ── Scoring ──────────────────────────────────────────────────────────────────

function scoreFeatures(features: TaskFeatures): number {
  const { weights, contextTiers, ambiguityTiers } = CLASSIFIER_CONFIG;

  return (
    features.reasoningLevel  * weights.reasoningLevel +
    features.generationLevel * weights.generationLevel +
    contextTiers[features.contextSize]    * weights.contextSize +
    ambiguityTiers[features.ambiguityLevel] * weights.ambiguityLevel +
    features.filesInvolved   * weights.filesInvolved
  );
}

// ── Reason builder — produces human-readable strings for the log ─────────────

function buildReasons(features: TaskFeatures, score: number): string[] {
  const reasons: string[] = [];

  if (features.requiresLanguageUnderstanding) {
    reasons.push("Requires natural-language understanding");
  }
  if (features.reasoningLevel >= 3) {
    reasons.push("Requires deep multi-step reasoning");
  } else if (features.reasoningLevel >= 1) {
    reasons.push("Requires light reasoning");
  }
  if (features.generationLevel >= 3) {
    reasons.push("Requires large open-ended text/code generation");
  } else if (features.generationLevel >= 1) {
    reasons.push("Requires modest text generation");
  }
  if (features.filesInvolved >= 3) {
    reasons.push(`Multiple files involved (${features.filesInvolved})`);
  }
  if (features.contextSize === "large" || features.contextSize === "medium") {
    reasons.push(`Context size is ${features.contextSize}`);
  }
  if (features.ambiguityLevel === "high" || features.ambiguityLevel === "medium") {
    reasons.push(`Task description has ${features.ambiguityLevel} ambiguity`);
  }

  // Fallback so there is always at least one reason
  if (reasons.length === 0) {
    reasons.push(
      score < CLASSIFIER_CONFIG.thresholds.simpleAiMax
        ? "Low reasoning/generation requirement"
        : "Elevated reasoning/generation requirement"
    );
  }

  return reasons;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function classify(task: Task): ClassificationResult {
  const features = extractFeatures(task);

  // Fast path — a deterministic tool is available for this task kind
  if (features.deterministicAvailable) {
    return {
      route:    "DETERMINISTIC",
      score:    0,
      reasons:  ["A deterministic tool can fully handle this task"],
      features,
    };
  }

  // Slow path — score the feature vector and pick an AI tier
  const score   = scoreFeatures(features);
  const route   = score < CLASSIFIER_CONFIG.thresholds.simpleAiMax
    ? "SIMPLE_AI"
    : "COMPLEX_AI";
  const reasons = buildReasons(features, score);

  return { route, score, features, reasons };
}
