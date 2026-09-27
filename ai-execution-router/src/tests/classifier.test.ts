// ─────────────────────────────────────────────────────────────────────────────
// Tests: ML Classifier (decision tree traversal and fallback)
// ─────────────────────────────────────────────────────────────────────────────

import { classifyWithML, clearModelCache } from "../router/classifier";
import { FeatureVector, NamedFeatures, TreeNode, DecisionTreeModel } from "../types";
import { TestResult, assert, assertEqual } from "./helpers";
import * as fs   from "fs";
import * as path from "path";

// ── Minimal NamedFeatures helper ─────────────────────────────────────────────

function makeNamed(overrides: Partial<NamedFeatures> = {}): NamedFeatures {
  return {
    reasoningLevel:    0,
    generationLevel:   0,
    contextSizeTier:   0,
    ambiguityTier:     0,
    filesInvolved:     0,
    hasErrorMessage:   0,
    hasCodeSnippet:    0,
    descriptionLength: 1,
    ...overrides,
  };
}

function makeVector(named: NamedFeatures): FeatureVector {
  return [
    named.reasoningLevel,
    named.generationLevel,
    named.contextSizeTier,
    named.ambiguityTier,
    named.filesInvolved,
    named.hasErrorMessage,
    named.hasCodeSnippet,
    named.descriptionLength,
  ];
}

// ── Known-tree inference test ─────────────────────────────────────────────────
// We write a minimal JSON tree to a temp file, point the classifier at it, and
// verify the traversal produces the expected labels.
//
// The tiny test tree:
//   root: feature[0] (reasoningLevel) <= 1.5
//     left  (≤ 1.5): class SIMPLE_AI
//     right (> 1.5): class COMPLEX_AI

const TEMP_MODEL_DIR  = path.resolve(__dirname, "../../models");
const TEMP_MODEL_PATH = path.join(TEMP_MODEL_DIR, "decision_tree.json");

function buildTestTree(): DecisionTreeModel {
  const leaf_simple: TreeNode = {
    feature_index: -2,
    threshold:     -2,
    left:          null,
    right:         null,
    class_label:   "SIMPLE_AI",
    class_counts:  { SIMPLE_AI: 10, COMPLEX_AI: 0 },
  };
  const leaf_complex: TreeNode = {
    feature_index: -2,
    threshold:     -2,
    left:          null,
    right:         null,
    class_label:   "COMPLEX_AI",
    class_counts:  { SIMPLE_AI: 0, COMPLEX_AI: 10 },
  };
  const root: TreeNode = {
    feature_index: 0,   // reasoningLevel
    threshold:     1.5,
    left:          leaf_simple,
    right:         leaf_complex,
  };
  return {
    version:       "1.0",
    trained_at:    "2024-01-01T00:00:00Z",
    feature_names: [
      "reasoningLevel", "generationLevel", "contextSizeTier",
      "ambiguityTier",  "filesInvolved",   "hasErrorMessage",
      "hasCodeSnippet", "descriptionLength",
    ],
    class_labels:  ["SIMPLE_AI", "COMPLEX_AI"],
    max_depth:     1,
    tree:          root,
  };
}

export function runClassifierTests(): TestResult[] {
  const results: TestResult[] = [];

  // ── Without model file — should use fallback heuristic ────────────────────
  // Save and temporarily rename the real model if it exists
  let savedModel: string | null = null;
  const backupPath = TEMP_MODEL_PATH + ".bak";
  if (fs.existsSync(TEMP_MODEL_PATH)) {
    savedModel = fs.readFileSync(TEMP_MODEL_PATH, "utf-8");
    fs.renameSync(TEMP_MODEL_PATH, backupPath);
  }

  clearModelCache();

  const namedSimple = makeNamed({ reasoningLevel: 1, generationLevel: 1 });
  const vecSimple   = makeVector(namedSimple);
  const fallbackResult = classifyWithML(vecSimple, namedSimple);
  results.push(assertEqual(
    fallbackResult.source,
    "FALLBACK_HEURISTIC",
    "No model → source=FALLBACK_HEURISTIC"
  ));
  results.push(assert(
    fallbackResult.label === "SIMPLE_AI" || fallbackResult.label === "COMPLEX_AI",
    "Fallback returns a valid label"
  ));

  // ── Fallback routing logic: high reasoning → COMPLEX_AI ───────────────────
  const namedComplex = makeNamed({ reasoningLevel: 3, generationLevel: 3 });
  const vecComplex   = makeVector(namedComplex);
  clearModelCache();
  const fallbackComplex = classifyWithML(vecComplex, namedComplex);
  results.push(assertEqual(
    fallbackComplex.source,
    "FALLBACK_HEURISTIC",
    "Fallback complex: source=FALLBACK_HEURISTIC"
  ));
  results.push(assertEqual(
    fallbackComplex.label,
    "COMPLEX_AI",
    "Fallback: high reasoning+generation → COMPLEX_AI"
  ));

  // ── Fallback routing: low reasoning → SIMPLE_AI ───────────────────────────
  clearModelCache();
  const namedLow = makeNamed({ reasoningLevel: 1, generationLevel: 1, filesInvolved: 0 });
  const vecLow   = makeVector(namedLow);
  const fallbackLow = classifyWithML(vecLow, namedLow);
  results.push(assertEqual(
    fallbackLow.label,
    "SIMPLE_AI",
    "Fallback: low reasoning+generation → SIMPLE_AI"
  ));

  // ── With a known test tree ─────────────────────────────────────────────────
  // Write the tiny test tree to the model path
  fs.mkdirSync(TEMP_MODEL_DIR, { recursive: true });
  fs.writeFileSync(TEMP_MODEL_PATH, JSON.stringify(buildTestTree()), "utf-8");
  clearModelCache();

  const namedR1  = makeNamed({ reasoningLevel: 1 });
  const vecR1    = makeVector(namedR1);
  const resultR1 = classifyWithML(vecR1, namedR1);
  results.push(assertEqual(resultR1.source, "ML_MODEL",   "Known tree: source=ML_MODEL"));
  results.push(assertEqual(resultR1.label,  "SIMPLE_AI",  "reasoningLevel=1 (≤1.5) → SIMPLE_AI"));
  results.push(assert(
    Array.isArray(resultR1.decisionPath) && resultR1.decisionPath!.length > 0,
    "Known tree: decisionPath is non-empty"
  ));
  results.push(assert(
    resultR1.confidence !== undefined && resultR1.confidence > 0,
    "Known tree: confidence is present and positive"
  ));

  const namedR3  = makeNamed({ reasoningLevel: 3 });
  const vecR3    = makeVector(namedR3);
  const resultR3 = classifyWithML(vecR3, namedR3);
  results.push(assertEqual(resultR3.source, "ML_MODEL",    "Known tree: source=ML_MODEL (complex)"));
  results.push(assertEqual(resultR3.label,  "COMPLEX_AI",  "reasoningLevel=3 (>1.5) → COMPLEX_AI"));

  // ── Wrong feature count in model → falls back gracefully ──────────────────
  const badModel = { ...buildTestTree(), feature_names: ["only_one_feature"] };
  fs.writeFileSync(TEMP_MODEL_PATH, JSON.stringify(badModel), "utf-8");
  clearModelCache();
  const badResult = classifyWithML(vecR1, namedR1);
  results.push(assertEqual(
    badResult.source,
    "FALLBACK_HEURISTIC",
    "Malformed model (wrong feature count) → fallback"
  ));

  // ── Wrong feature name order → falls back gracefully ──────────────────────
  const wrongNameModel = {
    ...buildTestTree(),
    feature_names: [
      "WRONG_NAME", "generationLevel", "contextSizeTier",
      "ambiguityTier", "filesInvolved", "hasErrorMessage",
      "hasCodeSnippet", "descriptionLength",
    ],
  };
  fs.writeFileSync(TEMP_MODEL_PATH, JSON.stringify(wrongNameModel), "utf-8");
  clearModelCache();
  const wrongResult = classifyWithML(vecR1, namedR1);
  results.push(assertEqual(
    wrongResult.source,
    "FALLBACK_HEURISTIC",
    "Mismatched feature names → fallback"
  ));

  // ── Cleanup: restore original model if it existed, else remove test file ──
  clearModelCache();
  if (savedModel !== null) {
    fs.writeFileSync(TEMP_MODEL_PATH, savedModel, "utf-8");
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  } else {
    if (fs.existsSync(TEMP_MODEL_PATH)) fs.unlinkSync(TEMP_MODEL_PATH);
  }

  return results;
}
