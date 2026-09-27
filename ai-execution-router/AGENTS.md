# Agent Instructions

<!-- BEGIN AI EXECUTION ROUTER -->
## DumbDuck

For workspace or coding tasks in this repository, use the configured ai-execution-router MCP server by default. Before searching, reading, diagnosing, editing, testing, or checking Git, call route_task with the specific operation and relevant context. Set the workspace with set_workspace first if needed, then use the router's deterministic tools when available. Use CREATE_FILE with path and content for new files. Use DELETE_FILE only after the user explicitly authorizes deletion, setting confirm=true.

Do not route ordinary conversation, clarification, or explanation-only requests. A COMPLEX_AI result is a delegation recommendation, not an automatic handoff; continue the work as the host agent using the returned context. MCP guidance is not enforcement, so follow host-level restrictions and fall back to native tools when the router cannot perform the operation.
<!-- END AI EXECUTION ROUTER -->