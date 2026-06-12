import {
  readFileSync,
  readdirSync,
  statSync,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import {
  PARSED_FRAGMENT_CONTRACT_VERSION,
  createFactId,
  createFileIdentity,
  sameFileFingerprint,
  stableCacheId,
  type AuxiliaryParseResult,
  type AuxiliaryParserAdapter,
  type DiscoveredFile,
  type DiscoveryResult,
  type FileFingerprint,
  type FileIdentity,
  type FileParseResult,
  type InvocationFact,
  type MessageFact,
  type NormalizedFacts,
  type ParserDescriptor,
  type ParserDiagnostic,
  type SessionFact,
  type SourcePosition,
  type ToolResultFact,
  type TranscriptDiscoveryAdapter,
  type TranscriptParserAdapter,
} from "./cache-contract.ts";
import { claudeFrictionEvents } from "./friction.ts";
import { HISTORY_FILE, PROJECTS_DIR } from "./paths.ts";
import { parseMcpTool } from "./tool-categories.ts";
import { emptyUsage, type Usage } from "./types.ts";

export const CLAUDE_PROJECTS_ROOT_ID = "claude-projects";
export const CLAUDE_CONFIG_ROOT_ID = "claude-config";
export const CLAUDE_TRANSCRIPT_ROOT_ID = CLAUDE_PROJECTS_ROOT_ID;
export const CLAUDE_AUXILIARY_ROOT_ID = CLAUDE_CONFIG_ROOT_ID;
export const CLAUDE_HISTORY_ROOT_ID = CLAUDE_CONFIG_ROOT_ID;
// v2: emits SessionFact.frictionEvents and MessageFact.stopReason (#37).
export const CLAUDE_TRANSCRIPT_PARSER_VERSION = "2";
export const CLAUDE_AUXILIARY_PARSER_VERSION = "1";
export const CLAUDE_TRANSCRIPT_PARSER: ParserDescriptor = {
  name: "claude-jsonl",
  source: "claude",
  version: CLAUDE_TRANSCRIPT_PARSER_VERSION,
};
export const CLAUDE_HISTORY_PARSER: ParserDescriptor = {
  name: "claude-history",
  source: "claude",
  version: CLAUDE_AUXILIARY_PARSER_VERSION,
};
export const CLAUDE_AUXILIARY_PARSER = CLAUDE_HISTORY_PARSER;
export const CLAUDE_PARSER = CLAUDE_TRANSCRIPT_PARSER;

const FILE_TOOLS = new Set(["Edit", "Write", "Read", "NotebookEdit", "MultiEdit"]);
const MAX_SNAPSHOT_ATTEMPTS = 3;

interface PositionedRecord {
  value: Record<string, any>;
  position: SourcePosition;
}

interface OpenAssistantMessage {
  providerMessageId: string;
  sourceSessionId: string;
  message?: MessageFact;
  pending: PositionedRecord[];
}

interface SessionState {
  fact: SessionFact;
  parentSourceSessionId?: string;
}

interface SnapshotRead {
  raw: string;
  fingerprint: FileFingerprint;
  attempts: number;
}

type SnapshotFailure = Exclude<FileParseResult, { status: "current" }>;

function normalizedRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function fingerprintFromStat(stat: BigIntStats): FileFingerprint {
  return {
    sizeBytes: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    physicalId: {
      scheme: process.platform === "win32" ? "windows_file_id" : "posix_dev_inode",
      value: `${stat.dev}:${stat.ino}`,
    },
  };
}

export function fingerprintClaudeFile(path: string): FileFingerprint {
  return fingerprintFromStat(statSync(path, { bigint: true }));
}

function fileIdentity(
  path: string,
  rootPath: string,
  rootId: string,
  role: "transcript" | "history",
): FileIdentity {
  return createFileIdentity({
    source: "claude",
    rootId,
    role,
    relativePath:
      role === "history"
        ? basename(path)
        : normalizedRelativePath(relative(rootPath, path)),
    path,
  });
}

export function claudeHistoryFileIdentity(
  historyFile = HISTORY_FILE,
  rootId = CLAUDE_CONFIG_ROOT_ID,
): FileIdentity {
  const path = resolve(historyFile);
  return fileIdentity(path, dirname(path), rootId, "history");
}

function diagnostic(
  code: string,
  phase: ParserDiagnostic["phase"],
  message: string,
  position?: SourcePosition,
  severity: ParserDiagnostic["severity"] = "warning",
): ParserDiagnostic {
  return { code, severity, phase, message, ...(position ? { position } : {}) };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function discoveryFailure(
  rootPath: string,
  rootId: string,
  error: unknown,
): DiscoveryResult {
  const missing = errorCode(error) === "ENOENT";
  return {
    status: missing ? "missing" : "unreadable",
    source: "claude",
    rootId,
    rootPath,
    files: [],
    diagnostics: [
      diagnostic(
        missing ? "missing_root" : "unreadable_root",
        "discovery",
        missing ? `Claude root does not exist: ${rootPath}` : `Unable to read Claude root: ${rootPath}`,
        undefined,
        missing ? "warning" : "error",
      ),
    ],
  };
}

export function discoverClaudeTranscripts(
  projectsDir = PROJECTS_DIR,
  rootId = CLAUDE_PROJECTS_ROOT_ID,
): DiscoveryResult {
  const rootPath = resolve(projectsDir);
  try {
    if (!statSync(rootPath).isDirectory()) {
      return {
        status: "unreadable",
        source: "claude",
        rootId,
        rootPath,
        files: [],
        diagnostics: [
          diagnostic(
            "root_not_directory",
            "discovery",
            `Claude transcript root is not a directory: ${rootPath}`,
            undefined,
            "error",
          ),
        ],
      };
    }
  } catch (error) {
    return discoveryFailure(rootPath, rootId, error);
  }

  const files: DiscoveredFile[] = [];
  const diagnostics: ParserDiagnostic[] = [];

  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch {
      diagnostics.push(
        diagnostic(
          "unreadable_directory",
          "discovery",
          `Unable to read Claude transcript directory: ${dir}`,
          undefined,
          "error",
        ),
      );
      return;
    }

    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        files.push({
          file: fileIdentity(path, rootPath, rootId, "transcript"),
          fingerprint: fingerprintClaudeFile(path),
        });
      } catch {
        diagnostics.push(
          diagnostic(
            "unreadable_file",
            "discovery",
            `Unable to fingerprint Claude transcript: ${path}`,
            undefined,
            "error",
          ),
        );
      }
    }
  };

  walk(rootPath);
  files.sort((a, b) =>
    a.file.relativePath < b.file.relativePath
      ? -1
      : a.file.relativePath > b.file.relativePath
        ? 1
        : 0,
  );

  return {
    status: diagnostics.length ? "partial" : "complete",
    source: "claude",
    rootId,
    rootPath,
    files,
    diagnostics,
  };
}

export function discoverClaudeHistory(
  historyFile = HISTORY_FILE,
  rootId = CLAUDE_CONFIG_ROOT_ID,
): DiscoveryResult {
  const file = claudeHistoryFileIdentity(historyFile, rootId);
  try {
    const stat = statSync(file.path, { bigint: true });
    if (!stat.isFile()) {
      return {
        status: "unreadable",
        source: "claude",
        rootId,
        rootPath: dirname(file.path),
        files: [],
        diagnostics: [
          diagnostic(
            "history_not_file",
            "discovery",
            `Claude history path is not a file: ${file.path}`,
            undefined,
            "error",
          ),
        ],
      };
    }
    return {
      status: "complete",
      source: "claude",
      rootId,
      rootPath: dirname(file.path),
      files: [{ file, fingerprint: fingerprintFromStat(stat) }],
      diagnostics: [],
    };
  } catch (error) {
    return discoveryFailure(dirname(file.path), rootId, error);
  }
}

export function discoverClaudeInputs(
  projectsDir = PROJECTS_DIR,
  historyFile = HISTORY_FILE,
): { transcripts: DiscoveryResult; auxiliary: DiscoveryResult } {
  return {
    transcripts: discoverClaudeTranscripts(projectsDir),
    auxiliary: discoverClaudeHistory(historyFile),
  };
}

function readStableSnapshot(
  file: DiscoveredFile,
  maxSnapshotAttempts = MAX_SNAPSHOT_ATTEMPTS,
): SnapshotRead | SnapshotFailure {
  const observations: FileFingerprint[] = [];
  const maxAttempts = Math.max(1, Math.floor(maxSnapshotAttempts));
  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    let before: FileFingerprint;
    try {
      before = fingerprintClaudeFile(file.file.path);
      observations.push(before);
    } catch (error) {
      const code = errorCode(error);
      return {
        status: code === "ENOENT" ? "missing" : "unreadable",
        file: file.file,
        observations,
        diagnostics: [
          diagnostic(
            code === "ENOENT" ? "missing_file" : "unreadable_file",
            "snapshot",
            code === "ENOENT"
              ? `Claude file disappeared before parsing: ${file.file.path}`
              : `Unable to fingerprint Claude file: ${file.file.path}`,
            undefined,
            code === "ENOENT" ? "warning" : "error",
          ),
        ],
      };
    }

    let raw: string;
    try {
      raw = readFileSync(file.file.path, "utf8");
    } catch (error) {
      const code = errorCode(error);
      return {
        status: code === "ENOENT" ? "missing" : "unreadable",
        file: file.file,
        observations,
        diagnostics: [
          diagnostic(
            code === "ENOENT" ? "missing_file" : "unreadable_file",
            "snapshot",
            code === "ENOENT"
              ? `Claude file disappeared while parsing: ${file.file.path}`
              : `Unable to read Claude file: ${file.file.path}`,
            undefined,
            code === "ENOENT" ? "warning" : "error",
          ),
        ],
      };
    }

    let after: FileFingerprint;
    try {
      after = fingerprintClaudeFile(file.file.path);
      observations.push(after);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      return {
        status: "unreadable",
        file: file.file,
        observations,
        diagnostics: [
          diagnostic(
            "unreadable_file",
            "snapshot",
            `Unable to fingerprint Claude file after reading: ${file.file.path}`,
            undefined,
            "error",
          ),
        ],
      };
    }

    if (sameFileFingerprint(before, after)) {
      return { raw, fingerprint: after, attempts };
    }
  }

  return {
    status: "unstable",
    file: file.file,
    observations,
    diagnostics: [
      diagnostic(
        "unstable_file",
        "snapshot",
        `Claude file changed during ${maxAttempts} parse attempt${maxAttempts === 1 ? "" : "s"}: ${file.file.path}`,
        undefined,
        "warning",
      ),
    ],
  };
}

function sourcePosition(
  file: FileIdentity,
  recordIndex: number,
  itemIndex = 0,
  byteOffset?: number,
): SourcePosition {
  return {
    originKey: file.id,
    recordIndex,
    itemIndex,
    ...(byteOffset == null ? {} : { byteOffset }),
  };
}

function jsonlRecords(
  raw: string,
  file: FileIdentity,
  diagnostics: ParserDiagnostic[],
): PositionedRecord[] {
  const records: PositionedRecord[] = [];
  let byteOffset = 0;
  for (const [recordIndex, line] of raw.split("\n").entries()) {
    const position = sourcePosition(file, recordIndex, 0, byteOffset);
    byteOffset += Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        diagnostics.push(
          diagnostic("malformed_record", "parse", "Skipped non-object JSON record", position),
        );
        continue;
      }
      records.push({ value, position });
    } catch {
      diagnostics.push(
        diagnostic("malformed_record", "parse", "Skipped malformed JSON record", position),
      );
    }
  }
  return records;
}

function timestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return NaN;
  return Date.parse(value);
}

function numberOrZero(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function normalizeClaudeUsage(raw: any): Usage {
  const usage = emptyUsage();
  if (!raw) return usage;
  usage.input = numberOrZero(raw.input_tokens);
  usage.output = numberOrZero(raw.output_tokens);
  usage.cacheRead = numberOrZero(raw.cache_read_input_tokens);
  const cacheCreation = raw.cache_creation;
  if (
    cacheCreation &&
    (cacheCreation.ephemeral_5m_input_tokens != null ||
      cacheCreation.ephemeral_1h_input_tokens != null)
  ) {
    usage.cacheWrite5m = numberOrZero(cacheCreation.ephemeral_5m_input_tokens);
    usage.cacheWrite1h = numberOrZero(cacheCreation.ephemeral_1h_input_tokens);
  } else {
    usage.cacheWrite5m = numberOrZero(raw.cache_creation_input_tokens);
  }
  return usage;
}

export function estimateClaudeResultTokens(content: unknown): number {
  let chars = 0;
  if (typeof content === "string") {
    chars = content.length;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") chars += part.length;
      else if (part && typeof part === "object" && typeof (part as any).text === "string") {
        chars += (part as any).text.length;
      } else {
        chars += JSON.stringify(part)?.length ?? 0;
      }
    }
  } else if (content != null) {
    chars = JSON.stringify(content)?.length ?? 0;
  }
  return Math.round(chars / 4);
}

function isSubagentPath(path: string): boolean {
  return normalizedRelativePath(path).split("/").includes("subagents");
}

function subagentIdentity(file: FileIdentity): string {
  return basename(file.path, ".jsonl");
}

export function claudeSourceSessionId(
  file: FileIdentity,
  parentSourceSessionId: string,
  record: Record<string, any>,
): { sourceSessionId: string; parentSourceSessionId?: string } {
  if (record.isSidechain !== true && !isSubagentPath(file.relativePath)) {
    return { sourceSessionId: parentSourceSessionId };
  }
  return {
    sourceSessionId: `${parentSourceSessionId}:subagent:${subagentIdentity(file)}`,
    parentSourceSessionId,
  };
}

function contentParts(record: Record<string, any>): any[] {
  return Array.isArray(record.message?.content) ? record.message.content : [];
}

function invocationMapKey(sourceSessionId: string, invocationId: string): string {
  return `${sourceSessionId}\u0000${invocationId}`;
}

function addInvocations(
  record: PositionedRecord,
  message: MessageFact,
  facts: NormalizedFacts,
  invocationFacts: Map<string, InvocationFact>,
): void {
  const timestamp = timestampMs(record.value.timestamp);
  for (const [itemIndex, part] of contentParts(record.value).entries()) {
    if (!part || part.type !== "tool_use" || typeof part.name !== "string") continue;
    const position = { ...record.position, itemIndex };
    const invocationId = typeof part.id === "string" && part.id ? part.id : undefined;
    const input = part.input ?? {};
    const mcp = parseMcpTool(part.name);
    const fact: InvocationFact = {
      id: createFactId(
        "invocation",
        "claude",
        message.sourceSessionId,
        position,
        invocationId ?? part.name,
      ),
      source: "claude",
      sourceSessionId: message.sourceSessionId,
      messageId: message.id,
      ...(invocationId ? { invocationId } : {}),
      ...(Number.isFinite(timestamp) ? { timestampMs: timestamp } : {}),
      name: part.name,
      ...(part.name === "Skill" && typeof input.skill === "string"
        ? {
            skill: input.skill,
            ...(typeof input.args === "string" && input.args
              ? { args: input.args.slice(0, 280) }
              : {}),
          }
        : {}),
      ...(mcp ? { mcpServer: mcp.server, mcpTool: mcp.tool } : {}),
      ...(FILE_TOOLS.has(part.name) && typeof input.file_path === "string"
        ? { filePath: input.file_path }
        : {}),
      position,
    };
    facts.invocations.push(fact);
    if (invocationId) invocationFacts.set(invocationMapKey(message.sourceSessionId, invocationId), fact);
  }
}

function createMessageFact(
  record: PositionedRecord,
  sourceSessionId: string,
  diagnostics: ParserDiagnostic[],
): MessageFact | undefined {
  const timestamp = timestampMs(record.value.timestamp);
  if (!Number.isFinite(timestamp)) {
    diagnostics.push(
      diagnostic(
        "invalid_message_timestamp",
        "parse",
        "Skipped Claude assistant message with an invalid timestamp",
        record.position,
      ),
    );
    return undefined;
  }
  const providerMessageId =
    typeof record.value.message?.id === "string" && record.value.message.id
      ? record.value.message.id
      : undefined;
  const requestId =
    typeof record.value.requestId === "string" && record.value.requestId
      ? record.value.requestId
      : undefined;
  return {
    id: createFactId(
      "message",
      "claude",
      sourceSessionId,
      record.position,
      providerMessageId ?? requestId ?? "",
    ),
    source: "claude",
    sourceSessionId,
    ...(providerMessageId ? { providerMessageId } : {}),
    ...(requestId ? { requestId } : {}),
    timestampMs: timestamp,
    model:
      typeof record.value.message?.model === "string" && record.value.message.model
        ? record.value.message.model
        : "(unknown)",
    usage: normalizeClaudeUsage(record.value.message?.usage),
    ...(typeof record.value.cwd === "string" ? { cwd: record.value.cwd } : {}),
    ...(typeof record.value.gitBranch === "string"
      ? { gitBranch: record.value.gitBranch }
      : {}),
    attributionSkill:
      typeof record.value.attributionSkill === "string"
        ? record.value.attributionSkill
        : null,
    ...(typeof record.value.message?.stop_reason === "string"
      ? { stopReason: record.value.message.stop_reason }
      : {}),
    position: record.position,
  };
}

function parseTranscript(
  raw: string,
  file: FileIdentity,
  historyInputId: string,
): {
  facts: NormalizedFacts;
  dependencies: Array<{
    inputId: string;
    selector: string;
    affects: ["session_first_prompt"];
  }>;
  diagnostics: ParserDiagnostic[];
} {
  const facts: NormalizedFacts = {
    sessions: [],
    messages: [],
    invocations: [],
    toolResults: [],
    relationships: [],
  };
  const diagnostics: ParserDiagnostic[] = [];
  const records = jsonlRecords(raw, file, diagnostics);
  const sessions = new Map<string, SessionState>();
  const dependencySelectors = new Set<string>();
  const invocationNames = new Map<string, string>();
  const invocationFacts = new Map<string, InvocationFact>();
  let open: OpenAssistantMessage | undefined;

  const ensureSession = (
    record: PositionedRecord,
    parentSourceSessionId: string,
  ): SessionState => {
    const identity = claudeSourceSessionId(file, parentSourceSessionId, record.value);
    let state = sessions.get(identity.sourceSessionId);
    if (!state) {
      const fact: SessionFact = {
        id: createFactId(
          "session",
          "claude",
          identity.sourceSessionId,
          record.position,
          identity.sourceSessionId,
        ),
        source: "claude",
        sourceSessionId: identity.sourceSessionId,
        kind: identity.parentSourceSessionId ? "subagent" : "main",
        transcriptPath: file.path,
        ...(typeof record.value.cwd === "string" && record.value.cwd
          ? { cwd: record.value.cwd }
          : {}),
        ...(typeof record.value.gitBranch === "string" && record.value.gitBranch
          ? { gitBranch: record.value.gitBranch }
          : {}),
        position: record.position,
      };
      state = { fact, parentSourceSessionId: identity.parentSourceSessionId };
      sessions.set(identity.sourceSessionId, state);
      facts.sessions.push(fact);
      if (identity.parentSourceSessionId) {
        facts.relationships.push({
          id: createFactId(
            "relationship",
            "claude",
            identity.sourceSessionId,
            record.position,
            identity.parentSourceSessionId,
          ),
          source: "claude",
          childSourceSessionId: identity.sourceSessionId,
          parentSourceSessionId: identity.parentSourceSessionId,
          kind: "subagent",
          position: record.position,
        });
      }
    } else {
      if (!state.fact.cwd && typeof record.value.cwd === "string" && record.value.cwd) {
        state.fact.cwd = record.value.cwd;
      }
      if (
        !state.fact.gitBranch &&
        typeof record.value.gitBranch === "string" &&
        record.value.gitBranch
      ) {
        state.fact.gitBranch = record.value.gitBranch;
      }
    }
    dependencySelectors.add(parentSourceSessionId);
    return state;
  };

  for (const record of records) {
    const parentSourceSessionId =
      typeof record.value.sessionId === "string" && record.value.sessionId
        ? record.value.sessionId
        : undefined;
    if (!parentSourceSessionId) {
      open = undefined;
      continue;
    }
    const session = ensureSession(record, parentSourceSessionId);
    const sourceSessionId = session.fact.sourceSessionId;
    const content = contentParts(record.value);

    const frictionEvents = claudeFrictionEvents(record.value);
    if (frictionEvents.length) {
      (session.fact.frictionEvents ??= []).push(...frictionEvents);
    }

    if (record.value.type === "assistant") {
      for (const part of content) {
        if (
          part?.type === "tool_use" &&
          typeof part.id === "string" &&
          typeof part.name === "string"
        ) {
          invocationNames.set(invocationMapKey(sourceSessionId, part.id), part.name);
        }
      }
    }

    if (record.value.type !== "assistant") open = undefined;

    if (record.value.type === "user") {
      for (const [itemIndex, part] of content.entries()) {
        if (
          !part ||
          part.type !== "tool_result" ||
          typeof part.tool_use_id !== "string"
        ) {
          continue;
        }
        const position = { ...record.position, itemIndex };
        const key = invocationMapKey(sourceSessionId, part.tool_use_id);
        const invocation = invocationFacts.get(key);
        const observedToolName = invocation?.name ?? invocationNames.get(key);
        const result: ToolResultFact = {
          id: createFactId(
            "tool_result",
            "claude",
            sourceSessionId,
            position,
            part.tool_use_id,
          ),
          source: "claude",
          sourceSessionId,
          invocationId: part.tool_use_id,
          ...(invocation ? { resolvedInvocationFactId: invocation.id } : {}),
          ...(observedToolName ? { observedToolName } : {}),
          approxTokens: estimateClaudeResultTokens(part.content),
          position,
        };
        facts.toolResults.push(result);
      }
    }

    if (record.value.type !== "assistant") continue;

    const providerMessageId =
      typeof record.value.message?.id === "string" && record.value.message.id
        ? record.value.message.id
        : undefined;
    const isContinuation =
      providerMessageId != null &&
      open?.providerMessageId === providerMessageId &&
      open?.sourceSessionId === sourceSessionId;

    if (!isContinuation) {
      open = providerMessageId
        ? { providerMessageId, sourceSessionId, pending: [] }
        : undefined;
    }

    if (!record.value.message?.usage) {
      if (open) open.pending.push(record);
      continue;
    }

    if (isContinuation && open?.message) {
      // Streamed messages repeat metadata per line; stop_reason is only non-null on the last.
      if (!open.message.stopReason && typeof record.value.message?.stop_reason === "string") {
        open.message.stopReason = record.value.message.stop_reason;
      }
      addInvocations(record, open.message, facts, invocationFacts);
      continue;
    }

    const message = createMessageFact(record, sourceSessionId, diagnostics);
    if (!message) continue;
    facts.messages.push(message);

    if (open) {
      for (const pending of open.pending) {
        addInvocations(pending, message, facts, invocationFacts);
      }
      open.pending = [];
      open.message = message;
    }
    addInvocations(record, message, facts, invocationFacts);
  }

  return {
    facts,
    dependencies: [...dependencySelectors]
      .sort()
      .map((selector) => ({
        inputId: historyInputId,
        selector,
        affects: ["session_first_prompt"] as ["session_first_prompt"],
      })),
    diagnostics,
  };
}

export interface ClaudeTranscriptParserOptions {
  historyInputId?: string;
  maxSnapshotAttempts?: number;
}

export interface ClaudeAuxiliaryParserOptions {
  maxSnapshotAttempts?: number;
}

export function parseClaudeTranscriptFile(
  file: DiscoveredFile,
  options: ClaudeTranscriptParserOptions = {},
): FileParseResult {
  if (file.file.source !== "claude" || file.file.role !== "transcript") {
    return {
      status: "failed",
      file: file.file,
      observations: [file.fingerprint],
      diagnostics: [
        diagnostic(
          "invalid_file_role",
          "parse",
          `Claude transcript parser cannot parse ${file.file.role} file ${file.file.path}`,
          undefined,
          "error",
        ),
      ],
    };
  }

  const snapshot = readStableSnapshot(file, options.maxSnapshotAttempts);
  if (!("raw" in snapshot)) return snapshot;

  try {
    const historyInputId =
      options.historyInputId ?? claudeHistoryFileIdentity().id;
    const parsed = parseTranscript(snapshot.raw, file.file, historyInputId);
    return {
      status: "current",
      fragment: {
        kind: "transcript",
        id: stableCacheId("fragment", [file.file.id]),
        contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
        parser: CLAUDE_TRANSCRIPT_PARSER,
        snapshot: {
          file: file.file,
          fingerprint: snapshot.fingerprint,
          attempts: snapshot.attempts,
        },
        facts: parsed.facts,
        dependencies: parsed.dependencies,
        diagnostics: parsed.diagnostics,
      },
    };
  } catch {
    return {
      status: "failed",
      file: file.file,
      observations: [snapshot.fingerprint],
      diagnostics: [
        diagnostic(
          "parse_failed",
          "parse",
          `Unable to parse Claude transcript: ${file.file.path}`,
          undefined,
          "error",
        ),
      ],
    };
  }
}

export function parseClaudeHistoryFile(
  file: DiscoveredFile,
  options: ClaudeAuxiliaryParserOptions = {},
): AuxiliaryParseResult {
  if (file.file.source !== "claude" || file.file.role !== "history") {
    return {
      status: "failed",
      file: file.file,
      observations: [file.fingerprint],
      diagnostics: [
        diagnostic(
          "invalid_file_role",
          "parse",
          `Claude history parser cannot parse ${file.file.role} file ${file.file.path}`,
          undefined,
          "error",
        ),
      ],
    };
  }

  const snapshot = readStableSnapshot(file, options.maxSnapshotAttempts);
  if (!("raw" in snapshot)) return snapshot;

  try {
    const diagnostics: ParserDiagnostic[] = [];
    const records = jsonlRecords(snapshot.raw, file.file, diagnostics);
    const earliest = new Map<
      string,
      { firstPrompt: string; timestampMs: number; position: SourcePosition }
    >();

    for (const record of records) {
      const sourceSessionId =
        typeof record.value.sessionId === "string" && record.value.sessionId
          ? record.value.sessionId
          : undefined;
      const firstPrompt =
        typeof record.value.display === "string" && record.value.display
          ? record.value.display
          : undefined;
      if (!sourceSessionId || !firstPrompt) continue;
      const timestamp = numberOrZero(record.value.timestamp);
      const previous = earliest.get(sourceSessionId);
      if (!previous || timestamp < previous.timestampMs) {
        earliest.set(sourceSessionId, {
          firstPrompt,
          timestampMs: timestamp,
          position: record.position,
        });
      }
    }

    const facts = [...earliest.entries()]
      .sort((a, b) =>
        a[0] < b[0]
          ? -1
          : a[0] > b[0]
            ? 1
            : a[1].position.recordIndex - b[1].position.recordIndex,
      )
      .map(([sourceSessionId, prompt]) => ({
        id: stableCacheId("fact:session_first_prompt", [
          sourceSessionId,
          prompt.position.originKey,
          prompt.position.recordIndex,
          prompt.position.itemIndex,
        ]),
        kind: "session_first_prompt" as const,
        source: "claude" as const,
        sourceSessionId,
        firstPrompt: prompt.firstPrompt,
        timestampMs: prompt.timestampMs,
        position: prompt.position,
      }));

    return {
      status: "current",
      fragment: {
        kind: "auxiliary",
        id: stableCacheId("auxiliary-fragment", [file.file.id]),
        contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
        parser: CLAUDE_HISTORY_PARSER,
        snapshot: {
          file: file.file,
          fingerprint: snapshot.fingerprint,
          attempts: snapshot.attempts,
        },
        facts,
        diagnostics,
      },
    };
  } catch {
    return {
      status: "failed",
      file: file.file,
      observations: [snapshot.fingerprint],
      diagnostics: [
        diagnostic(
          "parse_failed",
          "parse",
          `Unable to parse Claude history: ${file.file.path}`,
          undefined,
          "error",
        ),
      ],
    };
  }
}

export function createClaudeTranscriptDiscoveryAdapter(
  projectsDir = PROJECTS_DIR,
  rootId = CLAUDE_PROJECTS_ROOT_ID,
): TranscriptDiscoveryAdapter {
  return {
    source: "claude",
    discover: () => discoverClaudeTranscripts(projectsDir, rootId),
  };
}

export function createClaudeTranscriptParserAdapter(
  options: ClaudeTranscriptParserOptions = {},
): TranscriptParserAdapter {
  return {
    parser: CLAUDE_TRANSCRIPT_PARSER,
    parseFile: (file) => parseClaudeTranscriptFile(file, options),
  };
}

export function createClaudeHistoryParserAdapter(
  options: ClaudeAuxiliaryParserOptions = {},
): AuxiliaryParserAdapter {
  return {
    parser: CLAUDE_HISTORY_PARSER,
    parseFile: (file) => parseClaudeHistoryFile(file, options),
  };
}

export const discoverClaudeFiles = discoverClaudeTranscripts;
export const discoverClaudeAuxiliaryFiles = discoverClaudeHistory;
export const discoverClaudeAuxiliary = discoverClaudeHistory;
export const createClaudeDiscoveryAdapter = createClaudeTranscriptDiscoveryAdapter;
export const createClaudeParserAdapter = createClaudeTranscriptParserAdapter;
export const createClaudeAuxiliaryParserAdapter = createClaudeHistoryParserAdapter;
export const parseClaudeTranscript = parseClaudeTranscriptFile;
export const parseClaudeFile = parseClaudeTranscriptFile;
export const parseClaudeAuxiliary = parseClaudeHistoryFile;
export const claudeTranscriptParserAdapter = createClaudeTranscriptParserAdapter();
export const claudeAuxiliaryParserAdapter = createClaudeHistoryParserAdapter();
