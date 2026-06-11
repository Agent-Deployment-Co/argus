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
  CacheFragment,
  CacheInvalidationReason,
  CachedFragmentMetadata,
  CompleteDiscovery,
  FragmentCache,
} from "./cache-contract.ts";
import type { AgentSource } from "./types.ts";
import { FRAGMENT_CACHE_FILE } from "./paths.ts";

export const CACHE_SCHEMA_VERSION = 2;
export const CACHE_APPLICATION_ID = 0x41524753; // "ARGS"
export const DEFAULT_CACHE_BUSY_TIMEOUT_MS = 2_000;

export type CacheStoreErrorCode =
  | "busy"
  | "corrupt"
  | "incompatible_schema"
  | "unsafe_path"
  | "io";

export class CacheStoreError extends Error {
  constructor(
    readonly code: CacheStoreErrorCode,
    readonly cachePath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CacheStoreError";
  }
}

export interface OpenFragmentCacheOptions {
  path?: string;
  busyTimeoutMs?: number;
  now?: () => number;
}

interface SqliteError extends Error {
  code?: string;
  errno?: number;
}

interface FragmentRow {
  fragment_json: string;
  id: string;
  kind: CacheFragment["kind"];
  contract_version: number;
}

interface MetadataRow {
  id: string;
  kind: CacheFragment["kind"];
  source: AgentSource | null;
  file_id: string | null;
  contract_version: number;
  parser_version: string | null;
  updated_at_ms: number;
  status: CachedFragmentMetadata["status"];
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
}

const CREATE_V1_SQL = `
  CREATE TABLE cache_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at_ms INTEGER NOT NULL
  );

  CREATE TABLE cache_fragments (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('transcript', 'auxiliary', 'external')),
    source TEXT CHECK (source IS NULL OR source IN ('claude', 'codex', 'gemini')),
    file_id TEXT,
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
    fragment_json TEXT NOT NULL,
    diagnostics_json TEXT NOT NULL,
    last_success_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );

  CREATE INDEX cache_fragments_source_root
    ON cache_fragments(source, root_id);
  CREATE INDEX cache_fragments_file_id
    ON cache_fragments(file_id);

  CREATE TABLE auxiliary_dependencies (
    fragment_id TEXT NOT NULL REFERENCES cache_fragments(id) ON DELETE CASCADE,
    input_id TEXT NOT NULL,
    selector TEXT NOT NULL,
    affects_json TEXT NOT NULL,
    PRIMARY KEY (fragment_id, input_id, selector)
  );
`;

const INSERT_FRAGMENT_SQL = `
  INSERT INTO cache_fragments (
    id, kind, source, file_id, root_id, role, relative_path, observed_path,
    size_bytes, mtime_ns, ctime_ns, physical_id_scheme, physical_id_value,
    contract_version, parser_name, parser_version, status, invalidation_reason,
    fragment_json, diagnostics_json, import_provenance_json,
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
    file_id = excluded.file_id,
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
    fragment_json = excluded.fragment_json,
    diagnostics_json = excluded.diagnostics_json,
    import_provenance_json = excluded.import_provenance_json,
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
    throw new CacheStoreError(
      "unsafe_path",
      path,
      `Refusing to use Argus cache path because it is a symbolic link: ${path}`,
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
    throw new CacheStoreError("unsafe_path", path, `Argus cache directory is not a directory: ${path}`);
  }
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function prepareDatabaseFile(path: string): void {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const stat = ensureNotSymlink(path);

  if (stat) {
    if (!stat.isFile()) {
      throw new CacheStoreError("unsafe_path", path, `Argus cache path is not a regular file: ${path}`);
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

function rebuildHint(path: string): string {
  return `Delete ${path} (and its -wal/-shm files) to rebuild the local Argus cache.`;
}

function asStoreError(
  error: unknown,
  path: string,
  busyTimeoutMs: number,
  fallbackCode: CacheStoreErrorCode = "io",
): CacheStoreError {
  if (error instanceof CacheStoreError) return error;
  const sqliteError = error as SqliteError;
  if (sqliteError?.code === "SQLITE_BUSY" || sqliteError?.code === "SQLITE_LOCKED") {
    return new CacheStoreError(
      "busy",
      path,
      `Argus cache remained locked for ${busyTimeoutMs}ms. Close other Argus processes and retry.`,
      { cause: error },
    );
  }
  if (sqliteError?.code === "SQLITE_CORRUPT" || sqliteError?.code === "SQLITE_NOTADB") {
    return new CacheStoreError(
      "corrupt",
      path,
      `Argus cache is corrupt or is not a SQLite database. ${rebuildHint(path)}`,
      { cause: error },
    );
  }
  const message = sqliteError?.message || String(error);
  return new CacheStoreError(fallbackCode, path, `Unable to use Argus cache at ${path}: ${message}`, {
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
  if (applicationId !== CACHE_APPLICATION_ID) {
    throw new CacheStoreError(
      "incompatible_schema",
      path,
      `Refusing to use ${path}: it is not an Argus-owned cache database. Choose another cache path.`,
    );
  }
  if (userVersion > CACHE_SCHEMA_VERSION) {
    throw new CacheStoreError(
      "incompatible_schema",
      path,
      `Argus cache schema ${userVersion} is newer than supported schema ${CACHE_SCHEMA_VERSION}. Upgrade Argus or use a different cache path.`,
    );
  }
  return userVersion;
}

async function migrate(db: Database, fromVersion: number, now: () => number): Promise<void> {
  for (let version = fromVersion + 1; version <= CACHE_SCHEMA_VERSION; version++) {
    await transaction(db, async () => {
      if (version === 1) {
        await exec(db, CREATE_V1_SQL);
        await run(
          db,
          "INSERT INTO cache_schema_migrations(version, applied_at_ms) VALUES (?, ?)",
          [version, now()],
        );
      } else if (version === 2) {
        await exec(
          db,
          "ALTER TABLE cache_fragments ADD COLUMN import_provenance_json TEXT",
        );
        await run(
          db,
          "INSERT INTO cache_schema_migrations(version, applied_at_ms) VALUES (?, ?)",
          [version, now()],
        );
      }
      await exec(db, `PRAGMA application_id = ${CACHE_APPLICATION_ID}`);
      await exec(db, `PRAGMA user_version = ${version}`);
    });
  }
}

async function initializeDatabase(
  db: Database,
  path: string,
  now: () => number,
): Promise<void> {
  await exec(db, "PRAGMA foreign_keys = ON");
  const currentVersion = await validateOwnership(db, path);

  const check = await get<QuickCheckRow>(db, "PRAGMA quick_check(1)");
  if (check?.quick_check !== "ok") {
    throw new CacheStoreError(
      "corrupt",
      path,
      `Argus cache failed SQLite integrity checks: ${check?.quick_check ?? "unknown error"}. ${rebuildHint(path)}`,
    );
  }

  try {
    await migrate(db, currentVersion, now);
  } catch (error) {
    if ((error as SqliteError).code !== "SQLITE_ERROR") throw error;
    throw new CacheStoreError(
      "incompatible_schema",
      path,
      `Argus cache schema ${currentVersion} cannot be migrated safely. ${rebuildHint(path)}`,
      { cause: error },
    );
  }
  await exec(db, "PRAGMA journal_mode = WAL");
  await exec(db, "PRAGMA synchronous = NORMAL");
  await exec(db, "PRAGMA wal_autocheckpoint = 1000");
  await exec(db, "PRAGMA trusted_schema = OFF");

  // Verify the expected current schema rather than trusting user_version alone.
  try {
    await get(db, "SELECT id, import_provenance_json FROM cache_fragments LIMIT 1");
  } catch (error) {
    if ((error as SqliteError).code !== "SQLITE_ERROR") throw error;
    throw new CacheStoreError(
      "incompatible_schema",
      path,
      `Argus cache claims schema ${CACHE_SCHEMA_VERSION} but is missing required storage fields. ${rebuildHint(path)}`,
      { cause: error },
    );
  }
  secureSqliteFiles(path);
}

function fragmentStorage(fragment: CacheFragment): FragmentStorage {
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
  };
}

function parseFragment(row: FragmentRow, path: string): CacheFragment {
  let value: unknown;
  try {
    value = JSON.parse(row.fragment_json);
  } catch (error) {
    throw new CacheStoreError(
      "corrupt",
      path,
      `Cached fragment ${row.id} contains invalid JSON. ${rebuildHint(path)}`,
      { cause: error },
    );
  }

  if (
    typeof value !== "object" ||
    value === null ||
    (value as { id?: unknown }).id !== row.id ||
    (value as { kind?: unknown }).kind !== row.kind ||
    (value as { contractVersion?: unknown }).contractVersion !== row.contract_version
  ) {
    throw new CacheStoreError(
      "corrupt",
      path,
      `Cached fragment ${row.id} does not match its storage metadata. ${rebuildHint(path)}`,
    );
  }
  return value as CacheFragment;
}

function invalidatedStatus(reason: CacheInvalidationReason): CachedFragmentMetadata["status"] {
  return reason === "file_changed" ? "unstable" : "failed";
}

export class SqliteFragmentCache implements FragmentCache {
  private queue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly db: Database,
    readonly path: string,
    private readonly busyTimeoutMs: number,
    private readonly now: () => number,
  ) {}

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closePromise) return Promise.reject(new Error("Argus cache is closed"));
    const result = this.queue.then(operation, operation).catch((error) => {
      throw asStoreError(error, this.path, this.busyTimeoutMs);
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  load(id: string): Promise<CacheFragment | undefined> {
    return this.schedule(async () => {
      const row = await get<FragmentRow>(
        this.db,
        `SELECT fragment_json, id, kind, contract_version
         FROM cache_fragments
         WHERE id = ? AND status = 'success'`,
        [id],
      );
      return row ? parseFragment(row, this.path) : undefined;
    });
  }

  list(source?: AgentSource): Promise<CachedFragmentMetadata[]> {
    return this.schedule(async () => {
      const rows = await all<MetadataRow>(
        this.db,
        `SELECT id, kind, source, file_id, contract_version, parser_version, updated_at_ms, status
         FROM cache_fragments
         ${source ? "WHERE source = ?" : ""}
         ORDER BY id`,
        source ? [source] : [],
      );
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        source: row.source ?? undefined,
        fileId: row.file_id ?? undefined,
        contractVersion: row.contract_version,
        parserVersion: row.parser_version ?? undefined,
        updatedAtMs: row.updated_at_ms,
        status: row.status,
      }));
    });
  }

  replace(fragment: CacheFragment): Promise<void> {
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
          JSON.stringify(fragment),
          storage.diagnosticsJson,
          storage.importProvenanceJson,
          timestamp,
          timestamp,
        ]);
        await run(this.db, "DELETE FROM auxiliary_dependencies WHERE fragment_id = ?", [
          fragment.id,
        ]);
        if (fragment.kind === "transcript") {
          for (const dependency of fragment.dependencies) {
            await run(
              this.db,
              `INSERT INTO auxiliary_dependencies(fragment_id, input_id, selector, affects_json)
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
        const rows = await all<{ id: string; file_id: string }>(
          this.db,
          `SELECT id, file_id
           FROM cache_fragments
           WHERE source = ? AND root_id = ? AND file_id IS NOT NULL`,
          [discovery.source, discovery.rootId],
        );
        for (const row of rows) {
          if (!observedFileIds.has(row.file_id)) {
            await run(this.db, "DELETE FROM cache_fragments WHERE id = ?", [row.id]);
          }
        }
      });
    });
  }

  invalidate(ids: string[], reason: CacheInvalidationReason): Promise<void> {
    return this.schedule(async () => {
      if (ids.length === 0) return;
      await transaction(this.db, async () => {
        for (const id of new Set(ids)) {
          await run(
            this.db,
            `UPDATE cache_fragments
             SET status = ?, invalidation_reason = ?, updated_at_ms = ?
             WHERE id = ?`,
            [invalidatedStatus(reason), reason, this.now(), id],
          );
        }
      });
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

export async function openFragmentCache(
  options: OpenFragmentCacheOptions = {},
): Promise<SqliteFragmentCache> {
  const path = options.path ?? FRAGMENT_CACHE_FILE;
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_CACHE_BUSY_TIMEOUT_MS;
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
    await initializeDatabase(db, path, now);
    return new SqliteFragmentCache(db, path, busyTimeoutMs, now);
  } catch (error) {
    if (db) await closeDatabase(db).catch(() => undefined);
    throw asStoreError(error, path, busyTimeoutMs);
  }
}

function removeRegularCacheFile(path: string): void {
  const stat = ensureNotSymlink(path);
  if (!stat) return;
  if (!stat.isFile()) {
    throw new CacheStoreError("unsafe_path", path, `Refusing to remove non-file cache path: ${path}`);
  }
  unlinkSync(path);
}

/**
 * Explicit destructive recovery path. Call only after every connection to this cache is closed.
 */
export async function rebuildFragmentCache(
  options: OpenFragmentCacheOptions = {},
): Promise<SqliteFragmentCache> {
  const path = options.path ?? FRAGMENT_CACHE_FILE;
  try {
    removeRegularCacheFile(`${path}-wal`);
    removeRegularCacheFile(`${path}-shm`);
    removeRegularCacheFile(path);
  } catch (error) {
    throw asStoreError(
      error,
      path,
      options.busyTimeoutMs ?? DEFAULT_CACHE_BUSY_TIMEOUT_MS,
    );
  }
  return openFragmentCache(options);
}
