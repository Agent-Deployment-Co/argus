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

export type AgentSource = "claude" | "codex" | "gemini" | "cowork";

export type SessionRow = Omit<SchemaSessionRow, "source"> & {
  source: AgentSource;
  /** CLI-only (#38): per-session health, stripped by the server until the contract adopts it. */
  health: SessionHealth;
};

/**
 * Per-session health metrics (#38), derived in aggregate.ts from messages + SessionFriction.
 * Friction-derived fields are null when the session's source doesn't expose friction
 * (codex/gemini/AgentsView imports) — distinct from an observed zero.
 */
export interface SessionHealth {
  interruptions: number | null;
  rejections: number | null;
  compactions: number | null;
  turns: number | null;
  medianTurnMs: number | null;
  maxTurnMs: number | null;
  /** Assistant stop_reason counts — the agentic (tool_use) vs conversational (end_turn) mix. */
  stopReasons: Record<string, number> | null;
  /**
   * Tokens-per-message growth within the session: mean total tokens of the last decile of
   * messages over the first decile. High values flag sessions that got expensive late and
   * might have been better restarted. Null when the session is too short (<10 messages).
   */
  tokenGrowth: number | null;
  /**
   * How the session ended: "interrupted" when the final activity was a user interruption,
   * "clean" when the last recorded stop reason is end_turn/stop_sequence, else "unknown"
   * (mid-tool-use tails — possibly still running — and sources without stop reasons).
   */
  outcome: "clean" | "interrupted" | "unknown";
}

/** Cross-session friction rollup over sessions where friction is observable. */
export interface FrictionTotals {
  observableSessions: number;
  interruptions: number;
  rejections: number;
  compactions: number;
  turns: number;
}

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
  frictionTotals: FrictionTotals;
  /** Per-model token totals per day — parallel to `daily`, for the stacked model-over-time chart. */
  byModelDaily: { date: string; byModel: Record<string, number> }[];
  /** Per-skill token totals per day — parallel to `daily`, for the skill-usage-over-time chart. */
  bySkillDaily: { date: string; bySkill: Record<string, number> }[];
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
  /** Assistant stop_reason (claude only) — first non-null across the message's streamed lines. */
  stopReason?: string;
  toolUses: ToolUse[];
}

/** Approximate token weight of tool *results* (output dumped back into context), per tool name. */
export interface ToolResultStat {
  count: number;
  approxTokens: number;
}

/**
 * Session-level friction counters (#37), parsed from native Claude Code transcripts.
 * Undefined means "not observable for this session" (codex/gemini/AgentsView-imported),
 * which is distinct from a Claude session that simply had zero friction.
 */
export interface SessionFriction {
  /** User pressed Escape: "[Request interrupted by user]" (plain or "for tool use"). */
  interruptions: number;
  /** Tool uses the user declined at the permission prompt. */
  rejections: number;
  /** Context compactions observed in the transcript. */
  compactions: number;
  /** Completed turns (system/turn_duration records). */
  turns: number;
  /** Wall-clock duration of each completed turn, in transcript order. */
  turnDurationsMs: number[];
  /** Assistant stop_reason counts, one per deduped assistant message. */
  stopReasons: Record<string, number>;
  /** Timestamp of the latest interruption, when records carry timestamps (#38 outcome proxy). */
  lastInterruptionMs?: number;
}

export function emptySessionFriction(): SessionFriction {
  return {
    interruptions: 0,
    rejections: 0,
    compactions: 0,
    turns: 0,
    turnDurationsMs: [],
    stopReasons: {},
  };
}

export interface SessionMeta {
  source: AgentSource;
  sessionId: string;
  project: string;
  cwd: string;
  filePath: string; // transcript path, for on-demand LLM summarization
  firstPrompt?: string;
  /** Present only for sessions parsed from native Claude transcripts. */
  friction?: SessionFriction;
}

export interface ParseResult {
  messages: MessageRecord[];
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
