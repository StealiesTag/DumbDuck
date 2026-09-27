# models/

This directory holds the trained decision tree model exported by `training/train.py`.

## Expected file

`decision_tree.json` — exported after running the Python training script.

## How to generate it

```powershell
cd training
pip install -r requirements.txt
python train.py
```

The TypeScript application loads this file at startup. If it is absent, the
classifier falls back to the built-in heuristic and prints a clear warning.

## What the file contains

```json
{
  "version": "1.0",
  "trained_at": "...",
  "feature_names": ["reasoningLevel", ...],
  "class_labels": ["SIMPLE_AI", "COMPLEX_AI"],
  "max_depth": 4,
  "tree": { ... }
}
```

The `feature_names` array must match `FEATURE_NAMES` in `src/types.ts` exactly.
If you update features, retrain and replace this file.
