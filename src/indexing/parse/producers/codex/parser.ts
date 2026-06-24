import { readFileSync, readdirSync, statSync, type BigIntStats } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  PARSED_FRAGMENT_CONTRACT_VERSION,
  buildPromptFact,
  createFactId,
  type PromptFact,
  createFileIdentity,
  sameFileFingerprint,
  stableId,
  type CompleteDiscovery,
  type DiscoveredFile,
  type DiscoveryResult,
  type FileFingerprint,
  type FileParseResult,
  type InvocationFact,
  type UsageFact,
  type NormalizedFacts,
  type ParsedFileFragment,
  type ParserDescriptor,
  type ParserDiagnostic,
  type SourcePosition,
  type StableFileSnapshot,
  type ToolResultFact,
  type TranscriptDiscoveryAdapter,
  type TranscriptParserAdapter,
} from "../../../../store/store-contract.ts";
import { CODEX_SESSIONS_DIR } from "../../../../paths.ts";
import {
  TASK_TEXT_LIMIT,
  argusGeneratedPromptTitle,
  isCodexEnvironmentContextText,
  isTurnAbortedText,
  shouldSkipTaskCandidateText,
} from "../../../interpret/task-candidates.ts";
import { parseMcpTool } from "../../../../tool-categories.ts";
import { emptyUsage, totalTokens, type Usage } from "../../../../types.ts";

export const CODEX_SESSIONS_ROOT_ID = "codex-sessions";
export const CODEX_ROOT_ID = CODEX_SESSIONS_ROOT_ID;
export const CODEX_TRANSCRIPT_PARSER: ParserDescriptor = {
  name: "codex-jsonl",
  source: "codex",
  version: "9",
};
export const CODEX_PARSER = CODEX_TRANSCRIPT_PARSER;

const ARGUMENT_LIMIT = 280;
const FIRST_PROMPT_LIMIT = 500;
const DEFAULT_SNAPSHOT_ATTEMPTS = 3;

interface ParsedRecord {
  value: Record<string, unknown>;
  position: SourcePosition;
}

interface PendingInvocation {
  name: string;
  invocationId?: string;
  timestampMs?: number;
  args?: string;
  skill?: string;
  mcpServer?: string;
  mcpTool?: string;
  filePath?: string;
  position: SourcePosition;
  factId?: string;
}

interface PendingToolResult {
  invocationId: string;
  output: unknown;
  position: SourcePosition;
  matchedInvocation?: PendingInvocation;
}

export interface CodexTranscriptParserOptions {
  maxSnapshotAttempts?: number;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numericToken(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}


function normalizeCodexUsage(raw: unknown): Usage {
  const usage = emptyUsage();
  const values = objectValue(raw);
  const input = numericToken(values.input_tokens);
  const cached = numericToken(values.cached_input_tokens);
  usage.input = Math.max(input - cached, 0);
  usage.cacheRead = cached;
  usage.output = numericToken(values.output_tokens);

  const total = numericToken(values.total_tokens);
  if (totalTokens(usage) === 0 && total > 0) usage.input = total;
  return usage;
}

function textFromCodexContent(content: unknown, limit = FIRST_PROMPT_LIMIT): string {
  if (typeof content === "string") return content.slice(0, limit);
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => stringValue(objectValue(part).text) ?? "")
    .filter(Boolean)
    .join("\n")
    .slice(0, limit);
}

function estimateTokens(content: unknown): number {
  let chars = 0;
  if (typeof content === "string") {
    chars = content.length;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") chars += part.length;
      else if (stringValue(objectValue(part).text)) chars += stringValue(objectValue(part).text)!.length;
      else chars += JSON.stringify(part).length;
    }
  } else if (content != null) {
    chars = JSON.stringify(content).length;
  }
  return Math.round(chars / 4);
}

function parseArgumentObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") return {};
  try {
    return objectValue(JSON.parse(raw));
  } catch {
    return {};
  }
}

function boundedArguments(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  let serialized: string;
  if (typeof raw === "string") {
    serialized = raw;
  } else {
    try {
      serialized = JSON.stringify(raw);
    } catch {
      return undefined;
    }
  }
  return serialized ? serialized.slice(0, ARGUMENT_LIMIT) : undefined;
}

function invocationName(payload: Record<string, unknown>, custom = false): string | undefined {
  const name = stringValue(payload.name);
  if (!name) return undefined;
  if (custom) return name;
  const namespace = stringValue(payload.namespace);
  if (!namespace?.startsWith("mcp__") || name.startsWith("mcp__")) return name;
  return `${namespace.replace(/__$/, "")}__${name}`;
}

function invocationFromPayload(
  name: string,
  rawArgs: unknown,
  payload: Record<string, unknown>,
  position: SourcePosition,
  recordTimestamp: unknown,
): PendingInvocation {
  const parsedArgs = parseArgumentObject(rawArgs);
  const invocation: PendingInvocation = {
    name,
    position,
  };
  const invocationId = stringValue(payload.call_id) ?? stringValue(payload.id);
  const invocationTimestamp = timestampMs(recordTimestamp);
  const args = boundedArguments(rawArgs);
  const mcp = parseMcpTool(name);
  const filePath =
    stringValue(parsedArgs.file_path) ??
    stringValue(parsedArgs.filePath) ??
    stringValue(parsedArgs.path);

  if (invocationId) invocation.invocationId = invocationId;
  if (invocationTimestamp != null) invocation.timestampMs = invocationTimestamp;
  if (args) invocation.args = args;
  if (mcp) {
    invocation.mcpServer = mcp.server;
    invocation.mcpTool = mcp.tool;
  }
  if (filePath) invocation.filePath = filePath;

  if (name === "Skill" || name === "activate_skill") {
    const skill =
      stringValue(parsedArgs.skill) ??
      (name === "activate_skill" ? stringValue(parsedArgs.name) : undefined);
    if (skill) invocation.skill = skill;
    const skillArgs = stringValue(parsedArgs.args);
    if (skillArgs) invocation.args = skillArgs.slice(0, ARGUMENT_LIMIT);
  }
  return invocation;
}

function codexSessionId(filePath: string, metadata: Record<string, unknown>): string {
  const metadataId = stringValue(metadata.id);
  if (metadataId) return metadataId;
  const name = basename(filePath, ".jsonl");
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1] ?? name;
}

function fingerprintFromStats(stats: BigIntStats): FileFingerprint {
  const fingerprint: FileFingerprint = {
    sizeBytes: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
  };
  if (process.platform !== "win32") {
    fingerprint.physicalId = {
      scheme: "posix_dev_inode",
      value: `${stats.dev}:${stats.ino}`,
    };
  }
  return fingerprint;
}

export function fingerprintCodexFile(path: string): FileFingerprint {
  return fingerprintFromStats(statSync(path, { bigint: true }));
}

function errorCode(error: unknown): string | undefined {
  return objectValue(error).code as string | undefined;
}

function snapshotFailureStatus(error: unknown): "missing" | "unreadable" | "failed" {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  if (code === "EACCES" || code === "EPERM") return "unreadable";
  return "failed";
}

function snapshotFailureDiagnostic(error: unknown, path: string): ParserDiagnostic {
  const status = snapshotFailureStatus(error);
  return {
    code:
      status === "missing"
        ? "transcript_missing"
        : status === "unreadable"
          ? "transcript_unreadable"
          : "transcript_snapshot_failed",
    severity: "error",
    phase: "snapshot",
    message:
      status === "missing"
        ? `Codex transcript disappeared before it could be parsed: ${path}`
        : status === "unreadable"
          ? `Codex transcript could not be read: ${path}`
          : `Codex transcript snapshot failed: ${path}`,
  };
}

function normalizedRelativePath(rootPath: string, path: string): string {
  return relative(rootPath, path).split(sep).join("/").replaceAll("\\", "/");
}

export function discoverCodexFiles(
  sessionsDir = CODEX_SESSIONS_DIR,
  rootId = CODEX_ROOT_ID,
): DiscoveryResult {
  const rootPath = resolve(sessionsDir);
  const files: DiscoveredFile[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  let rootStats: BigIntStats;
  try {
    rootStats = statSync(rootPath, { bigint: true });
  } catch (error) {
    const status = snapshotFailureStatus(error);
    return {
      status: status === "missing" ? "missing" : "unreadable",
      source: "codex",
      rootId,
      rootPath,
      files,
      diagnostics: [
        {
          code: status === "missing" ? "missing_root" : "unreadable_root",
          severity: "error",
          phase: "discovery",
          message:
            status === "missing"
              ? `Codex sessions root does not exist: ${rootPath}`
              : `Codex sessions root is unreadable: ${rootPath}`,
        },
      ],
    };
  }

  if (!rootStats.isDirectory()) {
    return {
      status: "unreadable",
      source: "codex",
      rootId,
      rootPath,
      files,
      diagnostics: [
        {
          code: "root_not_directory",
          severity: "error",
          phase: "discovery",
          message: `Codex sessions root is not a directory: ${rootPath}`,
        },
      ],
    };
  }

  let partial = false;
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      partial = true;
      diagnostics.push({
        code: "unreadable_directory",
        severity: "error",
        phase: "discovery",
        message: `Could not traverse Codex sessions directory: ${directory}`,
      });
      return;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        files.push({
          file: createFileIdentity({
            source: "codex",
            rootId,
            role: "transcript",
            relativePath: normalizedRelativePath(rootPath, path),
            path,
          }),
          fingerprint: fingerprintCodexFile(path),
        });
      } catch {
        partial = true;
        diagnostics.push({
          code: "unreadable_transcript",
          severity: "error",
          phase: "discovery",
          message: `Could not inspect Codex transcript: ${path}`,
        });
      }
    }
  };

  walk(rootPath);
  files.sort((a, b) => a.file.relativePath.localeCompare(b.file.relativePath));

  const result: CompleteDiscovery | Exclude<DiscoveryResult, CompleteDiscovery> = {
    status: partial ? "partial" : "complete",
    source: "codex",
    rootId,
    rootPath,
    files,
    diagnostics,
  };
  return result;
}

export const discoverCodexTranscripts = discoverCodexFiles;

function parseRecords(raw: string, originKey: string): {
  records: ParsedRecord[];
  diagnostics: ParserDiagnostic[];
} {
  const records: ParsedRecord[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const lines = raw.split("\n");
  let byteOffset = 0;

  for (let recordIndex = 0; recordIndex < lines.length; recordIndex++) {
    const line = lines[recordIndex]!;
    const position: SourcePosition = { originKey, recordIndex, itemIndex: 0, byteOffset };
    byteOffset += Buffer.byteLength(line, "utf8") + (recordIndex < lines.length - 1 ? 1 : 0);
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        diagnostics.push({
          code: "malformed_record",
          severity: "warning",
          phase: "parse",
          message: "Skipped non-object Codex JSONL record",
          position,
        });
        continue;
      }
      records.push({ value: parsed as Record<string, unknown>, position });
    } catch {
      diagnostics.push({
        code: "malformed_record",
        severity: "warning",
        phase: "parse",
        message: "Skipped malformed Codex JSONL record",
        position,
      });
    }
  }
  return { records, diagnostics };
}

function scopedInvocationKey(sourceSessionId: string, invocationId: string): string {
  return `${sourceSessionId}\0${invocationId}`;
}

function codexUserMessageText(record: ParsedRecord, limit = TASK_TEXT_LIMIT): string | undefined {
  const payload = objectValue(record.value.payload);
  if (
    stringValue(record.value.type) !== "response_item" ||
    stringValue(payload.type) !== "message" ||
    payload.role !== "user"
  ) {
    return undefined;
  }
  return textFromCodexContent(payload.content, limit) || undefined;
}

function directlyFollowedByTurnAborted(records: ParsedRecord[], index: number): boolean {
  const nextText = records[index + 1] ? codexUserMessageText(records[index + 1]!) : undefined;
  return nextText ? isTurnAbortedText(nextText) : false;
}

function shouldSkipTaskMessage(records: ParsedRecord[], index: number, text: string): boolean {
  const nextText = directlyFollowedByTurnAborted(records, index) ? "<turn_aborted>" : undefined;
  return shouldSkipTaskCandidateText(text, nextText);
}

export function parseCodexTranscript(
  raw: string,
  snapshot: StableFileSnapshot,
): ParsedFileFragment {
  const { records, diagnostics } = parseRecords(raw, snapshot.file.id);
  const metadataRecord = records.find((record) => record.value.type === "session_meta");
  const metadata = objectValue(metadataRecord?.value.payload);
  const nativeSessionId = codexSessionId(snapshot.file.path, metadata);
  const sourceSessionId = `codex:${nativeSessionId}`;
  const sessionPosition =
    metadataRecord?.position ??
    records[0]?.position ?? {
      originKey: snapshot.file.id,
      recordIndex: 0,
      itemIndex: 0,
      byteOffset: 0,
    };

  let currentCwd = stringValue(metadata.cwd) ?? "";
  let currentModel = "(unknown)";
  let sessionCwd = currentCwd;
  let firstPrompt: string | undefined;
  let pendingInvocations: PendingInvocation[] = [];
  // Codex meters usage on token_count events, separate from the assistant text records (#122). Track
  // the latest assistant text since the last token_count so the flushed UsageFact carries the turn's
  // text — reconcile then reads the response-slot turn's text onto the interaction's responseText.
  let pendingAssistantText: string | undefined;
  const invocationByScopedId = new Map<string, PendingInvocation>();
  const pendingResults: PendingToolResult[] = [];
  const messages: UsageFact[] = [];
  const invocations: InvocationFact[] = [];
  const prompts: PromptFact[] = [];
  const rawTurnIds = new Set<string>();
  let rawTurnsWithoutId = 0;
  let userMessageEvents = 0;
  let agentMessageEvents = 0;
  let responseUserMessages = 0;
  let responseAssistantMessages = 0;

  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const record = records[recordIndex]!;
    const payload = objectValue(record.value.payload);
    const recordType = stringValue(record.value.type);
    const payloadType = stringValue(payload.type);

    if (recordType === "event_msg") {
      const turnId = stringValue(payload.turn_id);
      if (turnId) rawTurnIds.add(turnId);
      else if (payloadType === "task_started") rawTurnsWithoutId++;
    }

    if (recordType === "event_msg" && payloadType === "user_message") {
      userMessageEvents++;
    }

    if (recordType === "event_msg" && payloadType === "agent_message") {
      agentMessageEvents++;
    }

    if (recordType === "session_meta") {
      const cwd = stringValue(payload.cwd);
      if (cwd) {
        currentCwd = cwd;
        if (!sessionCwd) sessionCwd = cwd;
      }
      continue;
    }

    if (recordType === "turn_context") {
      if (typeof payload.cwd === "string") {
        currentCwd = payload.cwd;
        if (!sessionCwd && payload.cwd) sessionCwd = payload.cwd;
      }
      if (typeof payload.model === "string") currentModel = payload.model;
      continue;
    }

    if (recordType === "response_item" && payloadType === "message" && payload.role === "user") {
      responseUserMessages++;
      // A new user prompt opens a new interaction; drop any assistant text that never reached a
      // token_count flush so it can't leak onto this interaction's response (#122).
      pendingAssistantText = undefined;
      const taskText = codexUserMessageText(record, TASK_TEXT_LIMIT);
      const generatedTitle = taskText ? argusGeneratedPromptTitle(taskText) : undefined;
      // Interaction-opening prompt marker (#117). Skip Argus's own prompts (not human turns). Codex
      // has no subagents (so human-initiated, derived from the absent subagent kind) and — as far as
      // we observe — no cross-file replay, so there's no replay-stable id; reconcile dedups by
      // position. If Codex ever resumes across rollout files, a stable dedupKey would be needed here.
      if (taskText && !generatedTitle) {
        // The prompt carries task text (#122) when this opening is a task start (past the noise
        // filter) — the sole source of task candidates; codex has no subagents, so all openings are
        // human-initiated. firstPrompt titles the session from the first task-eligible turn (#131).
        const isTaskStart = !shouldSkipTaskMessage(records, recordIndex, taskText);
        if (isTaskStart && !firstPrompt) firstPrompt = textFromCodexContent(payload.content);
        prompts.push(
          buildPromptFact({
            source: "codex",
            sourceSessionId,
            position: record.position,
            timestampMs: timestampMs(record.value.timestamp),
            text: isTaskStart ? taskText : undefined,
          }),
        );
      }
      if (!firstPrompt && generatedTitle) firstPrompt = generatedTitle;
      continue;
    }

    if (recordType === "response_item" && payloadType === "message" && payload.role === "assistant") {
      responseAssistantMessages++;
      // Accumulate (don't overwrite): a turn may emit several assistant message records before its
      // token_count flush, and each carries part of the response (#122). Capped at TASK_TEXT_LIMIT.
      const assistantText = textFromCodexContent(payload.content, TASK_TEXT_LIMIT);
      if (assistantText) {
        pendingAssistantText = (
          pendingAssistantText ? `${pendingAssistantText}\n${assistantText}` : assistantText
        ).slice(0, TASK_TEXT_LIMIT);
      }
      continue;
    }

    let pendingInvocation: PendingInvocation | undefined;
    if (
      recordType === "response_item" &&
      payloadType === "function_call" &&
      stringValue(payload.name)
    ) {
      const name = invocationName(payload);
      if (name) {
        pendingInvocation = invocationFromPayload(
          name,
          payload.arguments,
          payload,
          record.position,
          record.value.timestamp,
        );
      }
    } else if (
      recordType === "response_item" &&
      payloadType === "custom_tool_call" &&
      stringValue(payload.name)
    ) {
      const name = invocationName(payload, true);
      if (name) {
        pendingInvocation = invocationFromPayload(
          name,
          payload.input,
          payload,
          record.position,
          record.value.timestamp,
        );
      }
    } else if (
      recordType === "response_item" &&
      payloadType?.endsWith("_call")
    ) {
      pendingInvocation = invocationFromPayload(
        payloadType,
        payload.arguments ?? payload.action ?? payload.input,
        payload,
        record.position,
        record.value.timestamp,
      );
    }

    if (pendingInvocation) {
      pendingInvocations.push(pendingInvocation);
      if (pendingInvocation.invocationId) {
        invocationByScopedId.set(
          scopedInvocationKey(sourceSessionId, pendingInvocation.invocationId),
          pendingInvocation,
        );
      }
      continue;
    }

    if (
      recordType === "response_item" &&
      payloadType?.endsWith("_output") &&
      stringValue(payload.call_id)
    ) {
      const invocationId = stringValue(payload.call_id)!;
      pendingResults.push({
        invocationId,
        output: payload.output ?? payload.result ?? payload.tools,
        position: record.position,
        matchedInvocation: invocationByScopedId.get(
          scopedInvocationKey(sourceSessionId, invocationId),
        ),
      });
      continue;
    }

    if (recordType !== "event_msg" || payloadType !== "token_count") continue;
    const info = objectValue(payload.info);
    const usage = normalizeCodexUsage(info.last_token_usage ?? info.total_token_usage);
    if (totalTokens(usage) === 0) {
      pendingInvocations = [];
      pendingAssistantText = undefined;
      continue;
    }

    const messageTimestamp = timestampMs(record.value.timestamp);
    if (messageTimestamp == null) {
      pendingInvocations = [];
      pendingAssistantText = undefined;
      diagnostics.push({
        code: "invalid_token_timestamp",
        severity: "warning",
        phase: "parse",
        message: "Skipped positive Codex token_count record with an invalid timestamp",
        position: record.position,
      });
      continue;
    }

    const messageId = createFactId(
      "message",
      "codex",
      sourceSessionId,
      record.position,
      "token_count",
    );
    messages.push({
      id: messageId,
      source: "codex",
      sourceSessionId,
      timestampMs: messageTimestamp,
      model: currentModel,
      usage,
      cwd: currentCwd,
      attributionSkill: null,
      ...(pendingAssistantText ? { text: pendingAssistantText } : {}),
      position: record.position,
    });
    pendingAssistantText = undefined;

    for (const pending of pendingInvocations) {
      const invocationId = createFactId(
        "invocation",
        "codex",
        sourceSessionId,
        pending.position,
        pending.invocationId ?? pending.name,
      );
      pending.factId = invocationId;
      const fact: InvocationFact = {
        id: invocationId,
        source: "codex",
        sourceSessionId,
        messageId,
        name: pending.name,
        position: pending.position,
      };
      if (pending.invocationId) fact.invocationId = pending.invocationId;
      if (pending.timestampMs != null) fact.timestampMs = pending.timestampMs;
      if (pending.args) fact.args = pending.args;
      if (pending.skill) fact.skill = pending.skill;
      if (pending.mcpServer) fact.mcpServer = pending.mcpServer;
      if (pending.mcpTool) fact.mcpTool = pending.mcpTool;
      if (pending.filePath) fact.filePath = pending.filePath;
      invocations.push(fact);
    }
    pendingInvocations = [];
  }

  const toolResults: ToolResultFact[] = pendingResults.map((pending) => {
    const fact: ToolResultFact = {
      id: createFactId(
        "tool_result",
        "codex",
        sourceSessionId,
        pending.position,
        pending.invocationId,
      ),
      source: "codex",
      sourceSessionId,
      invocationId: pending.invocationId,
      approxTokens: estimateTokens(pending.output),
      position: pending.position,
    };
    if (pending.matchedInvocation?.name) {
      fact.observedToolName = pending.matchedInvocation.name;
    }
    if (pending.matchedInvocation?.factId) {
      fact.resolvedInvocationFactId = pending.matchedInvocation.factId;
    }
    return fact;
  });

  const facts: NormalizedFacts = {
    sessions: [],
    prompts,
    messages,
    invocations,
    toolResults,
    tasks: [],
    relationships: [],
  };
  if (records.length > 0) {
    const session = {
      id: createFactId("session", "codex", sourceSessionId, sessionPosition, nativeSessionId),
      source: "codex" as const,
      sourceSessionId,
      kind: "main" as const,
      transcriptPath: snapshot.file.path,
      position: sessionPosition,
    };
    if (sessionCwd) Object.assign(session, { cwd: sessionCwd });
    if (firstPrompt) Object.assign(session, { firstPrompt });
    const userMessages = userMessageEvents || responseUserMessages;
    const agentMessages = agentMessageEvents || responseAssistantMessages;
    const rawTurns = rawTurnIds.size + rawTurnsWithoutId || userMessages || undefined;
    if (userMessages) Object.assign(session, { userMessages });
    if (agentMessages) Object.assign(session, { agentMessages });
    if (rawTurns) Object.assign(session, { rawTurns });
    facts.sessions.push(session);
  }

  return {
    kind: "transcript",
    id: stableId("fragment", [snapshot.file.id]),
    contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
    parser: CODEX_PARSER,
    snapshot,
    facts,
    dependencies: [],
    diagnostics,
  };
}

export function parseCodexFile(
  file: DiscoveredFile,
  options: CodexTranscriptParserOptions = {},
): FileParseResult {
  if (file.file.source !== "codex" || file.file.role !== "transcript") {
    return {
      status: "failed",
      file: file.file,
      observations: [file.fingerprint],
      diagnostics: [
        {
          code: "invalid_file_role",
          severity: "error",
          phase: "parse",
          message: `Codex transcript parser cannot parse ${file.file.role} file ${file.file.path}`,
        },
      ],
    };
  }

  const maxAttempts = Math.max(1, Math.floor(options.maxSnapshotAttempts ?? DEFAULT_SNAPSHOT_ATTEMPTS));
  const observations: FileFingerprint[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let before: FileFingerprint;
    try {
      before = fingerprintCodexFile(file.file.path);
      observations.push(before);
    } catch (error) {
      return {
        status: snapshotFailureStatus(error),
        file: file.file,
        observations,
        diagnostics: [snapshotFailureDiagnostic(error, file.file.path)],
      };
    }

    let raw: string;
    try {
      raw = readFileSync(file.file.path, "utf8");
    } catch (error) {
      return {
        status: snapshotFailureStatus(error),
        file: file.file,
        observations,
        diagnostics: [snapshotFailureDiagnostic(error, file.file.path)],
      };
    }

    let after: FileFingerprint;
    try {
      after = fingerprintCodexFile(file.file.path);
      observations.push(after);
    } catch (error) {
      return {
        status: snapshotFailureStatus(error),
        file: file.file,
        observations,
        diagnostics: [snapshotFailureDiagnostic(error, file.file.path)],
      };
    }

    if (sameFileFingerprint(before, after)) {
      try {
        return {
          status: "current",
          fragment: parseCodexTranscript(raw, {
            file: file.file,
            fingerprint: after,
            attempts: attempt,
          }),
        };
      } catch {
        return {
          status: "failed",
          file: file.file,
          observations,
          diagnostics: [
            {
              code: "parse_failed",
              severity: "error",
              phase: "parse",
              message: `Unable to parse Codex transcript: ${file.file.path}`,
            },
          ],
        };
      }
    }
  }

  return {
    status: "unstable",
    file: file.file,
    observations,
    diagnostics: [
      {
        code: "unstable_transcript",
        severity: "warning",
        phase: "snapshot",
        message: `Codex transcript changed during ${maxAttempts} parse attempt${maxAttempts === 1 ? "" : "s"}: ${file.file.path}`,
      },
    ],
  };
}

export const parseCodexTranscriptFile = parseCodexFile;

export function parseCodexTranscriptPath(path: string): FileParseResult {
  const absolutePath = resolve(path);
  const rootPath = resolve(CODEX_SESSIONS_DIR);
  const relativePath = normalizedRelativePath(rootPath, absolutePath);
  const file = createFileIdentity({
    source: "codex",
    rootId: CODEX_ROOT_ID,
    role: "transcript",
    relativePath,
    path: absolutePath,
  });
  let fingerprint: FileFingerprint;
  try {
    fingerprint = fingerprintCodexFile(absolutePath);
  } catch (error) {
    return {
      status: snapshotFailureStatus(error),
      file,
      observations: [],
      diagnostics: [snapshotFailureDiagnostic(error, absolutePath)],
    };
  }
  return parseCodexFile({ file, fingerprint });
}

export class CodexDiscoveryAdapter implements TranscriptDiscoveryAdapter {
  readonly source = "codex";

  constructor(
    readonly rootPath = CODEX_SESSIONS_DIR,
    readonly rootId = CODEX_ROOT_ID,
  ) {}

  discover(): DiscoveryResult {
    return discoverCodexFiles(this.rootPath, this.rootId);
  }
}

export class CodexParserAdapter implements TranscriptParserAdapter {
  readonly parser = CODEX_PARSER;

  constructor(readonly options: CodexTranscriptParserOptions = {}) {}

  parseFile(file: DiscoveredFile): FileParseResult {
    return parseCodexFile(file, this.options);
  }
}

export function createCodexDiscoveryAdapter(
  rootPath = CODEX_SESSIONS_DIR,
  rootId = CODEX_ROOT_ID,
): TranscriptDiscoveryAdapter {
  return new CodexDiscoveryAdapter(rootPath, rootId);
}

export function createCodexParserAdapter(
  options: CodexTranscriptParserOptions = {},
): TranscriptParserAdapter {
  return new CodexParserAdapter(options);
}

export const createCodexTranscriptDiscoveryAdapter = createCodexDiscoveryAdapter;
export const createCodexTranscriptParserAdapter = createCodexParserAdapter;
export const codexTranscriptParserAdapter = createCodexTranscriptParserAdapter();
