import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SESSION_ANALYSIS_CACHE_FILE } from "./paths.ts";
import { toolDisplayName } from "./tool-categories.ts";
import type { MessageRecord, SessionMeta, SessionRow, ToolUse } from "./types.ts";

const CACHE_VERSION = 2;

export type SessionOutcome = "success" | "partial" | "failed" | "unknown";

export interface SessionToolBreakdown {
  name: string;
  display: string;
  category: string;
  calls: number;
}

export interface SessionSkillBreakdown {
  name: string;
  calls: number;
  messages: number;
}

export interface SessionMcpServerBreakdown {
  server: string;
  calls: number;
  topTools: { tool: string; count: number }[];
}

export interface SessionAnalysis {
  version: number;
  sessionId: string;
  source: string;
  project: string;
  sessionLogPath: string;
  title: string;
  attempted: string;
  outcome: SessionOutcome;
  outcomeReason: string;
  generatedAtMs: number;
  generatedBy: "claude" | "heuristic";
  start: number;
  end: number;
  durationMs: number;
  messages: number;
  models: string[];
  totalTokens: number;
  cost: number;
  firstPrompt: string;
  tools: SessionToolBreakdown[];
  skills: SessionSkillBreakdown[];
  mcpServers: SessionMcpServerBreakdown[];
  filesTouched: string[];
}

interface CacheEntry {
  version: number;
  lastTs: number;
  analysis: SessionAnalysis;
}

interface SessionAnalysisCache {
  version: number;
  entries: Record<string, CacheEntry>;
}

export interface AnalyzeSessionOptions {
  row: SessionRow;
  meta?: SessionMeta;
  messages: MessageRecord[];
  model?: string;
  refresh?: boolean;
  useLlm?: boolean;
  cacheFile?: string;
  log?: (message: string) => void;
}

export interface AnalyzeSessionResult {
  analysis: SessionAnalysis;
  fromCache: boolean;
}

export interface CachedSessionAnalysisOptions {
  row: SessionRow;
  messages: MessageRecord[];
  cacheFile?: string;
}

interface CondensedTranscript {
  body: string;
  lastUserText: string;
  finalAssistantText: string;
  finalToolResultText: string;
}

function truncate(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 1))}...` : normalized;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const value = part as Record<string, unknown>;
      if (typeof value.text === "string") return value.text;
      if (typeof value.content === "string") return value.content;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function compactJson(value: unknown, limit = 220): string {
  if (value == null) return "";
  if (typeof value === "string") return truncate(value, limit);
  try {
    return truncate(JSON.stringify(value), limit);
  } catch {
    return "";
  }
}

function appendTranscriptRecord(record: any, lines: string[], state: CondensedTranscript): void {
  const payload = record?.payload ?? {};

  if (record?.type === "user") {
    const content = record.message?.content ?? record.content;
    const text = textFromContent(content);
    if (text && !text.startsWith("<")) {
      const value = truncate(text, 500);
      lines.push(`USER: ${value}`);
      state.lastUserText = value;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object" || (part as any).type !== "tool_result") continue;
        const result = compactJson((part as any).content, 420);
        if (result) {
          lines.push(`TOOL RESULT: ${result}`);
          state.finalToolResultText = result;
        }
      }
    }
    return;
  }

  if (record?.type === "assistant") {
    const content = record.message?.content ?? record.content;
    const text = textFromContent(content);
    if (text) {
      const value = truncate(text, 500);
      lines.push(`ASSISTANT: ${value}`);
      state.finalAssistantText = value;
    }
    if (Array.isArray(content)) {
      const tools = content
        .filter((part: any) => part?.type === "tool_use" && typeof part.name === "string")
        .map((part: any) => part.name);
      if (tools.length) lines.push(`TOOLS: ${tools.join(", ")}`);
    }
    return;
  }

  if (record?.type === "response_item") {
    if (payload.type === "message") {
      const text = textFromContent(payload.content);
      if (!text) return;
      const value = truncate(text, 500);
      if (payload.role === "user") {
        lines.push(`USER: ${value}`);
        state.lastUserText = value;
      } else {
        lines.push(`ASSISTANT: ${value}`);
        state.finalAssistantText = value;
      }
      return;
    }
    if (
      (payload.type === "function_call" || payload.type === "custom_tool_call") &&
      typeof payload.name === "string"
    ) {
      lines.push(`TOOLS: ${payload.name}`);
      return;
    }
    if (typeof payload.type === "string" && payload.type.endsWith("_call")) {
      lines.push(`TOOLS: ${payload.name ?? payload.type}`);
      return;
    }
    if (typeof payload.type === "string" && payload.type.endsWith("_output")) {
      const result = compactJson(payload.output ?? payload.result ?? payload.tools, 420);
      if (result) {
        lines.push(`TOOL RESULT: ${result}`);
        state.finalToolResultText = result;
      }
      return;
    }
  }

  if (record?.type === "gemini") {
    const text = textFromContent(record.content);
    if (text) {
      const value = truncate(text, 500);
      lines.push(`ASSISTANT: ${value}`);
      state.finalAssistantText = value;
    }
    if (Array.isArray(record.toolCalls)) {
      const tools = record.toolCalls
        .filter((call: any) => typeof call?.name === "string")
        .map((call: any) => call.name);
      if (tools.length) lines.push(`TOOLS: ${tools.join(", ")}`);
      const lastResult = [...record.toolCalls].reverse().find((call: any) => Object.hasOwn(call ?? {}, "result"));
      if (lastResult) {
        const result = compactJson(lastResult.result, 420);
        if (result) {
          lines.push(`TOOL RESULT: ${result}`);
          state.finalToolResultText = result;
        }
      }
    }
    return;
  }

  if (record?.type === "user" || payload.role === "user") {
    const text = textFromContent(record.content ?? payload.content);
    if (text) {
      const value = truncate(text, 500);
      lines.push(`USER: ${value}`);
      state.lastUserText = value;
    }
  }
}

export function condenseSessionTranscript(filePath: string | undefined, limitChars = 12000): CondensedTranscript {
  const state: CondensedTranscript = {
    body: "",
    lastUserText: "",
    finalAssistantText: "",
    finalToolResultText: "",
  };
  if (!filePath) return state;

  let raw = "";
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return state;
  }

  const lines: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.messages)) {
      for (const message of parsed.messages) appendTranscriptRecord(message, lines, state);
    } else {
      appendTranscriptRecord(parsed, lines, state);
    }
  } catch {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (Array.isArray(record?.$set?.messages)) {
          for (const message of record.$set.messages) appendTranscriptRecord(message, lines, state);
        } else {
          appendTranscriptRecord(record, lines, state);
        }
      } catch {
        // Skip malformed transcript lines.
      }
    }
  }

  const joined = lines.join("\n");
  if (joined.length <= limitChars) {
    state.body = joined;
    return state;
  }
  const headLength = Math.floor(limitChars * 0.6);
  const tailLength = Math.floor(limitChars * 0.4);
  state.body = `${joined.slice(0, headLength)}\n...\n${joined.slice(joined.length - tailLength)}`;
  return state;
}

function readCache(cacheFile: string): SessionAnalysisCache {
  try {
    const parsed = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : undefined;
    if (parsed?.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === "object") {
      return parsed as SessionAnalysisCache;
    }
  } catch {
    // Corrupt caches are ignored and replaced on write.
  }
  return { version: CACHE_VERSION, entries: {} };
}

function writeCache(cacheFile: string, cache: SessionAnalysisCache): void {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  } catch {
    // Best-effort cache.
  }
}

function cacheKey(row: SessionRow): string {
  return `${row.source}:${row.sessionId}`;
}

function latestTimestamp(row: SessionRow, messages: MessageRecord[]): number {
  return messages.reduce((latest, message) => Math.max(latest, message.ts), row.end);
}

function reusableCacheEntry(
  cached: CacheEntry | undefined,
  row: SessionRow,
  lastTs: number,
): cached is CacheEntry {
  return cached?.version === CACHE_VERSION &&
    cached.lastTs === lastTs &&
    cached.analysis.firstPrompt === row.firstPrompt;
}

function allToolUses(messages: MessageRecord[]): ToolUse[] {
  return messages.flatMap((message) => message.toolUses);
}

function toolBreakdown(messages: MessageRecord[]): SessionToolBreakdown[] {
  const counts = new Map<string, { tool: ToolUse; calls: number }>();
  for (const tool of allToolUses(messages)) {
    const current = counts.get(tool.name) ?? { tool, calls: 0 };
    current.calls++;
    counts.set(tool.name, current);
  }
  return [...counts.values()]
    .map(({ tool, calls }) => ({
      name: tool.name,
      display: toolDisplayName(tool.name),
      category: tool.category,
      calls,
    }))
    .sort((a, b) => b.calls - a.calls || a.display.localeCompare(b.display));
}

function skillBreakdown(messages: MessageRecord[]): SessionSkillBreakdown[] {
  const counts = new Map<string, { calls: number; messages: number }>();
  for (const message of messages) {
    if (message.attributionSkill) {
      const current = counts.get(message.attributionSkill) ?? { calls: 0, messages: 0 };
      current.messages++;
      counts.set(message.attributionSkill, current);
    }
    for (const tool of message.toolUses) {
      if (!tool.skill) continue;
      const current = counts.get(tool.skill) ?? { calls: 0, messages: 0 };
      current.calls++;
      counts.set(tool.skill, current);
    }
  }
  return [...counts.entries()]
    .map(([name, values]) => ({ name, ...values }))
    .sort((a, b) => b.calls + b.messages - (a.calls + a.messages) || a.name.localeCompare(b.name));
}

function mcpServerBreakdown(messages: MessageRecord[]): SessionMcpServerBreakdown[] {
  const counts = new Map<string, { calls: number; tools: Map<string, number> }>();
  for (const tool of allToolUses(messages)) {
    if (!tool.mcpServer) continue;
    const current = counts.get(tool.mcpServer) ?? { calls: 0, tools: new Map<string, number>() };
    current.calls++;
    current.tools.set(tool.mcpTool ?? tool.name, (current.tools.get(tool.mcpTool ?? tool.name) ?? 0) + 1);
    counts.set(tool.mcpServer, current);
  }
  return [...counts.entries()]
    .map(([server, values]) => ({
      server,
      calls: values.calls,
      topTools: [...values.tools.entries()]
        .map(([tool, count]) => ({ tool, count }))
        .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
        .slice(0, 5),
    }))
    .sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server));
}

function titleFromPrompt(prompt: string, fallback: string): string {
  const source = prompt || fallback;
  const firstLine = source.split(/\r?\n/).find((line) => line.trim()) ?? "Session analysis";
  const cleaned = firstLine
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\b(please|can you|could you|would you)\b[:,]?\s*/i, "")
    .trim();
  return truncate(cleaned || "Session analysis", 64);
}

function inferOutcome(row: SessionRow, transcript: CondensedTranscript): { outcome: SessionOutcome; reason: string } {
  const tail = `${transcript.finalAssistantText}\n${transcript.finalToolResultText}`.toLowerCase();
  if (row.health.outcome === "interrupted") {
    return {
      outcome: "partial",
      reason: "The last observable session activity was a user interruption, so completion is uncertain.",
    };
  }
  if (/\b(all tests pass|tests passed|checks pass|done|completed|implemented|fixed|successfully|wrote|updated)\b/.test(tail)) {
    return {
      outcome: "success",
      reason: "The transcript ends with language or tool output indicating the work completed successfully.",
    };
  }
  if (/\b(failed|error|exception|blocked|unable|cannot|can't|did not|didn't|rejected)\b/.test(tail)) {
    return {
      outcome: row.health.outcome === "clean" ? "partial" : "failed",
      reason: "The transcript ends with error or blocked-work language, so the requested work was not clearly completed.",
    };
  }
  if (row.health.outcome === "clean") {
    return {
      outcome: "unknown",
      reason: "The session ended cleanly, but the transcript does not contain enough outcome evidence.",
    };
  }
  return {
    outcome: "unknown",
    reason: "Argus does not have enough final-turn evidence to determine whether the session succeeded.",
  };
}

function heuristicAttempt(row: SessionRow, transcript: CondensedTranscript): string {
  const prompt = row.firstPrompt || transcript.lastUserText;
  if (prompt) return `The user appears to have asked the agent to ${truncate(prompt, 180)}`;
  if (row.summary) return truncate(row.summary, 220);
  return "The user's goal is not clear from the available transcript metadata.";
}

function baseAnalysis(
  row: SessionRow,
  meta: SessionMeta | undefined,
  messages: MessageRecord[],
  transcript: CondensedTranscript,
): SessionAnalysis {
  const outcome = inferOutcome(row, transcript);
  return {
    version: CACHE_VERSION,
    sessionId: row.sessionId,
    source: row.source,
    project: row.project,
    sessionLogPath: meta?.filePath ?? "",
    title: titleFromPrompt(row.firstPrompt, row.summary),
    attempted: heuristicAttempt(row, transcript),
    outcome: outcome.outcome,
    outcomeReason: outcome.reason,
    generatedAtMs: Date.now(),
    generatedBy: "heuristic",
    start: row.start,
    end: row.end,
    durationMs: row.durationMs,
    messages: row.messages,
    models: row.models,
    totalTokens: row.total,
    cost: row.cost,
    firstPrompt: row.firstPrompt,
    tools: toolBreakdown(messages),
    skills: skillBreakdown(messages),
    mcpServers: mcpServerBreakdown(messages),
    filesTouched: row.filesTouched,
  };
}

function extractJsonObject(value: string): unknown {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function normalizeOutcome(value: unknown): SessionOutcome | undefined {
  return value === "success" || value === "partial" || value === "failed" || value === "unknown"
    ? value
    : undefined;
}

function llmAnalysis(
  base: SessionAnalysis,
  transcript: CondensedTranscript,
  model: string | undefined,
  log: ((message: string) => void) | undefined,
): SessionAnalysis | undefined {
  if (!transcript.body) return undefined;

  const facts = {
    sessionId: base.sessionId,
    source: base.source,
    project: base.project,
    firstPrompt: base.firstPrompt,
    healthOutcome: base.outcome,
    tools: base.tools.map((tool) => ({ name: tool.display, calls: tool.calls, category: tool.category })),
    skills: base.skills,
    mcpServers: base.mcpServers,
    filesTouched: base.filesTouched.slice(0, 20),
  };
  const prompt =
    "Analyze this coding-agent session. Return JSON only with these string fields: " +
    'title, attempted, outcome, outcomeReason. "outcome" must be one of success, partial, failed, unknown. ' +
    "Use short, plain language. The title should be easy to understand and at most 8 words. " +
    "Base the outcome only on transcript evidence; use unknown when unclear.\n\n" +
    `FACTS:\n${JSON.stringify(facts, null, 2)}\n\nTRANSCRIPT:\n${transcript.body}`;
  const args = ["-p", prompt];
  if (model) args.push("--model", model);
  const res = spawnSync("claude", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (res.status !== 0 || !res.stdout?.trim()) {
    log?.(`  ! session analysis failed (${res.stderr?.trim()?.slice(0, 100) || "no output"})`);
    return undefined;
  }
  const parsed = extractJsonObject(res.stdout);
  if (!parsed || typeof parsed !== "object") {
    log?.("  ! session analysis returned non-JSON output; using heuristic analysis.");
    return undefined;
  }
  const object = parsed as Record<string, unknown>;
  const outcome = normalizeOutcome(object.outcome);
  if (
    typeof object.title !== "string" ||
    typeof object.attempted !== "string" ||
    !outcome ||
    typeof object.outcomeReason !== "string"
  ) {
    log?.("  ! session analysis JSON was missing required fields; using heuristic analysis.");
    return undefined;
  }
  return {
    ...base,
    title: truncate(object.title, 80),
    attempted: truncate(object.attempted, 500),
    outcome,
    outcomeReason: truncate(object.outcomeReason, 500),
    generatedAtMs: Date.now(),
    generatedBy: "claude",
  };
}

function claudeAvailable(): boolean {
  const res = spawnSync("claude", ["--version"], { encoding: "utf8" });
  return res.status === 0;
}

export function cachedSessionAnalysis(opts: CachedSessionAnalysisOptions): SessionAnalysis | undefined {
  const cache = readCache(opts.cacheFile ?? SESSION_ANALYSIS_CACHE_FILE);
  const cached = cache.entries[cacheKey(opts.row)];
  if (!reusableCacheEntry(cached, opts.row, latestTimestamp(opts.row, opts.messages))) return undefined;
  return cached.analysis;
}

export function analyzeSession(opts: AnalyzeSessionOptions): AnalyzeSessionResult {
  const cacheFile = opts.cacheFile ?? SESSION_ANALYSIS_CACHE_FILE;
  const lastTs = latestTimestamp(opts.row, opts.messages);
  const key = cacheKey(opts.row);
  const useLlm = opts.useLlm ?? true;
  const cache = readCache(cacheFile);
  const cached = cache.entries[key];

  let canUseClaude = false;
  if (useLlm && (!cached || cached.analysis.generatedBy !== "claude" || opts.refresh)) {
    canUseClaude = claudeAvailable();
  }

  if (
    !opts.refresh &&
    reusableCacheEntry(cached, opts.row, lastTs) &&
    ((!useLlm && cached.analysis.generatedBy === "heuristic") ||
      (useLlm && (cached.analysis.generatedBy === "claude" || !canUseClaude)))
  ) {
    return { analysis: cached.analysis, fromCache: true };
  }

  const transcript = condenseSessionTranscript(opts.meta?.filePath);
  const base = baseAnalysis(opts.row, opts.meta, opts.messages, transcript);
  const analysis = useLlm && canUseClaude
    ? llmAnalysis(base, transcript, opts.model, opts.log) ?? base
    : base;

  cache.entries[key] = { version: CACHE_VERSION, lastTs, analysis };
  writeCache(cacheFile, cache);
  return { analysis, fromCache: false };
}

function formatDateTime(ms: number): string {
  if (!ms) return "(unknown)";
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatMoney(value: number): string {
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

function listLines<T>(items: T[], render: (item: T) => string, empty = "  (none)"): string {
  if (!items.length) return empty;
  return items.map((item) => `  ${render(item)}`).join("\n");
}

export function formatSessionAnalysis(analysis: SessionAnalysis, fromCache = false): string {
  const lines = [
    "Session Analysis",
    `Title: ${analysis.title}`,
    `Outcome: ${analysis.outcome}`,
    `Session: ${analysis.sessionId}`,
    `Log: ${analysis.sessionLogPath || "(unknown)"}`,
    `Source: ${analysis.source}`,
    `Project: ${analysis.project}`,
    `Time: ${formatDateTime(analysis.start)} to ${formatDateTime(analysis.end)} (${formatDuration(analysis.durationMs)})`,
    `Usage: ${analysis.messages} messages, ${analysis.totalTokens.toLocaleString()} tokens, ${formatMoney(analysis.cost)}`,
    `Generated: ${analysis.generatedBy}${fromCache ? " (cached)" : ""}`,
    "",
    "Attempted",
    analysis.attempted,
    "",
    "Result",
    analysis.outcomeReason,
    "",
    "Tool Calls",
    listLines(analysis.tools, (tool) => `${tool.calls} x ${tool.display} (${tool.category})`),
    "",
    "Skills",
    listLines(
      analysis.skills,
      (skill) => `${skill.name}: ${skill.calls} calls, ${skill.messages} attributed messages`,
    ),
    "",
    "MCP Servers",
    listLines(
      analysis.mcpServers,
      (server) =>
        `${server.server}: ${server.calls} calls` +
        (server.topTools.length
          ? ` (${server.topTools.map((tool) => `${tool.tool} x ${tool.count}`).join(", ")})`
          : ""),
    ),
  ];
  if (analysis.filesTouched.length) {
    lines.push("", "Files Touched", listLines(analysis.filesTouched.slice(0, 20), (file) => file));
  }
  return `${lines.join("\n")}\n`;
}
