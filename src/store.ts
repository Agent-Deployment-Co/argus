import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import sqlite3, { type Database, type RunResult } from "sqlite3";
import type {
  AuxiliaryFact,
  StoredFragment,
  InvalidationReason,
  FragmentMetadata,
  CompleteDiscovery,
  Store,
  FileFingerprint,
  FileIdentity,
  FileRole,
  MaterializeSession,
  ParsedAuxiliaryFragment,
  PhysicalFileIdentity,
  ReconstructedFragments,
  ResolvedQuery,
  SourceCoverageRow,
  TranscriptIndex,
} from "./store-contract.ts";
import type { AgentSource, MessageRecord, ParseResult, SessionMeta, ToolResultStat } from "./types.ts";
import { STORE_FILE } from "./paths.ts";

export const STORE_SCHEMA_VERSION = 6;
export const STORE_APPLICATION_ID = 0x41524753; // "ARGS"
export const DEFAULT_STORE_BUSY_TIMEOUT_MS = 2_000;

export type StoreErrorCode =
  | "busy"
  | "corrupt"
  | "incompatible_schema"
  | "unsafe_path"
  | "io";

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    readonly storePath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StoreError";
  }
}

export interface OpenStoreOptions {
  path?: string;
  busyTimeoutMs?: number;
  now?: () => number;
}

interface SqliteError extends Error {
  code?: string;
  errno?: number;
}

interface MetadataRow {
  id: string;
  kind: StoredFragment["kind"];
  source: AgentSource | null;
  file_identity: string | null;
  contract_version: number;
  parser_version: string | null;
  updated_at_ms: number;
  status: FragmentMetadata["status"];
}

interface PragmaNumberRow {
  application_id?: number;
  user_version?: number;
}

interface QuickCheckRow {
  quick_check: string;
}

interface TableNameRow {
  name: string;
}

interface FragmentStorage {
  source: AgentSource | null;
  fileId: string | null;
  rootId: string | null;
  role: string | null;
  relativePath: string | null;
  observedPath: string | null;
  sizeBytes: string | null;
  mtimeNs: string | null;
  ctimeNs: string | null;
  physicalIdScheme: string | null;
  physicalIdValue: string | null;
  parserName: string | null;
  parserVersion: string | null;
  diagnosticsJson: string;
  importProvenanceJson: string | null;
  envelopeJson: string | null;
}

// The store is a DURABLE ARCHIVE, not a mirror of disk. Source transcripts age out (Claude Code
// keeps ~30 days), so once a session is materialized it is retained even after its files vanish —
// flagged `archived` rather than deleted. Three layers:
//   1. index_files + index_* — the per-file structural index producers write while indexing. This
//      layer IS fully derivable from disk and is rebuilt freely (see clearIndex / reindex).
//   2. resolved_* — the trusted, reconciled read model the reader SELECTs (no reconcile on read).
//      This is NOT re-derivable once a source ages off disk, so it is preserved across schema
//      changes via real migrations (MIGRATIONS below), never silently dropped.
//   3. source_coverage + session_ownership — freshness attestation and per-session ownership.
const CREATE_SCHEMA_SQL = `
  CREATE TABLE index_files (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('transcript', 'auxiliary', 'external')),
    source TEXT CHECK (source IS NULL OR source IN ('claude', 'codex', 'gemini', 'cowork')),
    file_identity TEXT,
    root_id TEXT,
    role TEXT,
    relative_path TEXT,
    observed_path TEXT,
    size_bytes TEXT,
    mtime_ns TEXT,
    ctime_ns TEXT,
    physical_id_scheme TEXT,
    physical_id_value TEXT,
    contract_version INTEGER NOT NULL,
    parser_name TEXT,
    parser_version TEXT,
    status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'unstable')),
    invalidation_reason TEXT,
    diagnostics_json TEXT NOT NULL,
    import_provenance_json TEXT,
    envelope_json TEXT,
    last_success_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );

  CREATE INDEX index_files_source_root
    ON index_files(source, root_id);
  CREATE INDEX index_files_identity
    ON index_files(file_identity);

  CREATE TABLE index_dependencies (
    file_id TEXT NOT NULL REFERENCES index_files(id) ON DELETE CASCADE,
    input_id TEXT NOT NULL,
    selector TEXT NOT NULL,
    affects_json TEXT NOT NULL,
    PRIMARY KEY (file_id, input_id, selector)
  );

  -- index_* is a thin structural index only: enough to detect change and map files -> sessions.
  -- Heavy per-message content (messages/invocations/tool-results) is NOT stored — a touched session
  -- is re-materialized by re-parsing its files from disk. resolved_* below is the single content store.
  CREATE TABLE IF NOT EXISTS index_sessions (
    file_id TEXT NOT NULL REFERENCES index_files(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('native', 'external')),
    source TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    kind TEXT,
    transcript_path TEXT,
    PRIMARY KEY (file_id, seq)
  );
  CREATE INDEX IF NOT EXISTS index_sessions_source_session
    ON index_sessions(source, source_session_id);
  CREATE INDEX IF NOT EXISTS index_sessions_file
    ON index_sessions(file_id);

  CREATE TABLE IF NOT EXISTS index_relationships (
    file_id TEXT NOT NULL REFERENCES index_files(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('native', 'external')),
    source TEXT NOT NULL,
    child_source_session_id TEXT NOT NULL,
    parent_source_session_id TEXT NOT NULL,
    PRIMARY KEY (file_id, seq)
  );

  CREATE TABLE IF NOT EXISTS index_auxiliary (
    file_id TEXT NOT NULL REFERENCES index_files(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('native', 'external')),
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    selector TEXT,
    fact_json TEXT NOT NULL,
    PRIMARY KEY (file_id, seq)
  );

  -- The trusted read model: reconciled session rows the reader SELECTs directly.
  -- archived = 1 means retained but no longer backed by its source on disk (aged out / deleted).
  CREATE TABLE resolved_sessions (
    session_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    source TEXT NOT NULL,
    project TEXT NOT NULL,
    cwd TEXT NOT NULL,
    first_ts INTEGER,
    last_ts INTEGER,
    message_count INTEGER NOT NULL,
    first_prompt TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    meta_json TEXT NOT NULL
  );
  CREATE INDEX resolved_sessions_project ON resolved_sessions(project);
  CREATE INDEX resolved_sessions_last_ts ON resolved_sessions(last_ts);
  CREATE INDEX resolved_sessions_source ON resolved_sessions(source);
  CREATE INDEX resolved_sessions_archived ON resolved_sessions(archived);

  CREATE TABLE resolved_messages (
    session_id TEXT NOT NULL REFERENCES resolved_sessions(session_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    source TEXT NOT NULL,
    ts INTEGER NOT NULL,
    date TEXT NOT NULL,
    cwd TEXT NOT NULL,
    project TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  CREATE INDEX resolved_messages_date ON resolved_messages(date);
  CREATE INDEX resolved_messages_ts ON resolved_messages(ts);
  CREATE INDEX resolved_messages_source ON resolved_messages(source);

  -- Tool-result stats per session (global dashboard total = SUM across all sessions).
  CREATE TABLE resolved_tool_results (
    session_id TEXT NOT NULL REFERENCES resolved_sessions(session_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    count INTEGER NOT NULL,
    approx_tokens INTEGER NOT NULL,
    PRIMARY KEY (session_id, name)
  );

  -- Per-source freshness attestation: lets a consumer know whether the store is current.
  CREATE TABLE source_coverage (
    source TEXT PRIMARY KEY,
    files_digest TEXT,
    last_sync_at_ms INTEGER,
    session_count INTEGER NOT NULL DEFAULT 0
  );

  -- Which producer owns each canonical session (native wins over dependent importers).
  CREATE TABLE session_ownership (
    session_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL
  );
`;

/** Fact tables in the order their rows are cleared when a fragment is re-materialized. */
const INDEX_TABLES = ["index_sessions", "index_relationships", "index_auxiliary"] as const;

const INSERT_FRAGMENT_SQL = `
  INSERT INTO index_files (
    id, kind, source, file_identity, root_id, role, relative_path, observed_path,
    size_bytes, mtime_ns, ctime_ns, physical_id_scheme, physical_id_value,
    contract_version, parser_name, parser_version, status, invalidation_reason,
    diagnostics_json, import_provenance_json, envelope_json,
    last_success_at_ms, updated_at_ms
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, 'success', NULL,
    ?, ?, ?,
    ?, ?
  )
  ON CONFLICT(id) DO UPDATE SET
    kind = excluded.kind,
    source = excluded.source,
    file_identity = excluded.file_identity,
    root_id = excluded.root_id,
    role = excluded.role,
    relative_path = excluded.relative_path,
    observed_path = excluded.observed_path,
    size_bytes = excluded.size_bytes,
    mtime_ns = excluded.mtime_ns,
    ctime_ns = excluded.ctime_ns,
    physical_id_scheme = excluded.physical_id_scheme,
    physical_id_value = excluded.physical_id_value,
    contract_version = excluded.contract_version,
    parser_name = excluded.parser_name,
    parser_version = excluded.parser_version,
    status = 'success',
    invalidation_reason = NULL,
    diagnostics_json = excluded.diagnostics_json,
    import_provenance_json = excluded.import_provenance_json,
    envelope_json = excluded.envelope_json,
    last_success_at_ms = excluded.last_success_at_ms,
    updated_at_ms = excluded.updated_at_ms
`;

function run(db: Database, sql: string, params: unknown[] = []): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function callback(error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function exec(db: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function get<T>(db: Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get<T>(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function all<T>(db: Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all<T>(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function closeDatabase(db: Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Stay well under sqlite3's default bound-parameter limit (999) when batching. */
const MAX_BOUND_PARAMS = 900;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Insert many rows in as few statements as possible (multi-row INSERT, chunked by param limit). */
async function insertRows(
  db: Database,
  table: string,
  columns: readonly string[],
  rows: unknown[][],
): Promise<void> {
  if (!rows.length) return;
  const perRowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
  const rowsPerStatement = Math.max(1, Math.floor(MAX_BOUND_PARAMS / columns.length));
  for (const part of chunk(rows, rowsPerStatement)) {
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${part
      .map(() => perRowPlaceholder)
      .join(", ")}`;
    await run(db, sql, part.flat());
  }
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function ensureNotSymlink(path: string): ReturnType<typeof lstatSync> | undefined {
  const stat = lstatIfExists(path);
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) {
    throw new StoreError(
      "unsafe_path",
      path,
      `Won't use the store path because it's a symbolic link: ${path}`,
    );
  }
  return stat;
}

function ensurePrivateDirectory(path: string): void {
  ensureNotSymlink(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  ensureNotSymlink(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory()) {
    throw new StoreError("unsafe_path", path, `The store folder isn't a directory: ${path}`);
  }
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function prepareDatabaseFile(path: string): void {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const stat = ensureNotSymlink(path);

  if (stat) {
    if (!stat.isFile()) {
      throw new StoreError("unsafe_path", path, `The store path isn't a regular file: ${path}`);
    }
  } else {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    closeSync(descriptor);
  }

  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function secureSqliteFiles(path: string): void {
  if (process.platform === "win32") return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (!ensureNotSymlink(candidate)) continue;
    chmodSync(candidate, 0o600);
  }
}

function openDatabase(path: string, busyTimeoutMs: number): Promise<Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(
      path,
      sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX,
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

function rebuildHint(_path: string): string {
  return "Run `argus reindex --force` to rebuild the local store from your transcripts.";
}

function asStoreError(
  error: unknown,
  path: string,
  busyTimeoutMs: number,
  fallbackCode: StoreErrorCode = "io",
): StoreError {
  if (error instanceof StoreError) return error;
  const sqliteError = error as SqliteError;
  if (sqliteError?.code === "SQLITE_BUSY" || sqliteError?.code === "SQLITE_LOCKED") {
    return new StoreError(
      "busy",
      path,
      `The local store is in use by another Argus command (waited ${busyTimeoutMs}ms). Close it and try again.`,
      { cause: error },
    );
  }
  if (sqliteError?.code === "SQLITE_CORRUPT" || sqliteError?.code === "SQLITE_NOTADB") {
    return new StoreError(
      "corrupt",
      path,
      `The local store is damaged or isn't a valid database. ${rebuildHint(path)}`,
      { cause: error },
    );
  }
  const message = sqliteError?.message || String(error);
  return new StoreError(fallbackCode, path, `Couldn't use the local store at ${path}: ${message}`, {
    cause: error,
  });
}

async function transaction<T>(db: Database, operation: () => Promise<T>): Promise<T> {
  await exec(db, "BEGIN IMMEDIATE");
  try {
    const value = await operation();
    await exec(db, "COMMIT");
    return value;
  } catch (error) {
    await exec(db, "ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function pragmaNumber(db: Database, name: "application_id" | "user_version"): Promise<number> {
  const row = await get<PragmaNumberRow>(db, `PRAGMA ${name}`);
  return row?.[name] ?? 0;
}

async function validateOwnership(db: Database, path: string): Promise<number> {
  const applicationId = await pragmaNumber(db, "application_id");
  const userVersion = await pragmaNumber(db, "user_version");
  const tables = await all<TableNameRow>(
    db,
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );

  if (applicationId === 0 && userVersion === 0 && tables.length === 0) return 0;
  if (applicationId !== STORE_APPLICATION_ID) {
    throw new StoreError(
      "incompatible_schema",
      path,
      `${path} isn't an Argus store. Point Argus at a different location, or remove that file.`,
    );
  }
  if (userVersion > STORE_SCHEMA_VERSION) {
    throw new StoreError(
      "incompatible_schema",
      path,
      `The local store was written by a newer version of Argus. Update Argus to read it.`,
    );
  }
  return userVersion;
}

async function createSchema(db: Database): Promise<void> {
  await transaction(db, async () => {
    await exec(db, CREATE_SCHEMA_SQL);
    await exec(db, `PRAGMA application_id = ${STORE_APPLICATION_ID}`);
    await exec(db, `PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
  });
}

/**
 * Forward-only schema migrations, keyed by the version they upgrade FROM. Because resolved_* holds
 * sessions that may no longer exist on disk (aged-out archives), the store can no longer be rebuilt
 * from source on a version bump — it must be migrated in place. Each entry's SQL runs in its own
 * transaction (with the user_version bump) so a partial upgrade never leaves a half-migrated store.
 */
const MIGRATIONS: Record<number, { to: number; sql: string }> = {
  // 4 → 5: durable archive. Add the `archived` flag so off-disk sessions can be retained, not deleted.
  4: {
    to: 5,
    sql: `
      ALTER TABLE resolved_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS resolved_sessions_archived ON resolved_sessions(archived);
    `,
  },
  // 5 → 6: cowork source. Recreate index_files with an updated CHECK constraint that includes 'cowork'.
  // SQLite doesn't support ALTER COLUMN; DROP TABLE is safe here because it does NOT trigger ON DELETE
  // CASCADE in child tables (FK enforcement only fires on DML, not DDL). Child table data is intact
  // after the rename because FK constraints reference the table by name, which is restored.
  5: {
    to: 6,
    sql: `
      CREATE TABLE index_files_v6 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('transcript', 'auxiliary', 'external')),
        source TEXT CHECK (source IS NULL OR source IN ('claude', 'codex', 'gemini', 'cowork')),
        file_identity TEXT,
        root_id TEXT,
        role TEXT,
        relative_path TEXT,
        observed_path TEXT,
        size_bytes TEXT,
        mtime_ns TEXT,
        ctime_ns TEXT,
        physical_id_scheme TEXT,
        physical_id_value TEXT,
        contract_version INTEGER NOT NULL,
        parser_name TEXT,
        parser_version TEXT,
        status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'unstable')),
        invalidation_reason TEXT,
        diagnostics_json TEXT NOT NULL,
        import_provenance_json TEXT,
        envelope_json TEXT,
        last_success_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      INSERT INTO index_files_v6 SELECT * FROM index_files;
      DROP TABLE index_files;
      ALTER TABLE index_files_v6 RENAME TO index_files;
      CREATE INDEX index_files_source_root ON index_files(source, root_id);
      CREATE INDEX index_files_identity ON index_files(file_identity);
    `,
  },
};

/** Apply the migration chain from `fromVersion` up to STORE_SCHEMA_VERSION, or throw if none exists. */
async function migrateSchema(db: Database, path: string, fromVersion: number): Promise<void> {
  let version = fromVersion;
  while (version !== STORE_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) {
      throw new StoreError(
        "incompatible_schema",
        path,
        `Argus can't upgrade the local store from this older version. ` +
          `Run \`argus reindex --force\` to rebuild it from your transcripts (this drops sessions no longer on disk).`,
      );
    }
    await transaction(db, async () => {
      await exec(db, step.sql);
      await exec(db, `PRAGMA user_version = ${step.to}`);
    });
    version = step.to;
  }
}

async function initializeDatabase(db: Database, path: string): Promise<void> {
  await exec(db, "PRAGMA foreign_keys = ON");
  const currentVersion = await validateOwnership(db, path);

  const check = await get<QuickCheckRow>(db, "PRAGMA quick_check(1)");
  if (check?.quick_check !== "ok") {
    throw new StoreError(
      "corrupt",
      path,
      `The local store failed an integrity check (${check?.quick_check ?? "unknown error"}). ${rebuildHint(path)}`,
    );
  }

  // The store is a durable archive: an empty store is created fresh; an older owned schema is
  // MIGRATED in place (resolved_* is preserved). validateOwnership already rejected newer schemas.
  // A version with no migration path raises incompatible_schema (never silently rebuilt) — the user
  // must opt into destruction via `reindex --force`.
  if (currentVersion === 0) {
    await createSchema(db);
  } else if (currentVersion !== STORE_SCHEMA_VERSION) {
    await migrateSchema(db, path, currentVersion);
  }

  await exec(db, "PRAGMA journal_mode = WAL");
  await exec(db, "PRAGMA synchronous = NORMAL");
  await exec(db, "PRAGMA wal_autocheckpoint = 1000");
  await exec(db, "PRAGMA trusted_schema = OFF");

  // Verify the expected schema rather than trusting user_version alone.
  try {
    await get(db, "SELECT id, import_provenance_json, envelope_json FROM index_files LIMIT 1");
    await get(db, "SELECT file_id FROM index_sessions LIMIT 1");
    await get(db, "SELECT session_id, archived FROM resolved_sessions LIMIT 1");
    await get(db, "SELECT source FROM source_coverage LIMIT 1");
  } catch (error) {
    if ((error as SqliteError).code !== "SQLITE_ERROR") throw error;
    throw new StoreError(
      "incompatible_schema",
      path,
      `The local store is missing data Argus expects. ${rebuildHint(path)}`,
      { cause: error },
    );
  }
  secureSqliteFiles(path);
}

function fragmentStorage(fragment: StoredFragment): FragmentStorage {
  if (fragment.kind === "external") {
    const snapshot = fragment.provenance.database;
    return {
      source: null,
      fileId: snapshot.file.id,
      rootId: snapshot.file.rootId,
      role: snapshot.file.role,
      relativePath: snapshot.file.relativePath,
      observedPath: snapshot.file.path,
      sizeBytes: snapshot.fingerprint.sizeBytes,
      mtimeNs: snapshot.fingerprint.mtimeNs,
      ctimeNs: snapshot.fingerprint.ctimeNs ?? null,
      physicalIdScheme: snapshot.fingerprint.physicalId?.scheme ?? null,
      physicalIdValue: snapshot.fingerprint.physicalId?.value ?? null,
      parserName: fragment.provenance.adapter.name,
      parserVersion: fragment.provenance.adapter.version,
      diagnosticsJson: JSON.stringify(fragment.diagnostics),
      importProvenanceJson: JSON.stringify(fragment.provenance),
      envelopeJson: envelopeJson(fragment),
    };
  }

  const snapshot = fragment.snapshot;
  return {
    source: fragment.parser.source,
    fileId: snapshot.file.id,
    rootId: snapshot.file.rootId,
    role: snapshot.file.role,
    relativePath: snapshot.file.relativePath,
    observedPath: snapshot.file.path,
    sizeBytes: snapshot.fingerprint.sizeBytes,
    mtimeNs: snapshot.fingerprint.mtimeNs,
    ctimeNs: snapshot.fingerprint.ctimeNs ?? null,
    physicalIdScheme: snapshot.fingerprint.physicalId?.scheme ?? null,
    physicalIdValue: snapshot.fingerprint.physicalId?.value ?? null,
    parserName: fragment.parser.name,
    parserVersion: fragment.parser.version,
    diagnosticsJson: JSON.stringify(fragment.diagnostics),
    importProvenanceJson: null,
    envelopeJson: envelopeJson(fragment),
  };
}

/**
 * The fragment minus its facts — enough to rebuild it once rows are reattached. Only auxiliary
 * fragments are reconstructed from rows (transcripts/imports are re-parsed from disk), so everything
 * else stores a null envelope.
 */
function envelopeJson(fragment: StoredFragment): string | null {
  if (fragment.kind !== "auxiliary") return null;
  return JSON.stringify({ ...fragment, facts: [] });
}

function factOrigin(fragment: StoredFragment): "native" | "external" {
  return fragment.kind === "external" ? "external" : "native";
}

/**
 * Explode a fragment's facts into the queryable `fact_*` rows (replacing any prior rows for this
 * fragment). Runs inside the same transaction as the fragment upsert. `seq` preserves array order
 * so reconstruction is byte-faithful (e.g. friction turn-duration ordering).
 */
async function materializeFactRows(db: Database, fragment: StoredFragment): Promise<void> {
  for (const table of INDEX_TABLES) {
    await run(db, `DELETE FROM ${table} WHERE file_id = ?`, [fragment.id]);
  }
  const origin = factOrigin(fragment);

  if (fragment.kind === "auxiliary") {
    await insertRows(
      db,
      "index_auxiliary",
      ["file_id", "seq", "origin", "kind", "source", "selector", "fact_json"],
      fragment.facts.map((fact, seq) => [
        fragment.id,
        seq,
        origin,
        fact.kind,
        fact.source,
        fact.kind === "session_first_prompt" ? fact.sourceSessionId : fact.selector,
        JSON.stringify(fact),
      ]),
    );
    return;
  }

  const facts = fragment.facts;
  // Only the structural columns are stored (file -> session map + subagent links). The full facts
  // and all message/invocation/tool-result content are re-parsed from disk on demand. `seq` (the
  // array index) preserves order so reconstruction stays byte-faithful.
  await insertRows(
    db,
    "index_sessions",
    ["file_id", "seq", "origin", "source", "source_session_id", "kind", "transcript_path"],
    facts.sessions.map((s, seq) => [
      fragment.id,
      seq,
      origin,
      s.source,
      s.sourceSessionId,
      s.kind,
      s.transcriptPath ?? null,
    ]),
  );
  await insertRows(
    db,
    "index_relationships",
    ["file_id", "seq", "origin", "source", "child_source_session_id", "parent_source_session_id"],
    facts.relationships.map((rel, seq) => [
      fragment.id,
      seq,
      origin,
      rel.source,
      rel.childSourceSessionId,
      rel.parentSourceSessionId,
    ]),
  );
}

interface FactJsonRow {
  fact_json: string;
}

async function loadFactArray<T>(db: Database, table: string, fragmentId: string): Promise<T[]> {
  const rows = await all<FactJsonRow>(
    db,
    `SELECT fact_json FROM ${table} WHERE file_id = ? ORDER BY seq`,
    [fragmentId],
  );
  return rows.map((row) => JSON.parse(row.fact_json) as T);
}

function invalidatedStatus(reason: InvalidationReason): FragmentMetadata["status"] {
  return reason === "file_changed" ? "unstable" : "failed";
}

/**
 * Resolve a query into SQL fragments. `source` is a collection *scope* (which sources this run
 * materialized) applied to every table but never dropping empty sessions; `since/until/project` are
 * content filters whose presence (`active`) makes the reader drop sessions with no surviving message.
 * `--project` matches cwd via `instr` (not LIKE) to avoid wildcard injection.
 */
function buildResolvedFilters(query?: ResolvedQuery, sourceColumn = "source"): {
  messageWhere: string;
  messageParams: unknown[];
  sourceWhere: string;
  sourceParams: unknown[];
  active: boolean;
} {
  const sourceConditions: string[] = [];
  const sourceParams: unknown[] = [];
  if (query?.sources?.length) {
    sourceConditions.push(`${sourceColumn} IN (${query.sources.map(() => "?").join(", ")})`);
    sourceParams.push(...query.sources);
  }
  const contentConditions: string[] = [];
  const contentParams: unknown[] = [];
  if (query?.since) {
    contentConditions.push("date >= ?");
    contentParams.push(query.since);
  }
  if (query?.until) {
    contentConditions.push("date <= ?");
    contentParams.push(query.until);
  }
  if (query?.projectSubstring) {
    contentConditions.push("instr(cwd, ?) > 0");
    contentParams.push(query.projectSubstring);
  }
  const all = [...sourceConditions, ...contentConditions];
  return {
    messageWhere: all.length ? `WHERE ${all.join(" AND ")}` : "",
    messageParams: [...sourceParams, ...contentParams],
    sourceWhere: sourceConditions.length ? `WHERE ${sourceConditions.join(" AND ")}` : "",
    sourceParams,
    active: contentConditions.length > 0,
  };
}

export class SqliteStore implements Store {
  private queue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly db: Database,
    readonly path: string,
    private readonly busyTimeoutMs: number,
    private readonly now: () => number,
  ) {}

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closePromise) return Promise.reject(new Error("Argus store is closed"));
    const result = this.queue.then(operation, operation).catch((error) => {
      throw asStoreError(error, this.path, this.busyTimeoutMs);
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  load(id: string): Promise<StoredFragment | undefined> {
    return this.schedule(async () => {
      const { nativeFragments, auxiliaryFragments, importedFragments } =
        await this.reconstructCore([id]);
      return nativeFragments[0] ?? importedFragments[0] ?? auxiliaryFragments[0];
    });
  }

  list(source?: AgentSource): Promise<FragmentMetadata[]> {
    return this.schedule(async () => {
      const rows = await all<MetadataRow>(
        this.db,
        `SELECT id, kind, source, file_identity, contract_version, parser_version, updated_at_ms, status
         FROM index_files
         ${source ? "WHERE source = ?" : ""}
         ORDER BY id`,
        source ? [source] : [],
      );
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        source: row.source ?? undefined,
        fileId: row.file_identity ?? undefined,
        contractVersion: row.contract_version,
        parserVersion: row.parser_version ?? undefined,
        updatedAtMs: row.updated_at_ms,
        status: row.status,
      }));
    });
  }

  replace(fragment: StoredFragment): Promise<void> {
    return this.schedule(async () => {
      const storage = fragmentStorage(fragment);
      const timestamp = this.now();
      await transaction(this.db, async () => {
        await run(this.db, INSERT_FRAGMENT_SQL, [
          fragment.id,
          fragment.kind,
          storage.source,
          storage.fileId,
          storage.rootId,
          storage.role,
          storage.relativePath,
          storage.observedPath,
          storage.sizeBytes,
          storage.mtimeNs,
          storage.ctimeNs,
          storage.physicalIdScheme,
          storage.physicalIdValue,
          fragment.contractVersion,
          storage.parserName,
          storage.parserVersion,
          storage.diagnosticsJson,
          storage.importProvenanceJson,
          storage.envelopeJson,
          timestamp,
          timestamp,
        ]);
        await run(this.db, "DELETE FROM index_dependencies WHERE file_id = ?", [
          fragment.id,
        ]);
        if (fragment.kind === "transcript") {
          for (const dependency of fragment.dependencies) {
            await run(
              this.db,
              `INSERT INTO index_dependencies(file_id, input_id, selector, affects_json)
               VALUES (?, ?, ?, ?)`,
              [
                fragment.id,
                dependency.inputId,
                dependency.selector,
                JSON.stringify(dependency.affects),
              ],
            );
          }
        }
        await materializeFactRows(this.db, fragment);
      });
      secureSqliteFiles(this.path);
    });
  }

  removeMissing(discovery: CompleteDiscovery): Promise<void> {
    return this.schedule(async () => {
      if (discovery.status !== "complete") {
        throw new Error("removeMissing requires a complete authoritative discovery result");
      }
      const observedFileIds = new Set(discovery.files.map(({ file }) => file.id));
      await transaction(this.db, async () => {
        const rows = await all<{ id: string; file_identity: string }>(
          this.db,
          `SELECT id, file_identity
           FROM index_files
           WHERE source = ? AND root_id = ? AND file_identity IS NOT NULL`,
          [discovery.source, discovery.rootId],
        );
        for (const row of rows) {
          if (!observedFileIds.has(row.file_identity)) {
            await run(this.db, "DELETE FROM index_files WHERE id = ?", [row.id]);
          }
        }
      });
    });
  }

  invalidate(ids: string[], reason: InvalidationReason): Promise<void> {
    return this.schedule(async () => {
      const unique = [...new Set(ids)];
      if (!unique.length) return;
      const status = invalidatedStatus(reason);
      const now = this.now();
      await transaction(this.db, async () => {
        // Three bound slots are fixed (status, reason, updated_at); the rest are ids.
        for (const part of chunk(unique, MAX_BOUND_PARAMS - 3)) {
          const placeholders = part.map(() => "?").join(", ");
          await run(
            this.db,
            `UPDATE index_files
             SET status = ?, invalidation_reason = ?, updated_at_ms = ?
             WHERE id IN (${placeholders})`,
            [status, reason, now, ...part],
          );
        }
      });
    });
  }

  transcriptIndex(source: AgentSource): Promise<TranscriptIndex> {
    return this.schedule(async () => {
      const fragmentRows = await all<{
        id: string;
        file_identity: string | null;
        root_id: string | null;
        role: string | null;
        relative_path: string | null;
        observed_path: string | null;
        size_bytes: string | null;
        mtime_ns: string | null;
        ctime_ns: string | null;
        physical_id_scheme: string | null;
        physical_id_value: string | null;
        parser_name: string | null;
        parser_version: string | null;
        status: FragmentMetadata["status"];
      }>(
        this.db,
        `SELECT id, file_identity, root_id, role, relative_path, observed_path, size_bytes, mtime_ns,
                ctime_ns, physical_id_scheme, physical_id_value, parser_name, parser_version, status
         FROM index_files WHERE source = ? AND kind = 'transcript'`,
        [source],
      );
      const sessionRows = await all<{ file_id: string; source_session_id: string }>(
        this.db,
        "SELECT file_id, source_session_id FROM index_sessions WHERE source = ?",
        [source],
      );
      const relationshipRows = await all<{ child: string; parent: string }>(
        this.db,
        `SELECT child_source_session_id AS child, parent_source_session_id AS parent
         FROM index_relationships WHERE source = ?`,
        [source],
      );

      const sessionsByFragment = new Map<string, string[]>();
      for (const row of sessionRows) {
        let list = sessionsByFragment.get(row.file_id);
        if (!list) {
          list = [];
          sessionsByFragment.set(row.file_id, list);
        }
        list.push(row.source_session_id);
      }

      const fragments = fragmentRows.map((row) => {
        const physicalId: PhysicalFileIdentity | undefined =
          row.physical_id_scheme && row.physical_id_value
            ? {
                scheme: row.physical_id_scheme as PhysicalFileIdentity["scheme"],
                value: row.physical_id_value,
              }
            : undefined;
        const file: FileIdentity = {
          id: row.file_identity ?? row.id,
          source,
          rootId: row.root_id ?? "",
          role: (row.role ?? "transcript") as FileRole,
          relativePath: row.relative_path ?? "",
          path: row.observed_path ?? "",
        };
        const fingerprint: FileFingerprint = {
          sizeBytes: row.size_bytes ?? "0",
          mtimeNs: row.mtime_ns ?? "0",
          ...(row.ctime_ns != null ? { ctimeNs: row.ctime_ns } : {}),
          ...(physicalId ? { physicalId } : {}),
        };
        return {
          fragmentId: row.id,
          file,
          fingerprint,
          parserName: row.parser_name,
          parserVersion: row.parser_version,
          status: row.status,
          sourceSessionIds: sessionsByFragment.get(row.id) ?? [],
        };
      });

      return {
        fragments,
        relationships: relationshipRows.map((row) => ({ child: row.child, parent: row.parent })),
      };
    });
  }

  // Reconstruct auxiliary fragments from their envelope + index_auxiliary rows. Transcript/import
  // fragments store a null envelope (their content is re-parsed from disk), so they aren't
  // reconstructed here. Unscheduled so callers compose it under one queue slot.
  private async reconstructCore(ids: string[]): Promise<ReconstructedFragments> {
    const result: ReconstructedFragments = {
      nativeFragments: [],
      auxiliaryFragments: [],
      importedFragments: [],
    };
    for (const id of new Set(ids)) {
      const row = await get<{ kind: StoredFragment["kind"]; envelope_json: string | null }>(
        this.db,
        "SELECT kind, envelope_json FROM index_files WHERE id = ? AND status = 'success'",
        [id],
      );
      if (!row || row.envelope_json == null || row.kind !== "auxiliary") continue;
      const fragment = JSON.parse(row.envelope_json) as ParsedAuxiliaryFragment;
      fragment.facts = await loadFactArray<AuxiliaryFact>(this.db, "index_auxiliary", id);
      result.auxiliaryFragments.push(fragment);
    }
    return result;
  }

  // --- Trusted read model ---------------------------------------------------------------------

  readResolved(query?: ResolvedQuery): Promise<ParseResult> {
    return this.schedule(() => this.readResolvedCore(query));
  }

  private async readResolvedCore(query?: ResolvedQuery): Promise<ParseResult> {
    const filters = buildResolvedFilters(query);
    const messageRows = await all<{ session_id: string; record_json: string }>(
      this.db,
      `SELECT session_id, record_json FROM resolved_messages ${filters.messageWhere}
       ORDER BY ts, source, session_id, seq`,
      filters.messageParams,
    );
    const messages = messageRows.map((row) => JSON.parse(row.record_json) as MessageRecord);

    const sessions = new Map<string, SessionMeta>();
    const sessionRows = await all<{ session_id: string; meta_json: string }>(
      this.db,
      `SELECT session_id, meta_json FROM resolved_sessions ${filters.sourceWhere} ORDER BY rowid`,
      filters.sourceParams,
    );
    if (filters.active) {
      // Content filters drop sessions with no surviving message (matches the old in-memory filter).
      const keep = new Set(messageRows.map((row) => row.session_id));
      for (const row of sessionRows) {
        if (keep.has(row.session_id)) sessions.set(row.session_id, JSON.parse(row.meta_json) as SessionMeta);
      }
    } else {
      for (const row of sessionRows) sessions.set(row.session_id, JSON.parse(row.meta_json) as SessionMeta);
    }

    // Tool-result totals are unfiltered by date/project but scoped to the requested sources.
    const sourceJoin = buildResolvedFilters(query, "s.source");
    const toolRows = await all<{ name: string; count: number; approx_tokens: number }>(
      this.db,
      `SELECT tr.name AS name, SUM(tr.count) AS count, SUM(tr.approx_tokens) AS approx_tokens
       FROM resolved_tool_results tr
       JOIN resolved_sessions s ON s.session_id = tr.session_id
       ${sourceJoin.sourceWhere}
       GROUP BY tr.name`,
      sourceJoin.sourceParams,
    );
    const toolResults = new Map<string, ToolResultStat>();
    for (const row of toolRows) toolResults.set(row.name, { count: row.count, approxTokens: row.approx_tokens });

    return { messages, sessions, toolResults };
  }

  materializeSessions(owner: string, sessions: MaterializeSession[]): Promise<string[]> {
    return this.schedule(async () => {
      if (!sessions.length) return [];
      const keptFuller: string[] = [];
      await transaction(this.db, async () => {
        for (const session of sessions) {
          const sid = session.meta.sessionId;
          // Don't-regress guard: transcripts are append-only, so a re-parse yielding FEWER messages
          // than already stored means some of the session's files are missing/unreadable this run, or
          // another producer already holds a richer copy. Keep the fuller stored row rather than
          // overwriting real history with a partial read — regardless of which producer owns it (a
          // handoff must not regress the count). We do NOT flag archived here: the file may still be
          // on disk (e.g. a transient parse failure); whether a session has truly left disk is decided
          // by the coordinator's discovery, not by a message-count dip.
          const existing = await get<{ message_count: number }>(
            this.db,
            "SELECT message_count FROM resolved_sessions WHERE session_id = ?",
            [sid],
          );
          if (existing && session.messages.length < existing.message_count) {
            keptFuller.push(sid);
            continue;
          }
          // Replace this session wholesale (messages + tool results cascade via FK). A freshly
          // materialized session is present on disk, so archived resets to 0.
          await run(this.db, "DELETE FROM resolved_sessions WHERE session_id = ?", [sid]);
          const timestamps = session.messages.map((message) => message.ts);
          const firstTs = timestamps.length ? Math.min(...timestamps) : null;
          const lastTs = timestamps.length ? Math.max(...timestamps) : null;
          await run(
            this.db,
            `INSERT INTO resolved_sessions(
               session_id, owner, source, project, cwd, first_ts, last_ts, message_count, first_prompt, archived, meta_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
            [
              sid,
              owner,
              session.meta.source,
              session.meta.project,
              session.meta.cwd ?? "",
              firstTs,
              lastTs,
              session.messages.length,
              session.meta.firstPrompt ?? null,
              JSON.stringify(session.meta),
            ],
          );
          await insertRows(
            this.db,
            "resolved_messages",
            ["session_id", "seq", "source", "ts", "date", "cwd", "project", "record_json"],
            session.messages.map((message, seq) => [
              sid,
              seq,
              message.source,
              message.ts,
              message.date,
              message.cwd ?? "",
              message.project,
              JSON.stringify(message),
            ]),
          );
          await insertRows(
            this.db,
            "resolved_tool_results",
            ["session_id", "name", "count", "approx_tokens"],
            session.toolResults.map((tr) => [sid, tr.name, tr.count, tr.approxTokens]),
          );
          await run(
            this.db,
            "INSERT OR REPLACE INTO session_ownership(session_id, owner) VALUES (?, ?)",
            [sid, owner],
          );
        }
      });
      secureSqliteFiles(this.path);
      return keptFuller;
    });
  }

  retractSessions(sessionIds: string[]): Promise<void> {
    return this.schedule(async () => {
      const ids = [...new Set(sessionIds)];
      if (!ids.length) return;
      await transaction(this.db, async () => {
        for (const part of chunk(ids, MAX_BOUND_PARAMS)) {
          const placeholders = part.map(() => "?").join(", ");
          await run(this.db, `DELETE FROM resolved_sessions WHERE session_id IN (${placeholders})`, part);
          await run(this.db, `DELETE FROM session_ownership WHERE session_id IN (${placeholders})`, part);
        }
      });
    });
  }

  setSessionsArchived(sessionIds: string[], archived: boolean): Promise<void> {
    return this.schedule(async () => {
      const ids = [...new Set(sessionIds)];
      if (!ids.length) return;
      const value = archived ? 1 : 0;
      await transaction(this.db, async () => {
        // One bound slot is taken by `value`, so leave room for it in each chunk of ids.
        for (const part of chunk(ids, MAX_BOUND_PARAMS - 1)) {
          const placeholders = part.map(() => "?").join(", ");
          await run(
            this.db,
            `UPDATE resolved_sessions SET archived = ? WHERE session_id IN (${placeholders})`,
            [value, ...part],
          );
        }
      });
    });
  }

  listArchived(source?: AgentSource): Promise<string[]> {
    return this.schedule(async () => {
      const rows = await all<{ session_id: string }>(
        this.db,
        `SELECT session_id FROM resolved_sessions WHERE archived = 1${
          source ? " AND source = ?" : ""
        }`,
        source ? [source] : [],
      );
      return rows.map((row) => row.session_id);
    });
  }

  archivedCountForOwner(owner: string): Promise<number> {
    return this.schedule(async () => {
      const row = await get<{ n: number }>(
        this.db,
        "SELECT COUNT(*) AS n FROM resolved_sessions WHERE owner = ? AND archived = 1",
        [owner],
      );
      return row?.n ?? 0;
    });
  }

  resolvedSessionCounts(): Promise<Array<{ owner: string; present: number; archived: number }>> {
    return this.schedule(async () => {
      const rows = await all<{ owner: string; present: number; archived: number }>(
        this.db,
        `SELECT owner,
                SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS present,
                SUM(archived) AS archived
         FROM resolved_sessions GROUP BY owner ORDER BY owner`,
      );
      return rows.map((row) => ({ owner: row.owner, present: row.present, archived: row.archived }));
    });
  }

  clearIndex(): Promise<void> {
    return this.schedule(async () => {
      // Drop only the structural index + freshness attestation (both re-derivable from disk).
      // resolved_* and session_ownership are the durable archive and are intentionally preserved.
      await transaction(this.db, async () => {
        await run(this.db, "DELETE FROM index_files"); // cascades to index_sessions/relationships/auxiliary/dependencies
        await run(this.db, "DELETE FROM source_coverage");
      });
    });
  }

  resolvedSessionIdsForOwner(owner: string): Promise<string[]> {
    return this.schedule(async () => {
      const rows = await all<{ session_id: string }>(
        this.db,
        "SELECT session_id FROM resolved_sessions WHERE owner = ?",
        [owner],
      );
      return rows.map((row) => row.session_id);
    });
  }

  ownedSessionIdsExcept(owner: string): Promise<Set<string>> {
    return this.schedule(async () => {
      const rows = await all<{ session_id: string }>(
        this.db,
        "SELECT session_id FROM session_ownership WHERE owner != ?",
        [owner],
      );
      return new Set(rows.map((row) => row.session_id));
    });
  }

  getCoverage(source: string): Promise<SourceCoverageRow | undefined> {
    return this.schedule(async () => {
      const row = await get<{
        source: string;
        files_digest: string | null;
        last_sync_at_ms: number | null;
        session_count: number;
      }>(
        this.db,
        "SELECT source, files_digest, last_sync_at_ms, session_count FROM source_coverage WHERE source = ?",
        [source],
      );
      if (!row) return undefined;
      return {
        source: row.source,
        filesDigest: row.files_digest,
        lastSyncAtMs: row.last_sync_at_ms,
        sessionCount: row.session_count,
      };
    });
  }

  setCoverage(source: string, filesDigest: string | null, sessionCount: number): Promise<void> {
    return this.schedule(async () => {
      await run(
        this.db,
        `INSERT INTO source_coverage(source, files_digest, last_sync_at_ms, session_count)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET
           files_digest = excluded.files_digest,
           last_sync_at_ms = excluded.last_sync_at_ms,
           session_count = excluded.session_count`,
        [source, filesDigest, this.now(), sessionCount],
      );
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.queue
      .then(async () => {
        await closeDatabase(this.db);
        secureSqliteFiles(this.path);
      })
      .catch((error) => {
        throw asStoreError(error, this.path, this.busyTimeoutMs);
      });
    return this.closePromise;
  }
}

export async function openStore(
  options: OpenStoreOptions = {},
): Promise<SqliteStore> {
  const path = options.path ?? STORE_FILE;
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_STORE_BUSY_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) {
    throw new RangeError("busyTimeoutMs must be an integer between 0 and 60000");
  }

  try {
    prepareDatabaseFile(path);
  } catch (error) {
    throw asStoreError(error, path, busyTimeoutMs);
  }

  let db: Database | undefined;
  try {
    db = await openDatabase(path, busyTimeoutMs);
    await initializeDatabase(db, path);
    return new SqliteStore(db, path, busyTimeoutMs, now);
  } catch (error) {
    if (db) await closeDatabase(db).catch(() => undefined);
    // The store is a durable archive: open never silently rebuilds. Older owned schemas are migrated
    // in place (initializeDatabase); anything unmigratable/newer/corrupt propagates so retained data
    // is never destroyed without the user opting into `reindex --force`.
    throw asStoreError(error, path, busyTimeoutMs);
  }
}

function removeRegularStoreFile(path: string): void {
  const stat = ensureNotSymlink(path);
  if (!stat) return;
  if (!stat.isFile()) {
    throw new StoreError("unsafe_path", path, `Won't remove the store path because it isn't a regular file: ${path}`);
  }
  unlinkSync(path);
}

/**
 * Explicit destructive recovery path. Call only after every connection to this store is closed.
 */
export async function rebuildStore(
  options: OpenStoreOptions = {},
): Promise<SqliteStore> {
  const path = options.path ?? STORE_FILE;
  try {
    removeRegularStoreFile(`${path}-wal`);
    removeRegularStoreFile(`${path}-shm`);
    removeRegularStoreFile(path);
  } catch (error) {
    throw asStoreError(
      error,
      path,
      options.busyTimeoutMs ?? DEFAULT_STORE_BUSY_TIMEOUT_MS,
    );
  }
  return openStore(options);
}
