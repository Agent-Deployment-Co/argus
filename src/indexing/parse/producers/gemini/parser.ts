import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  statSync,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  PARSED_FRAGMENT_CONTRACT_VERSION,
  createFactId,
  createFileIdentity,
  sameFileFingerprint,
  stableId,
  type AuxiliaryDependency,
  type AuxiliaryParseResult,
  type DiscoveredFile,
  type DiscoveryResult,
  type FileFingerprint,
  type FileIdentity,
  buildPromptFact,
  isAgentInitiated,
  type FileParseResult,
  type InvocationFact,
  type UsageFact,
  type NormalizedFacts,
  type PromptFact,
  type ParsedAuxiliaryFragment,
  type ParsedFileFragment,
  type ParserDescriptor,
  type ParserDiagnostic,
  type ProjectRootFact,
  type SessionFact,
  type SessionRelationshipFact,
  type SourcePosition,
  type ToolResultFact,
  type TranscriptDiscoveryAdapter,
  type TranscriptParserAdapter,
  type AuxiliaryParserAdapter,
} from "../../../../store/store-contract.ts";
import { GEMINI_DIR } from "../../../../paths.ts";
import {
  TASK_TEXT_LIMIT,
  argusGeneratedPromptTitle,
  shouldSkipTaskCandidateText,
  textFromUserContent,
} from "../../../interpret/task-candidates.ts";
import { parseMcpTool } from "../../../../tool-categories.ts";
import { dialogueTurn, type DialogueTurn } from "../../../interpret/dialogue.ts";
import { emptyUsage, totalTokens, type Usage } from "../../../../types.ts";

export const GEMINI_TRANSCRIPT_ROOT_ID = "gemini-chats";
export const GEMINI_AUXILIARY_ROOT_ID = "gemini-config";
export const GEMINI_ROOT_ID = GEMINI_TRANSCRIPT_ROOT_ID;
export const GEMINI_PROJECTS_ROOT_ID = GEMINI_AUXILIARY_ROOT_ID;
// v2: emits filtered user task candidates for explicit per-session task extraction.
// v3: excludes Argus task-extraction prompts from task candidates.
// v4: labels Argus task-extraction sessions with their target session.
// v5: excludes and labels Argus session-analysis prompts.
export const GEMINI_TRANSCRIPT_PARSER_VERSION = "5";
export const GEMINI_AUXILIARY_PARSER_VERSION = "1";

export const GEMINI_TRANSCRIPT_PARSER: ParserDescriptor = {
  name: "gemini-chat",
  source: "gemini",
  version: GEMINI_TRANSCRIPT_PARSER_VERSION,
};

export const GEMINI_AUXILIARY_PARSER: ParserDescriptor = {
  name: "gemini-project-metadata",
  source: "gemini",
  version: GEMINI_AUXILIARY_PARSER_VERSION,
};
export const GEMINI_PARSER = GEMINI_TRANSCRIPT_PARSER;

const MAX_SNAPSHOT_ATTEMPTS = 3;
const PROJECT_EFFECTS = ["session_cwd", "session_project"] as const;

interface PositionedGeminiMessage {
  value: Record<string, any>;
  position: SourcePosition;
}

export interface GeminiConversation {
  sessionId: string;
  projectHash: string;
  startTime?: string;
  lastUpdated?: string;
  directories?: string[];
  kind?: string;
  messages: PositionedGeminiMessage[];
  position: SourcePosition;
}

interface StableRead {
  raw: string;
  fingerprint: FileFingerprint;
  attempts: number;
  observations: FileFingerprint[];
}

interface StableReadFailure {
  status: "unstable" | "missing" | "unreadable" | "failed";
  observations: FileFingerprint[];
  diagnostics: ParserDiagnostic[];
}

export interface GeminiParseOptions {
  maxSnapshotAttempts?: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizedRelativePath(path: string): string {
  return path.split("\\").join("/").replace(/^\/+/, "");
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

export function fingerprintGeminiFile(path: string): FileFingerprint {
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
    source: "gemini",
    rootId,
    rootPath,
    files: [],
    diagnostics: [diagnostic(code, "discovery", message, "error")],
  };
}

function sortedEntries(path: string): Dirent[] {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name));
}

function discoveredFile(
  path: string,
  rootId: string,
  role: "transcript" | "project_registry" | "project_marker",
  relativePath: string,
): DiscoveredFile {
  return {
    file: createFileIdentity({
      source: "gemini",
      rootId,
      role,
      relativePath: normalizedRelativePath(relativePath),
      path,
    }),
    fingerprint: fingerprintGeminiFile(path),
  };
}

function rootStatus(path: string): "directory" | "missing" | "unreadable" {
  try {
    return statSync(path).isDirectory() ? "directory" : "unreadable";
  } catch (error) {
    return errno(error) === "ENOENT" ? "missing" : "unreadable";
  }
}

/**
 * Recursively discover Gemini JSON and JSONL chat files. Traversal starts at each
 * project-local chats directory so unrelated Gemini JSON files are not treated as transcripts.
 */
export function discoverGeminiTranscripts(geminiDir = GEMINI_DIR): DiscoveryResult {
  const rootPath = join(resolve(geminiDir), "tmp");
  const status = rootStatus(rootPath);
  if (status === "missing") {
    return discoveryFailure(
      rootPath,
      GEMINI_TRANSCRIPT_ROOT_ID,
      "missing",
      "missing_root",
      `Gemini transcript root does not exist: ${rootPath}`,
    );
  }
  if (status === "unreadable") {
    return discoveryFailure(
      rootPath,
      GEMINI_TRANSCRIPT_ROOT_ID,
      "unreadable",
      "unreadable_root",
      `Gemini transcript root is not readable: ${rootPath}`,
    );
  }

  const files: DiscoveredFile[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  let partial = false;
  let projects: Dirent[];
  try {
    projects = sortedEntries(rootPath);
  } catch (error) {
    return discoveryFailure(
      rootPath,
      GEMINI_TRANSCRIPT_ROOT_ID,
      "unreadable",
      "unreadable_root",
      `Unable to read Gemini transcript root ${rootPath}: ${String(error)}`,
    );
  }

  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = sortedEntries(dir);
    } catch (error) {
      partial = true;
      diagnostics.push(
        diagnostic(
          "unreadable_directory",
          "discovery",
          `Unable to read Gemini transcript directory ${dir}: ${String(error)}`,
          "error",
        ),
      );
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || (!entry.name.endsWith(".json") && !entry.name.endsWith(".jsonl"))) {
        continue;
      }
      try {
        const relativePath = relative(rootPath, path);
        files.push(
          discoveredFile(
            path,
            GEMINI_TRANSCRIPT_ROOT_ID,
            "transcript",
            relativePath,
          ),
        );
      } catch (error) {
        partial = true;
        diagnostics.push(
          diagnostic(
            "unreadable_file",
            "discovery",
            `Unable to fingerprint Gemini transcript ${path}: ${String(error)}`,
            "error",
          ),
        );
      }
    }
  };

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const chatsDir = join(rootPath, project.name, "chats");
    const chatsStatus = rootStatus(chatsDir);
    if (chatsStatus === "missing") continue;
    if (chatsStatus === "unreadable") {
      partial = true;
      diagnostics.push(
        diagnostic(
          "unreadable_directory",
          "discovery",
          `Gemini chats directory is not readable: ${chatsDir}`,
          "error",
        ),
      );
      continue;
    }
    walk(chatsDir);
  }

  files.sort((a, b) => compareText(a.file.relativePath, b.file.relativePath));
  return {
    status: partial ? "partial" : "complete",
    source: "gemini",
    rootId: GEMINI_TRANSCRIPT_ROOT_ID,
    rootPath,
    files,
    diagnostics,
  };
}

/** Discover projects.json and every project-local .project_root marker independently. */
export function discoverGeminiAuxiliaryFiles(geminiDir = GEMINI_DIR): DiscoveryResult {
  const rootPath = resolve(geminiDir);
  const status = rootStatus(rootPath);
  if (status === "missing") {
    return discoveryFailure(
      rootPath,
      GEMINI_AUXILIARY_ROOT_ID,
      "missing",
      "missing_root",
      `Gemini configuration root does not exist: ${rootPath}`,
    );
  }
  if (status === "unreadable") {
    return discoveryFailure(
      rootPath,
      GEMINI_AUXILIARY_ROOT_ID,
      "unreadable",
      "unreadable_root",
      `Gemini configuration root is not readable: ${rootPath}`,
    );
  }

  const files: DiscoveredFile[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  let partial = false;
  const registryPath = join(rootPath, "projects.json");
  try {
    files.push(
      discoveredFile(
        registryPath,
        GEMINI_AUXILIARY_ROOT_ID,
        "project_registry",
        "projects.json",
      ),
    );
  } catch (error) {
    if (errno(error) !== "ENOENT") {
      partial = true;
      diagnostics.push(
        diagnostic(
          "unreadable_file",
          "discovery",
          `Unable to fingerprint Gemini project registry ${registryPath}: ${String(error)}`,
          "error",
        ),
      );
    }
  }

  const tmpDir = join(rootPath, "tmp");
  const tmpStatus = rootStatus(tmpDir);
  if (tmpStatus === "unreadable") {
    partial = true;
    diagnostics.push(
      diagnostic(
        "unreadable_directory",
        "discovery",
        `Gemini project directory is not readable: ${tmpDir}`,
        "error",
      ),
    );
  } else if (tmpStatus === "directory") {
    let projects: Dirent[] = [];
    try {
      projects = sortedEntries(tmpDir);
    } catch (error) {
      partial = true;
      diagnostics.push(
        diagnostic(
          "unreadable_directory",
          "discovery",
          `Unable to read Gemini project directory ${tmpDir}: ${String(error)}`,
          "error",
        ),
      );
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const markerPath = join(tmpDir, project.name, ".project_root");
      try {
        files.push(
          discoveredFile(
            markerPath,
            GEMINI_AUXILIARY_ROOT_ID,
            "project_marker",
            join("tmp", project.name, ".project_root"),
          ),
        );
      } catch (error) {
        if (errno(error) !== "ENOENT") {
          partial = true;
          diagnostics.push(
            diagnostic(
              "unreadable_file",
              "discovery",
              `Unable to fingerprint Gemini project marker ${markerPath}: ${String(error)}`,
              "error",
            ),
          );
        }
      }
    }
  }

  files.sort((a, b) => compareText(a.file.relativePath, b.file.relativePath));
  return {
    status: partial ? "partial" : "complete",
    source: "gemini",
    rootId: GEMINI_AUXILIARY_ROOT_ID,
    rootPath,
    files,
    diagnostics,
  };
}

export function discoverGeminiInputs(geminiDir = GEMINI_DIR): {
  transcripts: DiscoveryResult;
  auxiliary: DiscoveryResult;
} {
  return {
    transcripts: discoverGeminiTranscripts(geminiDir),
    auxiliary: discoverGeminiAuxiliaryFiles(geminiDir),
  };
}

function readFailure(
  file: FileIdentity,
  error: unknown,
  observations: FileFingerprint[],
): StableReadFailure {
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

function readStableFile(
  file: FileIdentity,
  maxAttempts = MAX_SNAPSHOT_ATTEMPTS,
): StableRead | StableReadFailure {
  const observations: FileFingerprint[] = [];
  const attempts = Math.max(1, Math.trunc(maxAttempts));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let before: FileFingerprint;
    try {
      before = fingerprintGeminiFile(file.path);
      observations.push(before);
    } catch (error) {
      return readFailure(file, error, observations);
    }

    let raw: string;
    try {
      raw = readFileSync(file.path, "utf8");
    } catch (error) {
      return readFailure(file, error, observations);
    }

    let after: FileFingerprint;
    try {
      after = fingerprintGeminiFile(file.path);
      observations.push(after);
    } catch (error) {
      return readFailure(file, error, observations);
    }
    if (sameFileFingerprint(before, after)) {
      return { raw, fingerprint: after, attempts: attempt, observations };
    }
  }

  return {
    status: "unstable",
    observations,
    diagnostics: [
      diagnostic(
        "unstable_file",
        "snapshot",
        `Gemini input changed during ${attempts} consecutive read attempts: ${file.path}`,
        "error",
      ),
    ],
  };
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return NaN;
  return Date.parse(value);
}

export function normalizeGeminiUsage(raw: any): Usage {
  const usage = emptyUsage();
  if (!raw) return usage;
  const input = Number(raw.input ?? raw.promptTokenCount) || 0;
  const cached = Number(raw.cached ?? raw.cachedContentTokenCount) || 0;
  usage.input = Math.max(input - cached, 0);
  usage.cacheRead = cached;
  usage.output =
    (Number(raw.output ?? raw.candidatesTokenCount) || 0) +
    (Number(raw.thoughts ?? raw.thoughtsTokenCount) || 0) +
    (Number(raw.tool ?? raw.toolUsePromptTokenCount) || 0);
  const total = raw.total ?? raw.totalTokenCount;
  if (totalTokens(usage) === 0 && total) usage.input = Number(total) || 0;
  return usage;
}

/**
 * Reconstruct the human↔assistant dialogue from a Gemini transcript (#91). Reuses the producer's own
 * append-only replay (legacy .json object or JSONL with rewind/$set), then maps user/gemini records
 * to turns — so the file-format knowledge stays here, not duplicated in the dialogue consumer.
 */
export function reconstructGeminiDialogue(path: string): DialogueTurn[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const file = createFileIdentity({
    source: "gemini",
    rootId: "",
    role: "transcript",
    relativePath: path,
    path,
  });
  const { conversation } = replayGeminiConversation(raw, file);
  if (!conversation) return [];
  const turns: DialogueTurn[] = [];
  for (const positioned of conversation.messages) {
    const message = positioned.value;
    const ts = parseTimestamp(message.timestamp);
    if (message.type === "user") {
      const turn = dialogueTurn("user", textFromGeminiContent(message.content, TASK_TEXT_LIMIT), ts);
      if (turn) turns.push(turn);
    } else if (message.type === "gemini") {
      const turn = dialogueTurn("assistant", textFromGeminiContent(message.content, TASK_TEXT_LIMIT), ts);
      if (turn) turns.push(turn);
    }
  }
  return turns;
}

export function textFromGeminiContent(content: unknown, limit = 500): string {
  return textFromUserContent(content, limit);
}

export function estimateGeminiResultTokens(content: unknown): number {
  let chars = 0;
  if (typeof content === "string") {
    chars = content.length;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") chars += part.length;
      else if (part && typeof part === "object" && typeof (part as any).text === "string") {
        chars += (part as any).text.length;
      } else {
        chars += JSON.stringify(part).length;
      }
    }
  } else if (content != null) {
    chars = JSON.stringify(content).length;
  }
  return Math.round(chars / 4);
}

function boundedGeminiArguments(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized === "{}" ? undefined : serialized.slice(0, 280);
  } catch {
    return undefined;
  }
}

function messageWidth(message: unknown): number {
  if (!message || typeof message !== "object" || !Array.isArray((message as any).toolCalls)) return 1;
  return 1 + (message as any).toolCalls.length * 2;
}

function positionedMessages(
  file: FileIdentity,
  values: unknown[],
  recordIndex: number,
  byteOffset?: number,
): PositionedGeminiMessage[] {
  const messages: PositionedGeminiMessage[] = [];
  let itemIndex = 0;
  for (const value of values) {
    if (value && typeof value === "object" && typeof (value as any).id === "string") {
      messages.push({
        value: value as Record<string, any>,
        position: sourcePosition(file, recordIndex, itemIndex, byteOffset),
      });
    }
    itemIndex += messageWidth(value);
  }
  return messages;
}

function legacyConversation(
  raw: string,
  file: FileIdentity,
  diagnostics: ParserDiagnostic[],
): GeminiConversation | null {
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.sessionId !== "string" ||
    typeof value.projectHash !== "string" ||
    !Array.isArray(value.messages)
  ) {
    return null;
  }
  const position = sourcePosition(file, 0, 0, 0);
  const messages = positionedMessages(file, value.messages, 0, 0);
  for (const message of value.messages) {
    if (!message || typeof message !== "object" || typeof message.id !== "string") {
      diagnostics.push(
        diagnostic(
          "invalid_message",
          "parse",
          "Skipped Gemini message without a string id",
          "warning",
          position,
        ),
      );
    }
  }
  return {
    sessionId: value.sessionId,
    projectHash: value.projectHash,
    startTime: typeof value.startTime === "string" ? value.startTime : undefined,
    lastUpdated: typeof value.lastUpdated === "string" ? value.lastUpdated : undefined,
    directories: Array.isArray(value.directories) ? value.directories : undefined,
    kind: typeof value.kind === "string" ? value.kind : undefined,
    messages,
    position,
  };
}

/** Replay one Gemini append-only JSONL file into its current logical conversation. */
export function replayGeminiConversation(
  raw: string,
  file: FileIdentity,
): { conversation: GeminiConversation | null; diagnostics: ParserDiagnostic[] } {
  const diagnostics: ParserDiagnostic[] = [];
  if (file.path.endsWith(".json")) {
    return { conversation: legacyConversation(raw, file, diagnostics), diagnostics };
  }

  let metadata: Record<string, any> = {};
  let metadataPosition = sourcePosition(file, 0);
  const messages = new Map<string, PositionedGeminiMessage>();
  const lines = raw.split("\n");
  let byteOffset = 0;
  for (let recordIndex = 0; recordIndex < lines.length; recordIndex++) {
    const line = lines[recordIndex]!;
    const lineOffset = byteOffset;
    byteOffset += Buffer.byteLength(line, "utf8") + (recordIndex < lines.length - 1 ? 1 : 0);
    if (!line.trim()) continue;

    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      diagnostics.push(
        diagnostic(
          "malformed_record",
          "parse",
          "Skipped malformed Gemini JSONL record",
          "warning",
          sourcePosition(file, recordIndex, 0, lineOffset),
        ),
      );
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      diagnostics.push(
        diagnostic(
          "invalid_record",
          "parse",
          "Skipped non-object Gemini JSONL record",
          "warning",
          sourcePosition(file, recordIndex, 0, lineOffset),
        ),
      );
      continue;
    }

    if (typeof record.$rewindTo === "string") {
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

    if (typeof record.id === "string") {
      messages.set(record.id, {
        value: record,
        position: sourcePosition(file, recordIndex, 0, lineOffset),
      });
      continue;
    }

    if (record.$set && typeof record.$set === "object" && !Array.isArray(record.$set)) {
      if (Array.isArray(record.$set.messages)) {
        messages.clear();
        for (const message of positionedMessages(
          file,
          record.$set.messages,
          recordIndex,
          lineOffset,
        )) {
          messages.set(message.value.id, message);
        }
      }
      metadata = { ...metadata, ...record.$set };
      if (
        typeof record.$set.sessionId === "string" ||
        typeof record.$set.projectHash === "string"
      ) {
        metadataPosition = sourcePosition(file, recordIndex, 0, lineOffset);
      }
      continue;
    }

    if (typeof record.sessionId === "string" && typeof record.projectHash === "string") {
      metadata = { ...metadata, ...record };
      metadataPosition = sourcePosition(file, recordIndex, 0, lineOffset);
      if (Array.isArray(record.messages)) {
        for (const message of positionedMessages(file, record.messages, recordIndex, lineOffset)) {
          messages.set(message.value.id, message);
        }
      }
    }
  }

  if (typeof metadata.sessionId !== "string" || typeof metadata.projectHash !== "string") {
    return { conversation: legacyConversation(raw, file, diagnostics), diagnostics };
  }
  return {
    conversation: {
      sessionId: metadata.sessionId,
      projectHash: metadata.projectHash,
      startTime: typeof metadata.startTime === "string" ? metadata.startTime : undefined,
      lastUpdated: typeof metadata.lastUpdated === "string" ? metadata.lastUpdated : undefined,
      directories: Array.isArray(metadata.directories) ? metadata.directories : undefined,
      kind: typeof metadata.kind === "string" ? metadata.kind : undefined,
      messages: [...messages.values()],
      position: metadataPosition,
    },
    diagnostics,
  };
}

function transcriptRootPath(file: FileIdentity): string {
  let root = file.path;
  for (const _segment of normalizedRelativePath(file.relativePath).split("/").filter(Boolean)) {
    root = dirname(root);
  }
  return root;
}

function transcriptProjectSlug(file: FileIdentity): string {
  return normalizedRelativePath(file.relativePath).split("/").filter(Boolean)[0] || "";
}

function inferredParentSessionId(file: FileIdentity): string | undefined {
  const segments = normalizedRelativePath(file.relativePath).split("/").filter(Boolean);
  const chatsIndex = segments.indexOf("chats");
  if (chatsIndex < 0 || chatsIndex + 2 >= segments.length) return undefined;
  const parent = segments[chatsIndex + 1];
  return parent ? `gemini:${parent}` : undefined;
}

export function geminiProjectRegistryFileIdentity(
  geminiDir = GEMINI_DIR,
): FileIdentity {
  const rootPath = resolve(geminiDir);
  return createFileIdentity({
    source: "gemini",
    rootId: GEMINI_AUXILIARY_ROOT_ID,
    role: "project_registry",
    relativePath: "projects.json",
    path: join(rootPath, "projects.json"),
  });
}

export function geminiProjectMarkerFileIdentity(
  geminiDir: string,
  projectSlug: string,
): FileIdentity {
  const rootPath = resolve(geminiDir);
  return createFileIdentity({
    source: "gemini",
    rootId: GEMINI_AUXILIARY_ROOT_ID,
    role: "project_marker",
    relativePath: normalizedRelativePath(join("tmp", projectSlug, ".project_root")),
    path: join(rootPath, "tmp", projectSlug, ".project_root"),
  });
}

function projectDependencies(
  file: FileIdentity,
  projectHash: string,
): AuxiliaryDependency[] {
  const tmpDir = transcriptRootPath(file);
  const geminiDir = dirname(tmpDir);
  const projectSlug = transcriptProjectSlug(file);
  const registry = geminiProjectRegistryFileIdentity(geminiDir);
  const marker = geminiProjectMarkerFileIdentity(geminiDir, projectSlug);
  const selectors = [projectSlug, projectHash].filter(
    (selector, index, all) => selector && all.indexOf(selector) === index,
  );
  return [
    ...selectors.map((selector) => ({
      inputId: registry.id,
      selector,
      affects: [...PROJECT_EFFECTS],
    })),
    ...(projectSlug
      ? [
          {
            inputId: marker.id,
            selector: projectSlug,
            affects: [...PROJECT_EFFECTS],
          },
        ]
      : []),
  ];
}

function firstObservedDirectory(conversation: GeminiConversation): string | undefined {
  return conversation.directories?.find(
    (value): value is string => typeof value === "string" && isAbsolute(value),
  );
}

function sessionKind(
  conversation: GeminiConversation,
  parentSessionId: string | undefined,
): SessionFact["kind"] {
  if (conversation.kind === "main" || conversation.kind === "subagent") return conversation.kind;
  return parentSessionId ? "subagent" : "main";
}

function invocationFacts(
  message: PositionedGeminiMessage,
  sourceSessionId: string,
  messageId: string,
  timestampMs: number,
): { invocations: InvocationFact[]; results: ToolResultFact[] } {
  const invocations: InvocationFact[] = [];
  const results: ToolResultFact[] = [];
  const calls = Array.isArray(message.value.toolCalls) ? message.value.toolCalls : [];
  calls.forEach((call: any, callIndex: number) => {
    if (!call || typeof call.name !== "string" || !call.name) return;
    const invocationId =
      typeof call.id === "string"
        ? call.id
        : typeof call.callId === "string"
          ? call.callId
          : undefined;
    const invocationPosition = {
      ...message.position,
      itemIndex: message.position.itemIndex + 1 + callIndex * 2,
    };
    const invocationFactId = createFactId(
      "invocation",
      "gemini",
      sourceSessionId,
      invocationPosition,
      invocationId ?? `${message.value.id}:${callIndex}`,
    );
    const args = call.args && typeof call.args === "object" && !Array.isArray(call.args)
      ? call.args
      : {};
    const serializedArgs = boundedGeminiArguments(args);
    const filePath = args.file_path ?? args.filePath ?? args.path;
    const skill = call.name === "activate_skill" ? args.skill ?? args.name : undefined;
    const mcp = parseMcpTool(call.name);
    const callTimestampMs = parseTimestamp(call.timestamp);
    invocations.push({
      id: invocationFactId,
      source: "gemini",
      sourceSessionId,
      messageId,
      ...(invocationId ? { invocationId } : {}),
      timestampMs: Number.isNaN(callTimestampMs) ? timestampMs : callTimestampMs,
      name: call.name,
      ...(typeof skill === "string" && skill ? { skill } : {}),
      ...(serializedArgs ? { args: serializedArgs } : {}),
      ...(mcp ? { mcpServer: mcp.server, mcpTool: mcp.tool } : {}),
      ...(typeof filePath === "string" && filePath ? { filePath } : {}),
      position: invocationPosition,
    });

    if (!Object.hasOwn(call, "result")) return;
    const resultPosition = {
      ...message.position,
      itemIndex: message.position.itemIndex + 2 + callIndex * 2,
    };
    results.push({
      id: createFactId(
        "tool_result",
        "gemini",
        sourceSessionId,
        resultPosition,
        invocationId ?? `${message.value.id}:${callIndex}`,
      ),
      source: "gemini",
      sourceSessionId,
      ...(invocationId ? { invocationId } : {}),
      resolvedInvocationFactId: invocationFactId,
      observedToolName: call.name,
      approxTokens: estimateGeminiResultTokens(call.result),
      position: resultPosition,
    });
  });
  return { invocations, results };
}

function factsFromConversation(
  conversation: GeminiConversation,
  file: FileIdentity,
): NormalizedFacts {
  const sourceSessionId = `gemini:${conversation.sessionId}`;
  const parentSessionId = inferredParentSessionId(file);
  const cwd = firstObservedDirectory(conversation);
  const firstPrompt = conversation.messages
    .filter((message) => message.value.type === "user")
    .map((message) => textFromGeminiContent(message.value.content))
    .map((text) => argusGeneratedPromptTitle(text) ?? text)
    .find(Boolean);
  const prompts: PromptFact[] = [];
  // gemini doesn't fold subagents, so a subagent session (parent inferred from path) keeps its own
  // agent-initiated openings — derived centrally from the session kind by buildPromptFact (#117).
  const sessionFactKind = sessionKind(conversation, parentSessionId);
  for (let messageIndex = 0; messageIndex < conversation.messages.length; messageIndex++) {
    const positioned = conversation.messages[messageIndex]!;
    const message = positioned.value;
    if (message.type !== "user") continue;
    const taskText = textFromGeminiContent(message.content, TASK_TEXT_LIMIT);
    if (!taskText) continue;
    // Skip Argus's own prompts (not human turns) so they don't open phantom interactions.
    if (!argusGeneratedPromptTitle(taskText)) {
      // The prompt carries task text (#122) when this opening is a task start — human-initiated (a
      // subagent session's prompts are agent-authored, not human intent — #118) and past the noise
      // filter. That text is the sole source of task candidates; there is no separate candidate fact.
      const next = conversation.messages[messageIndex + 1];
      const nextText =
        next?.value.type === "user"
          ? textFromGeminiContent(next.value.content, TASK_TEXT_LIMIT)
          : undefined;
      const isTaskStart =
        !isAgentInitiated(sessionFactKind) && !shouldSkipTaskCandidateText(taskText, nextText);
      prompts.push(
        buildPromptFact({
          source: "gemini",
          sourceSessionId,
          position: positioned.position,
          kind: sessionFactKind,
          timestampMs: parseTimestamp(message.timestamp),
          dedupKey: typeof message.id === "string" ? message.id : undefined,
          text: isTaskStart ? taskText : undefined,
        }),
      );
    }
  }
  const session: SessionFact = {
    id: createFactId(
      "session",
      "gemini",
      sourceSessionId,
      conversation.position,
      conversation.sessionId,
    ),
    source: "gemini",
    sourceSessionId,
    kind: sessionFactKind,
    transcriptPath: file.path,
    ...(cwd ? { cwd } : {}),
    rawProjectId: conversation.projectHash,
    ...(firstPrompt ? { firstPrompt } : {}),
    position: conversation.position,
  };

  const messages: UsageFact[] = [];
  const invocations: InvocationFact[] = [];
  const toolResults: ToolResultFact[] = [];
  for (const positioned of conversation.messages) {
    const message = positioned.value;
    if (message.type !== "gemini" || !message.tokens) continue;
    const usage = normalizeGeminiUsage(message.tokens);
    if (totalTokens(usage) === 0) continue;
    const timestampMs = parseTimestamp(message.timestamp);
    if (Number.isNaN(timestampMs)) continue;
    const providerMessageId = typeof message.id === "string" ? message.id : undefined;
    const messageId = createFactId(
      "message",
      "gemini",
      sourceSessionId,
      positioned.position,
      providerMessageId ?? "",
    );
    messages.push({
      id: messageId,
      source: "gemini",
      sourceSessionId,
      ...(providerMessageId ? { providerMessageId } : {}),
      timestampMs,
      model: typeof message.model === "string" && message.model ? message.model : "(unknown)",
      usage,
      ...(cwd ? { cwd } : {}),
      attributionSkill: null,
      position: positioned.position,
    });
    const related = invocationFacts(positioned, sourceSessionId, messageId, timestampMs);
    invocations.push(...related.invocations);
    toolResults.push(...related.results);
  }

  const relationships: SessionRelationshipFact[] = [];
  if (parentSessionId && parentSessionId !== sourceSessionId) {
    relationships.push({
      id: createFactId(
        "relationship",
        "gemini",
        sourceSessionId,
        conversation.position,
        parentSessionId,
      ),
      source: "gemini",
      childSourceSessionId: sourceSessionId,
      parentSourceSessionId: parentSessionId,
      kind: "subagent",
      position: conversation.position,
    });
  }

  return {
    sessions: [session],
    prompts,
    messages,
    invocations,
    toolResults,
    tasks: [],
    relationships,
  };
}

function parseFailure(
  file: DiscoveredFile,
  observations: FileFingerprint[],
  diagnostics: ParserDiagnostic[],
): FileParseResult {
  return {
    status: "failed",
    file: file.file,
    observations,
    diagnostics,
  };
}

export function parseGeminiTranscriptFile(
  file: DiscoveredFile,
  options: GeminiParseOptions = {},
): FileParseResult {
  if (file.file.source !== "gemini" || file.file.role !== "transcript") {
    return parseFailure(file, [file.fingerprint], [
      diagnostic(
        "unsupported_file",
        "parse",
        `Gemini transcript parser cannot parse ${file.file.role} input`,
        "error",
      ),
    ]);
  }
  const stable = readStableFile(file.file, options.maxSnapshotAttempts);
  if ("status" in stable) {
    return {
      status: stable.status,
      file: file.file,
      observations: stable.observations,
      diagnostics: stable.diagnostics,
    };
  }

  const replayed = replayGeminiConversation(stable.raw, file.file);
  if (!replayed.conversation) {
    return parseFailure(file, stable.observations, [
      ...replayed.diagnostics,
      diagnostic(
        "invalid_conversation",
        "parse",
        "Gemini transcript did not contain a valid sessionId, projectHash, and messages collection",
        "error",
      ),
    ]);
  }

  const conversation = replayed.conversation;
  const updatedAtMs = parseTimestamp(conversation.lastUpdated);
  const representation = file.file.path.endsWith(".jsonl") ? "jsonl" : "json";
  const fragment: ParsedFileFragment = {
    kind: "transcript",
    id: stableId("fragment", [file.file.id]),
    contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
    parser: GEMINI_TRANSCRIPT_PARSER,
    snapshot: {
      file: file.file,
      fingerprint: stable.fingerprint,
      attempts: stable.attempts,
    },
    alternateRepresentation: {
      logicalId: `gemini:${conversation.sessionId}`,
      representation,
      preference: representation === "jsonl" ? 1 : 0,
      ...(Number.isNaN(updatedAtMs) ? {} : { updatedAtMs }),
    },
    facts: factsFromConversation(conversation, file.file),
    dependencies: projectDependencies(file.file, conversation.projectHash),
    diagnostics: replayed.diagnostics,
  };
  return { status: "current", fragment };
}

export function parseGeminiTranscriptPath(path: string): FileParseResult {
  const absolutePath = resolve(path);
  const rootPath = join(resolve(GEMINI_DIR), "tmp");
  const file = createFileIdentity({
    source: "gemini",
    rootId: GEMINI_TRANSCRIPT_ROOT_ID,
    role: "transcript",
    relativePath: normalizedRelativePath(relative(rootPath, absolutePath)),
    path: absolutePath,
  });
  let fingerprint: FileFingerprint;
  try {
    fingerprint = fingerprintGeminiFile(absolutePath);
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
          missing
            ? `Gemini transcript disappeared before parsing: ${absolutePath}`
            : `Unable to fingerprint Gemini transcript: ${absolutePath}`,
          missing ? "warning" : "error",
        ),
      ],
    };
  }
  return parseGeminiTranscriptFile({ file, fingerprint });
}

function projectRootFact(
  file: FileIdentity,
  selector: string,
  cwd: string,
  itemIndex: number,
): ProjectRootFact {
  return {
    id: stableId("fact:project_root", [file.id, selector, cwd]),
    kind: "project_root",
    source: "gemini",
    selector,
    cwd,
    position: sourcePosition(file, 0, itemIndex, 0),
  };
}

function parseProjectRegistry(
  raw: string,
  file: FileIdentity,
): { facts: ProjectRootFact[]; diagnostics: ParserDiagnostic[] } | null {
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || !value.projects || typeof value.projects !== "object") {
    return null;
  }
  const facts: ProjectRootFact[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  Object.entries(value.projects).forEach(([cwd, slug], index) => {
    if (typeof slug !== "string" || !slug) {
      diagnostics.push(
        diagnostic(
          "invalid_project_entry",
          "parse",
          `Skipped Gemini project registry entry for ${cwd}`,
          "warning",
          sourcePosition(file, 0, index * 2, 0),
        ),
      );
      return;
    }
    facts.push(projectRootFact(file, slug, cwd, index * 2));
    facts.push(
      projectRootFact(
        file,
        createHash("sha256").update(cwd).digest("hex"),
        cwd,
        index * 2 + 1,
      ),
    );
  });
  return { facts, diagnostics };
}

function parseProjectMarker(
  raw: string,
  file: FileIdentity,
): { facts: ProjectRootFact[]; diagnostics: ParserDiagnostic[] } {
  const cwd = raw.trim();
  const selector = basename(dirname(file.path));
  if (!cwd || !selector) {
    return {
      facts: [],
      diagnostics: [
        diagnostic(
          "empty_project_marker",
          "parse",
          `Gemini project marker is empty: ${file.path}`,
          "warning",
          sourcePosition(file, 0, 0, 0),
        ),
      ],
    };
  }
  return { facts: [projectRootFact(file, selector, cwd, 0)], diagnostics: [] };
}

export function parseGeminiAuxiliaryFile(
  file: DiscoveredFile,
  options: GeminiParseOptions = {},
): AuxiliaryParseResult {
  if (
    file.file.source !== "gemini" ||
    (file.file.role !== "project_registry" && file.file.role !== "project_marker")
  ) {
    return {
      status: "failed",
      file: file.file,
      observations: [file.fingerprint],
      diagnostics: [
        diagnostic(
          "unsupported_file",
          "parse",
          `Gemini auxiliary parser cannot parse ${file.file.role} input`,
          "error",
        ),
      ],
    };
  }
  const stable = readStableFile(file.file, options.maxSnapshotAttempts);
  if ("status" in stable) {
    return {
      status: stable.status,
      file: file.file,
      observations: stable.observations,
      diagnostics: stable.diagnostics,
    };
  }

  const parsed =
    file.file.role === "project_registry"
      ? parseProjectRegistry(stable.raw, file.file)
      : parseProjectMarker(stable.raw, file.file);
  if (!parsed) {
    return {
      status: "failed",
      file: file.file,
      observations: stable.observations,
      diagnostics: [
        diagnostic(
          "invalid_project_registry",
          "parse",
          `Gemini project registry is not valid JSON with a projects object: ${file.file.path}`,
          "error",
          sourcePosition(file.file, 0, 0, 0),
        ),
      ],
    };
  }

  const fragment: ParsedAuxiliaryFragment = {
    kind: "auxiliary",
    id: stableId("auxiliary-fragment", [file.file.id]),
    contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
    parser: GEMINI_AUXILIARY_PARSER,
    snapshot: {
      file: file.file,
      fingerprint: stable.fingerprint,
      attempts: stable.attempts,
    },
    facts: parsed.facts,
    diagnostics: parsed.diagnostics,
  };
  return { status: "current", fragment };
}

export function createGeminiDiscoveryAdapter(
  geminiDir = GEMINI_DIR,
): TranscriptDiscoveryAdapter {
  return {
    source: "gemini",
    discover: () => discoverGeminiTranscripts(geminiDir),
  };
}

export function createGeminiTranscriptParserAdapter(
  options: GeminiParseOptions = {},
): TranscriptParserAdapter {
  return {
    parser: GEMINI_TRANSCRIPT_PARSER,
    parseFile: (file) => parseGeminiTranscriptFile(file, options),
  };
}

export function createGeminiAuxiliaryParserAdapter(
  options: GeminiParseOptions = {},
): AuxiliaryParserAdapter {
  return {
    parser: GEMINI_AUXILIARY_PARSER,
    parseFile: (file) => parseGeminiAuxiliaryFile(file, options),
  };
}

export const geminiTranscriptParserAdapter = createGeminiTranscriptParserAdapter();
export const geminiAuxiliaryParserAdapter = createGeminiAuxiliaryParserAdapter();

export const discoverGeminiChats = discoverGeminiTranscripts;
export const discoverGeminiFiles = discoverGeminiTranscripts;
export const discoverGeminiAuxiliary = discoverGeminiAuxiliaryFiles;
export const createGeminiTranscriptDiscoveryAdapter = createGeminiDiscoveryAdapter;
export const createGeminiParserAdapter = createGeminiTranscriptParserAdapter;
export const parseGeminiTranscript = parseGeminiTranscriptFile;
export const parseGeminiFile = parseGeminiTranscriptFile;
export const parseGeminiAuxiliary = parseGeminiAuxiliaryFile;
