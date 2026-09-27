// ─────────────────────────────────────────────────────────────────────────────
// Executor: Deterministic
//
// Dispatches tasks to the appropriate local tool based on task.kind.
// No AI model is called here under any circumstance.
// ─────────────────────────────────────────────────────────────────────────────

import * as path from "path";
import { Task, ExecutionResult } from "../types";
import { searchFiles }          from "../tools/searchFiles";
import { readFile }             from "../tools/readFile";
import { calculate }            from "../tools/calculator";
import { runTests }             from "../tools/runTests";

export function runDeterministic(task: Task): ExecutionResult {
  const start = Date.now();
  let output: string;

  switch (task.kind) {
    case "SEARCH": {
      const pattern = String(task.args.pattern ?? "TODO");
      const root    = String(task.args.root ?? process.cwd());
      const results = searchFiles(pattern, root);
      if (results.length === 0) {
        output = `Search for "${pattern}": no matches found.`;
      } else {
        const preview = results
          .slice(0, 5)
          .map((r) => `  ${path.relative(process.cwd(), r.file)}:${r.line}  ${r.content}`)
          .join("\n");
        const more = results.length > 5 ? `\n  … and ${results.length - 5} more` : "";
        output = `Search for "${pattern}" — ${results.length} match(es):\n${preview}${more}`;
      }
      break;
    }

    case "READ_FILE": {
      const filePath = String(task.args.path ?? "package.json");
      const content  = readFile(filePath);
      // Truncate long files to keep log readable
      const preview  = content.length > 500 ? content.slice(0, 500) + "\n… (truncated)" : content;
      output = `Contents of "${filePath}":\n${preview}`;
      break;
    }

    case "CALCULATION": {
      const expr   = String(task.args.expression ?? "0");
      const result = calculate(expr);
      output = result.error
        ? `Calculation error: ${result.error}`
        : `${result.expression} = ${result.result}`;
      break;
    }

    case "RUN_TESTS": {
      const label  = String(task.args.suite ?? "default");
      const result = runTests(label);
      output = result.summary;
      break;
    }

    default:
      output = `[Deterministic executor] No tool registered for kind "${task.kind}"`;
  }

  return {
    taskId:     task.id,
    route:      "DETERMINISTIC",
    output,
    durationMs: Date.now() - start,
  };
}
