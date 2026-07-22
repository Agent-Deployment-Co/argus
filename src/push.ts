import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { STORE_APPLICATION_ID, STORE_SCHEMA_VERSION } from "./store/store.ts";
import { PARSED_FRAGMENT_CONTRACT_VERSION } from "./store/store-contract.ts";

/** Pull the human-readable message out of a Hub/Worker JSON error body (`{ "error": "..." }`),
 *  falling back to the raw text when it isn't that shape. The Hub's 422 body states the actual
 *  direction of a version mismatch (client too new → update the Hub; client too old → re-index),
 *  so surfacing it verbatim beats a hardcoded guess. */
export function hubErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return body.slice(0, 400);
}

export interface PushResult {
  ok: boolean;
  status: number;
  body: string;
  /** No upload was attempted because there was nothing eligible to send (e.g. the requested source is
   *  local-only). Distinct from a successful upload so callers don't report "Uploaded". */
  skipped?: boolean;
  /** Hub settings are not complete yet. Watchers should keep checking so settings added while the
   *  process is running take effect without a restart. */
  notConfigured?: boolean;
}

// ---- Hub JSON payload shape (mirrors hub's HubUploadRows row shapes) --------------------

export interface HubUploadSession {
  session_id: string;
  source: string;
  project: string;
  cwd: string;
  first_ts: number | null;
  last_ts: number | null;
  message_count: number;
  first_prompt: string | null;
  archived: number;
  friction_interruptions: number | null;
  friction_rejections: number | null;
  friction_compactions: number | null;
  friction_turns: number | null;
  last_interruption_ms: number | null;
  title: string | null;
  summary: string | null;
  meta_json: string;
}

export interface HubUploadUsage {
  session_id: string;
  seq: number;
  source: string;
  ts: number;
  date: string;
  cwd: string;
  project: string;
  record_json: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read: number | null;
  cache_write_5m: number | null;
  cache_write_1h: number | null;
  model: string | null;
  attribution_skill: string | null;
  stop_reason: string | null;
  interaction_seq: number | null;
}

export interface HubUploadTask {
  session_id: string;
  seq: number;
  source: string;
  ts: number | null;
  task_json: string;
}

export interface HubUploadInteraction {
  session_id: string;
  seq: number;
  source: string;
  ts: number | null;
  initiator: string;
  disposition: string;
  compaction_count: number;
  task_seq: number | null;
  interaction_json: string;
}

export interface HubUploadInvocation {
  session_id: string;
  seq: number;
  source: string;
  interaction_seq: number | null;
  tool: string;
  category: string;
  mcp_server: string | null;
  mcp_tool: string | null;
  skill: string | null;
  file_path: string | null;
  date: string | null;
  cwd: string | null;
  args: string | null;
  approx_result_tokens: number;
}

/** One label applied to a session or one of its tasks, denormalized: the label's `name`/`origin`
 *  are carried inline so the Hub needs no separate label-definition sync. Session-scoped — rides
 *  the same keep-set and cursor as tasks/interactions. Soft-deleted labels are excluded at read time. */
export interface HubUploadLabel {
  session_id: string;
  source: string;
  name: string;
  origin: string;
  applied_by: string;
  target_kind: string;
  task_seq: number | null;
  applied_at_ms: number;
}

export interface HubUploadRows {
  sessions: HubUploadSession[];
  usage: HubUploadUsage[];
  tasks: HubUploadTask[];
  interactions: HubUploadInteraction[];
  invocations: HubUploadInvocation[];
  labels: HubUploadLabel[];
}

export interface HubFingerprintEntry {
  key: string;
  value: string;
  tsMs: number;
}

export interface HubUploadPayload {
  schemaVersion: number;
  rows: HubUploadRows;
  /** Client-fingerprint observations the hub uses to attribute this client to a user.
   *  Already changes-only (the local store dedupes repeat-same-value writes), so we send
   *  the full log every time. */
  fingerprint: HubFingerprintEntry[];
}

export interface HubUploadFilters {
  /** Restrict to a specific transcript source (e.g. "claude", "codex"). Omit or "all" for all sources. */
  source?: string;
  /** Only sessions with activity on or after this YYYY-MM-DD date. */
  since?: string;
  /** Only sessions with activity on or before this YYYY-MM-DD date. */
  until?: string;
  /** Only sessions whose project path contains this substring. */
  project?: string;
}

export interface ReadHubUploadOptions extends HubUploadFilters {
  /** If set, include only sessions whose IDs are in this set (and their child rows). */
  onlySessionIds?: Set<string>;
}

/** Sources that must never appear in Hub uploads regardless of the source filter.
 *  Mirrors LOCAL_ONLY_SOURCES in reporting/dashboard-builder.ts; kept here so push.ts
 *  has no dependency on the reporting layer. */
const LOCAL_ONLY_HUB_SOURCES = ["claude-chat"] as const;

/** Build a SQL WHERE clause fragment (with leading space + AND if needed) and its parameter list
 *  from the upload filters. The session table must be aliased as `s` in the outer query. */
function buildSessionWhere(filters: HubUploadFilters): { where: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filters.source && filters.source !== "all") {
    clauses.push("s.source = ?");
    params.push(filters.source);
  }
  // Always exclude local-only sources — they are indexed locally but must never reach Hub
  // regardless of what `source` filter was passed.
  clauses.push(`s.source NOT IN (${LOCAL_ONLY_HUB_SOURCES.map(() => "?").join(", ")})`);
  params.push(...LOCAL_ONLY_HUB_SOURCES);
  if (filters.project) {
    clauses.push("(s.project LIKE ? OR s.cwd LIKE ?)");
    params.push(`%${filters.project}%`, `%${filters.project}%`);
  }
  if (filters.since) {
    const sinceMs = new Date(`${filters.since}T00:00:00Z`).getTime();
    clauses.push("(s.last_ts IS NULL OR s.last_ts >= ?)");
    params.push(sinceMs);
  }
  if (filters.until) {
    const untilMs = new Date(`${filters.until}T23:59:59.999Z`).getTime();
    clauses.push("(s.first_ts IS NULL OR s.first_ts <= ?)");
    params.push(untilMs);
  }
  return {
    where: clauses.length > 0 ? " WHERE " + clauses.join(" AND ") : "",
    params,
  };
}

export interface HubSessionCursorRow {
  sessionId: string;
  lastTs: number | null;
  /** SHA-256 hex of key session fields at upload time — used to detect reindexed data. */
  contentDigest: string;
  /** PARSED_FRAGMENT_CONTRACT_VERSION at upload time — bump triggers full re-upload. */
  parserVersion: number;
}

export interface HubSessionCursorSelection {
  totalSessions: number;
  sessions: HubSessionCursorRow[];
  /** Digest info for ALL filtered sessions, not just the changed subset — used when probe-recovered
   *  sessions need to be included in the upload with accurate cursor data. */
  allSessionData: Map<string, HubSessionCursorRow>;
}

/** Read the per-install client id from argus.db's store_metadata table. Throws if the
 *  row is missing — the store creates it on first open, so absence means a malformed db. */
export function readClientId(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query<{ value: string }, []>("SELECT value FROM store_metadata WHERE key = 'client_id'")
      .get();
    if (!row?.value) throw new Error(`${dbPath} is missing the per-install client_id row.`);
    return row.value;
  } finally {
    db.close();
  }
}

/** Open argus.db read-only, read all resolved_* rows, return them as plain JS objects.
 *  Source/project/since/until filters narrow which sessions are selected; `onlySessionIds`
 *  further restricts to a specific set (used by the cursor-based "only changed" path). */
export function readHubUploadPayload(
  dbPath: string,
  opts: ReadHubUploadOptions = {},
): HubUploadPayload {
  const db = new Database(dbPath, { readonly: true });
  try {
    const appId = db.query<{ application_id: number }, []>("PRAGMA application_id").get();
    if (appId?.application_id !== STORE_APPLICATION_ID) {
      throw new Error(`${dbPath} is not an Argus store.`);
    }
    const ver = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    const schemaVersion = ver?.user_version ?? 0;

    const { where: sessionWhere, params: sessionParams } = buildSessionWhere(opts);
    const allSessions = db
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .query<HubUploadSession, any[]>(
        `SELECT s.session_id, s.source, s.project, s.cwd, s.first_ts, s.last_ts, s.message_count,
                s.first_prompt, s.archived, s.friction_interruptions, s.friction_rejections,
                s.friction_compactions, s.friction_turns, s.last_interruption_ms,
                s.title, s.summary, s.meta_json
         FROM resolved_sessions s${sessionWhere}`,
      )
      .all(...sessionParams);

    const fingerprint = db
      .query<{ key: string; value: string; ts_ms: number }, []>(
        "SELECT key, value, ts_ms FROM client_fingerprint ORDER BY ts_ms, key",
      )
      .all()
      .map((r) => ({ key: r.key, value: r.value, tsMs: r.ts_ms }));

    // Build the set of session IDs to include, applying onlySessionIds restriction on top of filters.
    const filterIds = opts.onlySessionIds;
    const keep = new Set(
      filterIds
        ? allSessions.filter((s) => filterIds.has(s.session_id)).map((s) => s.session_id)
        : allSessions.map((s) => s.session_id),
    );

    if (keep.size === 0) {
      return {
        schemaVersion,
        rows: { sessions: [], usage: [], tasks: [], interactions: [], invocations: [], labels: [] },
        fingerprint,
      };
    }

    const keepFn = (sid: string) => keep.has(sid);
    const sessions = allSessions.filter((s) => keep.has(s.session_id));

    const allUsage = db
      .query<HubUploadUsage, []>(
        `SELECT session_id, seq, source, ts, date, cwd, project, record_json,
                input_tokens, output_tokens, cache_read, cache_write_5m, cache_write_1h,
                model, attribution_skill, stop_reason, interaction_seq
         FROM resolved_usage`,
      )
      .all();

    const allTasks = db
      .query<HubUploadTask, []>(
        "SELECT session_id, seq, source, ts, task_json FROM resolved_tasks",
      )
      .all();

    const allInteractions = db
      .query<HubUploadInteraction, []>(
        `SELECT session_id, seq, source, ts, initiator, disposition,
                compaction_count, task_seq, interaction_json
         FROM resolved_interactions`,
      )
      .all();

    const allInvocations = db
      .query<HubUploadInvocation, []>(
        `SELECT session_id, seq, source, interaction_seq, tool, category,
                mcp_server, mcp_tool, skill, file_path, date, cwd, args,
                approx_result_tokens
         FROM resolved_invocations`,
      )
      .all();

    const allLabels = readLabelRows(db);

    return {
      schemaVersion,
      rows: {
        sessions,
        usage: allUsage.filter((u) => keepFn(u.session_id)),
        tasks: allTasks.filter((t) => keepFn(t.session_id)),
        interactions: allInteractions.filter((i) => keepFn(i.session_id)),
        invocations: allInvocations.filter((v) => keepFn(v.session_id)),
        labels: allLabels.filter((l) => keepFn(l.session_id)),
      },
      fingerprint,
    };
  } finally {
    db.close();
  }
}

/** Read session IDs from argus.db, optionally filtered. Used to ask the Hub which ones it already has. */
export function readSessionIds(dbPath: string, filters: HubUploadFilters = {}): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const { where, params } = buildSessionWhere(filters);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return db
      .query<{ session_id: string }, any[]>(`SELECT s.session_id FROM resolved_sessions s${where}`)
      .all(...params)
      .map((r) => r.session_id);
  } finally {
    db.close();
  }
}

/** Read all applied labels (active definitions only), denormalized with the label name/origin and
 *  the owning session's source, for the Hub upload. Shared by the payload read and the cursor scan
 *  so both see the same label state. */
function readLabelRows(db: Database): HubUploadLabel[] {
  return db
    .query<HubUploadLabel, []>(
      `SELECT la.session_id AS session_id, s.source AS source, l.name AS name, l.origin AS origin,
              la.applied_by AS applied_by, la.target_kind AS target_kind,
              la.task_seq AS task_seq, la.applied_at_ms AS applied_at_ms
       FROM label_assignments la
       JOIN labels l ON l.id = la.label_id
       JOIN resolved_sessions s ON s.session_id = la.session_id
       WHERE l.deleted_at_ms IS NULL`,
    )
    .all();
}

/** Stable fingerprint of a session's applied labels — sorted so order doesn't matter, keyed by
 *  name (so a global rename/delete propagates to the digest) plus origin/appliedBy/target. */
function labelFingerprint(
  labels: { name: string; origin: string; applied_by: string; target_kind: string; task_seq: number | null }[],
): string {
  return JSON.stringify(
    labels
      // JSON-encode each field as a tuple so a name containing the old ":"/"|" delimiters can't
      // collide two distinct label states onto the same fingerprint (missed re-sync).
      .map((l) => [l.target_kind, l.task_seq, l.name, l.origin, l.applied_by])
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
  );
}

/** Compute a stable digest from session fields that can change without advancing last_ts:
 *  archive state, message count, task count, first_prompt, the model-generated title/summary
 *  (#234), and the applied-label fingerprint. */
function computeSessionDigest(
  sessionId: string,
  archived: number,
  messageCount: number,
  taskCount: number,
  firstPrompt: string | null,
  title: string | null,
  summary: string | null,
  labelFp: string,
): string {
  return createHash("sha256")
    .update(
      `${sessionId}|${archived}|${messageCount}|${taskCount}|${firstPrompt ?? ""}` +
        `|${title ?? ""}|${summary ?? ""}|${labelFp}`,
    )
    .digest("hex");
}

function shouldUploadForCursor(
  localLastTs: number | null,
  cursorLastTs: number | null,
  hasCursor: boolean,
  localDigest: string,
  cursorDigest: string | null,
  localParserVersion: number,
  cursorParserVersion: number | null,
): boolean {
  if (!hasCursor) return true;
  // Pre-v17 cursor has no digest/parserVersion; treat as upload-worthy to refresh with new cursor data.
  if (cursorDigest == null || cursorParserVersion == null) return true;
  if (localParserVersion !== cursorParserVersion) return true; // parser upgraded
  if (localDigest !== cursorDigest) return true; // content changed (tasks, archive state, etc.)
  if (localLastTs === cursorLastTs) return false;
  if (localLastTs == null || cursorLastTs == null) return true;
  return localLastTs > cursorLastTs;
}

/** Select sessions this client has not successfully uploaded to this Hub at the current local
 *  timestamp/digest/parserVersion. Also returns digest info for ALL filtered sessions so the
 *  caller can populate cursor data for probe-recovered sessions.
 *  Source/project/since/until filters restrict the candidate set the same way `pushHubJson` does. */
export function readChangedHubSessionIds(
  dbPath: string,
  hubUrl: string,
  clientId: string,
  filters: HubUploadFilters = {},
): HubSessionCursorSelection {
  const db = new Database(dbPath, { readonly: true });
  try {
    const { where: filterWhere, params: filterParams } = buildSessionWhere(filters);
    const rows = db
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .query<{
        session_id: string;
        last_ts: number | null;
        archived: number;
        message_count: number;
        first_prompt: string | null;
        title: string | null;
        summary: string | null;
        task_count: number;
        cursor_session_id: string | null;
        cursor_last_ts: number | null;
        cursor_digest: string | null;
        cursor_parser_version: number | null;
      }, any[]>(
        `SELECT s.session_id, s.last_ts, s.archived, s.message_count, s.first_prompt,
                s.title, s.summary,
                COUNT(t.seq) AS task_count,
                c.session_id AS cursor_session_id,
                c.last_ts AS cursor_last_ts,
                c.content_digest AS cursor_digest,
                c.parser_version AS cursor_parser_version
         FROM resolved_sessions s
         LEFT JOIN resolved_tasks t ON t.session_id = s.session_id
         LEFT JOIN hub_session_cursors c
           ON c.hub_url = ?
          AND c.client_id = ?
          AND c.session_id = s.session_id${filterWhere}
         GROUP BY s.session_id
         ORDER BY s.last_ts, s.session_id`,
      )
      .all(hubUrl, clientId, ...filterParams);

    // Group applied labels by session so each session's digest reflects its label state (labels
    // are edited independently of session activity, so they must feed the content digest).
    const labelsBySession = new Map<string, HubUploadLabel[]>();
    for (const label of readLabelRows(db)) {
      const list = labelsBySession.get(label.session_id);
      if (list) list.push(label);
      else labelsBySession.set(label.session_id, [label]);
    }

    const allSessionData = new Map<string, HubSessionCursorRow>();
    const changed: HubSessionCursorRow[] = [];
    for (const row of rows) {
      const localDigest = computeSessionDigest(
        row.session_id,
        row.archived,
        row.message_count,
        row.task_count,
        row.first_prompt,
        row.title,
        row.summary,
        labelFingerprint(labelsBySession.get(row.session_id) ?? []),
      );
      const cursorRow: HubSessionCursorRow = {
        sessionId: row.session_id,
        lastTs: row.last_ts,
        contentDigest: localDigest,
        parserVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
      };
      allSessionData.set(row.session_id, cursorRow);
      if (shouldUploadForCursor(
        row.last_ts,
        row.cursor_last_ts,
        row.cursor_session_id != null,
        localDigest,
        row.cursor_digest,
        PARSED_FRAGMENT_CONTRACT_VERSION,
        row.cursor_parser_version,
      )) {
        changed.push(cursorRow);
      }
    }
    return { totalSessions: rows.length, sessions: changed, allSessionData };
  } finally {
    db.close();
  }
}

/** Mark exactly the sessions accepted by the Hub. Call this only after `/api/sync` succeeds. */
export function markHubSessionsUploaded(
  dbPath: string,
  hubUrl: string,
  clientId: string,
  sessions: HubSessionCursorRow[],
  nowMs: number = Date.now(),
): void {
  if (sessions.length === 0) return;
  const db = new Database(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = db.query<void, [string, string, string, number | null, string, number, number]>(
        `INSERT INTO hub_session_cursors(hub_url, client_id, session_id, last_ts, content_digest, parser_version, uploaded_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hub_url, client_id, session_id) DO UPDATE SET
           last_ts = excluded.last_ts,
           content_digest = excluded.content_digest,
           parser_version = excluded.parser_version,
           uploaded_at_ms = excluded.uploaded_at_ms`,
      );
      for (const session of sessions) {
        stmt.run(hubUrl, clientId, session.sessionId, session.lastTs, session.contentDigest, session.parserVersion, nowMs);
      }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      throw err;
    }
  } finally {
    db.close();
  }
}

export interface PushHubOptions extends HubUploadFilters {
  /** Skip local cursor filtering and upload every session. */
  all?: boolean;
  /** Sink for progress messages (e.g. "Hub already has N/M sessions at the latest local timestamp"). */
  log?: (message: string) => void;
}

/** POST session data from argus.db to a Hub ingest endpoint as JSON. The client identifies
 *  itself by its per-install `client-<uuid>` (read from argus.db's store_metadata). By default,
 *  local per-Hub cursors select sessions the Hub has not accepted at the current last_ts; pass
 *  `{ all: true }` to refresh the Hub with every session. */
export async function pushHubJson(
  hubUrl: string,
  hubKey: string,
  dbPath: string,
  opts: PushHubOptions = {},
): Promise<PushResult> {
  const base = hubUrl.replace(/\/+$/, "");

  let clientId: string;
  try {
    clientId = readClientId(dbPath);
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }

  const filters: HubUploadFilters = { source: opts.source, since: opts.since, until: opts.until, project: opts.project };

  // allSessionData maps session_id → current HubSessionCursorRow with digest info;
  // populated by readChangedHubSessionIds for the non-all path, or computed inline for --all.
  let allSessionData: Map<string, HubSessionCursorRow> | undefined;
  let onlySessionIds: Set<string> | undefined;
  if (!opts.all) {
    let selection: HubSessionCursorSelection;
    try {
      selection = readChangedHubSessionIds(dbPath, base, clientId, filters);
    } catch (err) {
      return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
    }
    allSessionData = selection.allSessionData;
    onlySessionIds = new Set(selection.sessions.map((session) => session.sessionId));

    // Probe the Hub for sessions it doesn't know about. A restored/wiped Hub DB returns sessions
    // the local cursor already marked as uploaded — the probe catches them and adds them back.
    // 404 means older Hub without this endpoint → fall back to full upload. Any other probe failure
    // is non-fatal: log and continue with cursor-only selection.
    let allIds: string[];
    try {
      allIds = readSessionIds(dbPath, filters);
    } catch (err) {
      allIds = [];
    }
    if (allIds.length > 0) {
      const CHUNK = 10_000;
      let probeFailed = false;
      let probeFallbackFull = false;
      for (let i = 0; i < allIds.length; i += CHUNK) {
        const chunk = allIds.slice(i, i + CHUNK);
        const probeResult = await fetchUnknownSessionIds(base, hubKey, clientId, chunk);
        if (!probeResult.ok) {
          if (probeResult.status === 404) {
            probeFallbackFull = true;
          } else {
            probeFailed = true;
          }
          break;
        }
        for (const id of probeResult.unknownSessionIds ?? []) onlySessionIds.add(id);
      }
      if (probeFallbackFull) {
        onlySessionIds = undefined; // Hub doesn't support probe — upload everything
        opts.log?.("Hub does not support unknown-session probe; uploading all sessions.");
      } else if (probeFailed) {
        opts.log?.("Hub probe failed; falling back to cursor-only selection.");
      }
    }

    const known = selection.totalSessions - (onlySessionIds?.size ?? 0);
    opts.log?.(`Hub already has ${known}/${selection.totalSessions} sessions at the latest local timestamp; uploading ${onlySessionIds?.size ?? selection.totalSessions}.`);
  }

  let uploadedSessions: HubSessionCursorRow[];
  let body: string;
  try {
    const payload = readHubUploadPayload(dbPath, onlySessionIds ? { ...filters, onlySessionIds } : filters);
    if (opts.all) {
      // --all path: compute digests for all sessions being uploaded
      const digestSelection = readChangedHubSessionIds(dbPath, base, clientId, filters);
      allSessionData = digestSelection.allSessionData;
      opts.log?.(`Uploading all ${payload.rows.sessions.length} sessions and refreshing Hub cursors.`);
    }
    uploadedSessions = payload.rows.sessions.map((session) => {
      const cursor = allSessionData?.get(session.session_id);
      return {
        sessionId: session.session_id,
        lastTs: session.last_ts,
        contentDigest: cursor?.contentDigest ?? computeSessionDigest(
          session.session_id, session.archived, session.message_count, 0, session.first_prompt,
          session.title, session.summary,
          labelFingerprint(payload.rows.labels.filter((l) => l.session_id === session.session_id)),
        ),
        parserVersion: cursor?.parserVersion ?? PARSED_FRAGMENT_CONTRACT_VERSION,
      };
    });
    body = JSON.stringify(payload);
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
  try {
    const res = await fetch(base + "/api/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hubKey}`,
        "x-argus-client": clientId,
      },
      body,
    });
    const text = await res.text();
    if (res.ok) {
      try {
        markHubSessionsUploaded(dbPath, base, clientId, uploadedSessions);
      } catch (err) {
        return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
      }
    }
    return { ok: res.ok, status: res.status, body: text };
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}

export interface UnknownSessionsResult {
  ok: boolean;
  status: number;
  body: string;
  unknownSessionIds?: string[];
}

/** Ask the Hub which of `sessionIds` it does NOT already have for this client. Returns the
 *  parsed list on success, or a non-ok result describing the failure (network error, non-2xx,
 *  or a malformed body). */
export async function fetchUnknownSessionIds(
  hubBaseUrl: string,
  hubKey: string,
  clientId: string,
  sessionIds: string[],
): Promise<UnknownSessionsResult> {
  const url = hubBaseUrl.replace(/\/+$/, "") + "/api/sync/unknown-sessions";
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hubKey}`,
        "x-argus-client": clientId,
      },
      body: JSON.stringify({ sessionIds }),
    });
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, body: text };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (err) {
    return { ok: false, status: 0, body: `Malformed JSON from Hub: ${err instanceof Error ? err.message : String(err)}` };
  }
  const ids = (parsed as { unknownSessionIds?: unknown })?.unknownSessionIds;
  if (!Array.isArray(ids) || !ids.every((v) => typeof v === "string")) {
    return { ok: false, status: 0, body: "Malformed unknown-sessions response from Hub." };
  }
  return { ok: true, status: res.status, body: text, unknownSessionIds: ids as string[] };
}

export { STORE_SCHEMA_VERSION };
