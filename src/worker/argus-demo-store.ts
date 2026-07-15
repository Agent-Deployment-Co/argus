// The Durable Object backing the read-only public demo (#281 Part B.4): one named instance
// (`idFromName("demo")`) holds a single SqliteStore over its own DO SQLite storage for the object's
// entire lifetime, serving the read-only `createApp` routes plus a token-guarded seed endpoint the
// nightly GitHub Action (re)fills (Part B.3). No `@cloudflare/workers-types` dependency — see
// sql-driver.ts's own note on why; `DoSqlStorage`/`DoTransactionCtx` (exported from there) are the
// structural slices this class actually touches, and real Workers `ctx`/`ctx.storage.sql` values
// satisfy them as-is.
import { createApp } from "../api/serve.ts";
import { openStoreWithDriver, type SqliteStore } from "../store/store.ts";
import { DoSqliteDriver, type DoSqlStorage, type DoTransactionCtx } from "../store/sql-driver.ts";
import { buildDemoViews } from "./demo-views.ts";
import { parseDemoSnapshot } from "./demo-snapshot.ts";
import { INTERPRETER_VERSION } from "../indexing/interpret/index.ts";

interface DemoDurableObjectState extends DoTransactionCtx {
  storage: DoTransactionCtx["storage"] & { sql: DoSqlStorage };
}

export interface DemoEnv {
  /** Bearer token the nightly seed Action authenticates `/admin/seed` with (Part B.3). Unset means
   *  seeding is off — `/admin/seed` answers 503 rather than silently accepting an unauthenticated
   *  write, since an empty/undefined token must never be treated as "no auth required". */
  SEED_TOKEN?: string;
}

/** Every table `materializeSessions`/`writeSessionTasks` populate that a wholesale reseed must clear
 *  before replaying the new snapshot. `resolved_usage`/`resolved_tasks`/`resolved_interactions`/
 *  `resolved_invocations`/`resolved_interaction_text` all `REFERENCES resolved_sessions(session_id)
 *  ON DELETE CASCADE` and are deliberately NOT listed here — deleting `resolved_sessions` clears them
 *  too. Confirmed against Miniflare's DO SQLite emulation (not yet against a real Cloudflare account,
 *  same caveat as the rest of #281's de-risking) that cascade fires with no `PRAGMA foreign_keys`
 *  statement ever sent: DO SQLite reports `foreign_keys = 1` from a fresh connection and rejects
 *  attempts to change it, unlike bun:sqlite/plain SQLite's OFF-by-default. The three FTS tables below
 *  are plain (non-external-content) virtual tables the app writes to explicitly alongside their
 *  source row — SQLite doesn't sync them automatically, so cascade never reaches them. */
const SESSION_SCOPED_TABLES = [
  "resolved_sessions",
  "session_ownership",
  "label_assignments",
  "resolved_sessions_fts",
  "resolved_tasks_fts",
  "resolved_interaction_text_fts",
] as const;

export class ArgusDemoStore {
  private driver: DoSqliteDriver | undefined;
  private store: SqliteStore | undefined;
  private app: ReturnType<typeof createApp> | undefined;
  private openingPromise: Promise<void> | undefined;

  constructor(
    private readonly ctx: DemoDurableObjectState,
    private readonly env: DemoEnv,
  ) {}

  // Opened lazily (memoized on the promise, so concurrent first-requests share one open) rather than
  // in the constructor — DO constructors can't await, and every request after the first is instant
  // since the object stays alive across requests on the same instance.
  private async ensureOpen(): Promise<void> {
    if (this.app) return;
    this.openingPromise ??= (async () => {
      this.driver = new DoSqliteDriver(this.ctx.storage.sql, this.ctx);
      this.store = await openStoreWithDriver(this.driver, "do:demo");
      await this.rebuildApp();
    })();
    await this.openingPromise;
  }

  // Rebuilds the Hono app (and the plugin inventory it closes over — buildDemoViews reads it once at
  // build time, not per request) — called on first open and again after a successful seed, since the
  // seed is the only thing that ever changes the plugin inventory on this store.
  private async rebuildApp(): Promise<void> {
    const demo = await buildDemoViews(this.store!);
    // webRoot is null: this DO answers /api/* JSON only — the Worker's own fetch handler serves the
    // SPA + static assets straight off the Assets binding, never through this Hono app.
    this.app = createApp(null, { ...demo, demo: true });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/admin/seed" && request.method === "POST") return this.handleSeed(request);
    await this.ensureOpen();
    return this.app!.fetch(request);
  }

  private async handleSeed(request: Request): Promise<Response> {
    // Rejecting before ever reading the POST body leaves its stream unconsumed; drain it on every
    // early-return path (`.text()`, ignoring the result) before responding.
    if (!this.env.SEED_TOKEN) {
      await request.text().catch(() => {});
      return textResponse("Seeding isn't configured on this deployment.", 503);
    }
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${this.env.SEED_TOKEN}`) {
      await request.text().catch(() => {});
      return textResponse("Unauthorized.", 401);
    }

    let snapshot;
    try {
      snapshot = parseDemoSnapshot(await request.json());
    } catch (error) {
      return textResponse(`Bad seed payload: ${error instanceof Error ? error.message : String(error)}`, 400);
    }

    await this.ensureOpen();
    const store = this.store!;
    const driver = this.driver!;

    await driver.transaction(async () => {
      for (const table of SESSION_SCOPED_TABLES) driver.exec(`DELETE FROM ${table}`);
    });
    for (const [owner, sessions] of snapshot.sessionsByOwner) {
      await store.materializeSessions(owner, sessions);
    }
    const interpretationBySession = new Map(snapshot.interpretationBySession);
    for (const [sessionId, tasks] of snapshot.tasksBySession) {
      const interpretation = interpretationBySession.get(sessionId);
      await store.writeSessionTasks(
        sessionId,
        tasks,
        INTERPRETER_VERSION,
        interpretation?.title ?? null,
        interpretation?.summary ?? null,
      );
    }
    await store.setPluginInventoryJson(snapshot.settingsJson, snapshot.installedPluginsJson);

    // The plugin inventory the running app closes over is stale the moment setPluginInventoryJson
    // above returns — rebuild so the very next request sees it, not just the one after that.
    await this.rebuildApp();

    return textResponse(
      `Seeded ${snapshot.sessionsByOwner.reduce((n, [, sessions]) => n + sessions.length, 0)} session(s).`,
      200,
    );
  }
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}
