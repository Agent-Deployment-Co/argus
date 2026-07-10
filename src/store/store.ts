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
import { Database, SQLiteError } from "bun:sqlite";
import { assignInteractionTaskSeqs } from "./store-contract.ts";
import type {
  AuxiliaryFact,
  StoredFragment,
  InvalidationReason,
  FragmentMetadata,
  ClientFingerprintEntry,
  CompleteDiscovery,
  HealthRollups,
  Store,
  TaskFact,
  AppliedLabel,
  LabelAppliedBy,
  LabelFilterMode,
  LabelOrigin,
  LabelRecord,
  LabelTarget,
  LabelTargetKind,
  SessionLabels,
  FileFingerprint,
  FileIdentity,
  FileRole,
  InteractionFact,
  InteractionTextChunk,
  MaterializeSession,
  ParsedAuxiliaryFragment,
  PhysicalFileIdentity,
  ReconstructedFragments,
  ResolvedQuery,
  SessionAggregate,
  SessionInvocation,
  SessionProvenance,
  SessionSearchMatch,
  SessionSearchQuery,
  SessionSearchResult,
  SessionSearchTextSource,
  SourceCoverageRow,
  StoreStats,
  TaskSeqInteraction,
  TranscriptIndex,
  UsageGroupRow,
} from "./store-contract.ts";
import type {
  AgentSource,
  FrictionTotals,
  MessageRecord,
  ParseResult,
  SessionFriction,
  SessionMeta,
  ToolResultStat,
  Usage,
} from "../types.ts";
import type { ToolCategory } from "../tool-categories.ts";
import {
  emptyFrictionTotals,
  foldFriction,
  HIGH_TOKEN_GROWTH_RATIO,
} from "../health.ts";
import { STORE_FILE } from "../paths.ts";

export const STORE_SCHEMA_VERSION = 23;
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

export type LabelErrorCode =
  | "empty_name"
  | "name_conflict"
  | "not_found"
  | "invalid_target";

/** A label write couldn't be applied for a caller-fixable reason (bad name, duplicate, missing label).
 *  Thrown by the label store methods so the API layer can map each code to an HTTP status (e.g.
 *  name_conflict -> 409). Distinct from StoreError, which is reserved for store-integrity failures. */
export class LabelError extends Error {
  constructor(
    readonly code: LabelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LabelError";
  }
}

/** Row shape for the labels table, shared by the label read methods. */
interface LabelDbRow {
  id: string;
  name: string;
  origin: string;
  created_at_ms: number;
  deleted_at_ms: number | null;
}

function labelRecordFromRow(row: LabelDbRow): LabelRecord {
  const record: LabelRecord = {
    id: row.id,
    name: row.name,
    origin: row.origin as LabelOrigin,
    createdAtMs: row.created_at_ms,
  };
  if (row.deleted_at_ms != null) record.deletedAtMs = row.deleted_at_ms;
  return record;
}

function normalizedLabelTarget(target: LabelTarget): {
  targetKind: LabelTargetKind;
  taskSeq: number | null;
} {
  if (target.taskSeq == null) return { targetKind: "session", taskSeq: null };
  if (!Number.isSafeInteger(target.taskSeq) || target.taskSeq < 0) {
    throw new LabelError("invalid_target", "Invalid task position.");
  }
  return { targetKind: "task", taskSeq: target.taskSeq };
}

export interface OpenStoreOptions {
  path?: string;
  busyTimeoutMs?: number;
  now?: () => number;
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

interface TableColumnRow {
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

// Shared so a fresh schema (CREATE_SCHEMA_SQL) and the v10 -> v11 migration can't drift. Secondary
// indexes are intentionally NOT created here — no query reads these tables until #121 (the GROUP BY
// flip), which adds indexes tuned to its actual query shapes; until then they'd be pure write cost.
const RESOLVED_INTERACTIONS_DDL = `
  CREATE TABLE resolved_interactions (
    session_id TEXT NOT NULL REFERENCES resolved_sessions(session_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    source TEXT NOT NULL,
    ts INTEGER,
    initiator TEXT NOT NULL,
    disposition TEXT NOT NULL,
    compaction_count INTEGER NOT NULL DEFAULT 0,
    -- The task (chapter) this interaction falls under, as resolved_tasks.seq in the same session (#122).
    -- NULL = unattributed (no task extracted, or the interaction precedes the first task). Task membership
    -- lives ONLY here; the leaf tables (resolved_usage/resolved_invocations) carry no task pointer —
    -- task-grain rollups join usage/invocation -> interaction (interaction_seq) -> task (task_seq).
    task_seq INTEGER,
    interaction_json TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );`;
// Indexes the task<->interaction join (readSessionTaskMessages, messagesWithTask) rides. Shared by
// CREATE_SCHEMA_SQL and the v12 -> v13 migration.
const RESOLVED_INTERACTIONS_INDEXES = `
  CREATE INDEX resolved_interactions_task ON resolved_interactions(session_id, task_seq);`;
const RESOLVED_INVOCATIONS_DDL = `
  CREATE TABLE resolved_invocations (
    session_id TEXT NOT NULL REFERENCES resolved_sessions(session_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    source TEXT NOT NULL,
    interaction_seq INTEGER,
    tool TEXT NOT NULL,
    category TEXT NOT NULL,
    mcp_server TEXT,
    mcp_tool TEXT,
    skill TEXT,
    file_path TEXT,
    -- The owning message's local date (YYYY-MM-DD) and cwd, denormalized so per-tool breakdowns window
    -- by the since/until + project filters EXACTLY like the usage breakdowns (per-row, not session-level
    -- cwd — there is no usage<->invocation link to join on). NULL only if a migrated row's owning
    -- message couldn't be re-derived (shouldn't happen: invocation rows are 1:1 with record_json toolUses).
    date TEXT,
    cwd TEXT,
    -- For Skill/activate_skill calls: the (truncated) args sample, so skillInvocations.sampleArgs is a
    -- SQL read (it's tool-call metadata already on the ToolUse, not conversation text).
    args TEXT,
    -- The result half of the call+result unit (#130): approx token weight of this call's paired tool
    -- result(s), summed. resolved_tool_results (the old per-name aggregate) is retired; per-tool
    -- result-size GROUP BYs (byTool/heaviestToolResults) read this column. 0 when no result resolved.
    approx_result_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, seq)
  );`;
// Secondary indexes for the snapshot's whole-store GROUP BY/JOIN scans (#121): grouping by tool and
// filtering by date are the hot paths; mcp_server/skill are partial since most rows have neither.
// (session_id scans ride the PK.) Shared by CREATE_SCHEMA_SQL and the v11 -> v12 migration.
const RESOLVED_INVOCATIONS_INDEXES = `
  CREATE INDEX resolved_invocations_tool ON resolved_invocations(tool);
  CREATE INDEX resolved_invocations_date ON resolved_invocations(date);
  CREATE INDEX resolved_invocations_mcp_server ON resolved_invocations(mcp_server) WHERE mcp_server IS NOT NULL;
  CREATE INDEX resolved_invocations_skill ON resolved_invocations(skill) WHERE skill IS NOT NULL;`;

// Opt-in (default-on) local retention of conversation text (#120). Kept in its OWN table, never in
// resolved_interactions.interaction_json, so the push path (which reads only interaction_json) is
// text-free by construction — "never synced" is structural, not a strip step. Plaintext: privacy
// rests on the never-synced guarantee + OS disk encryption, keeping a future session-search feature
// open. CASCADE clears it when the session is re-materialized or retention is turned off.
//
// Tall, mirroring resolved_usage/resolved_invocations: one row per text chunk, `seq` is this table's
// own per-session ordinal in timeline order (the chunk order), `interaction_seq` is the soft link to
// the owning interaction, and `type` names the chunk's role (a controlled vocabulary stored as plain
// TEXT — like invocations.category — so adding kinds like 'narration' is additive, no schema change).
// The dialogue projection a reader rebuilds is `ORDER BY seq` (whole session) or filtered by
// `interaction_seq` (one interaction). Shared so CREATE_SCHEMA_SQL and the v17 -> v18 migration can't drift.
const RESOLVED_INTERACTION_TEXT_DDL = `
  CREATE TABLE resolved_interaction_text (
    session_id TEXT NOT NULL REFERENCES resolved_sessions(session_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    interaction_seq INTEGER,
    type TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );`;

// Full-text search over retained conversation text (#155). A PLAIN (not external-content) FTS5 table:
// external-content-table triggers were the original design, but this store deliberately runs with
// `PRAGMA trusted_schema = OFF` (hardening against a tampered db file), and SQLite categorically
// disallows virtual tables from being touched by triggers/views when trusted_schema is off — verified
// against bun:sqlite; there's no per-vtable "innocuous" override for this. So the FTS index is
// maintained by ordinary top-level DML at the same call sites that already do the wholesale
// DELETE-then-INSERT of resolved_interaction_text (materialize), not by triggers. `session_id` is
// duplicated onto the FTS row (UNINDEXED — not tokenized, just carried through) so a match can be
// grouped by session without a join back to the base table.
const RESOLVED_INTERACTION_TEXT_FTS_DDL = `
  CREATE VIRTUAL TABLE resolved_interaction_text_fts USING fts5(
    session_id UNINDEXED, text
  );`;

// Full-text search over task-interpretation text (#155). Same plain-FTS5-table approach as
// resolved_interaction_text_fts above (see its comment for why triggers aren't used). task_json is
// opaque JSON with no queryable text column, so the indexed text is derived at write time from
// description + outcomeReason + signals[] — deliberately excluding .evidence, which holds
// interaction-index bookkeeping ("interactions: 1, 2"), not prose (see SEARCH_DOC.md). Maintained by
// writeSessionTasks, which is also wholesale DELETE-then-INSERT. RESOLVED_TASKS_FTS_TEXT_EXPR is used
// only by the migration backfill (a plain SQL INSERT...SELECT, unaffected by trusted_schema since it's
// not run from a trigger); writeSessionTasks derives the same text in JS from the TaskFact it already
// has, not by re-deriving it in SQL.
const RESOLVED_TASKS_FTS_TEXT_EXPR = `
    COALESCE(json_extract(%ALIAS%.task_json, '$.description'), '') || ' ' ||
    COALESCE(json_extract(%ALIAS%.task_json, '$.outcomeReason'), '') || ' ' ||
    COALESCE((SELECT group_concat(value, ' ') FROM json_each(%ALIAS%.task_json, '$.signals')), '')`;
const RESOLVED_TASKS_FTS_DDL = `
  CREATE VIRTUAL TABLE resolved_tasks_fts USING fts5(
    session_id UNINDEXED, text
  );`;

// Full-text search over the model-generated session title + summary (#234). Same plain-FTS5-table
// shape as resolved_interaction_text_fts above (see its comment on why triggers aren't used); the
// indexed text is `title || ' ' || summary`. One row per session. Maintained by writeSessionTasks (the
// sole writer of those columns) and carried forward by materialize's wholesale session replace, both
// via ordinary DELETE-then-INSERT DML — folded into the same v20 -> v21 migration that adds the columns
// (no backfill: the columns are brand-new at that point, so there is no existing title/summary to index).
const RESOLVED_SESSIONS_FTS_DDL = `
  CREATE VIRTUAL TABLE resolved_sessions_fts USING fts5(
    session_id UNINDEXED, text
  );`;

/** The indexed text for a session's title/summary FTS row (#234): the two model fields joined. Empty
 *  when both are null → the caller writes no row, so un-interpreted / title-less sessions stay out of
 *  the index. Shared by the two maintenance sites (writeSessionTasks, materialize). */
function sessionFtsText(title: string | null, summary: string | null): string {
  return [title ?? "", summary ?? ""].join(" ").trim();
}

// Partial index on file_path (#155). The file: search term matches with
// instr(lower(file_path), lower(?)) — a substring test the SQLite planner can't satisfy from a
// b-tree index, so that query is a full scan of resolved_invocations regardless of this index
// (verified via EXPLAIN QUERY PLAN). Accepted: file_path substring search is a full scan today.
const RESOLVED_INVOCATIONS_FILE_PATH_INDEX = `
  CREATE INDEX resolved_invocations_file_path ON resolved_invocations(file_path) WHERE file_path IS NOT NULL;`;

// User- and system-generated labels for sessions and tasks (session-and-task-labels feature).
// Local-only: never SELECTed by push.ts, so labels stay off the sync wire by construction (the same
// "never synced" guarantee resolved_interaction_text gets). Two tables:
//   labels            — the label definitions. origin distinguishes user- vs system-created labels;
//                       deleted_at_ms is a soft delete so a name can be retired and later reused.
//   label_assignments — the many-to-many application of a label to a session OR one of its tasks.
// label_assignments deliberately has NO foreign key to resolved_sessions: materialize wholesale
// DELETEs + FK-CASCADEs a session's resolved_* rows on every re-index of a changed session, and
// user-authored labels must survive that. session_id is a plain text column here; assignments are
// removed only on genuine session deletion (retractSessions), mirroring session_ownership.
// task_seq is the task's position in the session (resolved_tasks.seq / interactions.task_seq); it is
// NULL for session-level labels. Tasks are re-derived on re-interpretation, so a task label is
// anchored to a position and may drift if segmentation changes — an accepted v1 limitation.
// Shared so CREATE_SCHEMA_SQL and the v20 -> v21 migration can't drift.
const LABELS_DDL = `
  CREATE TABLE IF NOT EXISTS labels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('user', 'system')),
    created_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER
  );
  -- Global, case-insensitive uniqueness among ACTIVE (non-deleted) labels only.
  CREATE UNIQUE INDEX IF NOT EXISTS labels_name_active
    ON labels(name COLLATE NOCASE) WHERE deleted_at_ms IS NULL;

  CREATE TABLE IF NOT EXISTS label_assignments (
    label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('session', 'task')),
    session_id TEXT NOT NULL,
    task_seq INTEGER,
    applied_by TEXT NOT NULL CHECK (applied_by IN ('user', 'system')),
    applied_at_ms INTEGER NOT NULL,
    CHECK (
      (target_kind = 'session' AND task_seq IS NULL) OR
      (target_kind = 'task' AND task_seq IS NOT NULL AND typeof(task_seq) = 'integer' AND task_seq >= 0)
    )
  );
  -- Dedup an application. COALESCE(task_seq, -1) so session-level rows (NULL task_seq) dedup
  -- correctly (SQLite treats NULLs as distinct in a plain unique index).
  CREATE UNIQUE INDEX IF NOT EXISTS label_assignments_unique
    ON label_assignments(label_id, session_id, COALESCE(task_seq, -1));
  CREATE INDEX IF NOT EXISTS label_assignments_session ON label_assignments(session_id);
  CREATE INDEX IF NOT EXISTS label_assignments_label ON label_assignments(label_id);`;

const CREATE_SCHEMA_SQL = `
  CREATE TABLE index_files (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('transcript', 'auxiliary', 'external')),
    source TEXT CHECK (source IS NULL OR source IN ('claude', 'codex', 'gemini', 'cowork', 'claude-chat')),
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
    -- Hidden sessions (local-only UI state, never pushed by sync): excluded from the sessions list
    -- and search via buildSessionFilterConds, but their usage still counts in aggregate rollups since
    -- those read directly from resolved_usage/resolved_invocations and never join this column.
    is_hidden INTEGER NOT NULL DEFAULT 0,
    -- Friction signals (#38) promoted out of meta_json so the snapshot's friction/outcome rollups are
    -- SQL SUM/GROUP BY instead of parsing every session's metadata per request (#121). NULL means
    -- friction is not observable for the source (codex/gemini) — the rollups only count non-NULL rows.
    -- friction_turns is rawTurns when known, else the friction turn count. meta_json stays authoritative.
    friction_interruptions INTEGER,
    friction_rejections INTEGER,
    friction_compactions INTEGER,
    friction_turns INTEGER,
    last_interruption_ms INTEGER,
    -- Interpretation state (#153). These are owned by the Interpret stage, not by structural indexing:
    -- materialize only ever sets content_indexed_at_ms (and only when message content actually changed);
    -- interpreted_at_ms / interpretation_version are written solely by writeSessionTasks. A session is
    -- eligible for (re)interpretation iff content_indexed_at_ms > COALESCE(interpreted_at_ms, 0) — the
    -- same comparison is the "outdated" signal (interpreted once, then content changed). The version is
    -- the interpreter's own implementation version (provenance); it is DELIBERATELY NOT part of the
    -- eligibility test, so bumping the interpreter never re-triggers the background drain.
    content_indexed_at_ms INTEGER,
    interpreted_at_ms INTEGER,
    interpretation_version TEXT,
    -- Model-generated title + summary (#234), written by writeSessionTasks alongside the interpretation
    -- stamp (interpretation-owned, carried forward by materialize). NULL until a session is interpreted;
    -- the read paths fall back to the first prompt / heuristic summary. Local-only, never on the wire.
    title TEXT,
    summary TEXT,
    meta_json TEXT NOT NULL
  );
  CREATE INDEX resolved_sessions_project ON resolved_sessions(project);
  CREATE INDEX resolved_sessions_last_ts ON resolved_sessions(last_ts);
  CREATE INDEX resolved_sessions_source ON resolved_sessions(source);
  CREATE INDEX resolved_sessions_archived ON resolved_sessions(archived);
  CREATE INDEX resolved_sessions_is_hidden ON resolved_sessions(is_hidden);
  -- Steady-state eligibility scan (#153): when nothing is pending this index is empty, so the
  -- newest-first drain query stays cheap regardless of how many sessions are interpreted.
  CREATE INDEX resolved_sessions_interpret_pending
    ON resolved_sessions(last_ts DESC)
    WHERE content_indexed_at_ms > COALESCE(interpreted_at_ms, 0);

  CREATE TABLE resolved_usage (
    session_id TEXT NOT NULL REFERENCES resolved_sessions(session_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    source TEXT NOT NULL,
    ts INTEGER NOT NULL,
    date TEXT NOT NULL,
    cwd TEXT NOT NULL,
    project TEXT NOT NULL,
    record_json TEXT NOT NULL,
    -- Usage/model promoted out of record_json so token & cost breakdowns can be done in SQL
    -- (GROUP BY) instead of re-walking every message in JS. record_json stays authoritative;
    -- these mirror message.usage.* / message.model / message.attributionSkill. Cost is NOT stored
    -- (it's priced in JS, per-model, from these sums — pricing is linear so SUM-then-price is exact).
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read INTEGER,
    cache_write_5m INTEGER,
    cache_write_1h INTEGER,
    model TEXT,
    attribution_skill TEXT,
    -- Assistant stop_reason promoted out of record_json so the outcome proxy reads the last non-null
    -- value in SQL instead of json_extract'ing every windowed row per dashboard-view request (#121).
    stop_reason TEXT,
    -- The interaction (#117) this usage row falls under, as resolved_interactions.seq in the same
    -- session (#122). NULL only for a turn that precedes the session's first opening prompt, or for a
    -- row materialized before #122 / migrated and not yet re-indexed. Task grain joins through here.
    interaction_seq INTEGER,
    PRIMARY KEY (session_id, seq)
  );
  CREATE INDEX resolved_usage_date ON resolved_usage(date);
  CREATE INDEX resolved_usage_ts ON resolved_usage(ts);
  CREATE INDEX resolved_usage_source ON resolved_usage(source);
  CREATE INDEX resolved_usage_date_model ON resolved_usage(date, model);

  -- The interaction spine (#117): one row per interaction (prompt -> loop -> response). Promoted
  -- initiator/disposition columns back the friction/outcome GROUP BY (#121); interaction_json keeps
  -- the full fact (incl. prompt/response slot positions) for detail reads. interaction_json is always
  -- text-free; opt-in retained conversation text lives in resolved_interaction_text (#120).
  ${RESOLVED_INTERACTIONS_DDL}
  ${RESOLVED_INTERACTIONS_INDEXES}

  -- Opt-in (default-on) local prompt/response text retention (#120). Local-only; never synced.
  ${RESOLVED_INTERACTION_TEXT_DDL}

  -- Full-text search over retained conversation text (#155). Local-only; never synced.
  ${RESOLVED_INTERACTION_TEXT_FTS_DDL}

  -- Per-tool-use rows (#113 Part B): so byTool / byToolCategory / byMcpServer / skillInvocations
  -- become GROUP BY queries instead of re-walking record_json.toolUses in JS (the flip is #121).
  ${RESOLVED_INVOCATIONS_DDL}
  ${RESOLVED_INVOCATIONS_INDEXES}
  ${RESOLVED_INVOCATIONS_FILE_PATH_INDEX}

  CREATE TABLE resolved_tasks (
    session_id TEXT NOT NULL REFERENCES resolved_sessions(session_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    source TEXT NOT NULL,
    ts INTEGER,
    task_json TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  CREATE INDEX resolved_tasks_source ON resolved_tasks(source);
  CREATE INDEX resolved_tasks_ts ON resolved_tasks(ts);

  -- Full-text search over task-interpretation text (#155). Local-only; never synced.
  ${RESOLVED_TASKS_FTS_DDL}

  -- Full-text search over the model-generated session title + summary (#234). Local-only; never synced.
  ${RESOLVED_SESSIONS_FTS_DDL}

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

  -- Single-row key/value bag for store-wide metadata (e.g. the per-install client_id).
  -- Intentionally generic so future scalars don't each need their own table + migration.
  CREATE TABLE store_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Append-only log of client-fingerprint observations (#141 follow-up). Each row is one (key,
  -- value, ts) tuple; a repeat write of the same value for a key is suppressed in the writer so
  -- only changes accumulate. Used later to register clients with the dashboard backend.
  CREATE TABLE client_fingerprint (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    ts_ms INTEGER NOT NULL,
    PRIMARY KEY (key, ts_ms)
  );

  -- Per-Hub upload cursors. A row means this client got a successful response from that Hub after
  -- sending the session at the recorded local last_ts / content_digest / parser_version.
  CREATE TABLE hub_session_cursors (
    hub_url TEXT NOT NULL,
    client_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    last_ts INTEGER,
    content_digest TEXT,
    parser_version INTEGER,
    uploaded_at_ms INTEGER NOT NULL,
    PRIMARY KEY (hub_url, client_id, session_id)
  );
  CREATE INDEX hub_session_cursors_hub_uploaded
    ON hub_session_cursors(hub_url, client_id, uploaded_at_ms);

  -- Session/task labels (local-only; see LABELS_DDL).
  ${LABELS_DDL}
`;

/** Fact tables in the order their rows are cleared when a fragment is re-materialized. */
const INDEX_TABLES = [
  "index_sessions",
  "index_relationships",
  "index_auxiliary",
] as const;

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

function run(db: Database, sql: string, params: unknown[] = []) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.query(sql).run(...(params as any[]));
}

function exec(db: Database, sql: string): void {
  db.run(sql);
}

function get<T>(
  db: Database,
  sql: string,
  params: unknown[] = [],
): T | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (
    (db.query<T, any[]>(sql).get(...(params as any[])) as T | null) ?? undefined
  );
}

function all<T>(db: Database, sql: string, params: unknown[] = []): T[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.query<T, any[]>(sql).all(...(params as any[]));
}

function closeDatabase(db: Database): void {
  db.close();
}

/** Stay well under sqlite3's default bound-parameter limit (999) when batching. */
const MAX_BOUND_PARAMS = 900;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** Shared session-filter conditions for `readSessionAggregates` and `searchSessions` (#155): archived
 *  status, source, project (cwd substring), and date window (a session is included if it has a message
 *  in range, via EXISTS over resolved_usage — not a per-message window). Callers append their own
 *  additional conditions (sessionIds, file:, freeform text) to the returned conds/params. */
function buildSessionFilterConds(
  query:
    | Pick<
        ResolvedQuery,
        "sources" | "projectSubstring" | "since" | "until" | "includeHidden"
      >
    | undefined,
): { conds: string[]; params: unknown[] } {
  const conds: string[] = ["s.archived = 0"];
  if (!query?.includeHidden) conds.push("s.is_hidden = 0");
  const params: unknown[] = [];
  if (query?.sources?.length) {
    conds.push(`s.source IN (${query.sources.map(() => "?").join(", ")})`);
    params.push(...query.sources);
  }
  if (query?.projectSubstring) {
    conds.push("instr(s.cwd, ?) > 0");
    params.push(query.projectSubstring);
  }
  const dateConds: string[] = [];
  const dateParams: unknown[] = [];
  if (query?.since) {
    dateConds.push("m.date >= ?");
    dateParams.push(query.since);
  }
  if (query?.until) {
    dateConds.push("m.date <= ?");
    dateParams.push(query.until);
  }
  if (dateConds.length) {
    conds.push(
      `EXISTS (SELECT 1 FROM resolved_usage m WHERE m.session_id = s.session_id AND ${dateConds.join(" AND ")})`,
    );
    params.push(...dateParams);
  }
  return { conds, params };
}

/** Escape freeform user input into a valid FTS5 MATCH query (#155): split on whitespace, wrap each
 *  token in double quotes (escaping embedded `"` as `""`), join with spaces for an implicit AND of
 *  quoted tokens. Avoids syntax errors from FTS5 operators in the raw text (`-`, `*`, `:`, …) and
 *  gives plain word/phrase matching instead. */
function toFtsMatchQuery(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" ");
}

// The single definition of "eligible for (re)interpretation" (#153), shared by the drain's session
// query and the `argus status` counts so "waiting" can never silently desync from what the drain
// actually processes. Eligible = content indexed more recently than last interpreted (interpreted_at_ms
// NULL → 0, so never-interpreted qualifies) AND a human-authored opening prompt whose text was retained
// exists (no retained text → nothing to interpret from, which also subsumes the retain-text gate).
// interpretation_version is deliberately NOT consulted: a version bump must not re-trigger the drain —
// only a content change or an explicit refresh does. Assumes the table is aliased `s`.
const INTERPRETATION_ELIGIBLE_SQL = `s.content_indexed_at_ms > COALESCE(s.interpreted_at_ms, 0)
  AND EXISTS (
    SELECT 1 FROM resolved_interaction_text t
    JOIN resolved_interactions i ON i.session_id = t.session_id AND i.seq = t.interaction_seq
    WHERE t.session_id = s.session_id AND t.type = 'prompt' AND i.initiator = 'human'
  )`;

interface ResolvedSessionSnapshot {
  metaJson: string;
  messageJsons: string[];
  tasks: TaskFact[];
  // Interpretation state to carry across a re-materialize (#153). Materialize preserves tasks +
  // interpreted_at_ms + interpretation_version untouched (it owns none of them); content_indexed_at_ms
  // is carried only when the content is unchanged, and replaced with "now" when it changed.
  contentIndexedAtMs: number | null;
  interpretedAtMs: number | null;
  interpretationVersion: string | null;
  // Model title/summary (#234) — interpretation-owned like interpretedAtMs, so carried forward here.
  title: string | null;
  summary: string | null;
  // Hidden sessions (local-only UI state) — a user preference, not a disk-presence fact like
  // `archived`, so it must be carried forward across a re-materialize rather than reset.
  isHidden: boolean;
}

async function readResolvedSessionSnapshot(
  db: Database,
  sessionId: string,
): Promise<ResolvedSessionSnapshot | undefined> {
  const row = await get<{
    meta_json: string;
    content_indexed_at_ms: number | null;
    interpreted_at_ms: number | null;
    interpretation_version: string | null;
    title: string | null;
    summary: string | null;
    is_hidden: number;
  }>(
    db,
    "SELECT meta_json, content_indexed_at_ms, interpreted_at_ms, interpretation_version, title, summary, is_hidden FROM resolved_sessions WHERE session_id = ?",
    [sessionId],
  );
  if (!row) return undefined;
  const messageRows = await all<{ record_json: string }>(
    db,
    "SELECT record_json FROM resolved_usage WHERE session_id = ? ORDER BY seq",
    [sessionId],
  );
  const taskRows = await all<{ task_json: string }>(
    db,
    "SELECT task_json FROM resolved_tasks WHERE session_id = ? ORDER BY seq",
    [sessionId],
  );
  return {
    metaJson: row.meta_json,
    messageJsons: messageRows.map((message) => message.record_json),
    tasks: taskRows.map((task) => JSON.parse(task.task_json) as TaskFact),
    contentIndexedAtMs: row.content_indexed_at_ms,
    interpretedAtMs: row.interpreted_at_ms,
    interpretationVersion: row.interpretation_version,
    title: row.title,
    summary: row.summary,
    isHidden: row.is_hidden === 1,
  };
}

function materializedSessionMatchesSnapshot(
  session: MaterializeSession,
  snapshot: ResolvedSessionSnapshot,
): boolean {
  // Tool-result sizes live inside each message's toolUses now (#130), so the message comparison
  // already covers them — no separate tool-results check. This is purely a CONTENT (meta + messages)
  // comparison: it must NOT consult interpretation_version. Interpretation freshness is a separate
  // axis (content_indexed_at_ms vs interpreted_at_ms); a version bump alone is deliberately not a
  // content change and must never re-trigger materialize or the background drain (#153).
  return (
    snapshot.metaJson === JSON.stringify(session.meta) &&
    snapshot.messageJsons.length === session.messages.length &&
    snapshot.messageJsons.every(
      (json, index) => json === JSON.stringify(session.messages[index]),
    )
  );
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
  const rowsPerStatement = Math.max(
    1,
    Math.floor(MAX_BOUND_PARAMS / columns.length),
  );
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

function ensureNotSymlink(
  path: string,
): ReturnType<typeof lstatSync> | undefined {
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
    throw new StoreError(
      "unsafe_path",
      path,
      `The store folder isn't a directory: ${path}`,
    );
  }
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function prepareDatabaseFile(path: string): void {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const stat = ensureNotSymlink(path);

  if (stat) {
    if (!stat.isFile()) {
      throw new StoreError(
        "unsafe_path",
        path,
        `The store path isn't a regular file: ${path}`,
      );
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

function openDatabase(path: string, busyTimeoutMs: number): Database {
  const db = new Database(path, { create: true });
  db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  return db;
}

function rebuildHint(_path: string): string {
  return "Run `argus index rebuild` to rebuild the local store from your transcripts.";
}

function asStoreError(
  error: unknown,
  path: string,
  busyTimeoutMs: number,
  fallbackCode: StoreErrorCode = "io",
): StoreError | LabelError {
  if (error instanceof StoreError) return error;
  // Label writes throw LabelError for caller-fixable reasons (bad name, duplicate, missing label);
  // it's not a store-integrity failure, so pass it through for the API layer to map to an HTTP status.
  if (error instanceof LabelError) return error;
  if (error instanceof SQLiteError) {
    if (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED") {
      return new StoreError(
        "busy",
        path,
        `The local store is in use by another Argus command (waited ${busyTimeoutMs}ms). Close it and try again.`,
        { cause: error },
      );
    }
    if (error.code === "SQLITE_CORRUPT" || error.code === "SQLITE_NOTADB") {
      return new StoreError(
        "corrupt",
        path,
        `The local store is damaged or isn't a valid database. ${rebuildHint(path)}`,
        { cause: error },
      );
    }
  }
  const message = (error as Error)?.message || String(error);
  return new StoreError(
    fallbackCode,
    path,
    `Couldn't use the local store at ${path}: ${message}`,
    {
      cause: error,
    },
  );
}

async function transaction<T>(
  db: Database,
  operation: () => Promise<T>,
): Promise<T> {
  exec(db, "BEGIN IMMEDIATE");
  try {
    const value = await operation();
    exec(db, "COMMIT");
    return value;
  } catch (error) {
    try {
      exec(db, "ROLLBACK");
    } catch {}
    throw error;
  }
}

async function pragmaNumber(
  db: Database,
  name: "application_id" | "user_version",
): Promise<number> {
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
  // 6 -> 7: Task facts. Preserve retained sessions and add a side table populated on the next
  // materialization of each session.
  6: {
    to: 7,
    sql: `
      CREATE TABLE resolved_tasks (
        session_id TEXT NOT NULL REFERENCES resolved_sessions(session_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        source TEXT NOT NULL,
        ts INTEGER,
        task_json TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX resolved_tasks_source ON resolved_tasks(source);
      CREATE INDEX resolved_tasks_ts ON resolved_tasks(ts);
    `,
  },
  // 7 -> 8: fact→task attribution. Stamp each message with the task (chapter) it falls under.
  // Existing rows get NULL (unattributed) until their session is re-indexed with task extraction on.
  7: {
    to: 8,
    sql: `
      ALTER TABLE resolved_messages ADD COLUMN task_seq INTEGER;
      CREATE INDEX resolved_messages_task ON resolved_messages(session_id, task_seq);
    `,
  },
  // 8 -> 9: promote usage/model/skill out of record_json into real columns so token & cost
  // breakdowns can be computed in SQL (GROUP BY) instead of re-walking every message in JS.
  // Backfill existing rows directly from the JSON blob — no JS re-parse needed.
  8: {
    to: 9,
    sql: `
      ALTER TABLE resolved_messages ADD COLUMN input_tokens INTEGER;
      ALTER TABLE resolved_messages ADD COLUMN output_tokens INTEGER;
      ALTER TABLE resolved_messages ADD COLUMN cache_read INTEGER;
      ALTER TABLE resolved_messages ADD COLUMN cache_write_5m INTEGER;
      ALTER TABLE resolved_messages ADD COLUMN cache_write_1h INTEGER;
      ALTER TABLE resolved_messages ADD COLUMN model TEXT;
      ALTER TABLE resolved_messages ADD COLUMN attribution_skill TEXT;
      UPDATE resolved_messages SET
        input_tokens = json_extract(record_json, '$.usage.input'),
        output_tokens = json_extract(record_json, '$.usage.output'),
        cache_read = json_extract(record_json, '$.usage.cacheRead'),
        cache_write_5m = json_extract(record_json, '$.usage.cacheWrite5m'),
        cache_write_1h = json_extract(record_json, '$.usage.cacheWrite1h'),
        model = json_extract(record_json, '$.model'),
        attribution_skill = json_extract(record_json, '$.attributionSkill');
      CREATE INDEX resolved_messages_date_model ON resolved_messages(date, model);
    `,
  },
  // 9 -> 10: "message" is retired as a unit of meaning (#117); the per-assistant-turn usage table is
  // renamed resolved_messages -> resolved_usage. RENAME preserves all rows (incl. archived sessions);
  // indexes are re-created under the new name for consistency with a fresh schema.
  9: {
    to: 10,
    sql: `
      ALTER TABLE resolved_messages RENAME TO resolved_usage;
      DROP INDEX IF EXISTS resolved_messages_date;
      DROP INDEX IF EXISTS resolved_messages_ts;
      DROP INDEX IF EXISTS resolved_messages_source;
      DROP INDEX IF EXISTS resolved_messages_task;
      DROP INDEX IF EXISTS resolved_messages_date_model;
      CREATE INDEX resolved_usage_date ON resolved_usage(date);
      CREATE INDEX resolved_usage_ts ON resolved_usage(ts);
      CREATE INDEX resolved_usage_source ON resolved_usage(source);
      CREATE INDEX resolved_usage_task ON resolved_usage(session_id, task_seq);
      CREATE INDEX resolved_usage_date_model ON resolved_usage(date, model);
    `,
  },
  // 10 -> 11: first-class interactions + per-invocation rows (#117/#119). Add resolved_interactions
  // and resolved_invocations (+ resolved_usage.interaction_seq). Backfill invocations from the
  // existing record_json.toolUses arrays so the new GROUP BY views (#121) work on current stores
  // without a re-index; interactions backfill on the next index (they're reconcile-derived).
  10: {
    to: 11,
    // Both new-table DDLs are inlined at their v11 shape (NOT the shared constants) so this migration
    // keeps producing the v11 tables even as the shared constants evolve: v11 -> v12 adds the #130
    // invocation columns, v12 -> v13 adds resolved_interactions.task_seq (#122).
    sql: `
      ALTER TABLE resolved_usage ADD COLUMN interaction_seq INTEGER;
      CREATE TABLE resolved_interactions (
        session_id TEXT NOT NULL REFERENCES resolved_sessions(session_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        source TEXT NOT NULL,
        ts INTEGER,
        initiator TEXT NOT NULL,
        disposition TEXT NOT NULL,
        compaction_count INTEGER NOT NULL DEFAULT 0,
        interaction_json TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE resolved_invocations (
        session_id TEXT NOT NULL REFERENCES resolved_sessions(session_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        source TEXT NOT NULL,
        interaction_seq INTEGER,
        tool TEXT NOT NULL,
        category TEXT NOT NULL,
        mcp_server TEXT,
        mcp_tool TEXT,
        skill TEXT,
        file_path TEXT,
        PRIMARY KEY (session_id, seq)
      );

      INSERT INTO resolved_invocations
        (session_id, seq, source, tool, category, mcp_server, mcp_tool, skill, file_path)
      SELECT session_id,
             ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY msg_seq, item) - 1,
             source, tool, category, mcp_server, mcp_tool, skill, file_path
      FROM (
        SELECT m.session_id AS session_id, m.seq AS msg_seq, je.key AS item, m.source AS source,
               json_extract(je.value, '$.name') AS tool,
               json_extract(je.value, '$.category') AS category,
               json_extract(je.value, '$.mcpServer') AS mcp_server,
               json_extract(je.value, '$.mcpTool') AS mcp_tool,
               json_extract(je.value, '$.skill') AS skill,
               json_extract(je.value, '$.filePath') AS file_path
        FROM resolved_usage m, json_each(m.record_json, '$.toolUses') je
      );
    `,
  },
  // 11 -> 12: the tool invocation becomes the call+result unit (#130). resolved_invocations gains
  // approx_result_tokens (the result half) and an args sample; resolved_tool_results (the old per-name
  // result aggregate) is retired. Backfill each (session, tool) result-token total onto that tool's
  // first invocation row, so per-tool SUMs are preserved exactly; a tool name whose results never
  // matched a call row is dropped (the accepted orphan drift). args backfills on the next re-index
  // (it's a cosmetic sample); archived sessions keep NULL args.
  11: {
    to: 12,
    sql: `
      ALTER TABLE resolved_invocations ADD COLUMN date TEXT;
      ALTER TABLE resolved_invocations ADD COLUMN cwd TEXT;
      ALTER TABLE resolved_invocations ADD COLUMN args TEXT;
      ALTER TABLE resolved_invocations ADD COLUMN approx_result_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE resolved_usage ADD COLUMN stop_reason TEXT;
      -- Backfill each (session, tool) result-token total onto that tool's first invocation row, so a
      -- GROUP BY tool SUM reproduces the old per-name totals exactly. A tool whose results never matched
      -- a call row is dropped (accepted orphan drift). args is left NULL (cosmetic; re-index repopulates).
      UPDATE resolved_invocations
      SET approx_result_tokens = COALESCE((
        SELECT tr.approx_tokens FROM resolved_tool_results tr
        WHERE tr.session_id = resolved_invocations.session_id AND tr.name = resolved_invocations.tool
      ), 0)
      WHERE seq = (
        SELECT MIN(i2.seq) FROM resolved_invocations i2
        WHERE i2.session_id = resolved_invocations.session_id AND i2.tool = resolved_invocations.tool
      );
      DROP TABLE resolved_tool_results;
      -- Backfill the denormalized date + cwd by re-deriving each invocation's owning message. Build the
      -- flattened (session, inv_seq, date, cwd) map ONCE into an indexed temp table, then a single joined
      -- UPDATE — not a correlated subquery per invocation row (which re-derives the whole set each time,
      -- O(rows^2), and hangs the first post-upgrade run). inv_seq uses the SAME (session, msg_seq, item)
      -- order the v10 -> v11 backfill assigned invocation seqs with, so the mapping is exact (and matches
      -- app-materialized rows, which flatMap in that order). Invocation rows are 1:1 with record_json
      -- toolUses, so every row resolves — no NULL date is left to silently drop from date-filtered views.
      CREATE TEMP TABLE _inv_owner AS
        SELECT m.session_id AS sid,
               ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.seq, je.key) - 1 AS inv_seq,
               m.date AS date, m.cwd AS cwd
        FROM resolved_usage m, json_each(m.record_json, '$.toolUses') je;
      CREATE INDEX _inv_owner_idx ON _inv_owner(sid, inv_seq);
      UPDATE resolved_invocations
      SET date = (SELECT o.date FROM _inv_owner o WHERE o.sid = resolved_invocations.session_id AND o.inv_seq = resolved_invocations.seq),
          cwd = (SELECT o.cwd FROM _inv_owner o WHERE o.sid = resolved_invocations.session_id AND o.inv_seq = resolved_invocations.seq);
      DROP TABLE _inv_owner;
      -- Promote stop_reason out of record_json (one pass over usage rows) so the outcome proxy reads a
      -- column instead of json_extract'ing every windowed row per request.
      UPDATE resolved_usage SET stop_reason = json_extract(record_json, '$.stopReason');
      ${RESOLVED_INVOCATIONS_INDEXES}

      -- Promote friction signals out of meta_json so the snapshot's friction/outcome rollups are SQL,
      -- not a per-request parse of every session's metadata (#121). NULL when friction isn't observable.
      ALTER TABLE resolved_sessions ADD COLUMN friction_interruptions INTEGER;
      ALTER TABLE resolved_sessions ADD COLUMN friction_rejections INTEGER;
      ALTER TABLE resolved_sessions ADD COLUMN friction_compactions INTEGER;
      ALTER TABLE resolved_sessions ADD COLUMN friction_turns INTEGER;
      ALTER TABLE resolved_sessions ADD COLUMN last_interruption_ms INTEGER;
      UPDATE resolved_sessions SET
        friction_interruptions = json_extract(meta_json, '$.friction.interruptions'),
        friction_rejections = json_extract(meta_json, '$.friction.rejections'),
        friction_compactions = json_extract(meta_json, '$.friction.compactions'),
        friction_turns = CASE WHEN json_extract(meta_json, '$.friction') IS NOT NULL
          THEN COALESCE(json_extract(meta_json, '$.rawTurns'), json_extract(meta_json, '$.friction.turns')) END,
        last_interruption_ms = json_extract(meta_json, '$.friction.lastInterruptionMs');
    `,
  },
  // 12 -> 13: tasks span INTERACTIONS, not messages (#122). Task membership moves onto
  // resolved_interactions.task_seq (the leaf tables carry no task pointer); the pre-interaction
  // resolved_usage.task_seq (where messages pointed straight at a chapter, sliced by message seq) is
  // dropped. Existing task attribution can't be carried over — it lived on usage rows whose
  // interaction_seq is NULL until a re-index repopulates the interaction spine — so task_seq starts
  // NULL on every interaction and fills on the next index with task extraction (same "re-index for
  // reconcile-derived data" story as the v10 -> v11 interactions backfill). SQLite >= 3.35 (sqlite3 v6
  // bundles newer) supports DROP COLUMN.
  12: {
    to: 13,
    // The index DDL is inlined at its v13 shape (NOT the shared RESOLVED_INTERACTIONS_INDEXES constant)
    // so this migration keeps producing exactly the v13 index even as that constant evolves — the same
    // pinning the v10 -> v11 step uses for its table DDL, preventing a future index add/rename from
    // leaking into this step.
    sql: `
      ALTER TABLE resolved_interactions ADD COLUMN task_seq INTEGER;
      CREATE INDEX resolved_interactions_task ON resolved_interactions(session_id, task_seq);
      DROP INDEX IF EXISTS resolved_usage_task;
      ALTER TABLE resolved_usage DROP COLUMN task_seq;
    `,
  },
  // 14 -> 15: client-fingerprint observation log (#141 follow-up). Append-only (key, value, ts)
  // tuples used later to register a client. IF NOT EXISTS matches the v13 -> v14 step's pattern so
  // a fresh-then-downgraded test store doesn't collide with the schema's own copy of the table.
  14: {
    to: 15,
    sql: `
      CREATE TABLE IF NOT EXISTS client_fingerprint (
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        ts_ms INTEGER NOT NULL,
        PRIMARY KEY (key, ts_ms)
      );
    `,
  },
  // 13 -> 14: per-install client id (#141). Add a generic key/value bag for store-wide metadata;
  // the client_id row is lazily generated on first open via ensureClientIdRow(), so no backfill here.
  // IF NOT EXISTS is defensive: a store created at v14 and then downgraded for a migration test
  // already has this table, and a real v13 store never does.
  13: {
    to: 14,
    sql: `
      CREATE TABLE IF NOT EXISTS store_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  // 15 -> 16: two changes in one step (combined to resolve a prior duplicate-key collision in this map
  // that silently dropped the hub_session_cursors step on every JS engine that evaluated the object):
  //   a) claude-chat source (#94): recreate index_files with a CHECK constraint that includes 'claude-chat'.
  //      DROP TABLE doesn't fire ON DELETE CASCADE, so child-table rows survive.
  //   b) per-Hub client-side upload cursors (#142): create hub_session_cursors if not already present.
  //      IF NOT EXISTS ensures idempotency for any test or tooling that pre-creates the table.
  15: {
    to: 16,
    sql: `
      CREATE TABLE index_files_v16 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('transcript', 'auxiliary', 'external')),
        source TEXT CHECK (source IS NULL OR source IN ('claude', 'codex', 'gemini', 'cowork', 'claude-chat')),
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
      INSERT INTO index_files_v16 SELECT * FROM index_files;
      DROP TABLE index_files;
      ALTER TABLE index_files_v16 RENAME TO index_files;
      CREATE INDEX index_files_source_root ON index_files(source, root_id);
      CREATE INDEX index_files_identity ON index_files(file_identity);
      CREATE TABLE IF NOT EXISTS hub_session_cursors (
        hub_url TEXT NOT NULL,
        client_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_ts INTEGER,
        uploaded_at_ms INTEGER NOT NULL,
        PRIMARY KEY (hub_url, client_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS hub_session_cursors_hub_uploaded
        ON hub_session_cursors(hub_url, client_id, uploaded_at_ms);
    `,
  },
  // 16 -> 17: strengthen Hub upload cursors with content_digest and parser_version (#140 review fix).
  // These let the client detect reindexed data (new tasks, parser upgrades, archive-state flips)
  // that does not advance last_ts, so re-syncs pick up those changes without a manual --all.
  // Recreate-table pattern handles two cases:
  //   - Fresh v16 stores: have hub_session_cursors with 5 columns; rebuild with 7.
  //   - v15 stores that ran the old (buggy, claude-chat-only) 15->16 migration: hub_session_cursors
  //     may be absent; IF NOT EXISTS creates an empty table first, then the rebuild adds new columns.
  16: {
    to: 17,
    sql: `
      CREATE TABLE IF NOT EXISTS hub_session_cursors (
        hub_url TEXT NOT NULL,
        client_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_ts INTEGER,
        uploaded_at_ms INTEGER NOT NULL,
        PRIMARY KEY (hub_url, client_id, session_id)
      );
      CREATE TABLE hub_session_cursors_v17 (
        hub_url TEXT NOT NULL,
        client_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_ts INTEGER,
        content_digest TEXT,
        parser_version INTEGER,
        uploaded_at_ms INTEGER NOT NULL,
        PRIMARY KEY (hub_url, client_id, session_id)
      );
      INSERT OR IGNORE INTO hub_session_cursors_v17
        SELECT hub_url, client_id, session_id, last_ts, NULL, NULL, uploaded_at_ms
        FROM hub_session_cursors;
      DROP TABLE hub_session_cursors;
      ALTER TABLE hub_session_cursors_v17 RENAME TO hub_session_cursors;
      CREATE INDEX hub_session_cursors_hub_uploaded
        ON hub_session_cursors(hub_url, client_id, uploaded_at_ms);
    `,
  },
  // 17 -> 18: opt-in (default-on) local conversation-text retention (#120). Add an empty tall side
  // table (one row per text chunk; see RESOLVED_INTERACTION_TEXT_DDL); no backfill — text re-derives
  // on the next index from the transcripts still on disk. Kept separate from
  // resolved_interactions.interaction_json so the push path stays text-free by construction.
  17: {
    to: 18,
    sql: `
      CREATE TABLE IF NOT EXISTS resolved_interaction_text (
        session_id TEXT NOT NULL REFERENCES resolved_sessions(session_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        interaction_seq INTEGER,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `,
  },
  // 18 -> 19: decoupled, throttled Interpret (#153). Add per-session interpretation state to
  // resolved_sessions: content_indexed_at_ms (processing time, set by materialize only on real content
  // change), interpreted_at_ms + interpretation_version (written solely by writeSessionTasks). Backfill
  // content_indexed_at_ms to "now" so existing sessions read as freshly indexed and thus eligible
  // (interpreted_at_ms is NULL → never interpreted). The partial index keeps the eligibility scan cheap.
  18: {
    to: 19,
    sql: `
      ALTER TABLE resolved_sessions ADD COLUMN content_indexed_at_ms INTEGER;
      ALTER TABLE resolved_sessions ADD COLUMN interpreted_at_ms INTEGER;
      ALTER TABLE resolved_sessions ADD COLUMN interpretation_version TEXT;
      UPDATE resolved_sessions
        SET content_indexed_at_ms = strftime('%s', 'now') * 1000
        WHERE content_indexed_at_ms IS NULL;
      CREATE INDEX resolved_sessions_interpret_pending
        ON resolved_sessions(last_ts DESC)
        WHERE content_indexed_at_ms > COALESCE(interpreted_at_ms, 0);
    `,
  },
  // 19 -> 20: session search (#155). Two plain FTS5 indexes (conversation text, task text) plus a
  // plain partial index for file-path substring search. Backfill both FTS tables from existing rows so
  // `argus index rebuild` is not required for existing users; going forward materialize/writeSessionTasks
  // maintain them directly (no triggers — see RESOLVED_INTERACTION_TEXT_FTS_DDL's comment for why).
  19: {
    to: 20,
    sql: `
      ${RESOLVED_INTERACTION_TEXT_FTS_DDL}
      INSERT INTO resolved_interaction_text_fts(session_id, text)
        SELECT session_id, text FROM resolved_interaction_text;

      ${RESOLVED_TASKS_FTS_DDL}
      INSERT INTO resolved_tasks_fts(session_id, text)
        SELECT session_id, ${RESOLVED_TASKS_FTS_TEXT_EXPR.replaceAll("%ALIAS%", "resolved_tasks")}
        FROM resolved_tasks;

      ${RESOLVED_INVOCATIONS_FILE_PATH_INDEX}
    `,
  },
  // 20 -> 21: session interpretation 2.0 (#234). Add the model-generated title + summary columns to
  // resolved_sessions, written by writeSessionTasks alongside the interpretation stamp. NULL until a
  // session is (re)interpreted; the read paths fall back to first prompt / heuristic summary. Also
  // create the title/summary FTS index (#234) so search covers interpretation text — no backfill, since
  // the columns are brand-new here (nothing to index); it fills as sessions get interpreted.
  20: {
    to: 21,
    sql: `
      ALTER TABLE resolved_sessions ADD COLUMN title TEXT;
      ALTER TABLE resolved_sessions ADD COLUMN summary TEXT;
      ${RESOLVED_SESSIONS_FTS_DDL}
    `,
  },
  // 21 -> 22: session/task labels (session-and-task-labels feature). Two new local-only tables; no
  // backfill (labels start empty). See LABELS_DDL for the model and why label_assignments has no FK
  // to resolved_sessions.
  21: {
    to: 22,
    sql: LABELS_DDL,
  },
  // 22 -> 23: hidden sessions (local-only UI state). Add the `is_hidden` flag so a session can be
  // hidden from the list/search while its usage still counts in aggregate rollups.
  22: {
    to: 23,
    sql: `
      ALTER TABLE resolved_sessions ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS resolved_sessions_is_hidden ON resolved_sessions(is_hidden);
    `,
  },
};

/** Apply the migration chain from `fromVersion` up to STORE_SCHEMA_VERSION, or throw if none exists. */
async function migrateSchema(
  db: Database,
  path: string,
  fromVersion: number,
): Promise<void> {
  let version = fromVersion;
  while (version !== STORE_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) {
      throw new StoreError(
        "incompatible_schema",
        path,
        `Argus can't upgrade the local store from this older version. ` +
          `Run \`argus index rebuild\` to rebuild it from your transcripts (this drops sessions no longer on disk).`,
      );
    }
    await transaction(db, async () => {
      await exec(db, step.sql);
      await exec(db, `PRAGMA user_version = ${step.to}`);
    });
    version = step.to;
  }
}

function tableExists(db: Database, name: string): boolean {
  return !!get<TableNameRow>(
    db,
    "SELECT name FROM sqlite_schema WHERE type IN ('table', 'virtual') AND name = ?",
    [name],
  );
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  return all<TableColumnRow>(db, `PRAGMA table_info(${table})`).some(
    (row) => row.name === column,
  );
}

async function repairKnownStampedSchemaGaps(
  db: Database,
  path: string,
): Promise<void> {
  try {
    const version = await pragmaNumber(db, "user_version");
    if (version < 21) return;

    const hasResolvedSessions = tableExists(db, "resolved_sessions");
    const needsSessionTitleRepair =
      hasResolvedSessions &&
      (!tableHasColumn(db, "resolved_sessions", "title") ||
        !tableHasColumn(db, "resolved_sessions", "summary") ||
        !tableExists(db, "resolved_sessions_fts"));
    const needsLabelsRepair =
      version >= 22 &&
      (!tableExists(db, "labels") || !tableExists(db, "label_assignments"));
    if (!needsSessionTitleRepair && !needsLabelsRepair) return;

    await transaction(db, async () => {
      if (needsSessionTitleRepair && tableExists(db, "resolved_sessions")) {
        if (!tableHasColumn(db, "resolved_sessions", "title")) {
          exec(db, "ALTER TABLE resolved_sessions ADD COLUMN title TEXT");
        }
        if (!tableHasColumn(db, "resolved_sessions", "summary")) {
          exec(db, "ALTER TABLE resolved_sessions ADD COLUMN summary TEXT");
        }
        if (!tableExists(db, "resolved_sessions_fts")) {
          exec(db, RESOLVED_SESSIONS_FTS_DDL);
          exec(
            db,
            `INSERT INTO resolved_sessions_fts(session_id, text)
             SELECT session_id, trim(COALESCE(title, '') || ' ' || COALESCE(summary, ''))
             FROM resolved_sessions
             WHERE trim(COALESCE(title, '') || ' ' || COALESCE(summary, '')) != ''`,
          );
        }
      }

      if (
        needsLabelsRepair &&
        (!tableExists(db, "labels") || !tableExists(db, "label_assignments"))
      ) {
        exec(db, LABELS_DDL);
      }
    });
  } catch (error) {
    if (!(error instanceof SQLiteError)) throw error;
    const c = error.code;
    if (
      c === "SQLITE_BUSY" ||
      c === "SQLITE_LOCKED" ||
      c === "SQLITE_CORRUPT" ||
      c === "SQLITE_NOTADB"
    )
      throw error;
    throw new StoreError(
      "incompatible_schema",
      path,
      `The local store is missing data Argus expects. ${rebuildHint(path)}`,
      { cause: error },
    );
  }
}

/**
 * Read the per-install client id, generating and persisting it the first time. The id is a stable
 * `client-<uuid>` string scoped to this argus.db; an INSERT OR IGNORE means a concurrent open won't
 * race two distinct ids in (only one row survives the unique key constraint).
 */
async function ensureClientIdRow(db: Database): Promise<string> {
  const existing = await get<{ value: string }>(
    db,
    "SELECT value FROM store_metadata WHERE key = 'client_id'",
  );
  if (existing) return existing.value;
  const id = `client-${crypto.randomUUID()}`;
  await run(
    db,
    "INSERT OR IGNORE INTO store_metadata (key, value) VALUES ('client_id', ?)",
    [id],
  );
  const row = await get<{ value: string }>(
    db,
    "SELECT value FROM store_metadata WHERE key = 'client_id'",
  );
  return row?.value ?? id;
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
  await repairKnownStampedSchemaGaps(db, path);

  await exec(db, "PRAGMA journal_mode = WAL");
  await exec(db, "PRAGMA synchronous = NORMAL");
  await exec(db, "PRAGMA wal_autocheckpoint = 1000");
  await exec(db, "PRAGMA trusted_schema = OFF");

  // Verify the expected schema rather than trusting user_version alone.
  try {
    await get(
      db,
      "SELECT id, import_provenance_json, envelope_json FROM index_files LIMIT 1",
    );
    await get(db, "SELECT file_id FROM index_sessions LIMIT 1");
    await get(
      db,
      "SELECT session_id, archived, title, summary FROM resolved_sessions LIMIT 1",
    );
    await get(
      db,
      "SELECT input_tokens, model, attribution_skill, interaction_seq FROM resolved_usage LIMIT 1",
    );
    await get(db, "SELECT session_id, task_json FROM resolved_tasks LIMIT 1");
    await get(
      db,
      "SELECT session_id, initiator, disposition, task_seq, interaction_json FROM resolved_interactions LIMIT 1",
    );
    await get(
      db,
      "SELECT session_id, seq, interaction_seq, type, text FROM resolved_interaction_text LIMIT 1",
    );
    await get(
      db,
      "SELECT session_id, text FROM resolved_interaction_text_fts WHERE resolved_interaction_text_fts MATCH 'x' LIMIT 1",
    );
    await get(
      db,
      "SELECT session_id, text FROM resolved_tasks_fts WHERE resolved_tasks_fts MATCH 'x' LIMIT 1",
    );
    await get(
      db,
      "SELECT session_id, text FROM resolved_sessions_fts WHERE resolved_sessions_fts MATCH 'x' LIMIT 1",
    );
    await get(
      db,
      "SELECT session_id, tool, category, file_path FROM resolved_invocations LIMIT 1",
    );
    await get(db, "SELECT source FROM source_coverage LIMIT 1");
    await get(db, "SELECT key, value FROM store_metadata LIMIT 1");
    await get(db, "SELECT key, value, ts_ms FROM client_fingerprint LIMIT 1");
    await get(
      db,
      "SELECT hub_url, client_id, session_id, last_ts, content_digest, parser_version FROM hub_session_cursors LIMIT 1",
    );
    await get(
      db,
      "SELECT id, name, origin, created_at_ms, deleted_at_ms FROM labels LIMIT 1",
    );
    await get(
      db,
      "SELECT label_id, target_kind, session_id, task_seq, applied_by, applied_at_ms FROM label_assignments LIMIT 1",
    );
  } catch (error) {
    if (!(error instanceof SQLiteError)) throw error;
    // Busy/corrupt errors propagate so asStoreError can classify them; anything else
    // (missing column, wrong table shape, etc.) is a schema mismatch.
    const c = error.code;
    if (
      c === "SQLITE_BUSY" ||
      c === "SQLITE_LOCKED" ||
      c === "SQLITE_CORRUPT" ||
      c === "SQLITE_NOTADB"
    )
      throw error;
    throw new StoreError(
      "incompatible_schema",
      path,
      `The local store is missing data Argus expects. ${rebuildHint(path)}`,
      { cause: error },
    );
  }
  secureSqliteFiles(path);
  // Ensure the per-install client id exists from the first successful open (#141), so callers
  // can rely on getClientId() without worrying about the bootstrap order.
  await ensureClientIdRow(db);
}

function fragmentStorage(fragment: StoredFragment): FragmentStorage {
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

/**
 * Explode a fragment's facts into the queryable `fact_*` rows (replacing any prior rows for this
 * fragment). Runs inside the same transaction as the fragment upsert. `seq` preserves array order
 * so reconstruction is byte-faithful (e.g. friction turn-duration ordering).
 */
async function materializeFactRows(
  db: Database,
  fragment: StoredFragment,
): Promise<void> {
  for (const table of INDEX_TABLES) {
    await run(db, `DELETE FROM ${table} WHERE file_id = ?`, [fragment.id]);
  }
  // All fragments are native now; 'external' is a retired origin kept in the column CHECK for
  // backward compatibility with stores written before AgentsView import was removed.
  const origin = "native";

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
        fact.kind === "session_first_prompt"
          ? fact.sourceSessionId
          : fact.selector,
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
    [
      "file_id",
      "seq",
      "origin",
      "source",
      "source_session_id",
      "kind",
      "transcript_path",
    ],
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
    [
      "file_id",
      "seq",
      "origin",
      "source",
      "child_source_session_id",
      "parent_source_session_id",
    ],
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

async function loadFactArray<T>(
  db: Database,
  table: string,
  fragmentId: string,
): Promise<T[]> {
  const rows = await all<FactJsonRow>(
    db,
    `SELECT fact_json FROM ${table} WHERE file_id = ? ORDER BY seq`,
    [fragmentId],
  );
  return rows.map((row) => JSON.parse(row.fact_json) as T);
}

function invalidatedStatus(
  reason: InvalidationReason,
): FragmentMetadata["status"] {
  return reason === "file_changed" ? "unstable" : "failed";
}

/**
 * Resolve a query into SQL fragments. `source` is a collection *scope* (which sources this run
 * materialized) applied to every table but never dropping empty sessions; `since/until/project` are
 * content filters whose presence (`active`) makes the reader drop sessions with no surviving message.
 * `--project` matches cwd via `instr` (not LIKE) to avoid wildcard injection.
 */
/** Column names the resolved filters target, so the same source/date/project predicates serve tables
 *  with different schemas/aliases (resolved_usage, aliased joins, resolved_invocations). `cwdColumn:
 *  null` skips the project predicate entirely — for tables with no cwd column (resolved_invocations),
 *  whose caller applies project as a session-id subquery instead. */
interface ResolvedFilterColumns {
  sourceColumn?: string;
  dateColumn?: string;
  /** Column for the `instr(cwd, ?)` project filter, or null to skip it (caller handles project). */
  cwdColumn?: string | null;
}

/** Centralizes the source-IN / date>= / date<= / project-substring predicates shared by every resolved
 *  read, parameterized by column so each table/alias reuses one definition (no per-call divergence). */
function buildResolvedFilters(
  query?: ResolvedQuery,
  columns: ResolvedFilterColumns = {},
): {
  messageWhere: string;
  messageParams: unknown[];
  sourceWhere: string;
  sourceParams: unknown[];
  active: boolean;
} {
  const sourceColumn = columns.sourceColumn ?? "source";
  const dateColumn = columns.dateColumn ?? "date";
  const cwdColumn = columns.cwdColumn === undefined ? "cwd" : columns.cwdColumn;
  const sourceConditions: string[] = [];
  const sourceParams: unknown[] = [];
  if (query?.sources?.length) {
    sourceConditions.push(
      `${sourceColumn} IN (${query.sources.map(() => "?").join(", ")})`,
    );
    sourceParams.push(...query.sources);
  }
  const contentConditions: string[] = [];
  const contentParams: unknown[] = [];
  if (query?.since) {
    contentConditions.push(`${dateColumn} >= ?`);
    contentParams.push(query.since);
  }
  if (query?.until) {
    contentConditions.push(`${dateColumn} <= ?`);
    contentParams.push(query.until);
  }
  if (query?.projectSubstring && cwdColumn) {
    contentConditions.push(`instr(${cwdColumn}, ?) > 0`);
    contentParams.push(query.projectSubstring);
  }
  const all = [...sourceConditions, ...contentConditions];
  return {
    messageWhere: all.length ? `WHERE ${all.join(" AND ")}` : "",
    messageParams: [...sourceParams, ...contentParams],
    sourceWhere: sourceConditions.length
      ? `WHERE ${sourceConditions.join(" AND ")}`
      : "",
    sourceParams,
    active: contentConditions.length > 0,
  };
}

/** Per-model usage sums + a message count for one GROUP BY row — the shared SELECT list for every
 *  usage breakdown (#217). Cost is priced per (dimension, model) in JS by the serve-side builders. */
const USAGE_SUMS =
  "SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read) AS cache_read, " +
  "SUM(cache_write_5m) AS cw5, SUM(cache_write_1h) AS cw1, COUNT(*) AS messages";

/** Total-tokens expression over a resolved_usage row (input + output + both cache buckets). */
const USAGE_TOTAL =
  "(input_tokens + output_tokens + cache_read + cache_write_5m + cache_write_1h)";

interface UsageSumRow {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cw5: number | null;
  cw1: number | null;
  messages: number;
}

function sumRowToUsage(r: UsageSumRow): Usage {
  return {
    input: r.input ?? 0,
    output: r.output ?? 0,
    cacheRead: r.cache_read ?? 0,
    cacheWrite5m: r.cw5 ?? 0,
    cacheWrite1h: r.cw1 ?? 0,
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
    if (this.closePromise)
      return Promise.reject(new Error("Argus store is closed"));
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
      const { nativeFragments, auxiliaryFragments } =
        await this.reconstructCore([id]);
      return nativeFragments[0] ?? auxiliaryFragments[0];
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
        throw new Error(
          "removeMissing requires a complete authoritative discovery result",
        );
      }
      const observedFileIds = new Set(
        discovery.files.map(({ file }) => file.id),
      );
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
            await run(this.db, "DELETE FROM index_files WHERE id = ?", [
              row.id,
            ]);
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
      const sessionRows = await all<{
        file_id: string;
        source_session_id: string;
      }>(
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
                scheme:
                  row.physical_id_scheme as PhysicalFileIdentity["scheme"],
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
        relationships: relationshipRows.map((row) => ({
          child: row.child,
          parent: row.parent,
        })),
      };
    });
  }

  // Reconstruct auxiliary fragments from their envelope + index_auxiliary rows. Transcript/import
  // fragments store a null envelope (their content is re-parsed from disk), so they aren't
  // reconstructed here. Unscheduled so callers compose it under one queue slot.
  private async reconstructCore(
    ids: string[],
  ): Promise<ReconstructedFragments> {
    const result: ReconstructedFragments = {
      nativeFragments: [],
      auxiliaryFragments: [],
    };
    for (const id of new Set(ids)) {
      const row = await get<{
        kind: StoredFragment["kind"];
        envelope_json: string | null;
      }>(
        this.db,
        "SELECT kind, envelope_json FROM index_files WHERE id = ? AND status = 'success'",
        [id],
      );
      if (!row || row.envelope_json == null || row.kind !== "auxiliary")
        continue;
      const fragment = JSON.parse(row.envelope_json) as ParsedAuxiliaryFragment;
      fragment.facts = await loadFactArray<AuxiliaryFact>(
        this.db,
        "index_auxiliary",
        id,
      );
      result.auxiliaryFragments.push(fragment);
    }
    return result;
  }

  // --- Trusted read model ---------------------------------------------------------------------

  readResolved(query?: ResolvedQuery): Promise<ParseResult> {
    return this.schedule(() => this.readResolvedCore(query));
  }

  readSessionMeta(sessionId: string): Promise<SessionMeta | undefined> {
    return this.schedule(async () => {
      const row = await get<{ meta_json: string }>(
        this.db,
        "SELECT meta_json FROM resolved_sessions WHERE session_id = ?",
        [sessionId],
      );
      return row ? (JSON.parse(row.meta_json) as SessionMeta) : undefined;
    });
  }

  readSessionHidden(sessionId: string): Promise<boolean> {
    return this.schedule(async () => {
      const row = await get<{ is_hidden: number }>(
        this.db,
        "SELECT is_hidden FROM resolved_sessions WHERE session_id = ?",
        [sessionId],
      );
      return row?.is_hidden === 1;
    });
  }

  // The model-generated title/summary for one session (#234), or nulls when not yet interpreted, plus
  // whether interpretation has run at all (`interpreted_at_ms` is set). Backs the on-demand detail
  // view's title/summary fallback and its "No tasks found." vs "Interpretation pending." distinction.
  readSessionInterpretation(
    sessionId: string,
  ): Promise<
    | { title: string | null; summary: string | null; interpreted: boolean }
    | undefined
  > {
    return this.schedule(async () => {
      const row = await get<{
        title: string | null;
        summary: string | null;
        interpreted_at_ms: number | null;
      }>(
        this.db,
        "SELECT title, summary, interpreted_at_ms FROM resolved_sessions WHERE session_id = ?",
        [sessionId],
      );
      return row
        ? {
            title: row.title,
            summary: row.summary,
            interpreted: row.interpreted_at_ms != null,
          }
        : undefined;
    });
  }

  readSessionTasks(sessionId: string): Promise<TaskFact[]> {
    return this.schedule(async () => {
      const rows = await all<{ task_json: string }>(
        this.db,
        "SELECT task_json FROM resolved_tasks WHERE session_id = ? ORDER BY ts IS NULL, ts, seq",
        [sessionId],
      );
      return rows.map((row) => JSON.parse(row.task_json) as TaskFact);
    });
  }

  // The interaction spine for a session, rehydrated with its retained prompt/response text (#153). The
  // stored interaction_json is text-free by construction (#120); we merge promptText/responseText back
  // from resolved_interaction_text by interaction_seq so this is the SINGLE text source the Interpret
  // stage reads — both the background drain and the inline refresh interpret from here, never from the
  // in-memory parse artifacts. Empty text (retention was off at index time) yields interactions without
  // promptText/responseText, which the interpreter treats as "no candidate".
  readSessionInteractions(sessionId: string): Promise<InteractionFact[]> {
    return this.schedule(async () => {
      const rows = await all<{ interaction_json: string }>(
        this.db,
        "SELECT interaction_json FROM resolved_interactions WHERE session_id = ? ORDER BY seq",
        [sessionId],
      );
      const interactions = rows.map(
        (row) => JSON.parse(row.interaction_json) as InteractionFact,
      );
      const byInteraction = new Map<number, InteractionFact>();
      for (const interaction of interactions)
        byInteraction.set(interaction.seq, interaction);
      const textRows = await all<{
        interaction_seq: number | null;
        type: string;
        text: string;
      }>(
        this.db,
        "SELECT interaction_seq, type, text FROM resolved_interaction_text WHERE session_id = ? ORDER BY seq",
        [sessionId],
      );
      for (const row of textRows) {
        if (row.interaction_seq == null) continue;
        const interaction = byInteraction.get(row.interaction_seq);
        if (!interaction) continue;
        // Concatenate defensively: today there is at most one prompt + one response chunk per
        // interaction, but the tall table can carry more — overwriting would silently drop text.
        if (row.type === "prompt")
          interaction.promptText = (interaction.promptText ?? "") + row.text;
        else if (row.type === "response")
          interaction.responseText =
            (interaction.responseText ?? "") + row.text;
      }
      return interactions;
    });
  }

  // Count of a session's interactions (#124): a cheap COUNT over resolved_interactions, for the
  // detail page's interaction tally without rehydrating prompt/response text.
  readSessionInteractionCount(sessionId: string): Promise<number> {
    return this.schedule(async () => {
      const row = await get<{ n: number }>(
        this.db,
        "SELECT COUNT(*) AS n FROM resolved_interactions WHERE session_id = ?",
        [sessionId],
      );
      return row?.n ?? 0;
    });
  }

  // All tool invocations for a session with their owning interaction seq (#234). Read straight off
  // resolved_invocations — deliberately NOT joined to task_seq, which writeSessionTasks assigns only
  // after pass 2 runs, so a task-grain read would come back empty mid-interpretation.
  readSessionInvocations(sessionId: string): Promise<SessionInvocation[]> {
    return this.schedule(async () => {
      const rows = await all<{
        interaction_seq: number | null;
        tool: string;
        category: string;
        mcp_server: string | null;
        mcp_tool: string | null;
        file_path: string | null;
      }>(
        this.db,
        "SELECT interaction_seq, tool, category, mcp_server, mcp_tool, file_path FROM resolved_invocations WHERE session_id = ? ORDER BY seq",
        [sessionId],
      );
      return rows.map((row) => ({
        interactionSeq: row.interaction_seq,
        tool: row.tool,
        category: row.category,
        ...(row.mcp_server != null ? { mcpServer: row.mcp_server } : {}),
        ...(row.mcp_tool != null ? { mcpTool: row.mcp_tool } : {}),
        ...(row.file_path != null ? { filePath: row.file_path } : {}),
      }));
    });
  }

  // Structural-index provenance for a session (#124): the transcript file(s) it was parsed from and
  // its subagent/resumed-session lineage. resolved_sessions.session_id equals the source's session id
  // (sid = session.meta.sessionId at materialize), which is also index_sessions.source_session_id, so
  // we look up the source once then match on (source, source_session_id).
  readSessionProvenance(sessionId: string): Promise<SessionProvenance | null> {
    return this.schedule(async () => {
      const srcRow = await get<{ source: string }>(
        this.db,
        "SELECT source FROM resolved_sessions WHERE session_id = ?",
        [sessionId],
      );
      if (!srcRow) return null;
      const source = srcRow.source as AgentSource;
      const fileRows = await all<{
        transcript_path: string | null;
        observed_path: string | null;
        relative_path: string | null;
        kind: string;
        session_kind: string | null;
        size_bytes: string | null;
        mtime_ns: string | null;
        status: string;
        invalidation_reason: string | null;
        parser_name: string | null;
        parser_version: string | null;
      }>(
        this.db,
        `SELECT f.observed_path, f.relative_path, f.kind, f.size_bytes, f.mtime_ns, f.status,
                f.invalidation_reason, f.parser_name, f.parser_version,
                s.transcript_path, s.kind AS session_kind
         FROM index_sessions s JOIN index_files f ON f.id = s.file_id
         WHERE s.source = ? AND s.source_session_id = ?
         ORDER BY f.observed_path`,
        [source, sessionId],
      );
      const relRows = await all<{ child: string; parent: string }>(
        this.db,
        `SELECT child_source_session_id AS child, parent_source_session_id AS parent
         FROM index_relationships
         WHERE source = ? AND (child_source_session_id = ? OR parent_source_session_id = ?)`,
        [source, sessionId, sessionId],
      );
      const parents = [...new Set(relRows.filter((r) => r.child === sessionId).map((r) => r.parent))].sort();
      const children = [...new Set(relRows.filter((r) => r.parent === sessionId).map((r) => r.child))].sort();
      const toNum = (v: string | null): number | null => {
        if (v == null) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      return {
        source,
        files: fileRows.map((r) => {
          const mtimeNs = toNum(r.mtime_ns);
          return {
            transcriptPath: r.transcript_path,
            observedPath: r.observed_path,
            relativePath: r.relative_path,
            kind: r.kind,
            sessionKind: r.session_kind,
            sizeBytes: toNum(r.size_bytes),
            mtimeMs: mtimeNs != null ? Math.round(mtimeNs / 1e6) : null,
            status: r.status,
            invalidationReason: r.invalidation_reason,
            parserName: r.parser_name,
            parserVersion: r.parser_version,
          };
        }),
        parents,
        children,
      };
    });
  }

  // Canonical ids of sessions eligible for (re)interpretation (#153), newest-first, capped at `limit`.
  // The eligibility predicate is INTERPRETATION_ELIGIBLE_SQL, shared with interpretationProgress.
  readPendingInterpretationSessions(limit: number): Promise<string[]> {
    return this.schedule(async () => {
      const rows = await all<{ session_id: string }>(
        this.db,
        `SELECT s.session_id FROM resolved_sessions s
         WHERE ${INTERPRETATION_ELIGIBLE_SQL}
         ORDER BY s.last_ts DESC, s.session_id
         LIMIT ?`,
        [limit],
      );
      return rows.map((row) => row.session_id);
    });
  }

  // The SOLE writer of resolved_tasks + interpretation state (#153). Replaces a session's tasks without
  // re-materializing its messages/interactions/text, re-derives task↔interaction membership
  // (resolved_interactions.task_seq) over the new tasks, and stamps interpreted_at_ms +
  // interpretation_version plus the model title/summary (#234). ALWAYS stamps — even for an empty task
  // list — so a session with no extractable tasks de-queues instead of being re-interpreted on every
  // drain tick. Survives a later unchanged re-materialize via materialize's carry-forward; discarded
  // only when content changes. `title`/`summary` default to null (cleared) — the interpret stage always
  // passes the values it generated.
  writeSessionTasks(
    sessionId: string,
    tasks: TaskFact[],
    version: string,
    title: string | null = null,
    summary: string | null = null,
  ): Promise<void> {
    return this.schedule(async () => {
      await transaction(this.db, async () => {
        await run(this.db, "DELETE FROM resolved_tasks WHERE session_id = ?", [
          sessionId,
        ]);
        await insertRows(
          this.db,
          "resolved_tasks",
          ["session_id", "seq", "source", "ts", "task_json"],
          tasks.map((task, seq) => [
            sessionId,
            seq,
            task.source,
            task.timestampMs ?? null,
            JSON.stringify(task),
          ]),
        );
        // Keep the search index (#155) in sync with the same wholesale replace, via ordinary DML (not
        // a trigger — see RESOLVED_INTERACTION_TEXT_FTS_DDL's comment). Indexes description +
        // outcomeReason + signals[] only — deliberately excludes .evidence (bookkeeping, not prose).
        await run(
          this.db,
          "DELETE FROM resolved_tasks_fts WHERE session_id = ?",
          [sessionId],
        );
        await insertRows(
          this.db,
          "resolved_tasks_fts",
          ["session_id", "text"],
          tasks.map((task) => [
            sessionId,
            [
              task.description,
              task.outcomeReason ?? "",
              ...(task.signals ?? []),
            ].join(" "),
          ]),
        );
        const interactionRows = await all<{ seq: number; ts: number | null }>(
          this.db,
          "SELECT seq, ts FROM resolved_interactions WHERE session_id = ?",
          [sessionId],
        );
        // The narrow TaskSeqInteraction type lets us pass these rebuilt-from-columns rows directly —
        // no cast that would silently hide a future field the assigner starts depending on.
        const interactions: TaskSeqInteraction[] = interactionRows.map(
          (row) => ({
            seq: row.seq,
            timestampMs: row.ts ?? undefined,
          }),
        );
        const taskSeqByInteraction = assignInteractionTaskSeqs(
          tasks,
          interactions,
        );
        // Re-derive every interaction's task_seq in ONE statement: a CASE maps assigned interactions to
        // their task and the ELSE clears the rest — instead of N round-trips (a reset + one UPDATE per
        // interaction), which a long session would pay on every interpret.
        const assigned = [...taskSeqByInteraction.entries()];
        if (assigned.length) {
          const cases = assigned.map(() => "WHEN ? THEN ?").join(" ");
          await run(
            this.db,
            `UPDATE resolved_interactions SET task_seq = CASE seq ${cases} ELSE NULL END WHERE session_id = ?`,
            [
              ...assigned.flatMap(([seq, taskSeq]) => [seq, taskSeq]),
              sessionId,
            ],
          );
        } else {
          await run(
            this.db,
            "UPDATE resolved_interactions SET task_seq = NULL WHERE session_id = ?",
            [sessionId],
          );
        }
        await run(
          this.db,
          "UPDATE resolved_sessions SET interpreted_at_ms = ?, interpretation_version = ?, title = ?, summary = ? WHERE session_id = ?",
          [Date.now(), version, title, summary, sessionId],
        );
        // Keep the title/summary search index (#234) in sync with the same wholesale replace, via
        // ordinary DML (not a trigger — see RESOLVED_INTERACTION_TEXT_FTS_DDL's comment).
        await run(
          this.db,
          "DELETE FROM resolved_sessions_fts WHERE session_id = ?",
          [sessionId],
        );
        const ftsText = sessionFtsText(title, summary);
        if (ftsText) {
          await run(
            this.db,
            "INSERT INTO resolved_sessions_fts(session_id, text) VALUES (?, ?)",
            [sessionId, ftsText],
          );
        }
      });
      secureSqliteFiles(this.path);
    });
  }

  // ---- Session/task labels (session-and-task-labels feature) ----
  // Local-only: none of these tables are read by push.ts, so labels never reach the sync wire.
  // label_assignments has no FK to resolved_sessions on purpose — materialize CASCADE-wipes a
  // session's resolved_* rows on every re-index of a changed session, and user-authored labels must
  // survive that. Assignments are removed only on genuine session deletion (retractSessions).

  listLabels(opts?: { includeDeleted?: boolean }): Promise<LabelRecord[]> {
    return this.schedule(async () => {
      const where = opts?.includeDeleted ? "" : "WHERE deleted_at_ms IS NULL";
      const rows = await all<LabelDbRow>(
        this.db,
        `SELECT id, name, origin, created_at_ms, deleted_at_ms FROM labels ${where} ORDER BY name COLLATE NOCASE, id`,
      );
      return rows.map(labelRecordFromRow);
    });
  }

  createLabel(input: {
    name: string;
    origin?: LabelOrigin;
  }): Promise<LabelRecord> {
    return this.schedule(async () => {
      const name = input.name.trim();
      if (!name) throw new LabelError("empty_name", "A label needs a name.");
      const origin: LabelOrigin = input.origin ?? "user";
      const id = `label:${crypto.randomUUID()}`;
      const createdAtMs = Date.now();
      let created: LabelRecord | undefined;
      // Serialized writes make this pre-check + insert race-free without relying on catching the
      // partial unique-index violation (which can't tell a name clash from other constraint errors).
      await transaction(this.db, async () => {
        const clash = await get<{ id: string }>(
          this.db,
          "SELECT id FROM labels WHERE name = ? COLLATE NOCASE AND deleted_at_ms IS NULL",
          [name],
        );
        if (clash)
          throw new LabelError(
            "name_conflict",
            `A label named "${name}" already exists.`,
          );
        await run(
          this.db,
          "INSERT INTO labels (id, name, origin, created_at_ms, deleted_at_ms) VALUES (?, ?, ?, ?, NULL)",
          [id, name, origin, createdAtMs],
        );
        created = { id, name, origin, createdAtMs };
      });
      secureSqliteFiles(this.path);
      return created!;
    });
  }

  renameLabel(id: string, name: string): Promise<LabelRecord> {
    return this.schedule(async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new LabelError("empty_name", "A label needs a name.");
      let updated: LabelRecord | undefined;
      await transaction(this.db, async () => {
        const existing = await get<LabelDbRow>(
          this.db,
          "SELECT id, name, origin, created_at_ms, deleted_at_ms FROM labels WHERE id = ?",
          [id],
        );
        if (!existing || existing.deleted_at_ms != null) {
          throw new LabelError("not_found", "That label no longer exists.");
        }
        const clash = await get<{ id: string }>(
          this.db,
          "SELECT id FROM labels WHERE name = ? COLLATE NOCASE AND deleted_at_ms IS NULL AND id != ?",
          [trimmed, id],
        );
        if (clash)
          throw new LabelError(
            "name_conflict",
            `A label named "${trimmed}" already exists.`,
          );
        await run(this.db, "UPDATE labels SET name = ? WHERE id = ?", [
          trimmed,
          id,
        ]);
        updated = labelRecordFromRow({ ...existing, name: trimmed });
      });
      secureSqliteFiles(this.path);
      return updated!;
    });
  }

  deleteLabel(id: string): Promise<void> {
    return this.schedule(async () => {
      // Soft delete: the name frees up for reuse, existing applications stay but stop surfacing (the
      // label reads all filter to deleted_at_ms IS NULL).
      await run(
        this.db,
        "UPDATE labels SET deleted_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL",
        [Date.now(), id],
      );
      secureSqliteFiles(this.path);
    });
  }

  assignLabel(
    labelId: string,
    target: LabelTarget,
    appliedBy: LabelAppliedBy = "user",
  ): Promise<void> {
    return this.schedule(async () => {
      const { targetKind, taskSeq } = normalizedLabelTarget(target);
      await transaction(this.db, async () => {
        const activeLabel = await get<{ id: string }>(
          this.db,
          "SELECT id FROM labels WHERE id = ? AND deleted_at_ms IS NULL",
          [labelId],
        );
        if (!activeLabel)
          throw new LabelError("not_found", "That label no longer exists.");
        // ON CONFLICT over label_assignments_unique makes re-applying the same (label, target) a no-op
        // that preserves the original applied_by / applied_at_ms.
        await run(
          this.db,
          `INSERT INTO label_assignments (label_id, target_kind, session_id, task_seq, applied_by, applied_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (label_id, session_id, COALESCE(task_seq, -1)) DO NOTHING`,
          [
            labelId,
            targetKind,
            target.sessionId,
            taskSeq,
            appliedBy,
            Date.now(),
          ],
        );
      });
      secureSqliteFiles(this.path);
    });
  }

  unassignLabel(labelId: string, target: LabelTarget): Promise<void> {
    return this.schedule(async () => {
      const { taskSeq } = normalizedLabelTarget(target);
      await run(
        this.db,
        "DELETE FROM label_assignments WHERE label_id = ? AND session_id = ? AND COALESCE(task_seq, -1) = COALESCE(?, -1)",
        [labelId, target.sessionId, taskSeq],
      );
      secureSqliteFiles(this.path);
    });
  }

  readSessionLabels(sessionId: string): Promise<SessionLabels> {
    return this.schedule(async () => {
      const rows = await all<
        LabelDbRow & {
          task_seq: number | null;
          applied_by: string;
          applied_at_ms: number;
        }
      >(
        this.db,
        `SELECT l.id, l.name, l.origin, l.created_at_ms, l.deleted_at_ms,
                a.task_seq, a.applied_by, a.applied_at_ms
         FROM label_assignments a
         JOIN labels l ON l.id = a.label_id
         WHERE a.session_id = ? AND l.deleted_at_ms IS NULL
         ORDER BY l.name COLLATE NOCASE, l.id`,
        [sessionId],
      );
      const session: AppliedLabel[] = [];
      const tasks: Record<number, AppliedLabel[]> = {};
      for (const row of rows) {
        const applied: AppliedLabel = {
          ...labelRecordFromRow(row),
          appliedBy: row.applied_by as LabelAppliedBy,
          appliedAtMs: row.applied_at_ms,
        };
        if (row.task_seq == null) session.push(applied);
        else (tasks[row.task_seq] ??= []).push(applied);
      }
      return { session, tasks };
    });
  }

  readSessionLabelsForSessions(
    sessionIds: string[],
  ): Promise<Map<string, AppliedLabel[]>> {
    return this.schedule(async () => {
      const out = new Map<string, AppliedLabel[]>();
      const ids = [...new Set(sessionIds)];
      if (!ids.length) return out;
      for (const part of chunk(ids, MAX_BOUND_PARAMS)) {
        const placeholders = part.map(() => "?").join(", ");
        const rows = await all<
          LabelDbRow & {
            session_id: string;
            applied_by: string;
            applied_at_ms: number;
          }
        >(
          this.db,
          `SELECT a.session_id, l.id, l.name, l.origin, l.created_at_ms, l.deleted_at_ms,
                  a.applied_by, a.applied_at_ms
           FROM label_assignments a
           JOIN labels l ON l.id = a.label_id
           WHERE a.task_seq IS NULL AND l.deleted_at_ms IS NULL AND a.session_id IN (${placeholders})
           ORDER BY l.name COLLATE NOCASE, l.id`,
          part,
        );
        for (const row of rows) {
          const applied: AppliedLabel = {
            ...labelRecordFromRow(row),
            appliedBy: row.applied_by as LabelAppliedBy,
            appliedAtMs: row.applied_at_ms,
          };
          const list = out.get(row.session_id);
          if (list) list.push(applied);
          else out.set(row.session_id, [applied]);
        }
      }
      return out;
    });
  }

  readSessionIdsForLabels(labelIds: string[], mode: LabelFilterMode = "any"): Promise<Set<string>> {
    return this.schedule(async () => {
      const out = new Set<string>();
      const ids = [...new Set(labelIds)];
      if (!ids.length) return out;
      if (mode === "any") {
        for (const part of chunk(ids, MAX_BOUND_PARAMS)) {
          const placeholders = part.map(() => "?").join(", ");
          const rows = await all<{ session_id: string }>(
            this.db,
            `SELECT DISTINCT session_id FROM label_assignments WHERE task_seq IS NULL AND label_id IN (${placeholders})`,
            part,
          );
          for (const row of rows) out.add(row.session_id);
        }
        return out;
      }
      // "all": a session must carry every requested label, so it's one GROUP BY/HAVING pass rather
      // than chunked union — a caller narrowing by "all" of N labels never sends more than a handful.
      const placeholders = ids.map(() => "?").join(", ");
      const rows = await all<{ session_id: string }>(
        this.db,
        `SELECT session_id FROM label_assignments
         WHERE task_seq IS NULL AND label_id IN (${placeholders})
         GROUP BY session_id
         HAVING COUNT(DISTINCT label_id) = ?`,
        [...ids, ids.length],
      );
      for (const row of rows) out.add(row.session_id);
      return out;
    });
  }

  // Persisted rate limiter for the throttled Interpret drain (#153). A leaky-bucket of "credits" where
  // one credit = permission to interpret one session (deliberately NOT called "tokens" — these are
  // unrelated to LLM tokens). Continuous refill at `maxPerHour` per hour, capacity `maxPerHour`; a fresh
  // bucket starts full (the rate is a ceiling, not a startup delay). Returns how many credits were
  // actually granted (min of `want` and whole credits available), decrementing by that amount. State
  // lives in store_metadata so the ceiling holds across process restarts and repeated one-shot
  // `argus index` runs. Decrement is on GRANT (an attempt), so a failing session still costs a credit —
  // bounding spend even when interpretation errors.
  takeInterpretCredits(want: number, maxPerHour: number): Promise<number> {
    return this.schedule(async () => {
      if (want <= 0 || maxPerHour <= 0) return 0;
      const nowMs = Date.now();
      const row = await get<{ value: string }>(
        this.db,
        "SELECT value FROM store_metadata WHERE key = 'interpret_rate'",
      );
      let credits = maxPerHour;
      if (row) {
        try {
          const state = JSON.parse(row.value) as {
            credits?: number;
            lastRefillMs?: number;
          };
          const lastRefillMs =
            typeof state.lastRefillMs === "number" ? state.lastRefillMs : nowMs;
          const prior =
            typeof state.credits === "number" ? state.credits : maxPerHour;
          const elapsedMs = Math.max(0, nowMs - lastRefillMs);
          credits = Math.min(
            maxPerHour,
            prior + (elapsedMs / 3_600_000) * maxPerHour,
          );
        } catch {
          credits = maxPerHour;
        }
      }
      const granted = Math.min(want, Math.floor(credits));
      await run(
        this.db,
        "INSERT OR REPLACE INTO store_metadata (key, value) VALUES ('interpret_rate', ?)",
        [JSON.stringify({ credits: credits - granted, lastRefillMs: nowMs })],
      );
      return granted;
    });
  }

  // Backfill progress for `argus status` (#153). interpreted = sessions interpreted at least once.
  // pending + outdated are both scoped to the SAME eligibility predicate the drain uses
  // (INTERPRETATION_ELIGIBLE_SQL): pending = all eligible; outdated = the eligible subset that was
  // already interpreted once (content has changed since — the "new data, refresh?" signal). Gating
  // outdated on eligibility (incl. the retained-text check) means it's a subset of pending, so it always
  // decreases as the drain works — a text-less session can't show as a permanently-stuck "outdated".
  interpretationProgress(): Promise<{
    interpreted: number;
    pending: number;
    outdated: number;
  }> {
    return this.schedule(async () => {
      const eligible = await get<{ pending: number; outdated: number }>(
        this.db,
        `SELECT COUNT(*) AS pending,
                COUNT(*) FILTER (WHERE s.interpreted_at_ms IS NOT NULL) AS outdated
         FROM resolved_sessions s WHERE ${INTERPRETATION_ELIGIBLE_SQL}`,
      );
      const interpretedRow = await get<{ n: number }>(
        this.db,
        "SELECT COUNT(*) AS n FROM resolved_sessions WHERE interpreted_at_ms IS NOT NULL",
      );
      return {
        interpreted: interpretedRow?.n ?? 0,
        pending: eligible?.pending ?? 0,
        outdated: eligible?.outdated ?? 0,
      };
    });
  }

  // Map each of a session's task seqs -> task id (from resolved_tasks). Runs the query directly (no
  // schedule wrap) so it composes inside an already-scheduled read. Shared by the task-grain readers.
  private async taskIdBySeq(sessionId: string): Promise<Map<number, string>> {
    const rows = await all<{ seq: number; task_json: string }>(
      this.db,
      "SELECT seq, task_json FROM resolved_tasks WHERE session_id = ? ORDER BY seq",
      [sessionId],
    );
    const idBySeq = new Map<number, string>();
    for (const row of rows) idBySeq.set(row.seq, (JSON.parse(row.task_json) as TaskFact).id);
    return idBySeq;
  }

  readSessionTaskMessages(
    sessionId: string,
  ): Promise<Map<string, MessageRecord[]>> {
    return this.schedule(async () => {
      // One pass for the whole session: map each task's seq -> id, then bucket the attributed
      // messages by task id. Task membership lives on resolved_interactions.task_seq (#122), so a usage
      // row's task is its owning interaction's task: usage -> interaction (interaction_seq) -> task_seq.
      // Tasks with no attributed messages simply don't appear in the map (callers treat that as zero).
      const idBySeq = await this.taskIdBySeq(sessionId);

      const rows = await all<{ record_json: string; task_seq: number | null }>(
        this.db,
        `SELECT u.record_json AS record_json, i.task_seq AS task_seq
         FROM resolved_usage u
         JOIN resolved_interactions i ON i.session_id = u.session_id AND i.seq = u.interaction_seq
         WHERE u.session_id = ? AND i.task_seq IS NOT NULL
         ORDER BY u.seq`,
        [sessionId],
      );
      const byTask = new Map<string, MessageRecord[]>();
      for (const row of rows) {
        const id = row.task_seq != null ? idBySeq.get(row.task_seq) : undefined;
        if (!id) continue;
        const list = byTask.get(id) ?? byTask.set(id, []).get(id)!;
        list.push(JSON.parse(row.record_json) as MessageRecord);
      }
      return byTask;
    });
  }

  // Per-task interaction counts straight off the interaction spine (resolved_interactions grouped by
  // task_seq), keyed by task id. This is the true interaction count for a task — it includes
  // interactions with no usage rows (interruptions, prompt-only turns) that the usage-joined
  // readSessionTaskMessages misses — and matches the timeline's chapter grouping (#124).
  readSessionTaskInteractionCounts(sessionId: string): Promise<Map<string, number>> {
    return this.schedule(async () => {
      const idBySeq = await this.taskIdBySeq(sessionId);

      const rows = await all<{ task_seq: number; n: number }>(
        this.db,
        `SELECT task_seq, COUNT(*) AS n FROM resolved_interactions
         WHERE session_id = ? AND task_seq IS NOT NULL
         GROUP BY task_seq`,
        [sessionId],
      );
      const byTask = new Map<string, number>();
      for (const row of rows) {
        const id = idBySeq.get(row.task_seq);
        if (id) byTask.set(id, row.n);
      }
      return byTask;
    });
  }

  readSessionMessages(sessionId: string): Promise<MessageRecord[]> {
    return this.schedule(async () => {
      const rows = await all<{ record_json: string }>(
        this.db,
        "SELECT record_json FROM resolved_usage WHERE session_id = ? ORDER BY seq",
        [sessionId],
      );
      return rows.map((row) => JSON.parse(row.record_json) as MessageRecord);
    });
  }

  // Opt-in retained conversation text for a session (#120): the session's text chunks in timeline
  // order (the table's own `seq`), each tagged with its owning `interactionSeq` and `type`. Returned
  // as a flat ordered list — matching the tall table's extensibility — so nothing is dropped if a
  // future chunk (e.g. session-level narration) carries a null interaction_seq; a consumer groups by
  // interactionSeq as needed. Empty when retention was off at index time. Lets a consumer (the
  // Interpret backfill, #153) read the dialogue from the store instead of re-parsing disk; local-only.
  readInteractionText(sessionId: string): Promise<InteractionTextChunk[]> {
    return this.schedule(async () => {
      const rows = await all<{
        seq: number;
        interaction_seq: number | null;
        type: string;
        text: string;
      }>(
        this.db,
        "SELECT seq, interaction_seq, type, text FROM resolved_interaction_text WHERE session_id = ? ORDER BY seq",
        [sessionId],
      );
      return rows.map((row) => ({
        seq: row.seq,
        interactionSeq: row.interaction_seq,
        type: row.type,
        text: row.text,
      }));
    });
  }

  readSessionAggregates(query?: ResolvedQuery): Promise<SessionAggregate[]> {
    return this.schedule(async () => {
      // sessionIds (#155): the searchSessions candidate set, when a search ran. Empty array means "no
      // matches" — short-circuit rather than emit `IN ()`, which is invalid SQL.
      if (query?.sessionIds && query.sessionIds.length === 0) return [];
      // Two cheap grouped queries (no per-message JS walk): the matching sessions, and per-(session,
      // model) token sums from the promoted columns. A date filter only selects sessions (included if
      // they have a message in range, via EXISTS); the token sums below are whole-session, not windowed.
      const { conds: sessionConds, params: sessionParams } =
        buildSessionFilterConds(query);
      if (query?.sessionIds) {
        sessionConds.push(
          `s.session_id IN (${query.sessionIds.map(() => "?").join(", ")})`,
        );
        sessionParams.push(...query.sessionIds);
      }
      const sessionRows = await all<{
        session_id: string;
        first_ts: number | null;
        last_ts: number | null;
        message_count: number;
        title: string | null;
        summary: string | null;
        is_hidden: number;
        meta_json: string;
      }>(
        this.db,
        `SELECT session_id, first_ts, last_ts, message_count, title, summary, is_hidden, meta_json
         FROM resolved_sessions s WHERE ${sessionConds.join(" AND ")}`,
        sessionParams,
      );

      // Whole-session token sums per (session, model): scoped by source ONLY, deliberately NOT by the
      // date window. A session is selected by the EXISTS check above (has a message in range), but its
      // totals reflect the full session — so the row is internally consistent with its whole-session
      // first_ts / last_ts / message_count / meta counts, and the recent/tokens/cost sorts agree.
      // (A session is single-source, so the source filter never splits a session's sum.)
      const msgFilters = buildResolvedFilters(
        query?.sources?.length ? { sources: query.sources } : undefined,
      );
      const usageRows = await all<{
        session_id: string;
        model: string | null;
        input: number;
        output: number;
        cache_read: number;
        cache_write_5m: number;
        cache_write_1h: number;
      }>(
        this.db,
        `SELECT session_id, model,
            SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read) AS cache_read,
            SUM(cache_write_5m) AS cache_write_5m, SUM(cache_write_1h) AS cache_write_1h
         FROM resolved_usage ${msgFilters.messageWhere}
         GROUP BY session_id, model`,
        msgFilters.messageParams,
      );
      const byModelBySession = new Map<
        string,
        { model: string; usage: Usage }[]
      >();
      for (const row of usageRows) {
        const list =
          byModelBySession.get(row.session_id) ??
          byModelBySession.set(row.session_id, []).get(row.session_id)!;
        list.push({
          model: row.model ?? "",
          usage: {
            input: row.input ?? 0,
            output: row.output ?? 0,
            cacheRead: row.cache_read ?? 0,
            cacheWrite5m: row.cache_write_5m ?? 0,
            cacheWrite1h: row.cache_write_1h ?? 0,
          },
        });
      }

      // Per-session interaction + task counts (grouped once, mapped by session id) for the list stats.
      const countBySession = async (table: string): Promise<Map<string, number>> => {
        const rows = await all<{ session_id: string; n: number }>(
          this.db,
          `SELECT session_id, COUNT(*) AS n FROM ${table} GROUP BY session_id`,
        );
        return new Map(rows.map((r) => [r.session_id, r.n]));
      };
      const interactionsBySession = await countBySession("resolved_interactions");
      const tasksBySession = await countBySession("resolved_tasks");

      return sessionRows.map((row) => ({
        meta: JSON.parse(row.meta_json) as SessionMeta,
        byModel: byModelBySession.get(row.session_id) ?? [],
        firstTs: row.first_ts,
        lastTs: row.last_ts,
        messageCount: row.message_count,
        interactions: interactionsBySession.get(row.session_id) ?? 0,
        tasks: tasksBySession.get(row.session_id) ?? 0,
        title: row.title,
        summary: row.summary,
      }));
    });
  }

  // Session search (#155): resolves the `/sessions` box's freeform `text` + `file:` term to a
  // candidate id set + per-session snippet/count, computed in SQL. Reuses the same source/date/project
  // narrowing readSessionAggregates builds, so search honors the global filters.
  searchSessions(query: SessionSearchQuery): Promise<SessionSearchResult> {
    return this.schedule(async () => {
      const { conds: sessionConds, params: sessionParams } =
        buildSessionFilterConds(query);

      // file: term — substring match on file_path (not FTS: the tokenizer would split paths on '/' and '.').
      if (query.file) {
        sessionConds.push(
          "EXISTS (SELECT 1 FROM resolved_invocations i WHERE i.session_id = s.session_id AND instr(lower(i.file_path), lower(?)) > 0)",
        );
        sessionParams.push(query.file);
      }

      // Freeform text: title/project/source substring (today's behavior) OR either FTS table matches.
      // Both FTS subqueries reuse the SAME escaped MATCH query string. Either table may be empty
      // (retention off, task interpretation never run) — an empty table just contributes no rows, no error.
      const trimmed = query.text?.trim();
      const matchQuery = trimmed ? toFtsMatchQuery(trimmed) : undefined;
      if (trimmed) {
        sessionConds.push(
          `(instr(lower(coalesce(s.first_prompt, '')), ?) > 0
            OR instr(lower(s.project), ?) > 0
            OR instr(lower(s.source), ?) > 0
            OR s.session_id IN (SELECT session_id FROM resolved_interaction_text_fts WHERE resolved_interaction_text_fts MATCH ?)
            OR s.session_id IN (SELECT session_id FROM resolved_tasks_fts WHERE resolved_tasks_fts MATCH ?)
            OR s.session_id IN (SELECT session_id FROM resolved_sessions_fts WHERE resolved_sessions_fts MATCH ?))`,
        );
        const lowered = trimmed.toLowerCase();
        sessionParams.push(
          lowered,
          lowered,
          lowered,
          matchQuery,
          matchQuery,
          matchQuery,
        );
      }

      const rows = await all<{ session_id: string }>(
        this.db,
        `SELECT s.session_id AS session_id FROM resolved_sessions s WHERE ${sessionConds.join(" AND ")}`,
        sessionParams,
      );
      const ids = new Set(rows.map((row) => row.session_id));

      const matches = new Map<string, SessionSearchMatch>();
      if (matchQuery) {
        // snippet() must be evaluated per matched row while the FTS cursor is positioned on it — it
        // cannot combine with GROUP BY ("unable to use function snippet in the requested context").
        // So fetch ungrouped rows (one per matching FTS row) and fold per-session in JS instead.
        // Column index 1 = `text` (column 0 is the UNINDEXED session_id carried on the row).
        const [interactionRows, taskRows, sessionRows] = await Promise.all([
          all<{ session_id: string; snip: string }>(
            this.db,
            `SELECT session_id, snippet(resolved_interaction_text_fts, 1, char(1), char(2), '…', 12) AS snip
             FROM resolved_interaction_text_fts WHERE resolved_interaction_text_fts MATCH ?`,
            [matchQuery],
          ),
          all<{ session_id: string; snip: string }>(
            this.db,
            `SELECT session_id, snippet(resolved_tasks_fts, 1, char(1), char(2), '…', 12) AS snip
             FROM resolved_tasks_fts WHERE resolved_tasks_fts MATCH ?`,
            [matchQuery],
          ),
          all<{ session_id: string; snip: string }>(
            this.db,
            `SELECT session_id, snippet(resolved_sessions_fts, 1, char(1), char(2), '…', 12) AS snip
             FROM resolved_sessions_fts WHERE resolved_sessions_fts MATCH ?`,
            [matchQuery],
          ),
        ]);
        // Accumulate per session: total match count + the first snippet seen from each source kind.
        const perSession = new Map<
          string,
          {
            count: number;
            snip: Partial<Record<SessionSearchTextSource, string>>;
          }
        >();
        const fold = (
          rows: { session_id: string; snip: string }[],
          source: SessionSearchTextSource,
        ) => {
          for (const row of rows) {
            let acc = perSession.get(row.session_id);
            if (!acc)
              perSession.set(row.session_id, (acc = { count: 0, snip: {} }));
            acc.count += 1;
            acc.snip[source] ??= row.snip; // first row's snippet wins per source
          }
        };
        fold(interactionRows, "conversation");
        fold(taskRows, "task");
        fold(sessionRows, "summary");
        // Order the matched sources most-distilled-first (summary > task > conversation) so `sources[0]`
        // is the snippet's origin and the UI can name each precisely. count sums across all of them.
        const PREFERENCE: SessionSearchTextSource[] = [
          "summary",
          "task",
          "conversation",
        ];
        for (const [sessionId, acc] of perSession) {
          const sources = PREFERENCE.filter((s) => acc.snip[s] !== undefined);
          matches.set(sessionId, {
            count: acc.count,
            snippet: acc.snip[sources[0]!]!,
            sources,
          });
        }
      }

      return { ids, matches };
    });
  }

  // ---- Per-view dashboard reads (#217) ----
  // Each serve endpoint reads only the breakdown it needs — there is no monolithic Dashboard build.
  // Usage breakdowns run over resolved_usage, windowed by the shared message filter (date/source/
  // project) — the same WHERE readResolved applies, so every breakdown windows identically. Cost is
  // priced per (dimension, model) in JS by the serve-side builders (pricing is linear, so
  // SUM-then-price equals price-then-SUM).

  readUsageByDateModel(
    query?: ResolvedQuery,
  ): Promise<Array<{ date: string } & UsageGroupRow>> {
    return this.schedule(async () => {
      const usage = buildResolvedFilters(query);
      return (
        await all<UsageSumRow & { date: string; model: string | null }>(
          this.db,
          `SELECT date, model, ${USAGE_SUMS} FROM resolved_usage ${usage.messageWhere} GROUP BY date, model`,
          usage.messageParams,
        )
      ).map((r) => ({
        date: r.date,
        model: r.model ?? "",
        usage: sumRowToUsage(r),
        messages: r.messages,
      }));
    });
  }

  readUsageBySourceModel(
    query?: ResolvedQuery,
  ): Promise<Array<{ source: string } & UsageGroupRow>> {
    return this.schedule(async () => {
      const usage = buildResolvedFilters(query);
      return (
        await all<UsageSumRow & { source: string; model: string | null }>(
          this.db,
          `SELECT source, model, ${USAGE_SUMS} FROM resolved_usage ${usage.messageWhere} GROUP BY source, model`,
          usage.messageParams,
        )
      ).map((r) => ({
        source: r.source,
        model: r.model ?? "",
        usage: sumRowToUsage(r),
        messages: r.messages,
      }));
    });
  }

  readUsageByProjectModel(
    query?: ResolvedQuery,
  ): Promise<Array<{ project: string } & UsageGroupRow>> {
    return this.schedule(async () => {
      const usage = buildResolvedFilters(query);
      return (
        await all<UsageSumRow & { project: string; model: string | null }>(
          this.db,
          `SELECT project, model, ${USAGE_SUMS} FROM resolved_usage ${usage.messageWhere} GROUP BY project, model`,
          usage.messageParams,
        )
      ).map((r) => ({
        project: r.project,
        model: r.model ?? "",
        usage: sumRowToUsage(r),
        messages: r.messages,
      }));
    });
  }

  readUsageBySkillModel(
    query?: ResolvedQuery,
  ): Promise<Array<{ skill: string } & UsageGroupRow>> {
    return this.schedule(async () => {
      const usage = buildResolvedFilters(query);
      return (
        await all<
          UsageSumRow & {
            attribution_skill: string | null;
            model: string | null;
          }
        >(
          this.db,
          `SELECT attribution_skill, model, ${USAGE_SUMS} FROM resolved_usage ${usage.messageWhere} GROUP BY attribution_skill, model`,
          usage.messageParams,
        )
      ).map((r) => ({
        skill: r.attribution_skill ?? "",
        model: r.model ?? "",
        usage: sumRowToUsage(r),
        messages: r.messages,
      }));
    });
  }

  readSkillTokensByDate(
    query?: ResolvedQuery,
  ): Promise<Array<{ date: string; skill: string; total: number }>> {
    return this.schedule(async () => {
      const usage = buildResolvedFilters(query);
      const where = usage.messageWhere
        ? `${usage.messageWhere} AND attribution_skill IS NOT NULL`
        : "WHERE attribution_skill IS NOT NULL";
      return (
        await all<{ date: string; skill: string; total: number }>(
          this.db,
          `SELECT date, attribution_skill AS skill, SUM(${USAGE_TOTAL}) AS total
           FROM resolved_usage ${where} GROUP BY date, attribution_skill`,
          usage.messageParams,
        )
      ).map((r) => ({ date: r.date, skill: r.skill, total: r.total ?? 0 }));
    });
  }

  readActiveDates(query?: ResolvedQuery): Promise<string[]> {
    return this.schedule(async () => {
      const usage = buildResolvedFilters(query);
      return (
        await all<{ date: string }>(
          this.db,
          `SELECT DISTINCT date FROM resolved_usage ${usage.messageWhere} ORDER BY date`,
          usage.messageParams,
        )
      ).map((r) => r.date);
    });
  }

  readSessionsBySource(
    query?: ResolvedQuery,
  ): Promise<Array<{ source: string; sessions: number }>> {
    return this.schedule(async () => {
      const usage = buildResolvedFilters(query);
      return all<{ source: string; sessions: number }>(
        this.db,
        `SELECT source, COUNT(DISTINCT session_id) AS sessions FROM resolved_usage ${usage.messageWhere} GROUP BY source`,
        usage.messageParams,
      );
    });
  }

  readSessionsByProject(
    query?: ResolvedQuery,
  ): Promise<Array<{ project: string; sessions: number }>> {
    return this.schedule(async () => {
      const usage = buildResolvedFilters(query);
      return all<{ project: string; sessions: number }>(
        this.db,
        `SELECT project, COUNT(DISTINCT session_id) AS sessions FROM resolved_usage ${usage.messageWhere} GROUP BY project`,
        usage.messageParams,
      );
    });
  }

  // Tool breakdowns run over resolved_invocations. Call counts/sessions are fully filtered
  // (source/date/project) against the invocation's OWN denormalized columns (source/date/cwd);
  // result-size totals are scoped by SOURCE ONLY, mirroring the legacy ParseResult.toolResults map
  // (no date/project window).

  readToolResultStats(
    query?: ResolvedQuery,
  ): Promise<Array<{ tool: string; count: number; approxTokens: number }>> {
    return this.schedule(async () => {
      const invSource = buildResolvedFilters(query, { sourceColumn: "source" });
      return (
        await all<{ tool: string; count: number; approx: number | null }>(
          this.db,
          // source is a column on resolved_invocations, so no join to resolved_sessions is needed.
          `SELECT tool, COUNT(*) AS count, SUM(approx_result_tokens) AS approx
           FROM resolved_invocations ${invSource.sourceWhere}
           GROUP BY tool`,
          invSource.sourceParams,
        )
      ).map((r) => ({
        tool: r.tool,
        count: r.count,
        approxTokens: r.approx ?? 0,
      }));
    });
  }

  readToolStats(
    query?: ResolvedQuery,
  ): Promise<
    Array<{
      tool: string;
      category: ToolCategory;
      calls: number;
      sessions: number;
    }>
  > {
    return this.schedule(async () => {
      const inv = buildResolvedFilters(query, {
        sourceColumn: "i.source",
        dateColumn: "i.date",
        cwdColumn: "i.cwd",
      });
      return (
        await all<{
          tool: string;
          category: string;
          calls: number;
          sessions: number;
        }>(
          this.db,
          // Group by tool NAME only (category is deterministic per name; MIN picks the single value).
          `SELECT tool, MIN(category) AS category, COUNT(*) AS calls, COUNT(DISTINCT session_id) AS sessions
           FROM resolved_invocations i ${inv.messageWhere} GROUP BY tool`,
          inv.messageParams,
        )
      ).map((r) => ({
        tool: r.tool,
        category: r.category as ToolCategory,
        calls: r.calls,
        sessions: r.sessions,
      }));
    });
  }

  readToolCategoryStats(
    query?: ResolvedQuery,
  ): Promise<
    Array<{
      category: ToolCategory;
      calls: number;
      tools: number;
      sessions: number;
    }>
  > {
    return this.schedule(async () => {
      const inv = buildResolvedFilters(query, {
        sourceColumn: "i.source",
        dateColumn: "i.date",
        cwdColumn: "i.cwd",
      });
      return (
        await all<{
          category: string;
          calls: number;
          tools: number;
          sessions: number;
        }>(
          this.db,
          `SELECT category, COUNT(*) AS calls, COUNT(DISTINCT tool) AS tools, COUNT(DISTINCT session_id) AS sessions
           FROM resolved_invocations i ${inv.messageWhere} GROUP BY category`,
          inv.messageParams,
        )
      ).map((r) => ({
        category: r.category as ToolCategory,
        calls: r.calls,
        tools: r.tools,
        sessions: r.sessions,
      }));
    });
  }

  readMcpServers(
    query?: ResolvedQuery,
  ): Promise<Array<{ server: string; calls: number }>> {
    return this.schedule(async () => {
      const inv = buildResolvedFilters(query, {
        sourceColumn: "i.source",
        dateColumn: "i.date",
        cwdColumn: "i.cwd",
      });
      const where = inv.messageWhere
        ? `${inv.messageWhere} AND i.mcp_server IS NOT NULL`
        : "WHERE i.mcp_server IS NOT NULL";
      return all<{ server: string; calls: number }>(
        this.db,
        `SELECT mcp_server AS server, COUNT(*) AS calls FROM resolved_invocations i ${where} GROUP BY mcp_server`,
        inv.messageParams,
      );
    });
  }

  readMcpServerTools(
    query?: ResolvedQuery,
  ): Promise<Array<{ server: string; tool: string; count: number }>> {
    return this.schedule(async () => {
      const inv = buildResolvedFilters(query, {
        sourceColumn: "i.source",
        dateColumn: "i.date",
        cwdColumn: "i.cwd",
      });
      const where = inv.messageWhere
        ? `${inv.messageWhere} AND i.mcp_server IS NOT NULL`
        : "WHERE i.mcp_server IS NOT NULL";
      return all<{ server: string; tool: string; count: number }>(
        this.db,
        `SELECT mcp_server AS server, tool, COUNT(*) AS count FROM resolved_invocations i ${where} GROUP BY mcp_server, tool`,
        inv.messageParams,
      );
    });
  }

  /** Session-level health rollups (#217/#38): friction totals + per-project + high-growth count,
   *  without materializing messages. Friction signals are promoted columns on resolved_sessions;
   *  token-growth is a SQL window over the usage rows (first vs last decile, matching the JS k).
   *  (The session-level outcome proxy was removed in #122 — outcome is per task.) Backs GET /api/health
   *  and the recommendations endpoint. */
  readHealthRollups(query?: ResolvedQuery): Promise<HealthRollups> {
    return this.schedule(() =>
      this.readHealthRollupsCore(query, buildResolvedFilters(query)),
    );
  }

  private async readHealthRollupsCore(
    query: ResolvedQuery | undefined,
    usage: ReturnType<typeof buildResolvedFilters>,
  ): Promise<HealthRollups> {
    // In-scope sessions (those with a message in the window) joined to their promoted friction columns.
    // Reuses the shared filter against the usage row's columns.
    const joinFilter = buildResolvedFilters(query, {
      sourceColumn: "m.source",
      dateColumn: "m.date",
      cwdColumn: "m.cwd",
    });
    const sessions = await all<{
      session_id: string;
      project: string;
      fi: number | null;
      fr: number | null;
      fc: number | null;
      ft: number | null;
    }>(
      this.db,
      `SELECT m.session_id AS session_id, s.project AS project,
              s.friction_interruptions AS fi, s.friction_rejections AS fr, s.friction_compactions AS fc,
              s.friction_turns AS ft
       FROM resolved_usage m JOIN resolved_sessions s ON s.session_id = m.session_id
       ${joinFilter.messageWhere}
       GROUP BY m.session_id`,
      joinFilter.messageParams,
    );

    // Token-growth ratio per session: mean total tokens of the last decile over the first decile, with
    // k = floor(n/10) and n >= 10 — the same slice the JS tokenGrowth uses.
    const growthRows = await all<{
      first_mean: number | null;
      last_mean: number | null;
    }>(
      this.db,
      `SELECT AVG(CASE WHEN rn <= n / 10 THEN total END) AS first_mean,
              AVG(CASE WHEN rn > n - n / 10 THEN total END) AS last_mean
       FROM (
         SELECT session_id,
                (input_tokens + output_tokens + cache_read + cache_write_5m + cache_write_1h) AS total,
                ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq) AS rn,
                COUNT(*) OVER (PARTITION BY session_id) AS n
         FROM resolved_usage ${usage.messageWhere}
       )
       WHERE n >= 10
       GROUP BY session_id`,
      usage.messageParams,
    );
    let highTokenGrowthSessions = 0;
    for (const r of growthRows) {
      const first = r.first_mean ?? 0;
      const last = r.last_mean ?? 0;
      if (first > 0 && last / first >= HIGH_TOKEN_GROWTH_RATIO)
        highTokenGrowthSessions += 1;
    }

    const totals = emptyFrictionTotals();
    const byProjectMap = new Map<string, FrictionTotals>();
    for (const row of sessions) {
      // Friction rollup over sessions where friction is observable (interruptions promoted, non-NULL).
      if (row.fi != null) {
        const pf = byProjectMap.get(row.project) ?? emptyFrictionTotals();
        if (!byProjectMap.has(row.project)) byProjectMap.set(row.project, pf);
        const contribution = {
          interruptions: row.fi,
          rejections: row.fr ?? 0,
          compactions: row.fc ?? 0,
          turns: row.ft ?? 0,
        };
        for (const bucket of [totals, pf]) foldFriction(bucket, contribution);
      }
    }
    const projectFriction = [...byProjectMap.entries()].map(
      ([project, friction]) => ({ project, friction }),
    );
    return { frictionTotals: totals, projectFriction, highTokenGrowthSessions };
  }

  private async readResolvedCore(query?: ResolvedQuery): Promise<ParseResult> {
    const filters = buildResolvedFilters(query);
    const messageRows = await all<{ session_id: string; record_json: string }>(
      this.db,
      `SELECT session_id, record_json FROM resolved_usage ${filters.messageWhere}
       ORDER BY ts, source, session_id, seq`,
      filters.messageParams,
    );
    const messages = messageRows.map(
      (row) => JSON.parse(row.record_json) as MessageRecord,
    );

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
        if (keep.has(row.session_id))
          sessions.set(
            row.session_id,
            JSON.parse(row.meta_json) as SessionMeta,
          );
      }
    } else {
      for (const row of sessionRows)
        sessions.set(row.session_id, JSON.parse(row.meta_json) as SessionMeta);
    }

    const sourceJoin = buildResolvedFilters(query, {
      sourceColumn: "s.source",
    });
    const taskRows = await all<{ session_id: string; task_json: string }>(
      this.db,
      `SELECT t.session_id, t.task_json
       FROM resolved_tasks t
       JOIN resolved_sessions s ON s.session_id = t.session_id
       ${sourceJoin.sourceWhere}
       ORDER BY t.session_id, t.ts IS NULL, t.ts, t.seq`,
      sourceJoin.sourceParams,
    );
    const tasksBySession = new Map<string, TaskFact[]>();
    for (const row of taskRows) {
      if (!sessions.has(row.session_id)) continue;
      const tasks = tasksBySession.get(row.session_id) ?? [];
      tasks.push(JSON.parse(row.task_json) as TaskFact);
      tasksBySession.set(row.session_id, tasks);
    }

    // Per-tool result-size totals, derived from the unified invocation rows (#130) — one row per tool
    // *call*, so `count` is the call count and `approxTokens` sums each call's paired result size
    // (resolved_tool_results, the old per-name aggregate, is retired). Unfiltered by date/project but
    // scoped to the requested sources, matching the prior behavior.
    // NOTE: this `count` flows to heaviestToolResults[].count (on the sync wire). It is deliberately
    // redefined from the retired "#results per tool" to "#calls per tool" — calls and results aren't
    // 1:1 (a result-less call, or an orphan result dropped per #130) — and the wire shape is unchanged.
    // heaviestToolResults is ranked by approxTokens, so the count drift doesn't reorder the view.
    const toolRows = await all<{
      name: string;
      count: number;
      approx_tokens: number;
    }>(
      this.db,
      `SELECT i.tool AS name, COUNT(*) AS count, SUM(i.approx_result_tokens) AS approx_tokens
       FROM resolved_invocations i
       JOIN resolved_sessions s ON s.session_id = i.session_id
       ${sourceJoin.sourceWhere}
       GROUP BY i.tool`,
      sourceJoin.sourceParams,
    );
    const toolResults = new Map<string, ToolResultStat>();
    for (const row of toolRows)
      toolResults.set(row.name, {
        count: row.count,
        approxTokens: row.approx_tokens ?? 0,
      });

    return { messages, sessions, toolResults, tasksBySession };
  }

  materializeSessions(
    owner: string,
    sessions: MaterializeSession[],
    opts: { retainText?: boolean } = {},
  ): Promise<string[]> {
    // Default-on local text retention (#120). The caller resolves the setting; default true so any
    // caller that doesn't pass it (tests, programmatic use) gets the core behavior.
    const retainText = opts.retainText ?? true;
    return this.schedule(async () => {
      if (!sessions.length) return [];
      const keptFuller: string[] = [];
      await transaction(this.db, async () => {
        for (const session of sessions) {
          const sid = session.meta.sessionId;
          const incomingTasks = session.tasks ?? [];
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
            // We keep the fuller stored row (skipping the wholesale DELETE + its CASCADE below), but an
            // opt-out must still take effect: clear any previously retained text for this session so
            // "turn retention off and re-index removes stored text" holds even on this short-parse path (#120).
            if (!retainText) {
              await run(
                this.db,
                "DELETE FROM resolved_interaction_text WHERE session_id = ?",
                [sid],
              );
              await run(
                this.db,
                "DELETE FROM resolved_interaction_text_fts WHERE session_id = ?",
                [sid],
              );
            }
            continue;
          }
          // Interpretation is decoupled from indexing (#153): materialize never writes tasks or
          // interpretation state for an EXISTING session — it carries them forward untouched (the
          // Interpret stage's writeSessionTasks is the sole task writer). So we always read the prior
          // snapshot to preserve it, and only seed `incomingTasks` for a brand-new session (tests /
          // programmatic callers). Even when the content changed, the prior tasks stay (shown as
          // "outdated" via the timestamp comparison) until the drain re-interprets.
          const existingSnapshot = await readResolvedSessionSnapshot(
            this.db,
            sid,
          );
          const contentChanged =
            !existingSnapshot ||
            !materializedSessionMatchesSnapshot(session, existingSnapshot);
          const tasks = existingSnapshot
            ? existingSnapshot.tasks
            : incomingTasks;
          // content_indexed_at_ms is a processing-time stamp bumped ONLY on a real content change (or a
          // brand-new session). An unchanged re-materialize (e.g. a bare `index refresh`) carries the old
          // value forward, so it does not falsely mark every session outdated. interpreted_at_ms /
          // interpretation_version are always carried forward; only writeSessionTasks updates them.
          const nowMs = Date.now();
          const contentIndexedAtMs = contentChanged
            ? nowMs
            : (existingSnapshot!.contentIndexedAtMs ?? nowMs);
          const interpretedAtMs = existingSnapshot?.interpretedAtMs ?? null;
          const interpretationVersion =
            existingSnapshot?.interpretationVersion ?? null;
          // Title/summary are interpretation-owned (#234): carried forward so a re-index never wipes
          // them. Only writeSessionTasks sets them; a brand-new session has none.
          const title = existingSnapshot?.title ?? null;
          const summary = existingSnapshot?.summary ?? null;
          // Hidden is a user preference, not a disk-presence fact — unlike `archived`, a re-materialize
          // must carry it forward rather than reset it. A brand-new session defaults to visible.
          const isHidden = existingSnapshot?.isHidden ?? false;
          // Replace this session wholesale (messages, tasks, and tool results cascade via FK). A freshly
          // materialized session is present on disk, so archived resets to 0.
          await run(
            this.db,
            "DELETE FROM resolved_sessions WHERE session_id = ?",
            [sid],
          );
          // The search FTS indexes (#155, #234) are NOT linked by foreign key, so the CASCADE above does
          // not reach them — clear them explicitly here. The conversation index is rebuilt below (if
          // retainText) alongside resolved_interaction_text; the title/summary index is rebuilt from the
          // carried-forward title/summary right after the session row is re-inserted.
          await run(
            this.db,
            "DELETE FROM resolved_interaction_text_fts WHERE session_id = ?",
            [sid],
          );
          await run(
            this.db,
            "DELETE FROM resolved_sessions_fts WHERE session_id = ?",
            [sid],
          );
          const timestamps = session.messages.map((message) => message.ts);
          const firstTs = timestamps.length ? Math.min(...timestamps) : null;
          const lastTs = timestamps.length ? Math.max(...timestamps) : null;
          // Promote friction signals to columns (#121). NULL when friction isn't observable for the
          // source; friction_turns prefers the raw turn count. meta_json stays the source of truth.
          const friction = session.meta.friction;
          await run(
            this.db,
            `INSERT INTO resolved_sessions(
               session_id, owner, source, project, cwd, first_ts, last_ts, message_count, first_prompt, archived,
               friction_interruptions, friction_rejections, friction_compactions, friction_turns, last_interruption_ms,
               content_indexed_at_ms, interpreted_at_ms, interpretation_version, title, summary, is_hidden, meta_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
              friction ? friction.interruptions : null,
              friction ? friction.rejections : null,
              friction ? friction.compactions : null,
              friction ? (session.meta.rawTurns ?? friction.turns) : null,
              friction?.lastInterruptionMs ?? null,
              contentIndexedAtMs,
              interpretedAtMs,
              interpretationVersion,
              title,
              summary,
              isHidden ? 1 : 0,
              JSON.stringify(session.meta),
            ],
          );
          // Re-index the carried-forward title/summary (#234) — same wholesale replace as the row above.
          const sessionFts = sessionFtsText(title, summary);
          if (sessionFts) {
            await run(
              this.db,
              "INSERT INTO resolved_sessions_fts(session_id, text) VALUES (?, ?)",
              [sid, sessionFts],
            );
          }
          // Assign each interaction to its owning task (#122), bookmark semantics over the tasks we're
          // about to write (incoming or the preserved snapshot), so attribution stays consistent with
          // resolved_tasks.seq and survives a re-materialization that reuses the stored tasks. The leaf
          // tables carry no task pointer — task grain joins usage/invocation -> interaction -> task.
          const taskSeqByInteraction = assignInteractionTaskSeqs(
            tasks,
            session.interactions ?? [],
          );
          await insertRows(
            this.db,
            "resolved_usage",
            // Usage/model/skill are mirrored into real columns (see resolved_usage DDL) so SQL
            // can do token & cost GROUP BY without re-walking record_json in JS.
            [
              "session_id",
              "seq",
              "source",
              "ts",
              "date",
              "cwd",
              "project",
              "record_json",
              "input_tokens",
              "output_tokens",
              "cache_read",
              "cache_write_5m",
              "cache_write_1h",
              "model",
              "attribution_skill",
              "stop_reason",
              "interaction_seq",
            ],
            session.messages.map((message, seq) => [
              sid,
              seq,
              message.source,
              message.ts,
              message.date,
              message.cwd ?? "",
              message.project,
              JSON.stringify(message),
              message.usage.input,
              message.usage.output,
              message.usage.cacheRead,
              message.usage.cacheWrite5m,
              message.usage.cacheWrite1h,
              message.model,
              message.attributionSkill,
              message.stopReason ?? null,
              message.interactionSeq ?? null,
            ]),
          );
          await insertRows(
            this.db,
            "resolved_tasks",
            ["session_id", "seq", "source", "ts", "task_json"],
            tasks.map((task, seq) => [
              sid,
              seq,
              task.source,
              task.timestampMs ?? null,
              JSON.stringify(task),
            ]),
          );
          // The interaction spine (#117/#119): one row per reconcile-derived interaction. seq is the
          // interaction's own ordinal (not the array index) so the PK and interaction_json agree and
          // the usage<->interaction link references one source of truth. task_seq (#122) carries the
          // interaction's owning task — task membership lives only here.
          await insertRows(
            this.db,
            "resolved_interactions",
            [
              "session_id",
              "seq",
              "source",
              "ts",
              "initiator",
              "disposition",
              "compaction_count",
              "task_seq",
              "interaction_json",
            ],
            (session.interactions ?? []).map((interaction) => {
              // interaction_json is ALWAYS text-free: promptText/responseText are split off into
              // resolved_interaction_text (below, when retention is on), never embedded here. This keeps
              // the push path — which reads only interaction_json — text-free by construction (#120).
              const {
                promptText: _p,
                responseText: _r,
                ...stored
              } = interaction;
              return [
                sid,
                interaction.seq,
                interaction.source,
                interaction.timestampMs ?? null,
                interaction.initiator,
                interaction.disposition,
                interaction.compactionCount,
                taskSeqByInteraction.get(interaction.seq) ?? null,
                JSON.stringify(stored),
              ];
            }),
          );
          // Opt-in (default-on) local conversation-text retention (#120). Local-only — this table is
          // never read by the push path, so retained text is structurally unable to reach the Hub.
          // Tall: each interaction contributes its text chunks (prompt and/or response prose today;
          // narration later) flattened in timeline order, with `seq` a running per-session ordinal and
          // `interaction_seq` the soft link back — exactly the resolved_usage/resolved_invocations
          // shape. The wholesale per-session DELETE above already cleared any prior rows via CASCADE (and
          // the kept-fuller short-parse path clears them explicitly when retention is off), so turning
          // retention off and re-indexing leaves the table empty for the session.
          if (retainText) {
            const textRows: unknown[][] = [];
            for (const interaction of session.interactions ?? []) {
              if (interaction.promptText != null) {
                textRows.push([
                  sid,
                  textRows.length,
                  interaction.seq,
                  "prompt",
                  interaction.promptText,
                ]);
              }
              if (interaction.responseText != null) {
                textRows.push([
                  sid,
                  textRows.length,
                  interaction.seq,
                  "response",
                  interaction.responseText,
                ]);
              }
            }
            await insertRows(
              this.db,
              "resolved_interaction_text",
              ["session_id", "seq", "interaction_seq", "type", "text"],
              textRows,
            );
            // Search FTS index (#155), kept in sync by direct DML (not a trigger — see
            // RESOLVED_INTERACTION_TEXT_FTS_DDL's comment). One FTS row per text chunk, mirroring textRows.
            await insertRows(
              this.db,
              "resolved_interaction_text_fts",
              ["session_id", "text"],
              textRows.map((row) => [sid, row[4]]),
            );
          }
          // Per-tool-use rows (#113 Part B / #130) from the reconciled messages' toolUses, so byTool/
          // byMcp/bySkill/heaviestToolResults become GROUP BY queries (#121). Each row is the call+result
          // unit: approx_result_tokens carries the paired result size folded on in reconcile.
          // Flattened in one pass; seq is the array index (matches the migration's ROW_NUMBER backfill).
          await insertRows(
            this.db,
            "resolved_invocations",
            [
              "session_id",
              "seq",
              "source",
              "interaction_seq",
              "tool",
              "category",
              "mcp_server",
              "mcp_tool",
              "skill",
              "file_path",
              "date",
              "cwd",
              "args",
              "approx_result_tokens",
            ],
            session.messages
              .flatMap((message) =>
                message.toolUses.map((toolUse) => ({ message, toolUse })),
              )
              .map(({ message, toolUse }, seq) => [
                sid,
                seq,
                message.source,
                message.interactionSeq ?? null, // owning interaction (#122), from the call's message
                toolUse.name,
                toolUse.category,
                toolUse.mcpServer ?? null,
                toolUse.mcpTool ?? null,
                toolUse.skill ?? null,
                toolUse.filePath ?? null,
                message.date,
                message.cwd ?? "",
                toolUse.args ?? null,
                toolUse.approxResultTokens ?? 0,
              ]),
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
          await run(
            this.db,
            `DELETE FROM resolved_sessions WHERE session_id IN (${placeholders})`,
            part,
          );
          await run(
            this.db,
            `DELETE FROM session_ownership WHERE session_id IN (${placeholders})`,
            part,
          );
          // Labels aren't FK-linked to resolved_sessions (so they survive re-index), so remove a
          // deleted session's applications here — the one place a session truly goes away.
          await run(
            this.db,
            `DELETE FROM label_assignments WHERE session_id IN (${placeholders})`,
            part,
          );
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

  setSessionsHidden(sessionIds: string[], hidden: boolean): Promise<void> {
    return this.schedule(async () => {
      const ids = [...new Set(sessionIds)];
      if (!ids.length) return;
      const value = hidden ? 1 : 0;
      await transaction(this.db, async () => {
        // One bound slot is taken by `value`, so leave room for it in each chunk of ids.
        for (const part of chunk(ids, MAX_BOUND_PARAMS - 1)) {
          const placeholders = part.map(() => "?").join(", ");
          await run(
            this.db,
            `UPDATE resolved_sessions SET is_hidden = ? WHERE session_id IN (${placeholders})`,
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

  resolvedSessionCounts(): Promise<
    Array<{ owner: string; present: number; archived: number }>
  > {
    return this.schedule(async () => {
      const rows = await all<{
        owner: string;
        present: number;
        archived: number;
      }>(
        this.db,
        `SELECT owner,
                SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS present,
                SUM(archived) AS archived
         FROM resolved_sessions GROUP BY owner ORDER BY owner`,
      );
      return rows.map((row) => ({
        owner: row.owner,
        present: row.present,
        archived: row.archived,
      }));
    });
  }

  getClientId(): Promise<string> {
    return this.schedule(() => ensureClientIdRow(this.db));
  }

  recordClientFingerprint(
    key: string,
    value: string,
    tsMs: number,
  ): Promise<void> {
    return this.schedule(async () => {
      // Suppress repeat-of-same-value: read the latest value for this key, and only insert when it
      // actually changed. Keeps the log a record of CHANGES rather than a tick per call.
      const latest = await get<{ value: string }>(
        this.db,
        "SELECT value FROM client_fingerprint WHERE key = ? ORDER BY ts_ms DESC LIMIT 1",
        [key],
      );
      if (latest && latest.value === value) return;
      // INSERT OR IGNORE on (key, ts_ms) protects against an exact-millisecond duplicate write —
      // unlikely in practice, but cheaper than synthesizing a unique timestamp.
      await run(
        this.db,
        "INSERT OR IGNORE INTO client_fingerprint (key, value, ts_ms) VALUES (?, ?, ?)",
        [key, value, tsMs],
      );
    });
  }

  listClientFingerprint(): Promise<ClientFingerprintEntry[]> {
    return this.schedule(async () => {
      const rows = await all<{ key: string; value: string; ts_ms: number }>(
        this.db,
        "SELECT key, value, ts_ms FROM client_fingerprint ORDER BY ts_ms, key",
      );
      return rows.map((row) => ({
        key: row.key,
        value: row.value,
        tsMs: row.ts_ms,
      }));
    });
  }

  storeStats(): Promise<StoreStats> {
    return this.schedule(async () => {
      const count = async (sql: string) =>
        (await get<{ n: number }>(this.db, sql))?.n ?? 0;
      return {
        schemaVersion: await pragmaNumber(this.db, "user_version"),
        sessions: await count("SELECT COUNT(*) AS n FROM resolved_sessions"),
        messages: await count("SELECT COUNT(*) AS n FROM resolved_usage"),
        tasks: await count("SELECT COUNT(*) AS n FROM resolved_tasks"),
        // Usage rows whose owning interaction is attributed to a task (#122): join through the
        // interaction since task membership lives on resolved_interactions.task_seq, not the leaf.
        messagesWithTask: await count(
          `SELECT COUNT(*) AS n FROM resolved_usage u
           JOIN resolved_interactions i ON i.session_id = u.session_id AND i.seq = u.interaction_seq
           WHERE i.task_seq IS NOT NULL`,
        ),
      };
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

  setCoverage(
    source: string,
    filesDigest: string | null,
    sessionCount: number,
  ): Promise<void> {
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

  if (
    !Number.isInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > 60_000
  ) {
    throw new RangeError(
      "busyTimeoutMs must be an integer between 0 and 60000",
    );
  }

  try {
    prepareDatabaseFile(path);
  } catch (error) {
    throw asStoreError(error, path, busyTimeoutMs);
  }

  let db: Database | undefined;
  try {
    db = openDatabase(path, busyTimeoutMs);
    await initializeDatabase(db, path);
    return new SqliteStore(db, path, busyTimeoutMs, now);
  } catch (error) {
    if (db)
      try {
        closeDatabase(db);
      } catch {}
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
    throw new StoreError(
      "unsafe_path",
      path,
      `Won't remove the store path because it isn't a regular file: ${path}`,
    );
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
