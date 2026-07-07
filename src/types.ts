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
import type { TaskFact } from "./store/store-contract.ts";
import type { ToolCategory } from "./tool-categories.ts";
export type {
  DayBucket,
  NamedUsage,
  PluginRow,
  Usage,
} from "@agentdeploymentco/argus-schema";
export type { ToolCategory } from "./tool-categories.ts";

export type AgentSource = "claude" | "codex" | "gemini" | "cowork" | "claude-chat";

/** The set of agent sources Argus can index. Alias of AgentSource, used where a value names a
 *  transcript source to collect (CLI flags, discovery options). */
export type TranscriptSource = AgentSource;

export type SessionRow = Omit<SchemaSessionRow, "source"> & {
  source: AgentSource;
  /** CLI-only: raw user-message count when the source exposes it. */
  userMessages: number | null;
  /** CLI-only: raw agent-message count when the source exposes it. */
  agentMessages: number | null;
  /** CLI-only: raw turn count when the source exposes it. */
  rawTurns: number | null;
  /** CLI-only (#38): per-session health, stripped by the server until the contract adopts it. */
  health: SessionHealth;
  /** CLI-only: tasks generated for this session via session interpretation. */
  tasks?: TaskFact[];
  /** CLI-only (#234): the model-generated session title, when interpreted; null otherwise. Not on the
   *  sync wire (`summary` already is; `title` stays local), stripped on push like `tasks`/`health`. */
  title?: string | null;
  /** CLI-only (#234): whether session interpretation has run for this session. Lets the UI show "No
   *  tasks found." (ran, produced none) vs "Interpretation pending." (not yet run). */
  interpreted?: boolean;
};

/**
 * Per-session health metrics (#38), derived in aggregate.ts from messages, source-owned counters,
 * and SessionFriction. Friction-derived fields are null when the session's source doesn't expose
 * friction — distinct from an observed zero.
 */
export interface SessionHealth {
  interruptions: number | null;
  rejections: number | null;
  compactions: number | null;
  /** Raw turns when source-owned counters exist, otherwise friction-observed turns if available. */
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
  /** Count of sessions whose context grew ≥ 5× start-to-finish — the token-growth recommendation's
   *  input, kept as a scalar so it survives even when the per-session array is omitted from the payload. */
  highTokenGrowthSessions: number;
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
  /** Approx token weight of this call's paired tool *result* (output dumped back into context),
   *  summed across the result(s) correlated to this call. Absent/0 when no result resolved to this
   *  call. The call+result unit (#130) — backs byTool/heaviestToolResults result-size GROUP BYs. */
  approxResultTokens?: number;
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
  /** Owning interaction's seq within its session (#122), as resolved_interactions.seq — the usage
   *  row attributes to this interaction. Absent for a turn that precedes the session's first prompt
   *  (no open interaction); reconcile derives it from the interaction spine. */
  interactionSeq?: number;
  toolUses: ToolUse[];
}

/** Approximate token weight of tool *results* (output dumped back into context), per tool name. */
export interface ToolResultStat {
  count: number;
  approxTokens: number;
}

/**
 * Session-level friction counters (#37), parsed from native Claude Code transcripts.
 * Undefined means "not observable for this session" (codex/gemini),
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
  /** Raw user-message events observed in this session, when the source exposes them. */
  userMessages?: number;
  /** Raw agent-message events observed in this session, when the source exposes them. */
  agentMessages?: number;
  /** Raw conversational turns observed in this session, when the source exposes them. */
  rawTurns?: number;
  /** Present only for sessions parsed from native Claude transcripts. */
  friction?: SessionFriction;
}

export interface ParseResult {
  messages: MessageRecord[];
  /** sessionId -> metadata */
  sessions: Map<string, SessionMeta>;
  /** full tool name -> result-token stats */
  toolResults: Map<string, ToolResultStat>;
  /** sessionId -> generated tasks */
  tasksBySession?: Map<string, TaskFact[]>;
}

export interface PluginInfo {
  name: string; // e.g. "gw-github"
  marketplace: string; // e.g. "dubmart"
  enabled: boolean;
  installedAt?: string;
  version?: string;
}
