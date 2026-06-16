// parse.ts — the original monolithic, from-scratch parser, kept DELIBERATELY as a second, independent
// implementation that shares NO parsing code with the per-source adapter parsers in
// `producers/<source>/parser.ts`. It exists for two roles:
//
//   1. Test oracle. The producer pipeline is validated against this — tests assert
//      `parseAllIncrementalDetailed(...)` deep-equals `parseAll(...)`. Because the two implementations
//      share no parsing code, the same bug is unlikely to hide on both sides; that independence is the
//      whole point of an oracle, so the apparent duplication here is intentional, not accidental.
//   2. Fallback. When the store can't be opened/synced, `parseAllIncrementalDetailed` catches the error
//      and returns `parseAll(opts)`, so `argus report` still works with no store.
//
// So yes: this is largely a duplicate of the adapter parsers, on purpose. Unlike them it emits a flat
// `ParseResult` (messages + sessions + tool-result stats) directly, not the fragment/fact model the
// store is built from. It also owns the shared parse types/util the rest of the pipeline imports:
// `ParseOptions`, `TranscriptSource`, `projectLabel`.
//
// Open question (a separate decision, not this file's concern): keep the dual implementation, or derive
// the oracle from the producers. For now the independent cross-check + dependency-free fallback are
// worth the duplication.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { claudeFrictionEvents, foldFrictionEvents, type FrictionEvent } from "./friction.ts";
import { CODEX_SESSIONS_DIR, COWORK_SESSIONS_DIR, GEMINI_DIR, HISTORY_FILE, PROJECTS_DIR } from "./paths.ts";
import { categorizeTool, parseMcpTool } from "./tool-categories.ts";
import {
  emptyUsage,
  type AgentSource,
  type MessageRecord,
  type ParseResult,
  type SessionMeta,
  type ToolResultStat,
  type ToolUse,
  totalTokens,
  type Usage,
} from "./types.ts";

const FILE_TOOLS = new Set(["Edit", "Write", "Read", "NotebookEdit", "MultiEdit"]);

/** Start a ToolUse with canonical category and MCP server/tool parsing applied. */
function newToolUse(name: string): ToolUse {
  const tu: ToolUse = { name, category: categorizeTool(name) };
  const mcp = parseMcpTool(name);
  if (mcp) {
    tu.mcpServer = mcp.server;
    tu.mcpTool = mcp.tool;
  }
  return tu;
}

export type TranscriptSource = AgentSource;

export interface ParseOptions {
  projectsDir?: string;
  historyFile?: string;
  codexSessionsDir?: string;
  geminiDir?: string;
  coworkSessionsDir?: string;
  sources?: TranscriptSource[];
}

/** Recursively collect every .jsonl under a directory (handles subagents/ subdirs). */
function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walkJsonl(p));
    else if (name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** Last two path segments, e.g. /Users/mando/code/gw/webapp -> "gw/webapp". */
function projectLabel(cwd: string): string {
  if (!cwd) return "(unknown)";
  const parts = cwd.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
}

function localDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeUsage(raw: any): Usage {
  const u = emptyUsage();
  if (!raw) return u;
  u.input = raw.input_tokens || 0;
  u.output = raw.output_tokens || 0;
  u.cacheRead = raw.cache_read_input_tokens || 0;
  const cc = raw.cache_creation;
  if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
    u.cacheWrite5m = cc.ephemeral_5m_input_tokens || 0;
    u.cacheWrite1h = cc.ephemeral_1h_input_tokens || 0;
  } else {
    // Older transcripts only carry the total; treat as 5m (the common default).
    u.cacheWrite5m = raw.cache_creation_input_tokens || 0;
  }
  return u;
}

function normalizeCodexUsage(raw: any): Usage {
  const u = emptyUsage();
  if (!raw) return u;
  const input = raw.input_tokens || 0;
  const cached = raw.cached_input_tokens || 0;
  u.input = Math.max(input - cached, 0);
  u.cacheRead = cached;
  u.output = raw.output_tokens || 0;

  // Older imported Codex entries can carry only total_tokens. Keep them visible rather
  // than dropping the turn entirely, but leave them unpriced if the model is unknown.
  if (totalTokens(u) === 0 && raw.total_tokens) u.input = raw.total_tokens;
  return u;
}

function normalizeGeminiUsage(raw: any): Usage {
  const u = emptyUsage();
  if (!raw) return u;
  const input = Number(raw.input ?? raw.promptTokenCount) || 0;
  const cached = Number(raw.cached ?? raw.cachedContentTokenCount) || 0;
  u.input = Math.max(input - cached, 0);
  u.cacheRead = cached;
  u.output =
    (Number(raw.output ?? raw.candidatesTokenCount) || 0) +
    (Number(raw.thoughts ?? raw.thoughtsTokenCount) || 0) +
    (Number(raw.tool ?? raw.toolUsePromptTokenCount) || 0);

  if (totalTokens(u) === 0 && raw.total) u.input = Number(raw.total) || 0;
  return u;
}

function estimateTokens(content: unknown): number {
  // Rough heuristic: ~4 chars per token. Used only for *approximate* result-size weighting.
  let chars = 0;
  if (typeof content === "string") {
    chars = content.length;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") chars += part.length;
      else if (part && typeof part === "object" && typeof (part as any).text === "string")
        chars += (part as any).text.length;
      else chars += JSON.stringify(part).length;
    }
  } else if (content != null) {
    chars = JSON.stringify(content).length;
  }
  return Math.round(chars / 4);
}

function toolUsesFrom(content: any[]): ToolUse[] {
  const out: ToolUse[] = [];
  for (const part of content) {
    if (!part || part.type !== "tool_use" || typeof part.name !== "string") continue;
    const tu = newToolUse(part.name);
    const input = part.input ?? {};
    if (part.name === "Skill" && typeof input.skill === "string") {
      tu.skill = input.skill;
      if (typeof input.args === "string" && input.args) tu.args = input.args.slice(0, 280);
    }
    if (FILE_TOOLS.has(part.name) && typeof input.file_path === "string") {
      tu.filePath = input.file_path;
    }
    out.push(tu);
  }
  return out;
}

function parseJsonObject(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function textFromCodexContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as any).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 500);
}

function codexSessionId(filePath: string, meta: any): string {
  if (typeof meta?.id === "string" && meta.id) return meta.id;
  const name = basename(filePath, ".jsonl");
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1] || name;
}

function toolUseFromCodexCall(name: string, rawArgs: unknown): ToolUse {
  const args = parseJsonObject(rawArgs);
  const tu = newToolUse(name);
  if (name === "Skill" && typeof args.skill === "string") {
    tu.skill = args.skill;
    if (typeof args.args === "string" && args.args) tu.args = args.args.slice(0, 280);
  }
  const filePath = args.file_path ?? args.filePath ?? args.path;
  if (typeof filePath === "string" && filePath) tu.filePath = filePath;
  return tu;
}

function textFromGeminiContent(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 500);
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as any).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 500);
}

function toolUseFromGeminiCall(call: any): ToolUse | null {
  if (!call || typeof call.name !== "string" || !call.name) return null;
  const tu = newToolUse(call.name);
  const args = call.args && typeof call.args === "object" ? call.args : {};
  const filePath = args.file_path ?? args.filePath ?? args.path;
  if (typeof filePath === "string" && filePath) tu.filePath = filePath;
  if (call.name === "activate_skill") {
    const skill = args.skill ?? args.name;
    if (typeof skill === "string" && skill) {
      tu.skill = skill;
      tu.args = JSON.stringify(args).slice(0, 280);
    }
  }
  return tu;
}

interface GeminiConversation {
  sessionId: string;
  projectHash: string;
  startTime?: string;
  lastUpdated?: string;
  directories?: string[];
  messages: any[];
}

interface GeminiChatFile {
  filePath: string;
  projectDir: string;
}

function walkGeminiChatFiles(geminiDir: string): GeminiChatFile[] {
  const tmpDir = join(geminiDir, "tmp");
  let projects: string[];
  try {
    projects = readdirSync(tmpDir);
  } catch {
    return [];
  }

  const out: GeminiChatFile[] = [];
  const walk = (dir: string, projectDir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const filePath = join(dir, name);
      let st;
      try {
        st = statSync(filePath);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(filePath, projectDir);
      else if (name.endsWith(".json") || name.endsWith(".jsonl")) out.push({ filePath, projectDir });
    }
  };

  for (const project of projects) {
    const projectDir = join(tmpDir, project);
    let st;
    try {
      st = statSync(projectDir);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(join(projectDir, "chats"), projectDir);
  }
  return out;
}

function legacyGeminiConversation(raw: string): GeminiConversation | null {
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.sessionId !== "string" ||
      typeof value.projectHash !== "string" ||
      !Array.isArray(value.messages)
    ) {
      return null;
    }
    return value as GeminiConversation;
  } catch {
    return null;
  }
}

/** Replay Gemini CLI's append-only JSONL records into the current conversation state. */
function loadGeminiConversation(filePath: string): GeminiConversation | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  if (filePath.endsWith(".json")) return legacyGeminiConversation(raw);

  let metadata: Record<string, any> = {};
  const messages = new Map<string, any>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof record?.$rewindTo === "string") {
      let found = false;
      const remove: string[] = [];
      for (const id of messages.keys()) {
        if (id === record.$rewindTo) found = true;
        if (found) remove.push(id);
      }
      if (found) {
        for (const id of remove) messages.delete(id);
      } else {
        messages.clear();
      }
      continue;
    }

    if (typeof record?.id === "string") {
      // Gemini writes the same message again as tool calls complete. Map#set keeps its
      // original order while replacing the stale copy with the final version.
      messages.set(record.id, record);
      continue;
    }

    if (record?.$set && typeof record.$set === "object") {
      if (Array.isArray(record.$set.messages)) {
        messages.clear();
        for (const message of record.$set.messages) {
          if (typeof message?.id === "string") messages.set(message.id, message);
        }
      }
      metadata = { ...metadata, ...record.$set };
      continue;
    }

    if (typeof record?.sessionId === "string" && typeof record?.projectHash === "string") {
      metadata = { ...metadata, ...record };
      if (Array.isArray(record.messages)) {
        for (const message of record.messages) {
          if (typeof message?.id === "string") messages.set(message.id, message);
        }
      }
    }
  }

  if (typeof metadata.sessionId !== "string" || typeof metadata.projectHash !== "string") {
    return legacyGeminiConversation(raw);
  }
  return {
    sessionId: metadata.sessionId,
    projectHash: metadata.projectHash,
    startTime: metadata.startTime,
    lastUpdated: metadata.lastUpdated,
    directories: Array.isArray(metadata.directories) ? metadata.directories : undefined,
    messages: [...messages.values()],
  };
}

interface GeminiProjectLookup {
  bySlug: Map<string, string>;
  byHash: Map<string, string>;
}

function loadGeminiProjectLookup(geminiDir: string): GeminiProjectLookup {
  const lookup: GeminiProjectLookup = { bySlug: new Map(), byHash: new Map() };
  try {
    const registry = JSON.parse(readFileSync(join(geminiDir, "projects.json"), "utf8"));
    if (!registry?.projects || typeof registry.projects !== "object") return lookup;
    for (const [projectRoot, slug] of Object.entries(registry.projects)) {
      if (typeof slug !== "string") continue;
      lookup.bySlug.set(slug, projectRoot);
      lookup.byHash.set(createHash("sha256").update(projectRoot).digest("hex"), projectRoot);
    }
  } catch {
    // Older Gemini CLI installs only have hash-named project directories.
  }
  return lookup;
}

function geminiProjectRoot(
  projectDir: string,
  conversation: GeminiConversation,
  lookup: GeminiProjectLookup,
): string {
  try {
    const marker = readFileSync(join(projectDir, ".project_root"), "utf8").trim();
    if (marker) return marker;
  } catch {
    // Fall through to the registry and legacy hash lookup.
  }
  const dirName = basename(projectDir);
  const registered = lookup.bySlug.get(dirName) ?? lookup.byHash.get(conversation.projectHash);
  if (registered) return registered;
  const directory = conversation.directories?.find((value) => typeof value === "string" && isAbsolute(value));
  return directory || "";
}

function timestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return NaN;
  return Date.parse(value);
}

function normalizeSources(sources: TranscriptSource[] | undefined): TranscriptSource[] {
  if (!sources?.length) return ["claude"];
  return [...new Set(sources)];
}

/** Load every prompt from history.jsonl, grouped to the earliest per session. */
function loadPrompts(historyFile: string): Map<string, string> {
  const firstPrompt = new Map<string, { ts: number; text: string }>();
  if (!existsSync(historyFile)) return new Map();
  for (const line of readFileSync(historyFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      const sid: string | undefined = o.sessionId;
      const text: string | undefined = o.display;
      const ts: number = o.timestamp || 0;
      if (!sid || !text) continue;
      const prev = firstPrompt.get(sid);
      if (!prev || ts < prev.ts) firstPrompt.set(sid, { ts, text });
    } catch {
      // skip malformed line
    }
  }
  const out = new Map<string, string>();
  for (const [sid, v] of firstPrompt) out.set(sid, v.text);
  return out;
}

/** Parse session transcripts from one or more local agent stores. */
export function parseAll(opts: ParseOptions = {}): ParseResult {
  const sources = normalizeSources(opts.sources);
  const projectsDir = opts.projectsDir ?? PROJECTS_DIR;
  const codexSessionsDir = opts.codexSessionsDir ?? CODEX_SESSIONS_DIR;
  const geminiDir = opts.geminiDir ?? GEMINI_DIR;
  const messages: MessageRecord[] = [];
  const sessions = new Map<string, SessionMeta>();
  const toolResults = new Map<string, ToolResultStat>();
  const idToName = new Map<string, string>(); // tool_use id -> tool name (for result attribution)
  const prompts = sources.includes("claude") ? loadPrompts(opts.historyFile ?? HISTORY_FILE) : new Map<string, string>();
  // Resumed/compacted sessions re-append prior assistant messages verbatim. Dedup on the API
  // message id (first occurrence wins) so we don't multi-count tokens — same approach as ccusage.
  const seenMessageIds = new Set<string>();
  // Session friction (#37): events carry stable ids (record uuid / tool_use_id) so replayed
  // lines dedupe the same way; stop reasons are counted once per deduped assistant message.
  const frictionEventsBySession = new Map<string, FrictionEvent[]>();
  const seenFrictionEventIds = new Set<string>();
  const stopReasonsBySession = new Map<string, Record<string, number>>();
  const countStopReason = (sid: string, stopReason: string): void => {
    const counts = stopReasonsBySession.get(sid) ?? {};
    if (!stopReasonsBySession.has(sid)) stopReasonsBySession.set(sid, counts);
    counts[stopReason] = (counts[stopReason] ?? 0) + 1;
  };
  const missingRoots: string[] = [];
  let rootsFound = 0;

  const ensureSession = (
    sid: string,
    source: AgentSource,
    cwd: string,
    filePath: string,
    firstPrompt?: string,
  ): SessionMeta => {
    const existing = sessions.get(sid);
    if (!existing) {
      const meta: SessionMeta = {
        source,
        sessionId: sid,
        project: cwd ? projectLabel(cwd) : "(unknown)",
        cwd,
        filePath,
        firstPrompt,
      };
      sessions.set(sid, meta);
      return meta;
    }
    // cwd is only present on some line types — upgrade the label once we see a real one.
    if (!existing.cwd && cwd) {
      existing.cwd = cwd;
      existing.project = projectLabel(cwd);
    }
    if (!existing.firstPrompt && firstPrompt) existing.firstPrompt = firstPrompt;
    return existing;
  };

  if (sources.includes("claude")) {
    if (!existsSync(projectsDir)) {
      missingRoots.push(projectsDir);
    } else {
      rootsFound++;
      for (const filePath of walkJsonl(projectsDir)) {
        let raw: string;
        try {
          raw = readFileSync(filePath, "utf8");
        } catch {
          continue;
        }
        // Claude streams a single assistant message (one message.id) across multiple JSONL
        // lines — one content block per line (thinking, then text, then each tool_use) — and
        // repeats the identical usage on every line. We must count that usage once but collect
        // tool_uses from ALL of those lines. Track the message we're currently building so
        // continuation lines merge into it instead of being dropped. Reset per file so a
        // same-id message replayed in another file is treated as a replay, not a continuation.
        let openMsgId: string | null = null;
        let openRecord: MessageRecord | null = null;
        let openStopReasonPending = false;
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let o: any;
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          const sid: string | undefined = o.sessionId;
          if (!sid) continue;

          const cwd: string = o.cwd || "";
          const existing = ensureSession(sid, "claude", cwd, filePath, prompts.get(sid));
          // Prefer the main transcript over subagents/* files (used by the summarizer).
          if (filePath.endsWith(`${sid}.jsonl`)) existing.filePath = filePath;

          for (const event of claudeFrictionEvents(o)) {
            const key = `${event.kind} ${event.eventId}`;
            if (seenFrictionEventIds.has(key)) continue;
            seenFrictionEventIds.add(key);
            const events = frictionEventsBySession.get(sid) ?? [];
            if (!frictionEventsBySession.has(sid)) frictionEventsBySession.set(sid, events);
            events.push(event);
          }

          const content = o.message?.content;

          // First pass: register tool_use ids -> names (for result attribution).
          if (o.type === "assistant" && Array.isArray(content)) {
            for (const part of content) {
              if (part?.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") {
                idToName.set(part.id, part.name);
              }
            }
          }

          // Any non-assistant line (user turn, tool results, system) ends the assistant message
          // currently being assembled, so a later same-id line counts as a replay, not a continuation.
          if (o.type !== "assistant") {
            openMsgId = null;
            openRecord = null;
          }

          // Tool results live on user messages; attribute their size to the tool that produced them.
          if (o.type === "user" && Array.isArray(content)) {
            for (const part of content) {
              if (part?.type === "tool_result" && typeof part.tool_use_id === "string") {
                const name = idToName.get(part.tool_use_id);
                if (!name) continue;
                const stat = toolResults.get(name) || { count: 0, approxTokens: 0 };
                stat.count += 1;
                stat.approxTokens += estimateTokens(part.content);
                toolResults.set(name, stat);
              }
            }
          }

          // Assistant messages with usage are the unit of token + skill attribution.
          if (o.type === "assistant" && o.message?.usage && o.message?.model !== "<synthetic>") {
            const msgId: string | undefined = o.message?.id;
            // Continuation line of the message we're already building: merge its tool_uses,
            // but don't re-count the (repeated) usage. stop_reason streams as null until the
            // message's final line, so the continuation may be the first to carry it.
            if (msgId && msgId === openMsgId && openRecord) {
              if (openStopReasonPending && typeof o.message.stop_reason === "string") {
                countStopReason(sid, o.message.stop_reason);
                openRecord.stopReason = o.message.stop_reason;
                openStopReasonPending = false;
              }
              if (Array.isArray(content)) openRecord.toolUses.push(...toolUsesFrom(content));
              continue;
            }
            if (msgId && seenMessageIds.has(msgId)) continue; // replayed copy of a completed message
            const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
            if (Number.isNaN(ts)) continue;
            if (msgId) seenMessageIds.add(msgId);
            const rec: MessageRecord = {
              source: "claude",
              sessionId: sid,
              project: projectLabel(o.cwd || ""),
              cwd: o.cwd || "",
              gitBranch: o.gitBranch || "",
              ts,
              date: localDate(ts),
              model: o.message.model || "(unknown)",
              usage: normalizeUsage(o.message.usage),
              attributionSkill: o.attributionSkill ?? null,
              toolUses: Array.isArray(content) ? toolUsesFrom(content) : [],
            };
            messages.push(rec);
            openMsgId = msgId ?? null;
            openRecord = rec;
            if (typeof o.message.stop_reason === "string") {
              countStopReason(sid, o.message.stop_reason);
              rec.stopReason = o.message.stop_reason;
              openStopReasonPending = false;
            } else {
              openStopReasonPending = true;
            }
          }
        }
      }

      // Fold friction onto every native Claude session — zeros are meaningful here,
      // unlike codex/gemini sessions where friction stays undefined (not observable).
      for (const [sid, meta] of sessions) {
        if (meta.source !== "claude") continue;
        meta.friction = foldFrictionEvents(frictionEventsBySession.get(sid) ?? []);
        const stopReasons = stopReasonsBySession.get(sid);
        if (stopReasons) meta.friction.stopReasons = stopReasons;
      }
    }
  }

  if (sources.includes("codex")) {
    if (!existsSync(codexSessionsDir)) {
      missingRoots.push(codexSessionsDir);
    } else {
      rootsFound++;
      for (const filePath of walkJsonl(codexSessionsDir)) {
        let raw: string;
        try {
          raw = readFileSync(filePath, "utf8");
        } catch {
          continue;
        }
        let sid = "";
        let currentCwd = "";
        let currentModel = "(unknown)";
        let pendingToolUses: ToolUse[] = [];
        const callIdToName = new Map<string, string>();

        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let o: any;
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          const payload = o.payload ?? {};
          if (o.type === "session_meta") {
            sid = `codex:${codexSessionId(filePath, payload)}`;
            if (typeof payload.cwd === "string") currentCwd = payload.cwd;
            ensureSession(sid, "codex", currentCwd, filePath);
            continue;
          }

          if (!sid) sid = `codex:${codexSessionId(filePath, null)}`;

          if (o.type === "turn_context") {
            if (typeof payload.cwd === "string") currentCwd = payload.cwd;
            if (typeof payload.model === "string") currentModel = payload.model;
            ensureSession(sid, "codex", currentCwd, filePath);
            continue;
          }

          if (o.type === "response_item" && payload.type === "message" && payload.role === "user") {
            const prompt = textFromCodexContent(payload.content);
            if (prompt) ensureSession(sid, "codex", currentCwd, filePath, prompt);
            continue;
          }

          if (o.type === "response_item" && payload.type === "function_call" && typeof payload.name === "string") {
            pendingToolUses.push(toolUseFromCodexCall(payload.name, payload.arguments));
            if (typeof payload.call_id === "string") callIdToName.set(payload.call_id, payload.name);
            continue;
          }

          if (o.type === "response_item" && payload.type === "function_call_output" && typeof payload.call_id === "string") {
            const name = callIdToName.get(payload.call_id);
            if (!name) continue;
            const stat = toolResults.get(name) || { count: 0, approxTokens: 0 };
            stat.count += 1;
            stat.approxTokens += estimateTokens(payload.output);
            toolResults.set(name, stat);
            continue;
          }

          if (
            o.type === "response_item" &&
            typeof payload.type === "string" &&
            payload.type.endsWith("_call")
          ) {
            pendingToolUses.push(newToolUse(payload.type));
            continue;
          }

          if (o.type === "event_msg" && payload.type === "token_count") {
            const usage = normalizeCodexUsage(payload.info?.last_token_usage ?? payload.info?.total_token_usage);
            if (totalTokens(usage) === 0) {
              pendingToolUses = [];
              continue;
            }
            const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
            if (Number.isNaN(ts)) continue;
            const meta = ensureSession(sid, "codex", currentCwd, filePath);
            messages.push({
              source: "codex",
              sessionId: sid,
              project: projectLabel(currentCwd),
              cwd: currentCwd,
              gitBranch: "",
              ts,
              date: localDate(ts),
              model: currentModel,
              usage,
              attributionSkill: null,
              toolUses: pendingToolUses,
            });
            // Keep the session label useful if the first metadata row had no cwd.
            if (!meta.cwd && currentCwd) {
              meta.cwd = currentCwd;
              meta.project = projectLabel(currentCwd);
            }
            pendingToolUses = [];
          }
        }
      }
    }
  }

  if (sources.includes("gemini")) {
    const geminiTmpDir = join(geminiDir, "tmp");
    if (!existsSync(geminiTmpDir)) {
      missingRoots.push(geminiTmpDir);
    } else {
      rootsFound++;
      const lookup = loadGeminiProjectLookup(geminiDir);
      const conversations = new Map<
        string,
        { conversation: GeminiConversation; filePath: string; projectDir: string; jsonl: boolean; updated: number }
      >();

      // Migration can leave both session.json and session.jsonl behind. Keep one logical
      // conversation per session, preferring the replayable JSONL form and then the newest copy.
      for (const { filePath, projectDir } of walkGeminiChatFiles(geminiDir)) {
        const conversation = loadGeminiConversation(filePath);
        if (!conversation) continue;
        const candidate = {
          conversation,
          filePath,
          projectDir,
          jsonl: filePath.endsWith(".jsonl"),
          updated: timestampMs(conversation.lastUpdated),
        };
        const previous = conversations.get(conversation.sessionId);
        if (
          !previous ||
          (candidate.jsonl && !previous.jsonl) ||
          (candidate.jsonl === previous.jsonl &&
            (Number.isNaN(previous.updated) || candidate.updated > previous.updated))
        ) {
          conversations.set(conversation.sessionId, candidate);
        }
      }

      for (const { conversation, filePath, projectDir } of conversations.values()) {
        const sid = `gemini:${conversation.sessionId}`;
        const cwd = geminiProjectRoot(projectDir, conversation, lookup);
        const fallbackProject = `gemini/${basename(projectDir)}`;
        const firstPrompt = conversation.messages
          .filter((message) => message?.type === "user")
          .map((message) => textFromGeminiContent(message.content))
          .find(Boolean);
        const meta = ensureSession(sid, "gemini", cwd, filePath, firstPrompt);
        if (!cwd) meta.project = fallbackProject;

        for (const message of conversation.messages) {
          if (message?.type !== "gemini" || !message.tokens) continue;
          const usage = normalizeGeminiUsage(message.tokens);
          if (totalTokens(usage) === 0) continue;
          const ts = timestampMs(message.timestamp);
          if (Number.isNaN(ts)) continue;
          const toolUses: ToolUse[] = [];
          if (Array.isArray(message.toolCalls)) {
            for (const call of message.toolCalls) {
              const toolUse = toolUseFromGeminiCall(call);
              if (toolUse) toolUses.push(toolUse);
              if (!call || typeof call.name !== "string" || !Object.hasOwn(call, "result")) continue;
              const stat = toolResults.get(call.name) || { count: 0, approxTokens: 0 };
              stat.count += 1;
              stat.approxTokens += estimateTokens(call.result);
              toolResults.set(call.name, stat);
            }
          }
          messages.push({
            source: "gemini",
            sessionId: sid,
            project: cwd ? projectLabel(cwd) : fallbackProject,
            cwd,
            gitBranch: "",
            ts,
            date: localDate(ts),
            model: typeof message.model === "string" && message.model ? message.model : "(unknown)",
            usage,
            attributionSkill: null,
            toolUses,
          });
        }
      }
    }
  }

  if (sources.includes("cowork")) {
    const coworkDir = opts.coworkSessionsDir ?? COWORK_SESSIONS_DIR;
    if (!coworkDir || !existsSync(coworkDir)) {
      if (coworkDir) missingRoots.push(coworkDir);
    } else {
      rootsFound++;
      // Walk recursively for audit.jsonl files only (avoids other .jsonl files in the session dir).
      const auditFiles: string[] = [];
      const walkAudit = (dir: string): void => {
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }
        for (const name of entries) {
          const p = join(dir, name);
          let st;
          try {
            st = statSync(p);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            walkAudit(p);
          } else if (st.isFile() && name === "audit.jsonl") {
            auditFiles.push(p);
          }
        }
      };
      walkAudit(coworkDir);

      for (const filePath of auditFiles) {
        let raw: string;
        try {
          raw = readFileSync(filePath, "utf8");
        } catch {
          continue;
        }

        // Read sibling local_<id>.json for project info (one dir up from the local_* dir).
        const localDirName = basename(dirname(filePath));
        const teamDir = dirname(dirname(filePath));
        let coworkCwd = "";
        let coworkFallbackProject = "";
        try {
          const meta = JSON.parse(readFileSync(join(teamDir, `${localDirName}.json`), "utf8"));
          const folders: unknown[] = Array.isArray(meta.userSelectedFolders)
            ? meta.userSelectedFolders
            : [];
          const first = folders.find((f) => typeof f === "string");
          coworkCwd = typeof first === "string" ? first : "";
          if (!coworkCwd) {
            coworkFallbackProject =
              (typeof meta.title === "string" && meta.title) ||
              (typeof meta.processName === "string" && meta.processName) ||
              "";
          }
        } catch {
          // metadata unavailable — proceed with empty cwd
        }

        let sid = "";
        let seenInit = false;
        let currentModel = "(unknown)";
        let open: { msgId: string; record: MessageRecord } | undefined;

        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let o: any;
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }

          // thinking_tokens streaming events carry no useful data
          if (o.type === "system" && o.subtype === "thinking_tokens") continue;

          // system/init: first establishes session; subsequent reconnects are per-turn
          if (o.type === "system" && o.subtype === "init") {
            if (!seenInit) {
              seenInit = true;
              const innerSid =
                typeof o.session_id === "string" && o.session_id ? o.session_id : undefined;
              if (!innerSid) continue;
              sid = `cowork:${innerSid}`;
              if (typeof o.model === "string" && o.model) currentModel = o.model;
              const meta = ensureSession(sid, "cowork", coworkCwd, filePath);
              if (!coworkCwd && coworkFallbackProject) meta.project = coworkFallbackProject;
            }
            continue;
          }

          if (!sid) continue;

          // Bare queued user event (no isReplay, no timestamp) — skip
          if (o.type === "user" && o.isReplay !== true) continue;

          if (o.type !== "assistant") continue;

          const msgId =
            typeof o.message?.id === "string" && o.message.id ? o.message.id : undefined;

          // Multi-line streaming: same message ID = continuation of open record
          if (msgId && open !== undefined && open.msgId === msgId) {
            if (o.message?.usage) {
              const extra = normalizeUsage(o.message.usage);
              // Usage is repeated on each streaming line — last line is authoritative,
              // so replace rather than add to avoid double-counting.
              Object.assign(open.record.usage, extra);
            }
            if (typeof o.message?.stop_reason === "string" && !open.record.stopReason) {
              open.record.stopReason = o.message.stop_reason;
            }
            continue;
          }

          if (!o.message?.usage) continue;
          if (o.message?.model === "<synthetic>") continue;

          const ts = (() => {
            if (typeof o.timestamp === "string") return Date.parse(o.timestamp);
            if (
              typeof o._audit_timestamp === "string" &&
              o._audit_timestamp
            )
              return Date.parse(o._audit_timestamp);
            return NaN;
          })();
          if (Number.isNaN(ts)) continue;

          if (msgId && seenMessageIds.has(msgId)) continue;
          if (msgId) seenMessageIds.add(msgId);

          const model =
            typeof o.message?.model === "string" && o.message.model
              ? o.message.model
              : currentModel;
          const usage = normalizeUsage(o.message.usage);
          const rec: MessageRecord = {
            source: "cowork",
            sessionId: sid,
            project: coworkCwd ? projectLabel(coworkCwd) : coworkFallbackProject || "(unknown)",
            cwd: coworkCwd,
            gitBranch: "",
            ts,
            date: localDate(ts),
            model,
            usage,
            attributionSkill: typeof o.attributionSkill === "string" ? o.attributionSkill : null,
            toolUses: Array.isArray(o.message?.content) ? toolUsesFrom(o.message.content) : [],
          };
          if (typeof o.message?.stop_reason === "string") {
            rec.stopReason = o.message.stop_reason;
            countStopReason(sid, o.message.stop_reason);
          }
          messages.push(rec);
          open = msgId ? { msgId, record: rec } : undefined;
        }
      }

      // Fold friction for cowork sessions (partial — result-record signals only; no per-record
      // interruption detection like Claude Code has, but stop_reason + turn counts are observable).
      for (const [sid, meta] of sessions) {
        if (meta.source !== "cowork") continue;
        meta.friction = foldFrictionEvents(frictionEventsBySession.get(sid) ?? []);
        const stopReasons = stopReasonsBySession.get(sid);
        if (stopReasons) meta.friction.stopReasons = stopReasons;
      }
    }
  }

  if (rootsFound === 0) {
    throw new Error(`No transcripts found at ${missingRoots.join(" or ")}`);
  }

  messages.sort((a, b) => a.ts - b.ts);
  return { messages, sessions, toolResults };
}

export { projectLabel };
