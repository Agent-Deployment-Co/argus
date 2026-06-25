// claude.ai chat transcripts read from the Claude desktop app's local Chromium HTTP cache (#94).
//
// The desktop app caches the full-transcript API response per conversation; we read those cache
// entries directly — local files only, no auth, no network. Each entry is one complete conversation
// JSON (`uuid`, `name`, `model`, `chat_messages[]` with typed `content[]` blocks). The cache is LRU
// and partial (only conversations recently opened in the app), and holds multiple snapshots of the
// same conversation, so we dedupe by `uuid` via the pipeline's AlternateRepresentation mechanism.
//
// Usage caveat: these transcripts carry NO metered token usage and NO per-message model — only a
// conversation-level (currently-selected) model and a per-message stop_reason. So token usage here is
// *estimated* from text length (chars/4), priced under the conversation model. It is a rough figure,
// surfaced as the `claude-chat` source so it reads as estimated rather than metered.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, type BigIntStats, type Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  PARSED_FRAGMENT_CONTRACT_VERSION,
  buildPromptFact,
  createFactId,
  createFileIdentity,
  isAgentInitiated,
  sameFileFingerprint,
  stableId,
  type AuxiliaryParseResult,
  type AuxiliaryParserAdapter,
  type DiscoveredFile,
  type DiscoveryResult,
  type FileFingerprint,
  type FileIdentity,
  type FileParseResult,
  type InvocationFact,
  type NormalizedFacts,
  type ParsedAuxiliaryFragment,
  type ParsedFileFragment,
  type ParserDescriptor,
  type ParserDiagnostic,
  type ProjectRootFact,
  type PromptFact,
  type SessionFact,
  type SourcePosition,
  type ToolResultFact,
  type TranscriptDiscoveryAdapter,
  type TranscriptParserAdapter,
  type UsageFact,
} from "../../../../store/store-contract.ts";
import { CLAUDE_CHAT_CACHE_DIR } from "../../../../paths.ts";
import {
  TASK_TEXT_LIMIT,
  argusGeneratedPromptTitle,
  shouldSkipTaskCandidateText,
  textFromUserContent,
} from "../../../interpret/task-candidates.ts";
import { parseMcpTool } from "../../../../tool-categories.ts";
import { emptyUsage, type Usage } from "../../../../types.ts";
import { decodeSimpleCacheBody, parseSimpleCacheHeader } from "./simple-cache.ts";

export const CLAUDE_CHAT_ROOT_ID = "claude-chat-cache";
export const CLAUDE_CHAT_AUXILIARY_ROOT_ID = "claude-chat-projects";
// v1: initial claude.ai desktop-cache producer (sessions, prompts, estimated usage, tool calls).
// v2: capture project_uuid so claude.ai-project conversations resolve to their project name.
export const CLAUDE_CHAT_TRANSCRIPT_PARSER_VERSION = "2";
export const CLAUDE_CHAT_AUXILIARY_PARSER_VERSION = "1";

export const CLAUDE_CHAT_TRANSCRIPT_PARSER: ParserDescriptor = {
  name: "claude-chat-cache",
  source: "claude-chat",
  version: CLAUDE_CHAT_TRANSCRIPT_PARSER_VERSION,
};

// claude.ai "Projects" inventory (`/projects`, `/projects_v2`) — maps a project uuid to its name so a
// conversation's project_uuid resolves to a human label (reconcile's source-agnostic project_root path).
export const CLAUDE_CHAT_AUXILIARY_PARSER: ParserDescriptor = {
  name: "claude-chat-projects",
  source: "claude-chat",
  version: CLAUDE_CHAT_AUXILIARY_PARSER_VERSION,
};

const MAX_SNAPSHOT_ATTEMPTS = 3;
/** Bytes read from each cache file during discovery to inspect its URL key (header + key only). */
const KEY_PROBE_BYTES = 16 * 1024;

export interface ClaudeChatParseOptions {
  maxSnapshotAttempts?: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sourcePosition(file: FileIdentity, recordIndex: number, itemIndex = 0): SourcePosition {
  return { originKey: file.id, recordIndex, itemIndex };
}

function fingerprintFromStats(stats: BigIntStats): FileFingerprint {
  const fingerprint: FileFingerprint = {
    sizeBytes: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
  };
  if (process.platform !== "win32") {
    fingerprint.physicalId = { scheme: "posix_dev_inode", value: `${stats.dev}:${stats.ino}` };
  }
  return fingerprint;
}

function fingerprintFile(path: string): FileFingerprint {
  return fingerprintFromStats(statSync(path, { bigint: true }));
}

function errno(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function diagnostic(
  code: string,
  phase: ParserDiagnostic["phase"],
  message: string,
  severity: ParserDiagnostic["severity"] = "warning",
  position?: SourcePosition,
): ParserDiagnostic {
  return { code, severity, phase, message, ...(position ? { position } : {}) };
}

function discoveryFailure(
  rootPath: string,
  rootId: string,
  status: "missing" | "unreadable",
  code: string,
  message: string,
): DiscoveryResult {
  return {
    status,
    source: "claude-chat",
    rootId,
    rootPath,
    files: [],
    diagnostics: [diagnostic(code, "discovery", message, "error")],
  };
}

function rootStatus(path: string): "directory" | "missing" | "unreadable" {
  try {
    return statSync(path).isDirectory() ? "directory" : "unreadable";
  } catch (error) {
    return errno(error) === "ENOENT" ? "missing" : "unreadable";
  }
}

/** True for the full-transcript endpoint (`…/chat_conversations/{id}?tree=True&…`). The list
 *  endpoints (`chat_conversations?limit=…`, `chat_conversations_v2?…`) are intentionally excluded. */
function isChatTranscriptKey(key: string): boolean {
  return key.includes("/chat_conversations/") && key.includes("tree=True");
}

/** True for the claude.ai Projects inventory endpoints (`…/projects?…`, `…/projects_v2?…`). */
function isProjectsKey(key: string): boolean {
  return /\/projects(_v2)?\?/.test(key);
}

/** Read just the header + key region of a cache file, so discovery can filter without reading bodies. */
function readKeyProbe(path: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(KEY_PROBE_BYTES);
    const bytes = readSync(fd, buf, 0, KEY_PROBE_BYTES, 0);
    return buf.subarray(0, bytes);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function discoveredFile(
  path: string,
  relativePath: string,
  rootId: string,
  role: "transcript" | "project_registry",
): DiscoveredFile {
  return {
    file: createFileIdentity({ source: "claude-chat", rootId, role, relativePath, path }),
    fingerprint: fingerprintFile(path),
  };
}

/**
 * Walk the desktop app's Chromium Simple Cache, inspect each entry's URL key, and keep the entries
 * whose key matches `keep`. Shared by transcript discovery and the projects-inventory discovery.
 */
function discoverCacheEntries(
  cacheDir: string,
  rootId: string,
  role: "transcript" | "project_registry",
  keep: (key: string) => boolean,
): DiscoveryResult {
  const rootPath = resolve(cacheDir);
  const status = rootStatus(rootPath);
  if (status === "missing") {
    return discoveryFailure(rootPath, rootId, "missing", "missing_root", `Claude desktop cache does not exist: ${rootPath}`);
  }
  if (status === "unreadable") {
    return discoveryFailure(rootPath, rootId, "unreadable", "unreadable_root", `Claude desktop cache is not readable: ${rootPath}`);
  }

  const files: DiscoveredFile[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  let partial = false;

  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      partial = true;
      diagnostics.push(
        diagnostic("unreadable_directory", "discovery", `Unable to read Claude cache directory ${dir}: ${String(error)}`, "error"),
      );
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path); // skips the Simple Cache index-dir naturally (its files don't match the magic)
        continue;
      }
      if (!entry.isFile()) continue;
      const probe = readKeyProbe(path);
      if (!probe) continue;
      const header = parseSimpleCacheHeader(probe);
      if (!header || !keep(header.key)) continue;
      try {
        files.push(discoveredFile(path, relative(rootPath, path).split("\\").join("/"), rootId, role));
      } catch (error) {
        partial = true;
        diagnostics.push(
          diagnostic("unreadable_file", "discovery", `Unable to fingerprint Claude cache entry ${path}: ${String(error)}`, "error"),
        );
      }
    }
  };
  walk(rootPath);

  files.sort((a, b) => compareText(a.file.relativePath, b.file.relativePath));
  return { status: partial ? "partial" : "complete", source: "claude-chat", rootId, rootPath, files, diagnostics };
}

/** Discover claude.ai full chat-transcript entries (`tree=True`) in the desktop app's cache. */
export function discoverClaudeChatTranscripts(cacheDir = CLAUDE_CHAT_CACHE_DIR): DiscoveryResult {
  return discoverCacheEntries(cacheDir, CLAUDE_CHAT_ROOT_ID, "transcript", isChatTranscriptKey);
}

/** Discover the claude.ai Projects inventory entries (`/projects`, `/projects_v2`) — the uuid→name map. */
export function discoverClaudeChatProjects(cacheDir = CLAUDE_CHAT_CACHE_DIR): DiscoveryResult {
  return discoverCacheEntries(cacheDir, CLAUDE_CHAT_AUXILIARY_ROOT_ID, "project_registry", isProjectsKey);
}

interface StableRead {
  buffer: Buffer;
  fingerprint: FileFingerprint;
  attempts: number;
  observations: FileFingerprint[];
}

interface StableReadFailure {
  status: "unstable" | "missing" | "unreadable" | "failed";
  observations: FileFingerprint[];
  diagnostics: ParserDiagnostic[];
}

function readFailure(file: FileIdentity, error: unknown, observations: FileFingerprint[]): StableReadFailure {
  const code = errno(error);
  const status = code === "ENOENT" ? "missing" : code === "EACCES" || code === "EPERM" ? "unreadable" : "failed";
  return {
    status,
    observations,
    diagnostics: [
      diagnostic(
        status === "missing" ? "missing_file" : status === "unreadable" ? "unreadable_file" : "read_failed",
        "snapshot",
        `Unable to read ${file.path}: ${String(error)}`,
        "error",
      ),
    ],
  };
}

/** Read the whole cache entry twice and confirm the fingerprint is stable, so a mid-write file is
 *  retried rather than parsed half-written (mirrors the other producers' stable-read guard). */
function readStableFile(file: FileIdentity, maxAttempts = MAX_SNAPSHOT_ATTEMPTS): StableRead | StableReadFailure {
  const observations: FileFingerprint[] = [];
  const attempts = Math.max(1, Math.trunc(maxAttempts));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let before: FileFingerprint;
    try {
      before = fingerprintFile(file.path);
      observations.push(before);
    } catch (error) {
      return readFailure(file, error, observations);
    }
    let buffer: Buffer;
    try {
      buffer = readFileSync(file.path);
    } catch (error) {
      return readFailure(file, error, observations);
    }
    let after: FileFingerprint;
    try {
      after = fingerprintFile(file.path);
      observations.push(after);
    } catch (error) {
      return readFailure(file, error, observations);
    }
    if (sameFileFingerprint(before, after)) return { buffer, fingerprint: after, attempts: attempt, observations };
  }
  return {
    status: "unstable",
    observations,
    diagnostics: [
      diagnostic("unstable_file", "snapshot", `Claude cache entry changed during ${attempts} read attempts: ${file.path}`, "error"),
    ],
  };
}

interface ChatContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface ChatMessage {
  uuid?: string;
  sender?: string;
  text?: string;
  content?: ChatContentBlock[];
  created_at?: string;
  updated_at?: string;
  stop_reason?: string;
}

interface ChatConversation {
  uuid?: string;
  name?: string;
  model?: string;
  created_at?: string;
  updated_at?: string;
  /** claude.ai Project the conversation belongs to, when started inside one; resolved to a name. */
  project_uuid?: string;
  chat_messages?: ChatMessage[];
}

function parseTimestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Visible text of a message: text + thinking content blocks, falling back to the top-level `text`. */
function messageText(message: ChatMessage, limit = TASK_TEXT_LIMIT): string {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const fromBlocks = blocks
    .filter((b) => b.type === "text" || b.type === "thinking")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
  if (fromBlocks) return fromBlocks.slice(0, limit);
  return typeof message.text === "string" ? message.text.slice(0, limit) : "";
}

function boundedArguments(value: unknown): string | undefined {
  if (value == null || typeof value !== "object") return undefined;
  try {
    const serialized = JSON.stringify(value);
    return !serialized || serialized === "{}" ? undefined : serialized.slice(0, 280);
  } catch {
    return undefined;
  }
}

function estimateResultTokens(content: unknown): number {
  if (typeof content === "string") return estimateTokens(content);
  if (content == null) return 0;
  try {
    return estimateTokens(JSON.stringify(content));
  } catch {
    return 0;
  }
}

function factsFromConversation(conversation: ChatConversation, file: FileIdentity): NormalizedFacts {
  const uuid = conversation.uuid!;
  const sourceSessionId = `claude-chat:${uuid}`;
  const model = typeof conversation.model === "string" && conversation.model ? conversation.model : "(unknown)";
  const chatMessages = Array.isArray(conversation.chat_messages) ? conversation.chat_messages : [];

  const conversationPosition = sourcePosition(file, 0, 0);
  const firstPrompt = chatMessages
    .filter((m) => m.sender === "human")
    .map((m) => messageText(m))
    .map((text) => argusGeneratedPromptTitle(text) ?? text)
    .find(Boolean);

  const prompts: PromptFact[] = [];
  const messages: UsageFact[] = [];
  const invocations: InvocationFact[] = [];
  const toolResults: ToolResultFact[] = [];
  let userMessages = 0;
  let agentMessages = 0;
  // Estimate each assistant turn's input from the human turn that preceded it (rough — claude.ai does
  // not record real input tokens). chat_messages is in conversation order.
  let lastHumanTokens = 0;

  for (let recordIndex = 0; recordIndex < chatMessages.length; recordIndex++) {
    const message = chatMessages[recordIndex]!;
    const messagePosition = sourcePosition(file, recordIndex, 0);
    const timestampMs = parseTimestamp(message.created_at ?? message.updated_at);

    if (message.sender === "human") {
      userMessages++;
      const taskText = messageText(message);
      lastHumanTokens = estimateTokens(taskText);
      if (taskText && !argusGeneratedPromptTitle(taskText)) {
        const nextText = chatMessages[recordIndex + 1]?.sender === "human" ? messageText(chatMessages[recordIndex + 1]!) : undefined;
        // claude.ai chat is never a subagent session, so a human turn is human-initiated; carry task
        // text only when it passes the same noise filter the other producers use.
        const isTaskStart = !shouldSkipTaskCandidateText(taskText, nextText);
        prompts.push(
          buildPromptFact({
            source: "claude-chat",
            sourceSessionId,
            position: messagePosition,
            kind: "main",
            ...(Number.isNaN(timestampMs) ? {} : { timestampMs }),
            ...(typeof message.uuid === "string" ? { dedupKey: message.uuid } : {}),
            ...(isTaskStart ? { text: taskText } : {}),
          }),
        );
      }
      continue;
    }

    if (message.sender !== "assistant") continue;
    agentMessages++;

    const outputText = messageText(message, Number.MAX_SAFE_INTEGER);
    const usage: Usage = emptyUsage();
    usage.input = lastHumanTokens;
    usage.output = estimateTokens(outputText);
    lastHumanTokens = 0; // consumed by this turn

    const providerMessageId = typeof message.uuid === "string" ? message.uuid : undefined;
    const messageId = createFactId("message", "claude-chat", sourceSessionId, messagePosition, providerMessageId ?? "");
    messages.push({
      id: messageId,
      source: "claude-chat",
      sourceSessionId,
      ...(providerMessageId ? { providerMessageId } : {}),
      timestampMs: Number.isNaN(timestampMs) ? 0 : timestampMs,
      model,
      usage,
      attributionSkill: null,
      ...(typeof message.stop_reason === "string" && message.stop_reason ? { stopReason: message.stop_reason } : {}),
      // Assistant text (#122), in-memory: becomes the interaction's responseText for pass-2 dialogue.
      ...(outputText ? { text: outputText.slice(0, TASK_TEXT_LIMIT) } : {}),
      position: messagePosition,
    });

    const blocks = Array.isArray(message.content) ? message.content : [];
    // Map tool_use id -> its invocation fact id, so a tool_result in the same message resolves to it.
    const invocationFactByToolId = new Map<string, string>();
    blocks.forEach((block, blockIndex) => {
      const blockPosition = sourcePosition(file, recordIndex, blockIndex + 1);
      if (block.type === "tool_use" && typeof block.name === "string" && block.name) {
        const invocationId = typeof block.id === "string" ? block.id : undefined;
        const invocationFactId = createFactId(
          "invocation",
          "claude-chat",
          sourceSessionId,
          blockPosition,
          invocationId ?? `${recordIndex}:${blockIndex}`,
        );
        if (invocationId) invocationFactByToolId.set(invocationId, invocationFactId);
        const mcp = parseMcpTool(block.name);
        const args = boundedArguments(block.input);
        invocations.push({
          id: invocationFactId,
          source: "claude-chat",
          sourceSessionId,
          messageId,
          ...(invocationId ? { invocationId } : {}),
          ...(Number.isNaN(timestampMs) ? {} : { timestampMs }),
          name: block.name,
          ...(args ? { args } : {}),
          ...(mcp ? { mcpServer: mcp.server, mcpTool: mcp.tool } : {}),
          position: blockPosition,
        });
      } else if (block.type === "tool_result") {
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        const resolved = toolUseId ? invocationFactByToolId.get(toolUseId) : undefined;
        toolResults.push({
          id: createFactId("tool_result", "claude-chat", sourceSessionId, blockPosition, toolUseId ?? `${recordIndex}:${blockIndex}`),
          source: "claude-chat",
          sourceSessionId,
          ...(toolUseId ? { invocationId: toolUseId } : {}),
          ...(resolved ? { resolvedInvocationFactId: resolved } : {}),
          ...(typeof block.name === "string" && block.name ? { observedToolName: block.name } : {}),
          approxTokens: estimateResultTokens(block.content),
          position: blockPosition,
        });
      }
    });
  }

  // The conversation's claude.ai Project (when started in one); reconcile resolves this selector to the
  // project name via the projects auxiliary, then labels the session by it (else "claude.ai chat").
  const projectUuid =
    typeof conversation.project_uuid === "string" && conversation.project_uuid ? conversation.project_uuid : undefined;
  const session: SessionFact = {
    id: createFactId("session", "claude-chat", sourceSessionId, conversationPosition, uuid),
    source: "claude-chat",
    sourceSessionId,
    kind: "main",
    transcriptPath: file.path,
    ...(projectUuid ? { rawProjectId: projectUuid } : {}),
    ...(firstPrompt ? { firstPrompt } : {}),
    userMessages,
    agentMessages,
    rawTurns: userMessages,
    position: conversationPosition,
  };

  return { sessions: [session], prompts, messages, invocations, toolResults, tasks: [], relationships: [] };
}

function parseFailure(file: DiscoveredFile, observations: FileFingerprint[], diagnostics: ParserDiagnostic[]): FileParseResult {
  return { status: "failed", file: file.file, observations, diagnostics };
}

export function parseClaudeChatTranscriptFile(file: DiscoveredFile, options: ClaudeChatParseOptions = {}): FileParseResult {
  if (file.file.source !== "claude-chat" || file.file.role !== "transcript") {
    return parseFailure(file, [file.fingerprint], [
      diagnostic("unsupported_file", "parse", `Claude chat parser cannot parse ${file.file.role} input`, "error"),
    ]);
  }
  const stable = readStableFile(file.file, options.maxSnapshotAttempts);
  if ("status" in stable) {
    return { status: stable.status, file: file.file, observations: stable.observations, diagnostics: stable.diagnostics };
  }

  const header = parseSimpleCacheHeader(stable.buffer);
  if (!header || !isChatTranscriptKey(header.key)) {
    return parseFailure(file, stable.observations, [
      diagnostic("invalid_cache_entry", "parse", `Not a claude.ai chat-transcript cache entry: ${file.file.path}`, "error"),
    ]);
  }
  const body = decodeSimpleCacheBody(stable.buffer, header.bodyStart);
  if (body == null) {
    return parseFailure(file, stable.observations, [
      diagnostic("undecodable_body", "parse", `Unable to decode the cached response body: ${file.file.path}`, "error"),
    ]);
  }
  let conversation: ChatConversation;
  try {
    conversation = JSON.parse(body) as ChatConversation;
  } catch {
    return parseFailure(file, stable.observations, [
      diagnostic("invalid_json", "parse", `Cached chat transcript was not valid JSON: ${file.file.path}`, "error"),
    ]);
  }
  if (!conversation || typeof conversation.uuid !== "string" || !Array.isArray(conversation.chat_messages)) {
    return parseFailure(file, stable.observations, [
      diagnostic("invalid_conversation", "parse", `Cached transcript lacked a uuid and chat_messages: ${file.file.path}`, "error"),
    ]);
  }

  const updatedAtMs = parseTimestamp(conversation.updated_at);
  const fragment: ParsedFileFragment = {
    kind: "transcript",
    id: stableId("fragment", [file.file.id]),
    contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
    parser: CLAUDE_CHAT_TRANSCRIPT_PARSER,
    snapshot: { file: file.file, fingerprint: stable.fingerprint, attempts: stable.attempts },
    // The cache can hold several snapshots of one conversation; keep the richest (most messages),
    // newest as the tie-breaker. reconcile.selectAlternateRepresentations does the picking.
    alternateRepresentation: {
      logicalId: `claude-chat:${conversation.uuid}`,
      representation: "cache",
      preference: conversation.chat_messages.length,
      ...(Number.isNaN(updatedAtMs) ? {} : { updatedAtMs }),
    },
    facts: factsFromConversation(conversation, file.file),
    dependencies: [],
    diagnostics: [],
  };
  return { status: "current", fragment };
}

export function parseClaudeChatTranscriptPath(path: string): FileParseResult {
  const absolutePath = resolve(path);
  const rootPath = resolve(CLAUDE_CHAT_CACHE_DIR);
  const file = createFileIdentity({
    source: "claude-chat",
    rootId: CLAUDE_CHAT_ROOT_ID,
    role: "transcript",
    relativePath: relative(rootPath, absolutePath).split("\\").join("/"),
    path: absolutePath,
  });
  let fingerprint: FileFingerprint;
  try {
    fingerprint = fingerprintFile(absolutePath);
  } catch (error) {
    const missing = errno(error) === "ENOENT";
    return {
      status: missing ? "missing" : "unreadable",
      file,
      observations: [],
      diagnostics: [
        diagnostic(
          missing ? "missing_file" : "unreadable_file",
          "snapshot",
          missing ? `Claude cache entry disappeared before parsing: ${absolutePath}` : `Unable to fingerprint Claude cache entry: ${absolutePath}`,
          missing ? "warning" : "error",
        ),
      ],
    };
  }
  return parseClaudeChatTranscriptFile({ file, fingerprint });
}

export function createClaudeChatDiscoveryAdapter(cacheDir = CLAUDE_CHAT_CACHE_DIR): TranscriptDiscoveryAdapter {
  return { source: "claude-chat", discover: () => discoverClaudeChatTranscripts(cacheDir) };
}

export function createClaudeChatTranscriptParserAdapter(options: ClaudeChatParseOptions = {}): TranscriptParserAdapter {
  return { parser: CLAUDE_CHAT_TRANSCRIPT_PARSER, parseFile: (file) => parseClaudeChatTranscriptFile(file, options) };
}

interface ProjectEntry {
  uuid?: unknown;
  name?: unknown;
}

/** The `/projects` body is a bare array; `/projects_v2` wraps it under `data`. */
function projectEntries(body: unknown): ProjectEntry[] {
  if (Array.isArray(body)) return body as ProjectEntry[];
  if (body && typeof body === "object") {
    const wrapped = (body as { data?: unknown; projects?: unknown }).data ?? (body as { projects?: unknown }).projects;
    if (Array.isArray(wrapped)) return wrapped as ProjectEntry[];
  }
  return [];
}

/** Parse a cached claude.ai Projects-inventory response into uuid→name project-root facts. */
export function parseClaudeChatProjectsFile(file: DiscoveredFile, options: ClaudeChatParseOptions = {}): AuxiliaryParseResult {
  if (file.file.source !== "claude-chat" || file.file.role !== "project_registry") {
    return {
      status: "failed",
      file: file.file,
      observations: [file.fingerprint],
      diagnostics: [diagnostic("unsupported_file", "parse", `Claude chat projects parser cannot parse ${file.file.role} input`, "error")],
    };
  }
  const stable = readStableFile(file.file, options.maxSnapshotAttempts);
  if ("status" in stable) {
    return { status: stable.status, file: file.file, observations: stable.observations, diagnostics: stable.diagnostics };
  }
  const header = parseSimpleCacheHeader(stable.buffer);
  const body = header && isProjectsKey(header.key) ? decodeSimpleCacheBody(stable.buffer, header.bodyStart) : null;
  let parsed: unknown;
  try {
    parsed = body == null ? null : JSON.parse(body);
  } catch {
    parsed = null;
  }

  const facts: ProjectRootFact[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  // Best-effort: the projects inventory only enriches the project label. Some cached responses are
  // empty or stored uncompressed (no zstd frame we can cleanly bound), so an undecodable entry yields
  // no project facts rather than a hard read error — name resolution still works from the entries that
  // do decode. (A "failed" status here would surface as a scary "couldn't be read" count.)
  if (parsed == null) {
    diagnostics.push(
      diagnostic("undecodable_projects", "parse", `Skipped a projects inventory entry that wasn't decodable JSON: ${file.file.path}`, "info"),
    );
  }
  projectEntries(parsed).forEach((entry, index) => {
    const uuid = typeof entry.uuid === "string" ? entry.uuid : undefined;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!uuid || !name) {
      diagnostics.push(diagnostic("invalid_project_entry", "parse", "Skipped a projects entry without a uuid and name", "warning"));
      return;
    }
    facts.push({
      id: stableId("fact:project_root", [file.file.id, uuid, name]),
      kind: "project_root",
      source: "claude-chat",
      selector: uuid,
      cwd: name,
      position: sourcePosition(file.file, 0, index),
    });
  });

  const fragment: ParsedAuxiliaryFragment = {
    kind: "auxiliary",
    id: stableId("auxiliary-fragment", [file.file.id]),
    contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
    parser: CLAUDE_CHAT_AUXILIARY_PARSER,
    snapshot: { file: file.file, fingerprint: stable.fingerprint, attempts: stable.attempts },
    facts,
    diagnostics,
  };
  return { status: "current", fragment };
}

export function createClaudeChatAuxiliaryParserAdapter(options: ClaudeChatParseOptions = {}): AuxiliaryParserAdapter {
  return { parser: CLAUDE_CHAT_AUXILIARY_PARSER, parseFile: (file) => parseClaudeChatProjectsFile(file, options) };
}
