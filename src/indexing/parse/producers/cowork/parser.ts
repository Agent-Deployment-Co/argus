import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  PARSED_FRAGMENT_CONTRACT_VERSION,
  buildPromptFact,
  createFactId,
  isAgentInitiated,
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
  isCountableClaudeUserMessage,
  shouldSkipTaskCandidateText,
  textFromUserContent,
} from "../../../interpret/task-candidates.ts";
import { parseMcpTool } from "../../../../tool-categories.ts";
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
// v6: processes live (non-replay, timestamped) user prompts, dedupes turns by uuid, and sets
//     firstPrompt / userMessages / agentMessages / rawTurns (#131).
export const COWORK_TRANSCRIPT_PARSER_VERSION = "6";
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
    prompts: [],
    messages: [],
    invocations: [],
    toolResults: [],
    tasks: [],
    relationships: [],
  };
  const diagnostics: ParserDiagnostic[] = [];
  const records = jsonlRecords(raw, file, diagnostics);

  let sessionFact: SessionFact | undefined;
  const invocationNames = new Map<string, string>();
  const invocationFacts = new Map<string, InvocationFact>();
  // Turn-level facts come from live user events only (replays are verbatim re-appends), so a live
  // turn logged twice is collapsed by `uuid`; assistant turns dedupe by provider message id; tool
  // results dedupe by tool_use_id since a turn's live and replayed copies can both carry them (#131).
  const seenUserUuids = new Set<string>();
  const seenAssistantIds = new Set<string>();
  const seenToolResultIds = new Set<string>();
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

  // User records carry the real prompts. The Cowork desktop-app audit format emits them as live
  // events (isReplay:false) that DO carry a timestamp, plus verbatim replayed copies after a resume.
  const handleUserRecord = (record: PositionedRecord, recordIndex: number): void => {
    open = undefined;
    if (!sessionFact) return;
    const sourceSessionId = sessionFact.sourceSessionId;
    const content = Array.isArray(record.value.message?.content) ? record.value.message.content : [];
    const ts = timestampMs(record.value.timestamp ?? record.value._audit_timestamp);

    // Tool results may be carried by a turn's live copy, its replayed copy, or both — extract from
    // any user record but dedupe by tool_use_id so the same result isn't counted twice. Kept
    // independent of turn dedup below: a replay can carry a tool_result its live twin lacks.
    for (const [itemIndex, part] of content.entries()) {
      if (!part || part.type !== "tool_result" || typeof part.tool_use_id !== "string") continue;
      if (seenToolResultIds.has(part.tool_use_id)) continue;
      seenToolResultIds.add(part.tool_use_id);
      const position = { ...record.position, itemIndex };
      const key = invocationMapKey(sourceSessionId, part.tool_use_id);
      const invocation = invocationFacts.get(key);
      const observedToolName = invocation?.name ?? invocationNames.get(key);
      facts.toolResults.push({
        id: createFactId("tool_result", "cowork", sourceSessionId, position, part.tool_use_id),
        source: "cowork",
        sourceSessionId,
        invocationId: part.tool_use_id,
        ...(invocation ? { resolvedInvocationFactId: invocation.id } : {}),
        ...(observedToolName ? { observedToolName } : {}),
        approxTokens: estimateClaudeResultTokens(part.content),
        position,
      });
    }

    // Turn-level facts (counts, prompt marker + text, firstPrompt) come from LIVE events only, so a
    // replayed copy can never double-count a turn regardless of whether it carries a uuid (#131).
    // A truly bare placeholder (no isReplay, no timestamp/_audit_timestamp) isn't a real turn.
    if (record.value.isReplay === true || !Number.isFinite(ts)) return;
    // Belt-and-suspenders against a live event logged twice; real Cowork records carry a uuid.
    const uuid =
      typeof record.value.uuid === "string" && record.value.uuid ? record.value.uuid : undefined;
    if (uuid) {
      if (seenUserUuids.has(uuid)) return;
      seenUserUuids.add(uuid);
    }

    const taskText = coworkUserMessageText(record);
    const nativeSessionId =
      typeof record.value.session_id === "string" ? record.value.session_id : "";
    const generatedTitle = taskText ? argusGeneratedPromptTitle(taskText) : undefined;
    // Cowork's audit.jsonl is a flattened log that doesn't currently carry subagent (sidechain)
    // turns — but Cowork does run subagents, so guard defensively. A sidechain turn is agent-authored
    // *loop content*: it is neither a human task candidate (#118) nor an interaction opening. Because
    // Cowork emits a single (kind `main`) session, we can't route it to a distinct subagent session
    // id the way Claude/Gemini do, so reconcile's fold-filter wouldn't catch it — emitting an
    // agent-initiated prompt here would just split the human interaction in two. So we skip the
    // prompt marker entirely; its tokens/tools still count as the surrounding interaction's loop.
    // (Full Cowork subagent attribution is #128.)
    const agentInitiated = isAgentInitiated(sessionFact.kind) || record.value.isSidechain === true;
    // Count real human turns and title the session from the first one (#131). Same filter the
    // Claude/Codex producers use — tool-result echoes, compaction summaries, and Argus-generated
    // context aren't human turns. Sidechain (agent-authored) turns are loop content, not human.
    if (isCountableClaudeUserMessage(record.value) && !agentInitiated) {
      sessionFact.userMessages = (sessionFact.userMessages ?? 0) + 1;
      if (taskText && !sessionFact.firstPrompt) sessionFact.firstPrompt = taskText;
    }
    // Interaction-opening prompt marker (#117). Skip Argus's own prompts and agent-authored turns.
    if (taskText && !generatedTitle && !agentInitiated) {
      // The prompt carries task text (#122) when this opening is a task start (past the noise filter)
      // — the sole source of task candidates; there is no separate candidate fact.
      const isTaskStart = !shouldSkipTaskCandidateText(taskText, nextUserText(recordIndex, nativeSessionId));
      facts.prompts!.push(
        buildPromptFact({
          source: "cowork",
          sourceSessionId,
          position: record.position,
          kind: sessionFact.kind,
          timestampMs: ts,
          dedupKey: uuid,
          text: isTaskStart ? taskText : undefined,
        }),
      );
    }
    if (generatedTitle && !sessionFact.firstPrompt) {
      sessionFact.firstPrompt = generatedTitle;
    }
  };

  // The desktop app sometimes logs the opening prompt as the first record, *before* system/init
  // establishes the session. Buffer any such user records and replay them once the session exists,
  // so a session's very first prompt isn't lost (#131).
  const pendingPreInitUsers: { record: PositionedRecord; recordIndex: number }[] = [];

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
        // Replay any prompts that arrived before this init established the session (#131).
        for (const pending of pendingPreInitUsers) handleUserRecord(pending.record, pending.recordIndex);
        pendingPreInitUsers.length = 0;
      }
      open = undefined;
      continue;
    }

    if (!sessionFact) {
      // No session yet — keep early user records so the opening prompt isn't lost (#131).
      if (record.value.type === "user") pendingPreInitUsers.push({ record, recordIndex });
      continue;
    }
    const sourceSessionId = sessionFact.sourceSessionId;

    if (record.value.type === "user") {
      handleUserRecord(record, recordIndex);
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

    // Continuation of an already-created message: update stop_reason, accumulate any answer text, and
    // add invocations. One assistant message streams across records sharing a providerMessageId — e.g.
    // a `thinking` chunk (no text) carries the usage that builds the UsageFact, then the `text` chunk
    // carries the answer. Fold the non-empty text from every chunk onto the message so its in-memory
    // text (#122) is the full response, not just whatever the first usage-bearing chunk held.
    if (isContinuation && open?.message) {
      if (
        !open.message.stopReason &&
        typeof record.value.message?.stop_reason === "string"
      ) {
        open.message.stopReason = record.value.message.stop_reason;
      }
      const continuationText = textFromUserContent(record.value.message?.content);
      if (continuationText) {
        open.message.text = (
          open.message.text ? `${open.message.text}\n${continuationText}` : continuationText
        ).slice(0, TASK_TEXT_LIMIT);
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

    // Count agent turns (#131) at the point a new message is actually created — past the synthetic
    // and invalid-timestamp guards — so agentMessages stays in sync with the messages indexed.
    // Deduped by provider message id since one assistant message is split across streaming records
    // (and a resumed session re-appends earlier ones verbatim).
    if (providerMessageId) {
      if (!seenAssistantIds.has(providerMessageId)) {
        seenAssistantIds.add(providerMessageId);
        sessionFact.agentMessages = (sessionFact.agentMessages ?? 0) + 1;
      }
    } else {
      sessionFact.agentMessages = (sessionFact.agentMessages ?? 0) + 1;
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
      // Assistant text (#122), in-memory: becomes the interaction's responseText for pass-2 dialogue.
      ...(textFromUserContent(record.value.message?.content)
        ? { text: textFromUserContent(record.value.message?.content) }
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

  // Raw conversational turns. Cowork has no independent turn signal, so fall back to the human
  // turn count — the same fallback the Codex producer uses (`rawTurns ... || userMessages`) (#131).
  if (sessionFact?.userMessages) sessionFact.rawTurns = sessionFact.userMessages;

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
