import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import sqlite3 from "sqlite3";
import {
  PARSED_FRAGMENT_CONTRACT_VERSION,
  createFactId,
  createFileIdentity,
  sameFileFingerprint,
  stableCacheId,
  type CompatibleExternalImportProbe,
  type ExternalFragmentImporter,
  type ExternalImportProbe,
  type FileFingerprint,
  type ImportedFragment,
  type InvocationFact,
  type MessageFact,
  type NormalizedFacts,
  type ParserDiagnostic,
  type SessionFact,
  type SessionRelationshipFact,
  type SourcePosition,
  type StableFileSnapshot,
  type ToolResultFact,
} from "./cache-contract.ts";
import { parseMcpTool } from "./tool-categories.ts";
import { emptyUsage, totalTokens, type AgentSource, type Usage } from "./types.ts";

const SUPPORTED_AGENTS = new Set<AgentSource>(["claude", "codex", "gemini"]);
const REQUIRED_SCHEMA: Record<string, string[]> = {
  sessions: ["id", "agent"],
  messages: ["id", "session_id", "ordinal", "role"],
};

type SqliteRow = Record<string, unknown>;
type SchemaColumns = Map<string, Set<string>>;

export interface AgentsViewImporterOptions {
  databasePath?: string;
  busyTimeoutMs?: number;
}

export function agentsViewDatabasePath(override?: string): string {
  if (override) return override;
  const dataDir =
    process.env.AGENTSVIEW_DATA_DIR ||
    process.env.AGENT_VIEWER_DATA_DIR ||
    join(homedir(), ".agentsview");
  return join(dataDir, "sessions.db");
}

function sqliteAll<T extends SqliteRow>(
  db: sqlite3.Database,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all<T>(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function sqliteGet<T extends SqliteRow>(
  db: sqlite3.Database,
  sql: string,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get<T>(sql, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function sqliteExec(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function closeSqlite(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function openReadOnly(path: string, busyTimeoutMs: number): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(
      path,
      sqlite3.OPEN_READONLY | sqlite3.OPEN_FULLMUTEX,
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        db.configure("busyTimeout", busyTimeoutMs);
        resolve(db);
      },
    );
  });
}

function fingerprint(path: string): FileFingerprint {
  const stat = statSync(path, { bigint: true });
  return {
    sizeBytes: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    physicalId: {
      scheme: "posix_dev_inode",
      value: `${stat.dev}:${stat.ino}`,
    },
  };
}

function databaseSnapshot(path: string, value: FileFingerprint): StableFileSnapshot {
  return {
    file: createFileIdentity({
      rootId: "agentsview",
      role: "external_database",
      relativePath: basename(path),
      path,
    }),
    fingerprint: value,
    attempts: 1,
  };
}

async function schemaColumns(db: sqlite3.Database): Promise<SchemaColumns> {
  const tableRows = await sqliteAll<{ name: string }>(
    db,
    "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
  );
  const result: SchemaColumns = new Map();
  for (const { name } of tableRows) {
    const rows = await sqliteAll<{ name: string }>(
      db,
      `SELECT name FROM pragma_table_info(${JSON.stringify(name)}) ORDER BY cid`,
    );
    result.set(name, new Set(rows.map((row) => row.name)));
  }
  return result;
}

function schemaHash(schema: SchemaColumns): string {
  const entries = [...schema.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([table, columns]) => [table, ...[...columns].sort()]);
  return stableCacheId("agentsview-schema", entries);
}

function missingRequiredSchema(schema: SchemaColumns): string[] {
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
    const available = schema.get(table);
    if (!available) {
      missing.push(table);
      continue;
    }
    for (const column of columns) {
      if (!available.has(column)) missing.push(`${table}.${column}`);
    }
  }
  return missing;
}

function pragmaNumber(row: SqliteRow | undefined): number | undefined {
  if (!row) return undefined;
  const value = Object.values(row)[0];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function sqliteMetadata(db: sqlite3.Database) {
  const [applicationId, userVersion, schemaVersion, dataVersion] = await Promise.all([
    sqliteGet(db, "PRAGMA application_id"),
    sqliteGet(db, "PRAGMA user_version"),
    sqliteGet(db, "PRAGMA schema_version"),
    sqliteGet(db, "PRAGMA data_version"),
  ]);
  return {
    applicationId: pragmaNumber(applicationId),
    userVersion: pragmaNumber(userVersion),
    schemaVersion: pragmaNumber(schemaVersion),
    dataVersion: pragmaNumber(dataVersion),
  };
}

function column(
  schema: SchemaColumns,
  table: string,
  name: string,
  fallback = "NULL",
): string {
  return schema.get(table)?.has(name) ? name : `${fallback} AS ${name}`;
}

function sourceFromAgent(value: unknown): AgentSource | null {
  if (typeof value !== "string" || !SUPPORTED_AGENTS.has(value as AgentSource)) return null;
  return value as AgentSource;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | undefined {
  const valueText = text(value);
  return valueText || undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function usageFromTokenJson(raw: unknown): Usage {
  const usage = emptyUsage();
  if (typeof raw !== "string" || !raw) return usage;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    usage.input = numberValue(parsed.input_tokens);
    usage.output = numberValue(parsed.output_tokens);
    usage.cacheRead = numberValue(parsed.cache_read_input_tokens);
    // AgentsView currently stores one cache-creation total. Preserve it in Argus's legacy
    // 5m bucket until a schema exposes the original 5m/1h split.
    usage.cacheWrite5m = numberValue(parsed.cache_creation_input_tokens);
  } catch {
    // The caller records a diagnostic while preserving the message/tool relationship.
  }
  return usage;
}

function parseInput(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function sourcePosition(originKey: string, recordIndex: number, itemIndex = 0): SourcePosition {
  return { originKey, recordIndex, itemIndex };
}

interface SessionRow extends SqliteRow {
  id: string;
  agent: string;
}

interface MessageRow extends SqliteRow {
  id: number;
  session_id: string;
  ordinal: number;
  role: string;
}

interface ToolCallRow extends SqliteRow {
  id: number;
  message_id: number;
  session_id: string;
  tool_name: string;
}

interface UsageEventRow extends SqliteRow {
  id: number;
  session_id: string;
  source: string;
  model: string;
}

interface ImportState {
  schema: SchemaColumns;
  sessions: SessionRow[];
  messages: MessageRow[];
  usageEvents: UsageEventRow[];
  toolCalls: ToolCallRow[];
}

async function loadImportState(db: sqlite3.Database, schema: SchemaColumns): Promise<ImportState> {
  const activeSessions = schema.get("sessions")?.has("deleted_at")
    ? "agent IN ('claude', 'codex', 'gemini') AND deleted_at IS NULL"
    : "agent IN ('claude', 'codex', 'gemini')";
  const sessionSelect = [
    "id",
    "agent",
    column(schema, "sessions", "project", "''"),
    column(schema, "sessions", "first_message"),
    column(schema, "sessions", "started_at"),
    column(schema, "sessions", "ended_at"),
    column(schema, "sessions", "parent_session_id"),
    column(schema, "sessions", "relationship_type", "''"),
    column(schema, "sessions", "cwd", "''"),
    column(schema, "sessions", "git_branch", "''"),
    column(schema, "sessions", "source_session_id", "''"),
    column(schema, "sessions", "file_path"),
    column(schema, "sessions", "file_size"),
    column(schema, "sessions", "file_mtime"),
    column(schema, "sessions", "file_inode"),
    column(schema, "sessions", "file_device"),
  ].join(", ");
  const messageSelect = [
    "id",
    "session_id",
    "ordinal",
    "role",
    column(schema, "messages", "timestamp"),
    column(schema, "messages", "model", "''"),
    column(schema, "messages", "token_usage", "''"),
    column(schema, "messages", "claude_message_id", "''"),
    column(schema, "messages", "claude_request_id", "''"),
  ].join(", ");
  const sessions = await sqliteAll<SessionRow>(
    db,
    `SELECT ${sessionSelect}
       FROM sessions
      WHERE ${activeSessions}
      ORDER BY agent, id`,
  );
  const messages = await sqliteAll<MessageRow>(
    db,
    `SELECT ${messageSelect}
       FROM messages
      WHERE session_id IN (
        SELECT id FROM sessions
         WHERE ${activeSessions}
      )
      ORDER BY session_id, ordinal, id`,
  );

  let usageEvents: UsageEventRow[] = [];
  const usageColumns = schema.get("usage_events");
  if (
    usageColumns?.has("id") &&
    usageColumns.has("session_id") &&
    usageColumns.has("source") &&
    usageColumns.has("model") &&
    usageColumns.has("input_tokens") &&
    usageColumns.has("output_tokens") &&
    usageColumns.has("cache_creation_input_tokens") &&
    usageColumns.has("cache_read_input_tokens")
  ) {
    const usageSelect = [
      "id",
      "session_id",
      column(schema, "usage_events", "message_ordinal"),
      "source",
      "model",
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      column(schema, "usage_events", "reasoning_tokens", "0"),
      column(schema, "usage_events", "occurred_at"),
      column(schema, "usage_events", "dedup_key", "''"),
    ].join(", ");
    usageEvents = await sqliteAll<UsageEventRow>(
      db,
      `SELECT ${usageSelect}
         FROM usage_events
        WHERE session_id IN (
          SELECT id FROM sessions
           WHERE ${activeSessions}
        )
        ORDER BY session_id, COALESCE(occurred_at, ''), COALESCE(message_ordinal, -1), id`,
    );
  }

  let toolCalls: ToolCallRow[] = [];
  const toolColumns = schema.get("tool_calls");
  if (
    toolColumns?.has("id") &&
    toolColumns.has("message_id") &&
    toolColumns.has("session_id") &&
    toolColumns.has("tool_name")
  ) {
    const toolSelect = [
      "id",
      "message_id",
      "session_id",
      "tool_name",
      column(schema, "tool_calls", "tool_use_id"),
      column(schema, "tool_calls", "input_json", "''"),
      column(schema, "tool_calls", "skill_name", "''"),
      column(schema, "tool_calls", "result_content_length", "0"),
      column(schema, "tool_calls", "subagent_session_id"),
    ].join(", ");
    toolCalls = await sqliteAll<ToolCallRow>(
      db,
      `SELECT ${toolSelect}
         FROM tool_calls
        WHERE session_id IN (
          SELECT id FROM sessions
           WHERE ${activeSessions}
        )
        ORDER BY session_id, message_id, id`,
    );
  }
  return { schema, sessions, messages, usageEvents, toolCalls };
}

function importedSourceSessionId(row: SessionRow, source: AgentSource): string {
  const raw = optionalText(row.source_session_id);
  if (source === "claude") return raw ?? row.id;
  const prefix = `${source}:`;
  if (raw) return raw.startsWith(prefix) ? raw : `${prefix}${raw}`;
  return row.id.startsWith(prefix) ? row.id : `${prefix}${row.id}`;
}

function usageFromEventRow(row: UsageEventRow): Usage {
  return {
    input: numberValue(row.input_tokens),
    output: numberValue(row.output_tokens) + numberValue(row.reasoning_tokens),
    cacheRead: numberValue(row.cache_read_input_tokens),
    cacheWrite5m: numberValue(row.cache_creation_input_tokens),
    cacheWrite1h: 0,
  };
}

function buildFragments(
  state: ImportState,
  probe: CompatibleExternalImportProbe,
): ImportedFragment[] {
  const diagnostics: ParserDiagnostic[] = [];
  const sourceBySession = new Map<string, AgentSource>();
  const sessionRows = new Map<string, SessionRow>();
  const sourceSessionIdByDbId = new Map<string, string>();
  for (const row of state.sessions) {
    const source = sourceFromAgent(row.agent);
    if (!source) continue;
    sourceBySession.set(row.id, source);
    sessionRows.set(row.id, row);
    sourceSessionIdByDbId.set(row.id, importedSourceSessionId(row, source));
  }

  const factsBySource = new Map<AgentSource, NormalizedFacts>();
  const factsFor = (source: AgentSource): NormalizedFacts => {
    let facts = factsBySource.get(source);
    if (!facts) {
      facts = { sessions: [], messages: [], invocations: [], toolResults: [], relationships: [] };
      factsBySource.set(source, facts);
    }
    return facts;
  };

  const sessionOrigin = `${probe.schemaFingerprint}:sessions`;
  for (const row of state.sessions) {
    const source = sourceFromAgent(row.agent);
    if (!source) continue;
    const sourceSessionId = sourceSessionIdByDbId.get(row.id) ?? row.id;
    const position = sourcePosition(sessionOrigin, factsFor(source).sessions.length);
    const session: SessionFact = {
      id: createFactId("session", source, sourceSessionId, position, row.id),
      source,
      sourceSessionId,
      kind: row.parent_session_id ? "subagent" : "main",
      transcriptPath: text(row.file_path),
      cwd: optionalText(row.cwd),
      gitBranch: optionalText(row.git_branch),
      firstPrompt: optionalText(row.first_message),
      position,
    };
    factsFor(source).sessions.push(session);
    if (typeof row.parent_session_id === "string" && row.parent_session_id) {
      const relationshipPosition = sourcePosition(sessionOrigin, position.recordIndex, 1);
      const parentSourceSessionId =
        sourceSessionIdByDbId.get(row.parent_session_id) ?? row.parent_session_id;
      const relationship: SessionRelationshipFact = {
        id: createFactId(
          "relationship",
          source,
          sourceSessionId,
          relationshipPosition,
          parentSourceSessionId,
        ),
        source,
        childSourceSessionId: sourceSessionId,
        parentSourceSessionId,
        kind: "subagent",
        position: relationshipPosition,
      };
      factsFor(source).relationships.push(relationship);
    }
  }

  const messageIdByRow = new Map<number, string>();
  const messagesOrigin = `${probe.schemaFingerprint}:messages`;
  for (const row of state.messages) {
    const source = sourceBySession.get(row.session_id);
    if (!source || row.role !== "assistant") continue;
    const usage = usageFromTokenJson(row.token_usage);
    const position = sourcePosition(messagesOrigin, numberValue(row.ordinal));
    const sourceSessionId = sourceSessionIdByDbId.get(row.session_id) ?? row.session_id;
    const sourceIdentity = text(row.claude_message_id) || String(row.id);
    const id = createFactId("message", source, sourceSessionId, position, sourceIdentity);
    const message: MessageFact = {
      id,
      source,
      sourceSessionId,
      providerMessageId: optionalText(row.claude_message_id),
      requestId: optionalText(row.claude_request_id),
      timestampMs: timestampMs(row.timestamp),
      model: text(row.model) || "(unknown)",
      usage,
      cwd: optionalText(sessionRows.get(row.session_id)?.cwd),
      gitBranch: optionalText(sessionRows.get(row.session_id)?.git_branch),
      attributionSkill: null,
      position,
    };
    factsFor(source).messages.push(message);
    messageIdByRow.set(row.id, id);
    if (typeof row.token_usage === "string" && row.token_usage && totalTokens(usage) === 0) {
      try {
        JSON.parse(row.token_usage);
      } catch {
        diagnostics.push({
          code: "agentsview_invalid_token_usage",
          severity: "warning",
          phase: "import",
          message: `Message ${row.id} has malformed token_usage JSON`,
          position,
        });
      }
    }
  }

  const usageOrigin = `${probe.schemaFingerprint}:usage_events`;
  for (const row of state.usageEvents) {
    const source = sourceBySession.get(row.session_id);
    if (!source) continue;
    const usage = usageFromEventRow(row);
    if (totalTokens(usage) === 0) continue;
    const sourceSessionId = sourceSessionIdByDbId.get(row.session_id) ?? row.session_id;
    const position = sourcePosition(
      usageOrigin,
      numberValue(row.message_ordinal) || factsFor(source).messages.length,
      numberValue(row.id),
    );
    const eventIdentity = text(row.dedup_key) || `${row.source}:${row.id}`;
    const id = createFactId("message", source, sourceSessionId, position, eventIdentity);
    factsFor(source).messages.push({
      id,
      source,
      sourceSessionId,
      timestampMs: timestampMs(row.occurred_at),
      model: text(row.model) || "(unknown)",
      usage,
      cwd: optionalText(sessionRows.get(row.session_id)?.cwd),
      gitBranch: optionalText(sessionRows.get(row.session_id)?.git_branch),
      attributionSkill: null,
      position,
    });
  }

  const toolsOrigin = `${probe.schemaFingerprint}:tool_calls`;
  const toolIndexByMessage = new Map<number, number>();
  for (const row of state.toolCalls) {
    const source = sourceBySession.get(row.session_id);
    const messageId = messageIdByRow.get(row.message_id);
    if (!source || !messageId) continue;
    const sourceSessionId = sourceSessionIdByDbId.get(row.session_id) ?? row.session_id;
    const itemIndex = toolIndexByMessage.get(row.message_id) ?? 0;
    toolIndexByMessage.set(row.message_id, itemIndex + 1);
    const position = sourcePosition(toolsOrigin, row.message_id, itemIndex);
    const invocationId = optionalText(row.tool_use_id);
    const args = parseInput(row.input_json);
    const mcp = parseMcpTool(row.tool_name);
    const filePath = args.file_path ?? args.filePath ?? args.path;
    const invocation: InvocationFact = {
      id: createFactId(
        "invocation",
        source,
        sourceSessionId,
        position,
        invocationId || String(row.id),
      ),
      source,
      sourceSessionId,
      messageId,
      invocationId,
      name: row.tool_name,
      skill: optionalText(row.skill_name),
      args:
        typeof row.input_json === "string" && row.input_json
          ? row.input_json.slice(0, 280)
          : undefined,
      mcpServer: mcp?.server,
      mcpTool: mcp?.tool,
      filePath: typeof filePath === "string" && filePath ? filePath : undefined,
      position,
    };
    factsFor(source).invocations.push(invocation);
    const resultLength = numberValue(row.result_content_length);
    if (resultLength > 0) {
      const resultPosition = sourcePosition(toolsOrigin, row.message_id, itemIndex + 1);
      const result: ToolResultFact = {
        id: createFactId(
          "tool_result",
          source,
          sourceSessionId,
          resultPosition,
          invocationId || String(row.id),
        ),
        source,
        sourceSessionId,
        invocationId,
        resolvedInvocationFactId: invocation.id,
        observedToolName: row.tool_name,
        approxTokens: Math.round(resultLength / 4),
        position: resultPosition,
      };
      factsFor(source).toolResults.push(result);
    }
  }

  const hasToolCalls = state.schema.has("tool_calls");
  const hasUsageEvents = state.schema.has("usage_events");
  const capabilities = {
    sessions: "complete" as const,
    messages: "complete" as const,
    usageEvents: hasUsageEvents ? ("complete" as const) : ("missing" as const),
    toolCalls: hasToolCalls ? ("complete" as const) : ("missing" as const),
    toolResultEvents: state.schema.has("tool_result_events") ? ("partial" as const) : ("missing" as const),
    attributionSkill: "missing" as const,
    claudeSubagentFolding: "partial" as const,
    codexTokenCountSemantics: "partial" as const,
    geminiNestedDiscovery: "partial" as const,
  };

  return [...factsBySource.entries()].map(([source, facts]) => {
    const rows = state.sessions.filter((row) => row.agent === source);
    const sourceFiles = rows.flatMap((row) => {
      const path = optionalText(row.file_path);
      if (!path) return [];
      const size = numberValue(row.file_size);
      const mtime = numberValue(row.file_mtime);
      const inode = numberValue(row.file_inode);
      const device = numberValue(row.file_device);
      return [
        {
          file: createFileIdentity({
            source,
            rootId: `agentsview-${source}`,
            role: "transcript",
            relativePath: path,
            path,
          }),
          fingerprint:
            size || mtime || inode || device
              ? {
                  sizeBytes: String(size),
                  mtimeNs: String(mtime),
                  physicalId:
                    inode || device
                      ? {
                          scheme: "posix_dev_inode" as const,
                          value: `${device}:${inode}`,
                        }
                      : undefined,
                }
              : undefined,
        },
      ];
    });
    const throughTimestampMs = Math.max(
      0,
      ...facts.messages.map((message) => message.timestampMs),
    );
    return {
      kind: "external",
      id: stableCacheId("agentsview-fragment", [probe.schemaFingerprint, source]),
      contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
      provenance: {
        importId: stableCacheId("agentsview-import", [
          probe.database.file.id,
          probe.database.fingerprint.sizeBytes,
          probe.database.fingerprint.mtimeNs,
          probe.schemaFingerprint,
        ]),
        adapter: { name: "agentsview", version: "1" },
        database: probe.database,
        schemaFingerprint: probe.schemaFingerprint,
        sqlite: probe.sqlite,
        capabilities,
        coverage: [
          {
            source,
            completeness: "partial",
            sourceFiles,
            sourceSessionIds: rows.map(
              (row) => sourceSessionIdByDbId.get(row.id) ?? row.id,
            ),
            throughTimestampMs: throughTimestampMs || undefined,
          },
        ],
        importedAtMs: Date.now(),
      },
      facts,
      diagnostics,
    };
  });
}

export class AgentsViewImporter implements ExternalFragmentImporter {
  readonly kind = "agentsview" as const;
  readonly databasePath: string;
  readonly busyTimeoutMs: number;

  constructor(options: AgentsViewImporterOptions = {}) {
    this.databasePath = agentsViewDatabasePath(options.databasePath);
    this.busyTimeoutMs = options.busyTimeoutMs ?? 2_000;
  }

  async probe(): Promise<ExternalImportProbe> {
    if (!existsSync(this.databasePath)) {
      return {
        compatible: false,
        reason: `AgentsView database not found at ${this.databasePath}`,
      };
    }
    const before = fingerprint(this.databasePath);
    let db: sqlite3.Database | undefined;
    try {
      db = await openReadOnly(this.databasePath, this.busyTimeoutMs);
      await sqliteExec(db, "BEGIN");
      const schema = await schemaColumns(db);
      const sqlite = await sqliteMetadata(db);
      await sqliteExec(db, "COMMIT");
      const after = fingerprint(this.databasePath);
      if (!sameFileFingerprint(before, after)) {
        return {
          compatible: false,
          reason: "AgentsView database changed while compatibility was being inspected",
          database: databaseSnapshot(this.databasePath, after),
        };
      }
      const missing = missingRequiredSchema(schema);
      if (missing.length) {
        return {
          compatible: false,
          reason: `AgentsView database is missing required schema: ${missing.join(", ")}`,
          database: databaseSnapshot(this.databasePath, after),
          schemaFingerprint: schemaHash(schema),
          sqlite,
        };
      }
      return {
        compatible: true,
        database: databaseSnapshot(this.databasePath, after),
        schemaFingerprint: schemaHash(schema),
        sqlite,
      };
    } catch (error) {
      if (db) {
        try {
          await sqliteExec(db, "ROLLBACK");
        } catch {
          // The connection may have failed before a transaction began.
        }
      }
      return {
        compatible: false,
        reason: `Unable to inspect AgentsView database: ${
          error instanceof Error ? error.message : String(error)
        }`,
        database: databaseSnapshot(this.databasePath, before),
      };
    } finally {
      if (db) await closeSqlite(db);
    }
  }

  async importFragments(
    probe: CompatibleExternalImportProbe,
  ): Promise<ImportedFragment[]> {
    const before = fingerprint(this.databasePath);
    if (!sameFileFingerprint(before, probe.database.fingerprint)) {
      throw new Error("AgentsView database changed after compatibility probing");
    }
    const db = await openReadOnly(this.databasePath, this.busyTimeoutMs);
    try {
      await sqliteExec(db, "BEGIN");
      const schema = await schemaColumns(db);
      if (schemaHash(schema) !== probe.schemaFingerprint) {
        throw new Error("AgentsView schema changed after compatibility probing");
      }
      const state = await loadImportState(db, schema);
      await sqliteExec(db, "COMMIT");
      const after = fingerprint(this.databasePath);
      if (!sameFileFingerprint(before, after)) {
        throw new Error("AgentsView database changed during import");
      }
      return buildFragments(state, probe);
    } catch (error) {
      try {
        await sqliteExec(db, "ROLLBACK");
      } catch {
        // Preserve the import error when no transaction remains active.
      }
      throw error;
    } finally {
      await closeSqlite(db);
    }
  }
}
