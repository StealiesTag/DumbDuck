// ─────────────────────────────────────────────────────────────────────────────
// MCP Tool Schemas
//
// Defines the JSON Schema for every MCP tool exposed by the server.
// Used by the server for ListTools responses and for documentation.
// ─────────────────────────────────────────────────────────────────────────────

export const TOOL_SCHEMAS = [
  {
    name:        "set_workspace",
    description: "Set the workspace root directory. All file operations are scoped to this directory. Call this first before using any file or git tools.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type:        "string",
          description: "Absolute path to the workspace root directory.",
        },
      },
      required: ["path"],
    },
  },
  {
    name:        "list_files",
    description: "List files and directories under a workspace-relative path. Requires set_workspace.",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type:        "string",
          description: "Workspace-relative directory path (default: '.').",
        },
      },
    },
  },
  {
    name:        "read_file",
    description: "Read the contents of a workspace-relative file. Text files only; max 512 KB. Requires set_workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type:        "string",
          description: "Workspace-relative path to the file.",
        },
      },
      required: ["path"],
    },
  },
  {
    name:        "search_repository",
    description: "Search for a text pattern across workspace source files. Excludes node_modules, .git, build directories. Returns file:line matches. Requires set_workspace.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type:        "string",
          description: "Text pattern to search for (plain string, not regex).",
        },
        directory: {
          type:        "string",
          description: "Workspace-relative subdirectory to search in (default: '.').",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name:        "get_git_status",
    description: "Get the git status of the workspace repository. Returns a message if git is unavailable or the directory is not a repository. Requires set_workspace.",
    inputSchema: {
      type:       "object",
      properties: {},
    },
  },
  {
    name:        "get_git_diff",
    description: "Get the current git diff of the workspace (read-only). Requires set_workspace.",
    inputSchema: {
      type: "object",
      properties: {
        staged: {
          type:        "boolean",
          description: "If true, return the staged diff. Default: false (unstaged).",
        },
      },
    },
  },
  {
    name:        "run_tests",
    description: "Run an approved pre-configured test suite in the workspace. Only approved suite names are accepted; arbitrary commands are rejected. Requires set_workspace.",
    inputSchema: {
      type: "object",
      properties: {
        suite: {
          type:        "string",
          description: "Approved suite name: 'npm-test' | 'npm-test-ci' | 'vitest' | 'jest' | 'pytest'.",
        },
      },
      required: ["suite"],
    },
  },
  {
    name:        "route_task",
    description: "Route a task through the AI Execution Router. Classifies as DETERMINISTIC, SIMPLE_AI, or COMPLEX_AI. Executes deterministic tasks locally, sends simple tasks to the configured lightweight AI model (mock by default), and returns complex tasks as DELEGATED to the originating agent.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type:        "string",
          description: "Unique task ID (auto-generated if omitted).",
        },
        description: {
          type:        "string",
          description: "Human-readable task description.",
        },
        kind: {
          type:        "string",
          enum:        ["SEARCH", "READ_FILE", "CALCULATION", "RUN_TESTS", "SUMMARIZE", "DIAGNOSE", "DESIGN", "UNKNOWN"],
          description: "Task kind. Used by capability matching and feature extraction.",
        },
        originatingAgent: {
          type:        "string",
          description: "Identifier of the agent or client submitting the task (e.g. 'bob', 'cli').",
        },
        filesInvolved: {
          type:        "array",
          items:       { type: "string" },
          description: "File paths relevant to the task.",
        },
        errorMessage: {
          type:        "string",
          description: "Error message or stack trace to include as context.",
        },
        codeSnippet: {
          type:        "string",
          description: "Code snippet to include as context.",
        },
        taskArgs: {
          type:        "object",
          description: "Additional arguments passed to the executor (e.g. { pattern: 'TODO' }).",
        },
      },
      required: ["description"],
    },
  },
  {
    name:        "get_execution_report",
    description: "Return a JSON summary of all tasks routed in this session: counts by route and status, AI call counts, token usage (if any), and duration.",
    inputSchema: {
      type:       "object",
      properties: {},
    },
  },
];
