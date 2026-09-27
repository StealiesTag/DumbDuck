# AI Execution Router

A TypeScript/Node.js prototype that routes individual AI agent tasks to the cheapest execution method capable of completing them.

---

## 1. What the project does

When an AI agent works on a user request, it typically decomposes the request into many small tasks — search a file, read a config, calculate a value, summarise an error, diagnose a bug, design a change.

The **AI Execution Router** intercepts each task and assigns it to one of three execution tiers:

| Tier | Label | Description |
|------|-------|-------------|
| 0 | `DETERMINISTIC` | Solved by a local program/tool — no AI at all |
| 1 | `SIMPLE_AI` | Solved by a lightweight / cheap language model |
| 2 | `COMPLEX_AI` | Solved by a powerful language model |

The goal: **avoid spending AI tokens on tasks that don't need them**.

---

## 2. Why task-level routing is different from classifying an entire prompt

A common approach is to look at a whole user message ("is this hard or easy?") and send the entire conversation to one model tier.

This project takes a finer-grained view. A single user request often contains a mix of subtasks at very different complexity levels:

```
User: "Find all TODO comments, read the config, then diagnose the crash in auth"
          │                    │                  └─ COMPLEX_AI  (multi-file reasoning)
          │                    └──────────────────── DETERMINISTIC (file read)
          └───────────────────────────────────────── DETERMINISTIC (text search)
```

Routing the entire conversation to `COMPLEX_AI` wastes tokens on trivial subtasks.
Routing it to `SIMPLE_AI` may fail on the hard subtask.
**Per-task routing** uses the right resource for each piece of work.

---

## 3. Architecture

```
src/
├── index.ts              Entry point — runs the mock agent and router
├── types.ts              All shared types (Task, Route, TaskFeatures, …)
│
├── agent/
│   └── mockAgent.ts      Simulates an AI agent producing 7 observable tasks
│
├── router/
│   ├── features.ts       Extracts a feature vector from a Task
│   ├── classifier.ts     Scores features → selects a Route
│   └── router.ts         Orchestrates classify → log → execute → summarise
│
├── executors/
│   ├── deterministic.ts  Dispatches to local tools (no AI)
│   ├── simpleAI.ts       Placeholder for a lightweight model
│   └── complexAI.ts      Placeholder for a powerful model
│
└── tools/
    ├── searchFiles.ts    Walks the filesystem looking for a pattern
    ├── readFile.ts       Reads a file from disk
    ├── calculator.ts     Parses and evaluates arithmetic expressions
    └── runTests.ts       Mocked test-suite runner
```

Data flows in one direction:

```
Task → features.ts → classifier.ts → router.ts → executor → ExecutionResult
```

---

## 4. DETERMINISTIC vs SIMPLE_AI vs COMPLEX_AI

### DETERMINISTIC
- A known local tool can fully answer the task.
- Examples: file search, file read, arithmetic, running tests.
- Zero AI tokens consumed.
- Fast and perfectly reproducible.

### SIMPLE_AI
- No local tool can handle the task, but the task is narrow and well-defined.
- Low reasoning requirement, small context, low ambiguity.
- Examples: summarising a short error message, rephrasing a sentence.
- A small / cheap model (e.g. a 7B parameter model, or a low-cost API tier) is sufficient.

### COMPLEX_AI
- The task requires deep multi-step reasoning, open-ended generation, or spans many files.
- Examples: diagnosing a race condition across five modules, designing a new architecture.
- A powerful model (e.g. GPT-4-class, Claude Opus) is needed.

---

## 5. How the heuristic classifier works

The classifier is entirely rule-based — no AI is used to classify tasks.

### Step 1 — deterministic fast path
If the task's `kind` is one of `SEARCH | READ_FILE | CALCULATION | RUN_TESTS`,
the classifier immediately returns `DETERMINISTIC` without computing a score.

### Step 2 — feature extraction (`features.ts`)
For all other task kinds, the classifier builds a `TaskFeatures` object:

| Feature | How it is inferred |
|---------|-------------------|
| `deterministicAvailable` | Task kind is in the deterministic set |
| `requiresLanguageUnderstanding` | Lookup table keyed by task kind |
| `reasoningLevel` (0–3) | Lookup table keyed by task kind |
| `generationLevel` (0–3) | Lookup table keyed by task kind |
| `contextSize` (none/small/medium/large) | Number of files + presence of error/code |
| `ambiguityLevel` (none/low/medium/high) | Count of vague keywords in description |
| `filesInvolved` | Length of `context.filesInvolved` array |

### Step 3 — scoring (`classifier.ts`)
```
complexityScore =
    reasoningLevel  × 2
  + generationLevel × 2
  + contextTier     × 1   (none=0, small=1, medium=2, large=3)
  + ambiguityTier   × 1   (none=0, low=1, medium=2, high=3)
  + filesInvolved   × 0.5
```

All weights are defined in `CLASSIFIER_CONFIG` in `classifier.ts`.
Thresholds are also there:

```typescript
thresholds: { simpleAiMax: 6 }
// score < 6  → SIMPLE_AI
// score ≥ 6  → COMPLEX_AI
```

> **Important:** these weights are a starting heuristic, not scientifically validated values.
> They are intentionally centralised so you can tune them as you collect real data.

### Step 4 — result
The classifier returns a `ClassificationResult`:

```json
{
  "route": "COMPLEX_AI",
  "score": 9.5,
  "features": { "reasoningLevel": 3, "filesInvolved": 5, ... },
  "reasons": [
    "Requires deep multi-step reasoning",
    "Multiple files involved (5)",
    "Context size is medium"
  ]
}
```

---

## 6. How to run the project

### Prerequisites
- Node.js 18+
- npm

### Install
```bash
cd ai-execution-router
npm install
```

### Run the main demo
```bash
npm start
```

You will see the mock agent's 7 tasks classified, routed, and executed, followed by a routing summary.

### Run the classifier tests
```bash
npm test
```

Runs 7 test cases and reports pass/fail. Exits with code 1 if any test fails.

---

## 7. What is mocked vs real

| Component | Status | Notes |
|-----------|--------|-------|
| `mockAgent.ts` | **Mock** | Returns a hard-coded list of 7 tasks |
| `searchFiles.ts` | **Real** | Walks the actual filesystem using Node `fs` |
| `readFile.ts` | **Real** | Reads actual files from disk |
| `calculator.ts` | **Real** | Parses and evaluates arithmetic without `eval()` |
| `runTests.ts` | **Mock** | Returns a fixed result — wire up a real runner later |
| `classifier.ts` | **Real (rule-based)** | No AI used — fully deterministic heuristic |
| `simpleAI.ts` | **Mock** | Returns a labelled placeholder string |
| `complexAI.ts` | **Mock** | Returns a labelled placeholder string |

---

## 8. Future plan for real AI integration and benchmarking

### Replacing the AI executors
Both `simpleAI.ts` and `complexAI.ts` have a clearly labelled `// Placeholder` block.
To wire up a real model, install its SDK and replace that block:

```typescript
// Example — replacing simpleAI.ts with OpenAI
import OpenAI from "openai";
const client = new OpenAI();
const resp = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: task.description }],
});
output = resp.choices[0].message.content ?? "";
```

The router, classifier, and all other code stay unchanged.

### Replacing the mock agent
Swap `getMockTasks()` in `index.ts` for a real agent integration that emits
observable tool-call events (e.g. from LangChain, AutoGen, CrewAI, or a custom agent loop).

### Improving the classifier
- Collect real routing decisions + outcomes.
- Measure which classifications were wrong (task succeeded / failed / was too expensive).
- Use that data to tune `CLASSIFIER_CONFIG` weights and thresholds.
- Later: replace the rule-based classifier with a small trained model if the rule base becomes too complex.

### Adding real cost measurement
- Record actual token counts returned by the model SDKs.
- Store them alongside each `ExecutionResult`.
- Add a pricing table (cost per 1k tokens per model).
- Compute real dollar savings: `deterministicTaskCount × averageTokenCostIfAIWasUsed`.
