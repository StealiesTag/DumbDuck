// ─────────────────────────────────────────────────────────────────────────────
// Tests: Feature Extractor
// ─────────────────────────────────────────────────────────────────────────────

import {
  extractNamedFeatures,
  toNumericVector,
  extractFeatureVector,
  FEATURE_NAMES,
} from "../router/features";
import { Task, FEATURE_VECTOR_LENGTH } from "../types";
import { TestResult, assert, assertEqual } from "./helpers";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id:          "t",
    description: "test task",
    kind:        "SUMMARIZE",
    args:        {},
    ...overrides,
  };
}

export function runFeatureTests(): TestResult[] {
  const results: TestResult[] = [];

  // ── FEATURE_NAMES order must be stable ────────────────────────────────────
  results.push(assertEqual(FEATURE_NAMES[0], "reasoningLevel",    "FEATURE_NAMES[0]"));
  results.push(assertEqual(FEATURE_NAMES[1], "generationLevel",   "FEATURE_NAMES[1]"));
  results.push(assertEqual(FEATURE_NAMES[2], "contextSizeTier",   "FEATURE_NAMES[2]"));
  results.push(assertEqual(FEATURE_NAMES[3], "ambiguityTier",     "FEATURE_NAMES[3]"));
  results.push(assertEqual(FEATURE_NAMES[4], "filesInvolved",     "FEATURE_NAMES[4]"));
  results.push(assertEqual(FEATURE_NAMES[5], "hasErrorMessage",   "FEATURE_NAMES[5]"));
  results.push(assertEqual(FEATURE_NAMES[6], "hasCodeSnippet",    "FEATURE_NAMES[6]"));
  results.push(assertEqual(FEATURE_NAMES[7], "descriptionLength", "FEATURE_NAMES[7]"));
  results.push(assertEqual(FEATURE_NAMES.length, FEATURE_VECTOR_LENGTH, "FEATURE_NAMES.length === FEATURE_VECTOR_LENGTH"));

  // ── toNumericVector produces correct length ────────────────────────────────
  const f0 = extractNamedFeatures(makeTask());
  const v0 = toNumericVector(f0);
  results.push(assertEqual(v0.length, FEATURE_VECTOR_LENGTH, "vector length is FEATURE_VECTOR_LENGTH"));

  // ── extractFeatureVector is consistent with extractNamedFeatures ──────────
  const { named, vector } = extractFeatureVector(makeTask());
  results.push(assertEqual(vector[0], named.reasoningLevel,    "vector[0] === reasoningLevel"));
  results.push(assertEqual(vector[1], named.generationLevel,   "vector[1] === generationLevel"));
  results.push(assertEqual(vector[2], named.contextSizeTier,   "vector[2] === contextSizeTier"));
  results.push(assertEqual(vector[3], named.ambiguityTier,     "vector[3] === ambiguityTier"));
  results.push(assertEqual(vector[4], named.filesInvolved,     "vector[4] === filesInvolved"));
  results.push(assertEqual(vector[5], named.hasErrorMessage,   "vector[5] === hasErrorMessage"));
  results.push(assertEqual(vector[6], named.hasCodeSnippet,    "vector[6] === hasCodeSnippet"));
  results.push(assertEqual(vector[7], named.descriptionLength, "vector[7] === descriptionLength"));

  // ── Context size tier ──────────────────────────────────────────────────────
  const noContext = extractNamedFeatures(makeTask());
  results.push(assertEqual(noContext.contextSizeTier, 0, "no context → tier 0"));

  const withError = extractNamedFeatures(makeTask({ context: { errorMessage: "boom" } }));
  results.push(assertEqual(withError.contextSizeTier, 1,  "error message → tier 1"));
  results.push(assertEqual(withError.hasErrorMessage, 1,  "error message → hasErrorMessage=1"));

  const withCode = extractNamedFeatures(makeTask({ context: { codeSnippet: "fn()" } }));
  results.push(assertEqual(withCode.contextSizeTier, 1, "code snippet → tier 1"));
  results.push(assertEqual(withCode.hasCodeSnippet,  1, "code snippet → hasCodeSnippet=1"));

  const twoFiles = extractNamedFeatures(makeTask({ context: { filesInvolved: ["a.ts", "b.ts"] } }));
  results.push(assertEqual(twoFiles.contextSizeTier, 2, "2 files → tier 2"));

  const fourFiles = extractNamedFeatures(
    makeTask({ context: { filesInvolved: ["a.ts", "b.ts", "c.ts", "d.ts"] } })
  );
  results.push(assertEqual(fourFiles.contextSizeTier, 3, "4 files → tier 3"));

  // ── Ambiguity tier ─────────────────────────────────────────────────────────
  const plain = extractNamedFeatures(makeTask({ description: "read the file" }));
  results.push(assertEqual(plain.ambiguityTier, 0, "plain description → tier 0"));

  const oneKw = extractNamedFeatures(makeTask({ description: "design a new component" }));
  results.push(assertEqual(oneKw.ambiguityTier, 1, "one ambiguous keyword → tier 1"));

  const twoKw = extractNamedFeatures(makeTask({ description: "propose and improve the component" }));
  results.push(assertEqual(twoKw.ambiguityTier, 2, "two keywords → tier 2"));

  const threeKw = extractNamedFeatures(
    makeTask({ description: "propose design architecture refactor" })
  );
  results.push(assertEqual(threeKw.ambiguityTier, 3, "three+ keywords → tier 3"));

  // ── Description length bucket ──────────────────────────────────────────────
  const shortDesc  = extractNamedFeatures(makeTask({ description: "short" }));  // 5 chars
  results.push(assertEqual(shortDesc.descriptionLength, 0, "len 5 → bucket 0"));

  const medDesc    = extractNamedFeatures(makeTask({ description: "a".repeat(60) }));
  results.push(assertEqual(medDesc.descriptionLength, 2, "len 60 → bucket 2"));

  const longDesc   = extractNamedFeatures(makeTask({ description: "a".repeat(200) }));
  results.push(assertEqual(longDesc.descriptionLength, 4, "len 200 → bucket 4"));

  // ── DIAGNOSE kind produces expected defaults ───────────────────────────────
  const diag = extractNamedFeatures(makeTask({ kind: "DIAGNOSE" }));
  results.push(assertEqual(diag.reasoningLevel,  3, "DIAGNOSE → reasoningLevel=3"));
  results.push(assertEqual(diag.generationLevel, 2, "DIAGNOSE → generationLevel=2"));

  // ── DESIGN kind ────────────────────────────────────────────────────────────
  const design = extractNamedFeatures(makeTask({ kind: "DESIGN" }));
  results.push(assertEqual(design.reasoningLevel,  3, "DESIGN → reasoningLevel=3"));
  results.push(assertEqual(design.generationLevel, 3, "DESIGN → generationLevel=3"));

  // ── SEARCH kind produces zeros for AI features ─────────────────────────────
  const search = extractNamedFeatures(makeTask({ kind: "SEARCH" }));
  results.push(assertEqual(search.reasoningLevel,  0, "SEARCH → reasoningLevel=0"));
  results.push(assertEqual(search.generationLevel, 0, "SEARCH → generationLevel=0"));

  return results;
}
