import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { STORE_APPLICATION_ID, STORE_SCHEMA_VERSION } from "./store/store.ts";
// Wire contract from the shared schema package (single source of truth). SCHEMA_VERSION comes
// from the zod-free entry so the CLI doesn't pull zod into its runtime.
import { SCHEMA_VERSION } from "@agentdeploymentco/argus-schema/version";
import type { PushPayload } from "@agentdeploymentco/argus-schema";
export { SCHEMA_VERSION };
export type { PushPayload };

/**
 * Resolve the user id for a snapshot: explicit override wins, else `git config user.email`,
 * else $USER@hostname. Used to tag whose sessions are whose in the team dashboard.
 */
export function detectUser(override?: string): string {
  if (override && override.trim()) return override.trim();
  const git = spawnSync("git", ["config", "user.email"], { encoding: "utf8" });
  if (git.status === 0 && git.stdout.trim()) return git.stdout.trim();
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return process.env.USER || "unknown";
  }
}

/** Resolve an explicit org override; otherwise let the server use the authenticated Access org. */
export function detectOrg(override?: string): string | undefined {
  if (override && override.trim()) return override.trim();
  return undefined;
}

export interface PushCredentials {
  bearerToken?: string;
  jwt?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface PushResult {
  ok: boolean;
  status: number;
  body: string;
  isAccessChallenge?: boolean;
  /** No upload was attempted because there was nothing eligible to send (e.g. the requested source is
   *  local-only). Distinct from a successful upload so callers don't report "Uploaded". */
  skipped?: boolean;
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

export interface HubUploadRows {
  sessions: HubUploadSession[];
  usage: HubUploadUsage[];
  tasks: HubUploadTask[];
  interactions: HubUploadInteraction[];
  invocations: HubUploadInvocation[];
}

export interface HubUploadPayload {
  schemaVersion: number;
  rows: HubUploadRows;
}

export interface ReadHubUploadOptions {
  /** If set, include only sessions whose IDs are in this set (and their child rows). */
  onlySessionIds?: Set<string>;
}

/** Open argus.db read-only, read all resolved_* rows, return them as plain JS objects.
 *  When `onlySessionIds` is provided, the result is filtered to those sessions and any rows
 *  referencing them — used by `sync`'s "only send what the Hub doesn't already have" path. */
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

    const allSessions = db
      .query<HubUploadSession, []>(
        `SELECT session_id, source, project, cwd, first_ts, last_ts, message_count,
                first_prompt, archived, friction_interruptions, friction_rejections,
                friction_compactions, friction_turns, last_interruption_ms, meta_json
         FROM resolved_sessions`,
      )
      .all();

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

    const filter = opts.onlySessionIds;
    if (!filter) {
      return {
        schemaVersion,
        rows: { sessions: allSessions, usage: allUsage, tasks: allTasks, interactions: allInteractions, invocations: allInvocations },
      };
    }
    const keep = (sid: string) => filter.has(sid);
    return {
      schemaVersion,
      rows: {
        sessions: allSessions.filter((s) => keep(s.session_id)),
        usage: allUsage.filter((u) => keep(u.session_id)),
        tasks: allTasks.filter((t) => keep(t.session_id)),
        interactions: allInteractions.filter((i) => keep(i.session_id)),
        invocations: allInvocations.filter((v) => keep(v.session_id)),
      },
    };
  } finally {
    db.close();
  }
}

/** Read just the session IDs from argus.db. Used to ask the Hub which ones it already has. */
export function readSessionIds(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<{ session_id: string }, []>("SELECT session_id FROM resolved_sessions")
      .all()
      .map((r) => r.session_id);
  } finally {
    db.close();
  }
}

export interface PushHubOptions {
  /** Skip the unknown-sessions probe and upload every session. */
  all?: boolean;
  /** Sink for progress messages (e.g. "Hub already has N/M sessions"). */
  log?: (message: string) => void;
}

/** Stay well under the Hub's MAX_SESSION_IDS_PER_REQUEST (10_000). */
const UNKNOWN_SESSIONS_PROBE_CHUNK = 5_000;

/** POST session data from argus.db to a Hub ingest endpoint as JSON. By default, first asks the
 *  Hub which session IDs it already has and uploads only the rest; pass `{ all: true }` to skip
 *  the probe. If the Hub returns 404 for the probe (older Hub without the endpoint), falls back
 *  to a full upload. */
export async function pushHubJson(
  hubUrl: string,
  hubKey: string,
  userId: string,
  dbPath: string,
  opts: PushHubOptions = {},
): Promise<PushResult> {
  const base = hubUrl.replace(/\/+$/, "");

  let onlySessionIds: Set<string> | undefined;
  if (!opts.all) {
    let allIds: string[];
    try {
      allIds = readSessionIds(dbPath);
    } catch (err) {
      return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
    }
    if (allIds.length === 0) {
      onlySessionIds = new Set();
    } else {
      const unknown: string[] = [];
      let probeFailedWithFallback = false;
      for (let i = 0; i < allIds.length; i += UNKNOWN_SESSIONS_PROBE_CHUNK) {
        const slice = allIds.slice(i, i + UNKNOWN_SESSIONS_PROBE_CHUNK);
        const r = await fetchUnknownSessionIds(base, hubKey, userId, slice);
        if (!r.ok) {
          if (r.status === 404) {
            opts.log?.("Hub does not support the unknown-sessions probe; uploading all sessions.");
            probeFailedWithFallback = true;
            break;
          }
          return { ok: false, status: r.status, body: r.body };
        }
        unknown.push(...r.unknownSessionIds!);
      }
      if (!probeFailedWithFallback) {
        onlySessionIds = new Set(unknown);
        const known = allIds.length - onlySessionIds.size;
        opts.log?.(`Hub already has ${known}/${allIds.length} sessions; uploading ${onlySessionIds.size}.`);
      }
    }
  }

  let body: string;
  try {
    const payload = readHubUploadPayload(dbPath, onlySessionIds ? { onlySessionIds } : {});
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
        "x-argus-user": userId,
      },
      body,
    });
    const text = await res.text();
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

/** Ask the Hub which of `sessionIds` it does NOT already have for `userId`. Returns the parsed
 *  list on success, or a non-ok result describing the failure (network error, non-2xx, or a
 *  malformed body). */
export async function fetchUnknownSessionIds(
  hubBaseUrl: string,
  hubKey: string,
  userId: string,
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
        "x-argus-user": userId,
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

/** POST a per-user snapshot to the Worker ingest endpoint using Cloudflare Access. */
export async function pushSnapshot(
  endpoint: string,
  credentials: PushCredentials,
  payload: PushPayload,
): Promise<PushResult> {
  const url = endpoint.replace(/\/+$/, "") + "/ingest";
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (credentials.clientId && credentials.clientSecret) {
    headers["cf-access-client-id"] = credentials.clientId;
    headers["cf-access-client-secret"] = credentials.clientSecret;
  } else if (credentials.bearerToken) {
    headers.authorization = `Bearer ${credentials.bearerToken}`;
  } else if (credentials.jwt) {
    headers["cf-access-token"] = credentials.jwt;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  const contentType = res.headers.get("content-type") || "";
  const authenticate = res.headers.get("www-authenticate") || "";
  const isAccessChallenge =
    contentType.includes("text/html") ||
    (res.status === 401 && authenticate.toLowerCase().includes("resource_metadata"));
  return { ok: res.ok && !isAccessChallenge, status: res.status, body, isAccessChallenge };
}
