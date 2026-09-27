#!/usr/bin/env python3
"""
train.py — Train and export a decision tree classifier for the AI Execution Router.

Usage:
    cd training
    pip install -r requirements.txt
    python train.py

Output:
    ../models/decision_tree.json   — model artifact loaded by TypeScript at runtime
    eval_report.txt                — evaluation metrics and notes

IMPORTANT NOTES
───────────────
- This script trains on a SMALL, HUMAN-LABELLED dataset (< 50 rows).
- Results reflect how well the tree fits this specific set of examples.
- DO NOT interpret training or test accuracy as production-readiness.
- The tree is intentionally shallow (max_depth=4) to avoid overfitting the tiny dataset.
- Retrain whenever features change (see FEATURE_COLUMNS below).
"""

import json
import os
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.tree import DecisionTreeClassifier
from sklearn.model_selection import train_test_split, StratifiedKFold
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
)

# ── Paths ─────────────────────────────────────────────────────────────────────

SCRIPT_DIR   = Path(__file__).parent
DATASET_PATH = SCRIPT_DIR / "dataset.csv"
MODEL_DIR    = SCRIPT_DIR / ".." / "models"
MODEL_PATH   = MODEL_DIR  / "decision_tree.json"
REPORT_PATH  = SCRIPT_DIR / "eval_report.txt"

# ── Feature column order ──────────────────────────────────────────────────────
# CRITICAL: This MUST match FEATURE_NAMES in src/types.ts exactly.
# If you change this list, also update src/types.ts and src/router/features.ts.

FEATURE_COLUMNS = [
    "reasoningLevel",
    "generationLevel",
    "contextSizeTier",
    "ambiguityTier",
    "filesInvolved",
    "hasErrorMessage",
    "hasCodeSnippet",
    "descriptionLength",
]

LABEL_COLUMN = "label"
CLASS_LABELS = ["SIMPLE_AI", "COMPLEX_AI"]

# ── Hyperparameters ────────────────────────────────────────────────────────────
# Keep tree shallow to avoid overfitting on the small dataset.

MAX_DEPTH   = 4
RANDOM_SEED = 42
TEST_SIZE   = 0.25   # 25% held out for evaluation

# ── Helpers ───────────────────────────────────────────────────────────────────

def load_dataset(path: Path) -> pd.DataFrame:
    """Load CSV, skipping comment lines starting with #."""
    rows = []
    header = None
    with open(path, "r") as f:
        for line in f:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if header is None:
                header = stripped.split(",")
            else:
                rows.append(stripped.split(","))
    if header is None:
        raise ValueError(f"Dataset at {path} appears empty or has no header.")
    df = pd.DataFrame(rows, columns=header)
    return df


def validate_dataset(df: pd.DataFrame) -> None:
    """Check required columns and label values."""
    missing = [c for c in FEATURE_COLUMNS + [LABEL_COLUMN] if c not in df.columns]
    if missing:
        raise ValueError(f"Dataset is missing columns: {missing}")

    invalid_labels = df[~df[LABEL_COLUMN].isin(CLASS_LABELS)][LABEL_COLUMN].unique()
    if len(invalid_labels) > 0:
        raise ValueError(
            f"Unexpected labels found: {invalid_labels}. Expected: {CLASS_LABELS}"
        )


def export_node(tree, node_id: int, class_names: list) -> dict:
    """Recursively convert an sklearn tree node to a JSON-serialisable dict."""
    feature_index = int(tree.feature[node_id])
    threshold     = float(tree.threshold[node_id])
    left_child    = int(tree.children_left[node_id])
    right_child   = int(tree.children_right[node_id])

    # Leaf node: sklearn uses TREE_UNDEFINED = -2 for feature index
    is_leaf = (feature_index == -2)

    node: dict = {
        "feature_index": feature_index,
        "threshold":     threshold,
        "left":          None,
        "right":         None,
    }

    if is_leaf:
        # Class with the highest sample count wins
        class_counts = {
            class_names[i]: int(tree.value[node_id][0][i])
            for i in range(len(class_names))
        }
        winning_class = max(class_counts, key=lambda k: class_counts[k])
        node["class_label"]  = winning_class
        node["class_counts"] = class_counts
    else:
        node["left"]  = export_node(tree, left_child,  class_names)
        node["right"] = export_node(tree, right_child, class_names)

    return node


def export_model(clf: DecisionTreeClassifier, class_names: list) -> dict:
    """Serialise the trained tree to a JSON-compatible dict."""
    sklearn_tree = clf.tree_
    return {
        "version":       "1.0",
        "trained_at":    datetime.now(timezone.utc).isoformat(),
        "feature_names": FEATURE_COLUMNS,
        "class_labels":  CLASS_LABELS,
        "max_depth":     int(clf.max_depth) if clf.max_depth is not None else MAX_DEPTH,
        "tree":          export_node(sklearn_tree, 0, class_names),
    }


def write_report(lines: list, path: Path) -> None:
    content = "\n".join(lines)
    path.write_text(content, encoding="utf-8")
    print(content)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    print("=" * 60)
    print("AI Execution Router — Decision Tree Training")
    print("=" * 60)

    # ── Load and validate ──────────────────────────────────────────────────────
    if not DATASET_PATH.exists():
        print(f"ERROR: Dataset not found at {DATASET_PATH}", file=sys.stderr)
        sys.exit(1)

    df = load_dataset(DATASET_PATH)
    validate_dataset(df)

    n_total = len(df)
    counts  = df[LABEL_COLUMN].value_counts().to_dict()
    print(f"\nDataset loaded: {n_total} rows")
    for cls in CLASS_LABELS:
        print(f"  {cls}: {counts.get(cls, 0)}")

    # ── Small-dataset warning ──────────────────────────────────────────────────
    if n_total < 30:
        warnings.warn(
            f"\n⚠  Dataset is very small ({n_total} rows). "
            "Evaluation metrics are unreliable. "
            "Results should not be used to claim model accuracy.",
            stacklevel=1,
        )

    # ── Prepare features and labels ────────────────────────────────────────────
    X = df[FEATURE_COLUMNS].astype(float).to_numpy()
    y = df[LABEL_COLUMN].to_numpy()

    # ── Train / test split ─────────────────────────────────────────────────────
    min_class_count = min(counts.get(c, 0) for c in CLASS_LABELS)
    can_stratify    = min_class_count >= 2

    if can_stratify:
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=TEST_SIZE, random_state=RANDOM_SEED, stratify=y
        )
    else:
        warnings.warn(
            "Cannot stratify split (a class has < 2 samples). "
            "Using non-stratified split.",
            stacklevel=1,
        )
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=TEST_SIZE, random_state=RANDOM_SEED
        )

    print(f"\nTrain set: {len(X_train)} rows")
    print(f"Test  set: {len(X_test)}  rows")

    # ── Train ──────────────────────────────────────────────────────────────────
    clf = DecisionTreeClassifier(
        max_depth=MAX_DEPTH,
        random_state=RANDOM_SEED,
        class_weight="balanced",   # compensates for any class imbalance
    )
    clf.fit(X_train, y_train)

    # ── Evaluate on test set ───────────────────────────────────────────────────
    y_pred    = clf.predict(X_test)
    accuracy  = accuracy_score(y_test, y_pred)
    report    = classification_report(y_test, y_pred, labels=CLASS_LABELS, zero_division=0)
    cm        = confusion_matrix(y_test, y_pred, labels=CLASS_LABELS)

    # ── Also evaluate on full training set (to show potential overfitting) ─────
    train_accuracy = accuracy_score(y_train, clf.predict(X_train))

    # ── Cross-validation (only if dataset is big enough) ──────────────────────
    cv_note = ""
    if n_total >= 10 and can_stratify:
        n_splits  = min(5, min_class_count)
        kf        = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=RANDOM_SEED)
        cv_scores = []
        for train_idx, val_idx in kf.split(X, y):
            c = DecisionTreeClassifier(
                max_depth=MAX_DEPTH, random_state=RANDOM_SEED, class_weight="balanced"
            )
            c.fit(X[train_idx], y[train_idx])
            cv_scores.append(accuracy_score(y[val_idx], c.predict(X[val_idx])))
        cv_mean = float(np.mean(cv_scores))
        cv_std  = float(np.std(cv_scores))
        cv_note = (
            f"Cross-validation ({n_splits}-fold): "
            f"mean={cv_mean:.3f}, std={cv_std:.3f}\n"
        )
    else:
        cv_note = "Cross-validation skipped (dataset too small or class imbalance).\n"

    # ── Confusion matrix formatting ────────────────────────────────────────────
    cm_lines = [
        "Confusion matrix (rows=actual, cols=predicted):",
        f"               {CLASS_LABELS[0]:<14} {CLASS_LABELS[1]}",
    ]
    for i, row_label in enumerate(CLASS_LABELS):
        cm_lines.append(f"  {row_label:<14}  {cm[i][0]:<14} {cm[i][1]}")

    # ── Build report ───────────────────────────────────────────────────────────
    report_lines = [
        "=" * 60,
        "AI Execution Router — Training Evaluation Report",
        "=" * 60,
        f"Trained at:           {datetime.now(timezone.utc).isoformat()}",
        f"Dataset:              {DATASET_PATH.name}  ({n_total} rows)",
        f"Feature columns ({len(FEATURE_COLUMNS)}): {', '.join(FEATURE_COLUMNS)}",
        f"Class labels:         {CLASS_LABELS}",
        f"Max depth:            {MAX_DEPTH}",
        f"Random seed:          {RANDOM_SEED}",
        f"Test size:            {TEST_SIZE}",
        "",
        f"Train accuracy:       {train_accuracy:.3f}",
        f"Test  accuracy:       {accuracy:.3f}",
        "",
        cv_note.strip(),
        "",
        "Per-class metrics (test set):",
        report,
        "",
        *cm_lines,
        "",
        "=" * 60,
        "LIMITATIONS",
        "=" * 60,
        "- Labels are human-assigned policy labels, not empirical measurements.",
        f"- Dataset is small ({n_total} rows). Metrics may not generalise.",
        "- A decision tree is a simple baseline, not a production classifier.",
        "- Collect real routing decisions + outcomes before claiming improvements.",
        "=" * 60,
    ]

    write_report(report_lines, REPORT_PATH)

    # ── Export model ───────────────────────────────────────────────────────────
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    model_dict = export_model(clf, list(clf.classes_))
    with open(MODEL_PATH, "w", encoding="utf-8") as f:
        json.dump(model_dict, f, indent=2)

    print(f"\nModel exported to: {MODEL_PATH}")
    print(f"Report saved to:   {REPORT_PATH}")
    print("\nDone. Load the model by running: npm start")


if __name__ == "__main__":
    main()
