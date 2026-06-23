import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  PARSED_FRAGMENT_CONTRACT_VERSION,
  createFactId,
  createFileIdentity,
  sameFileFingerprint,
  stableId,
  type DiscoveredFile,
  type DiscoveryResult,
  type FileFingerprint,
  type FileIdentity,
  type FileParseResult,
  type InvocationFact,
  type UsageFact,
  type NormalizedFacts,
  type ParserDescriptor,
  type ParserDiagnostic,
  type SessionFact,
  type SourcePosition,
  type TaskCandidateFact,
  type ToolResultFact,
  type TranscriptDiscoveryAdapter,
  type TranscriptParserAdapter,
} from "../../../../store/store-contract.ts";
import { type FrictionEvent } from "../../../friction.ts";
import { COWORK_SESSIONS_DIR } from "../../../../paths.ts";
import {
  TASK_TEXT_LIMIT,
  argusGeneratedPromptTitle,
  hasClaudeToolResultContent,
  isClaudeGeneratedContextText,
  shouldSkipTaskCandidateText,
  textFromUserContent,
} from "../../../interpret/task-candidates.ts";
import { parseMcpTool } from "../../../../tool-categories.ts";
import { dialogueTurn, type DialogueTurn } from "../../../interpret/dialogue.ts";
import { emptyUsage } from "../../../../types.ts";
import {
  estimateClaudeResultTokens,
  fingerprintClaudeFile,
  normalizeClaudeUsage,
} from "../claude/parser.ts";

export const COWORK_SESSIONS_ROOT_ID = "cowork-sessions";
// v1: initial implementation.
// v2: emits filtered user task candidates for explicit per-session task extraction.
// v3: excludes Argus task-extraction prompts from task candidates.
// v4: labels Argus task-extraction sessions with their target session.
// v5: excludes and labels Argus session-analysis prompts.
export const COWORK_TRANSCRIPT_PARSER_VERSION = "5";
export const COWORK_TRANSCRIPT_PARSER: ParserDescriptor = {
  name: "cowork-jsonl",
  source: "cowork",
  version: COWORK_TRANSCRIPT_PARSER_VERSION,
};

const FILE_TOOLS = new Set(["Edit", "Write", "Read", "NotebookEdit", "MultiEdit"]);
const DEFAULT_SNAPSHOT_ATTEMPTS: number = 3;

interface PositionedRecord {
  value: Record<string, any>;
  position: SourcePosition;
}

interface OpenAssistantMessage {
  providerMessageId: string;
  sourceSessionId: string;
  message?: UsageFact;
  pending: PositionedRecord[];
}

interface CoworkSessionMetadata {
  userSelectedFolders: string[];
  title?: string;
  processName?: string;
}

function normalizedRelativePath(path: string): string {
  return path.split(sep).join("/");
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

function invocationMapKey(sourceSessionId: string, invocationId: string): string {
  return `${sourceSessionId}\u0000${invocationId}`;
}

function contentParts(record: Record<string, any>): any[] {
  return Array.isArray(record.message?.content) ? record.message.content : [];
}

function coworkUserMessageText(record: PositionedRecord, limit = TASK_TEXT_LIMIT): string | undefined {
  if (record.value.type !== "user") return undefined;
  return textFromUserContent(record.value.message?.content, limit) || undefined;
}

function timestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return NaN;
  return Date.parse(value);
}

/**
 * Reconstruct the human↔assistant dialogue from a Cowork JSONL transcript (#91). Same shape as
 * Claude (message.content), but timestamps fall back to _audit_timestamp and replayed user events
 * (isReplay) are skipped so resumed sessions don't double-count.
 */
export function reconstructCoworkDialogue(path: string): DialogueTurn[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const turns: DialogueTurn[] = [];
  const seenAssistant = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let value: Record<string, any>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      value = parsed;
    } catch {
      continue;
    }
    const ts = timestampMs(value.timestamp ?? value._audit_timestamp);
    if (value.type === "user") {
      if (value.isReplay === true) continue;
      const content = value.message?.content;
      if (hasClaudeToolResultContent(content)) continue;
      const text = textFromUserContent(content);
      if (text && !isClaudeGeneratedContextText(text)) {
        const turn = dialogueTurn("user", text, ts);
        if (turn) turns.push(turn);
      }
    } else if (value.type === "assistant") {
      // Same fix as the Claude parser: a single assistant message is often split across records (a
      // tool_use record with no text, then the text record), so only let a NON-EMPTY turn claim the
      // dedup slot — otherwise the answer record (same id) is dropped and outcome judging thinks the
      // assistant never replied. First non-empty occurrence per id wins (re-appends still dedup).
      const turn = dialogueTurn("assistant", textFromUserContent(value.message?.content), ts);
      if (!turn) continue;
      const id = typeof value.message?.id === "string" ? value.message.id : undefined;
      if (id) {
        if (seenAssistant.has(id)) continue;
        seenAssistant.add(id);
      }
      turns.push(turn);
    }
  }
  return turns;
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

function discoveryFailure(rootPath: string, error: unknown): DiscoveryResult {
  const missing = errorCode(error) === "ENOENT";
  return {
    status: missing ? "missing" : "unreadable",
    source: "cowork",
    rootId: COWORK_SESSIONS_ROOT_ID,
    rootPath,
    files: [],
    diagnostics: [
      diagnostic(
        missing ? "missing_root" : "unreadable_root",
        "discovery",
        missing
          ? `Cowork sessions root does not exist: ${rootPath}`
          : `Unable to read Cowork sessions root: ${rootPath}`,
        undefined,
        missing ? "warning" : "error",
      ),
    ],
  };
}

function fileIdentity(path: string, rootPath: string): FileIdentity {
  return createFileIdentity({
    source: "cowork",
    rootId: COWORK_SESSIONS_ROOT_ID,
    role: "transcript",
    relativePath: normalizedRelativePath(relative(rootPath, path)),
    path,
  });
}

export function discoverCoworkTranscripts(sessionsDir?: string): DiscoveryResult {
  // Fall back to the platform default when no override is given.
  const dir = sessionsDir ?? COWORK_SESSIONS_DIR;
  if (!dir) {
    return {
      status: "missing",
      source: "cowork",
      rootId: COWORK_SESSIONS_ROOT_ID,
      rootPath: "(unavailable)",
      files: [],
      diagnostics: [
        diagnostic(
          "missing_root",
          "discovery",
          "Cowork sessions directory is not available on this platform",
          undefined,
          "warning",
        ),
      ],
    };
  }

  const rootPath = resolve(dir);
  try {
    if (!statSync(rootPath).isDirectory()) {
      return {
        status: "unreadable",
        source: "cowork",
        rootId: COWORK_SESSIONS_ROOT_ID,
        rootPath,
        files: [],
        diagnostics: [
          diagnostic(
            "root_not_directory",
            "discovery",
            `Cowork sessions root is not a directory: ${rootPath}`,
            undefined,
            "error",
          ),
        ],
      };
    }
  } catch (error) {
    return discoveryFailure(rootPath, error);
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
          `Unable to read Cowork directory: ${dir}`,
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
      if (!entry.isFile() || entry.name !== "audit.jsonl") continue;
      try {
        files.push({
          file: fileIdentity(path, rootPath),
          fingerprint: fingerprintClaudeFile(path),
        });
      } catch {
        diagnostics.push(
          diagnostic(
            "unreadable_file",
            "discovery",
            `Unable to fingerprint Cowork transcript: ${path}`,
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
    source: "cowork",
    rootId: COWORK_SESSIONS_ROOT_ID,
    rootPath,
    files,
    diagnostics,
  };
}

function readCoworkMetadata(auditPath: string): CoworkSessionMetadata | null {
  // audit.jsonl is at: <root>/<org>/<team>/<local_id>/audit.jsonl
  // metadata is at:    <root>/<org>/<team>/local_<id>.json
  const localDirName = basename(dirname(auditPath));
  const teamDir = dirname(dirname(auditPath));
  const metaPath = join(teamDir, `${localDirName}.json`);
  try {
    const data = JSON.parse(readFileSync(metaPath, "utf8"));
    return {
      userSelectedFolders: Array.isArray(data.userSelectedFolders)
        ? (data.userSelectedFolders as unknown[]).filter((f): f is string => typeof f === "string")
        : [],
      title: typeof data.title === "string" && data.title ? data.title : undefined,
      processName: typeof data.processName === "string" && data.processName ? data.processName : undefined,
    };
  } catch {
    return null;
  }
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

function coworkResultFrictionEvents(
  record: Record<string, any>,
  position: SourcePosition,
): FrictionEvent[] {
  const events: FrictionEvent[] = [];
  // Use _audit_timestamp as a stable ID across replays; fall back to record position.
  const baseId =
    typeof record._audit_timestamp === "string" && record._audit_timestamp
      ? record._audit_timestamp
      : `pos:${position.recordIndex}`;

  const durationMs =
    typeof record.duration_ms === "number" && Number.isFinite(record.duration_ms)
      ? record.duration_ms
      : undefined;
  events.push({
    eventId: `cowork:turn:${baseId}`,
    kind: "turn",
    ...(durationMs !== undefined ? { durationMs } : {}),
  });

  const denials =
    typeof record.permission_denials === "number"
      ? Math.max(0, Math.floor(record.permission_denials))
      : 0;
  for (let i = 0; i < denials; i++) {
    events.push({ eventId: `cowork:rejection:${baseId}:${i}`, kind: "rejection" });
  }

  return events;
}

function addInvocations(
  record: PositionedRecord,
  message: UsageFact,
  facts: NormalizedFacts,
  invocationFacts: Map<string, InvocationFact>,
): void {
  const ts = timestampMs(record.value.timestamp ?? record.value._audit_timestamp);
  for (const [itemIndex, part] of contentParts(record.value).entries()) {
    if (!part || part.type !== "tool_use" || typeof part.name !== "string") continue;
    const position = { ...record.position, itemIndex };
    const invocationId = typeof part.id === "string" && part.id ? part.id : undefined;
    const input = part.input ?? {};
    const mcp = parseMcpTool(part.name);
    const fact: InvocationFact = {
      id: createFactId(
        "invocation",
        "cowork",
        message.sourceSessionId,
        position,
        invocationId ?? part.name,
      ),
      source: "cowork",
      sourceSessionId: message.sourceSessionId,
      messageId: message.id,
      ...(invocationId ? { invocationId } : {}),
      ...(Number.isFinite(ts) ? { timestampMs: ts } : {}),
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
    if (invocationId)
      invocationFacts.set(invocationMapKey(message.sourceSessionId, invocationId), fact);
  }
}

function parseCoworkTranscript(
  raw: string,
  file: FileIdentity,
  metadata: CoworkSessionMetadata | null,
): { facts: NormalizedFacts; diagnostics: ParserDiagnostic[] } {
  const facts: NormalizedFacts = {
    sessions: [],
    messages: [],
    invocations: [],
    toolResults: [],
    taskCandidates: [],
    tasks: [],
    relationships: [],
  };
  const diagnostics: ParserDiagnostic[] = [];
  const records = jsonlRecords(raw, file, diagnostics);

  let sessionFact: SessionFact | undefined;
  const invocationNames = new Map<string, string>();
  const invocationFacts = new Map<string, InvocationFact>();
  let open: OpenAssistantMessage | undefined;

  const cwd = metadata?.userSelectedFolders?.[0] ?? undefined;
  const rawProjectId = cwd
    ? undefined
    : (metadata?.title ?? metadata?.processName ?? undefined);

  const nextUserText = (recordIndex: number, nativeSessionId: string): string | undefined => {
    const next = records[recordIndex + 1];
    if (!next || next.value.session_id !== nativeSessionId) return undefined;
    return coworkUserMessageText(next);
  };

  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const record = records[recordIndex]!;
    // system/thinking_tokens: streaming progress events, no useful data
    if (record.value.type === "system" && record.value.subtype === "thinking_tokens") continue;

    // system/init: first occurrence establishes session; subsequent ones are per-turn reconnects
    if (record.value.type === "system" && record.value.subtype === "init") {
      if (!sessionFact) {
        const innerSessionId =
          typeof record.value.session_id === "string" && record.value.session_id
            ? record.value.session_id
            : undefined;
        if (!innerSessionId) continue;
        const sourceSessionId = `cowork:${innerSessionId}`;
        const fact: SessionFact = {
          id: createFactId("session", "cowork", sourceSessionId, record.position, sourceSessionId),
          source: "cowork",
          sourceSessionId,
          kind: "main",
          transcriptPath: file.path,
          ...(cwd ? { cwd } : {}),
          ...(rawProjectId ? { rawProjectId } : {}),
          position: record.position,
        };
        sessionFact = fact;
        facts.sessions.push(fact);
      }
      open = undefined;
      continue;
    }

    if (!sessionFact) continue;
    const sourceSessionId = sessionFact.sourceSessionId;

    // Bare queued desktop-app user events (no isReplay, no timestamp) — skip
    if (record.value.type === "user" && record.value.isReplay !== true) {
      open = undefined;
      continue;
    }

    // Replayed user messages: extract tool_result facts for result-size attribution
    if (record.value.type === "user") {
      open = undefined;
      const content = Array.isArray(record.value.message?.content)
        ? record.value.message.content
        : [];
      const taskText = coworkUserMessageText(record);
      const nativeSessionId =
        typeof record.value.session_id === "string" ? record.value.session_id : "";
      const generatedTitle = taskText ? argusGeneratedPromptTitle(taskText) : undefined;
      if (generatedTitle && !sessionFact.firstPrompt) {
        sessionFact.firstPrompt = generatedTitle;
      }
      if (
        taskText &&
        !shouldSkipTaskCandidateText(taskText, nextUserText(recordIndex, nativeSessionId))
      ) {
        const taskTimestamp = timestampMs(record.value.timestamp ?? record.value._audit_timestamp);
        const task: TaskCandidateFact = {
          id: createFactId(
            "task_candidate",
            "cowork",
            sourceSessionId,
            record.position,
            "user_message",
          ),
          source: "cowork",
          sourceSessionId,
          text: taskText,
          position: record.position,
        };
        if (Number.isFinite(taskTimestamp)) task.timestampMs = taskTimestamp;
        facts.taskCandidates.push(task);
      }
      for (const [itemIndex, part] of content.entries()) {
        if (!part || part.type !== "tool_result" || typeof part.tool_use_id !== "string") continue;
        const position = { ...record.position, itemIndex };
        const key = invocationMapKey(sourceSessionId, part.tool_use_id);
        const invocation = invocationFacts.get(key);
        const observedToolName = invocation?.name ?? invocationNames.get(key);
        const result: ToolResultFact = {
          id: createFactId("tool_result", "cowork", sourceSessionId, position, part.tool_use_id),
          source: "cowork",
          sourceSessionId,
          invocationId: part.tool_use_id,
          ...(invocation ? { resolvedInvocationFactId: invocation.id } : {}),
          ...(observedToolName ? { observedToolName } : {}),
          approxTokens: estimateClaudeResultTokens(part.content),
          position,
        };
        facts.toolResults.push(result);
      }
      continue;
    }

    // result records: per-turn friction signals (stop_reason, permission_denials, duration)
    if (record.value.type === "result") {
      open = undefined;
      const frictionEvents = coworkResultFrictionEvents(record.value, record.position);
      if (frictionEvents.length) (sessionFact.frictionEvents ??= []).push(...frictionEvents);
      continue;
    }

    if (record.value.type !== "assistant") {
      open = undefined;
      continue;
    }

    // Track invocation names from tool_use content blocks for result attribution
    for (const part of contentParts(record.value)) {
      if (
        part?.type === "tool_use" &&
        typeof part.id === "string" &&
        typeof part.name === "string"
      ) {
        invocationNames.set(invocationMapKey(sourceSessionId, part.id), part.name);
      }
    }

    const providerMessageId =
      typeof record.value.message?.id === "string" && record.value.message.id
        ? record.value.message.id
        : undefined;

    const isContinuation =
      providerMessageId != null &&
      open?.providerMessageId === providerMessageId &&
      open?.sourceSessionId === sourceSessionId;

    if (!isContinuation) {
      open = providerMessageId ? { providerMessageId, sourceSessionId, pending: [] } : undefined;
    }

    // No usage yet on this streaming line — buffer for invocations when usage arrives
    if (!record.value.message?.usage) {
      if (open) open.pending.push(record);
      continue;
    }

    // Continuation of an already-created message: update stop_reason and add invocations
    if (isContinuation && open?.message) {
      if (
        !open.message.stopReason &&
        typeof record.value.message?.stop_reason === "string"
      ) {
        open.message.stopReason = record.value.message.stop_reason;
      }
      addInvocations(record, open.message, facts, invocationFacts);
      continue;
    }

    if (record.value.message?.model === "<synthetic>") continue;

    const ts = timestampMs(record.value.timestamp ?? record.value._audit_timestamp);
    if (!Number.isFinite(ts)) {
      diagnostics.push(
        diagnostic(
          "invalid_message_timestamp",
          "parse",
          "Skipped Cowork assistant message with an invalid timestamp",
          record.position,
        ),
      );
      open = undefined;
      continue;
    }

    const requestId =
      typeof record.value.requestId === "string" && record.value.requestId
        ? record.value.requestId
        : undefined;

    const message: UsageFact = {
      id: createFactId(
        "message",
        "cowork",
        sourceSessionId,
        record.position,
        providerMessageId ?? requestId ?? "",
      ),
      source: "cowork",
      sourceSessionId,
      ...(providerMessageId ? { providerMessageId } : {}),
      ...(requestId ? { requestId } : {}),
      timestampMs: ts,
      model:
        typeof record.value.message?.model === "string" && record.value.message.model
          ? record.value.message.model
          : "(unknown)",
      usage: normalizeClaudeUsage(record.value.message?.usage),
      attributionSkill:
        typeof record.value.attributionSkill === "string"
          ? record.value.attributionSkill
          : null,
      ...(typeof record.value.message?.stop_reason === "string"
        ? { stopReason: record.value.message.stop_reason }
        : {}),
      position: record.position,
    };

    facts.messages.push(message);

    if (open) {
      for (const pending of open.pending) addInvocations(pending, message, facts, invocationFacts);
      open.pending = [];
      open.message = message;
    }
    addInvocations(record, message, facts, invocationFacts);
  }

  return { facts, diagnostics };
}

export function parseCoworkTranscriptFile(file: DiscoveredFile): FileParseResult {
  if (file.file.source !== "cowork" || file.file.role !== "transcript") {
    return {
      status: "failed",
      file: file.file,
      observations: [file.fingerprint],
      diagnostics: [
        diagnostic(
          "invalid_file_role",
          "parse",
          `Cowork transcript parser cannot parse ${file.file.role} file ${file.file.path}`,
          undefined,
          "error",
        ),
      ],
    };
  }

  const metadata = readCoworkMetadata(file.file.path);
  const maxAttempts = DEFAULT_SNAPSHOT_ATTEMPTS;
  const observations: FileFingerprint[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
              ? `Cowork transcript disappeared before parsing: ${file.file.path}`
              : `Unable to fingerprint Cowork transcript: ${file.file.path}`,
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
              ? `Cowork transcript disappeared while reading: ${file.file.path}`
              : `Unable to read Cowork transcript: ${file.file.path}`,
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
            `Unable to fingerprint Cowork transcript after reading: ${file.file.path}`,
            undefined,
            "error",
          ),
        ],
      };
    }

    if (sameFileFingerprint(before, after)) {
      try {
        const parsed = parseCoworkTranscript(raw, file.file, metadata);
        return {
          status: "current",
          fragment: {
            kind: "transcript",
            id: stableId("fragment", [file.file.id]),
            contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
            parser: COWORK_TRANSCRIPT_PARSER,
            snapshot: { file: file.file, fingerprint: after, attempts: attempt },
            facts: parsed.facts,
            dependencies: [],
            diagnostics: parsed.diagnostics,
          },
        };
      } catch {
        return {
          status: "failed",
          file: file.file,
          observations,
          diagnostics: [
            diagnostic(
              "parse_failed",
              "parse",
              `Unable to parse Cowork transcript: ${file.file.path}`,
              undefined,
              "error",
            ),
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
      diagnostic(
        "unstable_file",
        "snapshot",
        `Cowork transcript changed during ${maxAttempts} parse attempt${maxAttempts === 1 ? "" : "s"}: ${file.file.path}`,
        undefined,
        "warning",
      ),
    ],
  };
}

export function parseCoworkTranscriptPath(path: string): FileParseResult {
  const absolutePath = resolve(path);
  const rootPath = COWORK_SESSIONS_DIR ? resolve(COWORK_SESSIONS_DIR) : dirname(absolutePath);
  const file = fileIdentity(absolutePath, rootPath);
  let fingerprint: FileFingerprint;
  try {
    fingerprint = fingerprintClaudeFile(absolutePath);
  } catch (error) {
    const missing = errorCode(error) === "ENOENT";
    return {
      status: missing ? "missing" : "unreadable",
      file,
      observations: [],
      diagnostics: [
        diagnostic(
          missing ? "missing_file" : "unreadable_file",
          "snapshot",
          missing
            ? `Cowork transcript disappeared before parsing: ${absolutePath}`
            : `Unable to fingerprint Cowork transcript: ${absolutePath}`,
          undefined,
          missing ? "warning" : "error",
        ),
      ],
    };
  }
  return parseCoworkTranscriptFile({ file, fingerprint });
}

export function createCoworkTranscriptDiscoveryAdapter(
  sessionsDir = COWORK_SESSIONS_DIR,
): TranscriptDiscoveryAdapter {
  return {
    source: "cowork",
    discover: () => discoverCoworkTranscripts(sessionsDir),
  };
}

export function createCoworkTranscriptParserAdapter(): TranscriptParserAdapter {
  return {
    parser: COWORK_TRANSCRIPT_PARSER,
    parseFile: (file) => parseCoworkTranscriptFile(file),
  };
}
