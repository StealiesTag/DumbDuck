// ─────────────────────────────────────────────────────────────────────────────
// ML Classifier
//
// Loads a trained decision tree exported to JSON by training/train.py and uses
// it to predict SIMPLE_AI or COMPLEX_AI for a given feature vector.
//
// If no model file exists, the classifier falls back to a simple heuristic
// that is CLEARLY LABELLED as a fallback — never as an ML prediction.
//
// Model file location: models/decision_tree.json
// (path is configurable via MODEL_PATH below)
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from "fs";
import * as path from "path";
import {
  FeatureVector,
  NamedFeatures,
  MLLabel,
  MLClassificationResult,
  DecisionTreeModel,
  TreeNode,
  FEATURE_NAMES,
  FEATURE_VECTOR_LENGTH,
} from "../types";

// ── Model path ───────────────────────────────────────────────────────────────

const MODEL_PATH = path.resolve(__dirname, "../../models/decision_tree.json");

// ── Model cache — loaded once, reused for every call ─────────────────────────

type ModelState =
  | { status: "loaded";   model: DecisionTreeModel }
  | { status: "missing" }
  | { status: "error";    message: string };

let _modelState: ModelState | null = null;

function loadModel(): ModelState {
  if (_modelState !== null) return _modelState;

  if (!fs.existsSync(MODEL_PATH)) {
    _modelState = { status: "missing" };
    return _modelState;
  }

  try {
    const raw   = fs.readFileSync(MODEL_PATH, "utf-8");
    const model = JSON.parse(raw) as DecisionTreeModel;

    // Validate feature name order matches what this code was built against
    if (!model.feature_names || model.feature_names.length !== FEATURE_VECTOR_LENGTH) {
      throw new Error(
        `Model has ${model.feature_names?.length ?? 0} features, ` +
        `expected ${FEATURE_VECTOR_LENGTH}`
      );
    }
    for (let i = 0; i < FEATURE_NAMES.length; i++) {
      if (model.feature_names[i] !== FEATURE_NAMES[i]) {
        throw new Error(
          `Feature name mismatch at index ${i}: ` +
          `model has "${model.feature_names[i]}", ` +
          `code expects "${FEATURE_NAMES[i]}". ` +
          `Retrain the model after updating features.`
        );
      }
    }

    _modelState = { status: "loaded", model };
    return _modelState;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    _modelState = { status: "error", message };
    return _modelState;
  }
}

/** Clears the model cache. Used by tests to force a reload. */
export function clearModelCache(): void {
  _modelState = null;
}

// ── Decision tree traversal ──────────────────────────────────────────────────

function traverseTree(
  node: TreeNode,
  vector: FeatureVector,
  path: string[]
): { label: MLLabel; decisionPath: string[]; confidence?: number } {
  // Leaf node
  if (node.feature_index === -2 || (node.left === null && node.right === null)) {
    if (!node.class_label) {
      throw new Error("Leaf node missing class_label — model may be corrupt");
    }
    let confidence: number | undefined;
    if (node.class_counts) {
      const counts = Object.values(node.class_counts);
      const total  = counts.reduce((a, b) => a + b, 0);
      const max    = Math.max(...counts);
      confidence   = total > 0 ? max / total : undefined;
    }
    return { label: node.class_label, decisionPath: path, confidence };
  }

  const featureValue = vector[node.feature_index];
  const featureName  = FEATURE_NAMES[node.feature_index] ?? `feature[${node.feature_index}]`;

  if (featureValue <= node.threshold) {
    const nextPath = [...path, `${featureName} <= ${node.threshold} → left`];
    return traverseTree(node.left!, vector, nextPath);
  } else {
    const nextPath = [...path, `${featureName} > ${node.threshold} → right`];
    return traverseTree(node.right!, vector, nextPath);
  }
}

// ── Fallback heuristic ────────────────────────────────────────────────────────
// Used ONLY when the model is unavailable. Explicitly labelled as a fallback.
// This is NOT an ML prediction. Do not present it as one.

function heuristicFallback(
  vector: FeatureVector,
  named: NamedFeatures
): MLClassificationResult {
  // Simple rule: high reasoning OR high generation → COMPLEX_AI
  const isComplex =
    named.reasoningLevel >= 3 ||
    named.generationLevel >= 3 ||
    named.filesInvolved >= 4 ||
    (named.reasoningLevel >= 2 && named.generationLevel >= 2);

  const label: MLLabel = isComplex ? "COMPLEX_AI" : "SIMPLE_AI";

  return {
    label,
    source:        "FALLBACK_HEURISTIC",
    featureVector: vector,
    namedFeatures: named,
    decisionPath:  ["[FALLBACK] No ML model available — using rule-based heuristic"],
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify a feature vector as SIMPLE_AI or COMPLEX_AI.
 *
 * If a trained model is available, uses it (source = ML_MODEL).
 * If not, uses the heuristic fallback (source = FALLBACK_HEURISTIC).
 *
 * The caller can inspect result.source to know which path was taken.
 */
export function classifyWithML(
  vector: FeatureVector,
  named: NamedFeatures
): MLClassificationResult {
  const state = loadModel();

  if (state.status === "loaded") {
    try {
      const { label, decisionPath, confidence } = traverseTree(
        state.model.tree,
        vector,
        []
      );
      const result: MLClassificationResult = {
        label,
        source:        "ML_MODEL",
        featureVector: vector,
        namedFeatures: named,
        decisionPath,
      };
      if (confidence !== undefined) result.confidence = confidence;
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[classifier] ML model traversal failed: ${msg}. Falling back to heuristic.`);
      return heuristicFallback(vector, named);
    }
  }

  if (state.status === "error") {
    console.warn(`[classifier] Model load error: ${state.message}. Using fallback heuristic.`);
  } else {
    // status === "missing" — log once, quietly
    if (!_alreadyWarnedMissing) {
      console.warn(
        `[classifier] No model found at ${MODEL_PATH}.\n` +
        `  To train: cd training && pip install -r requirements.txt && python train.py\n` +
        `  Using FALLBACK_HEURISTIC until a model is available.\n` +
        `  WARNING: fallback results are NOT ML predictions.`
      );
      _alreadyWarnedMissing = true;
    }
  }

  return heuristicFallback(vector, named);
}

let _alreadyWarnedMissing = false;

/** Returns a human-readable status string for the current model state. */
export function getModelStatus(): string {
  const state = loadModel();
  switch (state.status) {
    case "loaded":
      return `ML model loaded from ${MODEL_PATH}`;
    case "missing":
      return `No model file at ${MODEL_PATH} — using fallback heuristic`;
    case "error":
      return `Model load error: ${state.message} — using fallback heuristic`;
  }
}
