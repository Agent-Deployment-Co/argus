// Data model for argus. The stable wire-contract types come from the shared schema package.
// Local dashboard types extend that contract with fields this CLI can emit ahead of a schema
// package release.
// CLI-internal parsing types (MessageRecord, ParseResult, …) are defined locally below.
import type {
  Dashboard as SchemaDashboard,
  NamedUsage,
  SessionRow as SchemaSessionRow,
  Usage,
} from "@agentdeploymentco/argus-schema";
import type { ToolCategory } from "./tool-categories.ts";
export type {
  DayBucket,
  NamedUsage,
  PluginRow,
  Usage,
} from "@agentdeploymentco/argus-schema";
export type { ToolCategory } from "./tool-categories.ts";

export type AgentSource = "claude" | "codex" | "gemini";

export type CapabilityType = "skill" | "tool" | "mcp";
export type CapabilityOutcome = "success" | "failure" | "partial" | "unknown";
export type CapabilityAssessmentBasis = "unassessed" | "observed" | "inferred";
export type CapabilityFailureType =
  | "authentication"
  | "authorization"
  | "timeout"
  | "not_found"
  | "invalid_input"
  | "missing_dependency"
  | "unsupported_operation"
  | "user_correction"
  | "abandoned"
  | "unknown";
export type CapabilityEvidenceKind =
  | "invocation"
  | "result"
  | "error"
  | "status"
  | "user_correction"
  | "semantic";

export interface CapabilityRef {
  type: CapabilityType;
  /** Stable source-level identity: skill name, raw tool name, or raw MCP tool name. */
  name: string;
  displayName: string;
  /** The source transcript's tool name, including Skill/activate_skill wrappers. */
  toolName: string;
  skill?: string;
  mcpServer?: string;
  mcpTool?: string;
}

export interface CapabilityEvidence {
  kind: CapabilityEvidenceKind;
  /** Whether the evidence came directly from a transcript or from later inference. */
  basis: Exclude<CapabilityAssessmentBasis, "unassessed">;
  /** Sanitized, single-line, bounded text. Never store raw argument/result objects here. */
  summary: string;
  timestamp?: number;
}

export type CapabilityEvidenceInput = Omit<CapabilityEvidence, "summary"> & {
  summary: unknown;
};

export interface CapabilityEvent {
  id: string;
  source: AgentSource;
  sessionId: string;
  project: string;
  timestamp: number;
  invocationId?: string;
  capability: CapabilityRef;
  action?: string;
  outcome: CapabilityOutcome;
  failureType?: CapabilityFailureType;
  assessmentBasis: CapabilityAssessmentBasis;
  /** 0 for unassessed events; otherwise a value from 0 to 1. */
  confidence: number;
  durationMs?: number;
  retryOf?: string;
  evidence: CapabilityEvidence[];
}

export type CapabilityEventInput = Omit<CapabilityEvent, "evidence"> & {
  evidence: CapabilityEvidenceInput[];
};

export type SessionRow = SchemaSessionRow & {
  source: AgentSource;
};

/** Per-tool usage ranking: call count and distinct sessions. */
export interface ToolStat {
  name: string;
  category: ToolCategory;
  /** Display label — `server · tool` for MCP tools, else the raw name. */
  display: string;
  calls: number;
  sessions: number;
  approxResultTokens: number;
}

/** Tool calls folded by category. */
export interface ToolCategoryStat {
  category: ToolCategory;
  label: string;
  calls: number;
  tools: number; // distinct tool names in this category
  sessions: number; // distinct sessions touching this category
  approxResultTokens: number;
}

export type Dashboard = Omit<SchemaDashboard, "sessions"> & {
  bySource: NamedUsage[];
  sessions: SessionRow[];
  // CLI-only fields emitted ahead of a schema-package release (stripped on push until the
  // wire contract adopts them).
  byTool: ToolStat[];
  byToolCategory: ToolCategoryStat[];
};

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

export function addUsage(a: Usage, b: Usage): void {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite5m += b.cacheWrite5m;
  a.cacheWrite1h += b.cacheWrite1h;
}

export function totalTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

/** A single tool invocation extracted from an assistant message's content. */
export interface ToolUse {
  /** Raw tool name, e.g. "Bash", "Skill", "mcp__fathom__search_meetings". */
  name: string;
  /** Source-level invocation ID used to correlate later results and errors. */
  invocationId?: string;
  /** Invocation timestamp when the source records it separately from token usage. */
  timestamp?: number;
  /** Canonical category, e.g. "file-io", "mcp", "skill". */
  category: ToolCategory;
  /** For name === "Skill": the invoked skill, e.g. "jj:jj". */
  skill?: string;
  /** For Skill invocations: the (truncated) args string. */
  args?: string;
  /** For MCP tools (`mcp__<server>__<tool>`): the server segment. */
  mcpServer?: string;
  /** For MCP tools: the tool segment (everything after `mcp__<server>__`). */
  mcpTool?: string;
  /** For file tools (Edit/Write/Read/NotebookEdit): the target path. */
  filePath?: string;
}

/** One assistant message — the unit that carries token usage + skill attribution. */
export interface MessageRecord {
  source: AgentSource;
  sessionId: string;
  project: string; // human label, e.g. "gw/webapp"
  cwd: string;
  gitBranch: string;
  ts: number; // epoch ms
  date: string; // YYYY-MM-DD (local)
  model: string;
  usage: Usage;
  attributionSkill: string | null; // skill active for this message
  toolUses: ToolUse[];
}

/** Approximate token weight of tool *results* (output dumped back into context), per tool name. */
export interface ToolResultStat {
  count: number;
  approxTokens: number;
}

export interface SessionMeta {
  source: AgentSource;
  sessionId: string;
  project: string;
  cwd: string;
  filePath: string; // transcript path, for on-demand LLM summarization
  firstPrompt?: string;
}

export interface ParseResult {
  messages: MessageRecord[];
  /** Source-neutral capability invocations and their current outcome assessments. */
  capabilityEvents: CapabilityEvent[];
  /** sessionId -> metadata */
  sessions: Map<string, SessionMeta>;
  /** full tool name -> result-token stats */
  toolResults: Map<string, ToolResultStat>;
}

export interface PluginInfo {
  name: string; // e.g. "gw-github"
  marketplace: string; // e.g. "dubmart"
  enabled: boolean;
  installedAt?: string;
  version?: string;
}
