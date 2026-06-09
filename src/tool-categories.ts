// Tool + MCP-server parsing, ported to match cc-lens (Arindam200/cc-lens, lib/tool-categories.ts)
// so argus categorizes tools and splits MCP server/tool names the same way. This is the single
// source of truth for "what category is this tool" and "what server/tool does this mcp__ name
// refer to" — used by both the parser (parse.ts) and the aggregator (aggregate.ts).

export type ToolCategory =
  | "file-io"
  | "shell"
  | "agent"
  | "web"
  | "planning"
  | "todo"
  | "skill"
  | "mcp"
  | "other";

/** Built-in tool → category. Mirrors cc-lens's TOOL_CATEGORIES map. */
export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  Read: "file-io",
  Write: "file-io",
  Edit: "file-io",
  MultiEdit: "file-io",
  Glob: "file-io",
  Grep: "file-io",
  NotebookEdit: "file-io",
  read_file: "file-io",
  read_many_files: "file-io",
  write_file: "file-io",
  replace: "file-io",
  glob: "file-io",
  grep_search: "file-io",

  Bash: "shell",
  run_shell_command: "shell",

  Task: "agent",
  Agent: "agent",
  TaskCreate: "agent",
  TaskUpdate: "agent",
  TaskList: "agent",
  TaskOutput: "agent",
  TaskStop: "agent",
  TaskGet: "agent",
  invoke_agent: "agent",
  complete_task: "agent",

  WebSearch: "web",
  WebFetch: "web",
  google_web_search: "web",
  get_internal_docs: "web",

  EnterPlanMode: "planning",
  ExitPlanMode: "planning",
  AskUserQuestion: "planning",
  update_topic: "planning",

  TodoWrite: "todo",

  Skill: "skill",
  ToolSearch: "skill",
  ListMcpResourcesTool: "skill",
  ReadMcpResourceTool: "skill",
  activate_skill: "skill",
};

export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  "file-io": "File I/O",
  shell: "Shell",
  agent: "Agents",
  web: "Web",
  planning: "Planning",
  todo: "Todo",
  skill: "Skills",
  mcp: "MCP",
  other: "Other",
};

/** A tool name is an MCP tool iff it starts with the `mcp__` prefix (cc-lens semantics). */
export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

/**
 * Classify a tool name into a category. MCP tools (`mcp__server__tool`) are always "mcp";
 * built-ins resolve via TOOL_CATEGORIES; anything else (custom/unknown) is "other".
 */
export function categorizeTool(name: string): ToolCategory {
  if (isMcpTool(name)) return "mcp";
  return TOOL_CATEGORIES[name] ?? "other";
}

/**
 * Split an `mcp__<server>__<tool>` name into its server and tool parts, matching cc-lens.
 * Requires at least 3 `__`-delimited segments; the tool part keeps any further `__` (e.g.
 * `mcp__srv__a__b` → { server: "srv", tool: "a__b" }). Returns null for non-MCP or malformed names.
 */
export function parseMcpTool(name: string): { server: string; tool: string } | null {
  if (!isMcpTool(name)) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  return { server: parts[1]!, tool: parts.slice(2).join("__") };
}

/** Human-friendly tool label: `server · tool` for MCP tools, otherwise the raw name. */
export function toolDisplayName(name: string): string {
  const mcp = parseMcpTool(name);
  return mcp ? `${mcp.server} · ${mcp.tool}` : name;
}
