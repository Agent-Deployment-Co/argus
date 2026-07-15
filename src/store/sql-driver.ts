// The seam behind every SQL access in store.ts (#281 Part B.1): store.ts's `run`/`exec`/`get`/`all`
// helpers and `openDatabase`/`closeDatabase`/`transaction` dispatch through this interface instead of
// calling `bun:sqlite`'s `Database` directly, so the ~160 call sites inside `SqliteStore` (which only
// ever see `this.db` typed as `SqlDriver`) are unchanged by what actually opened the connection.
//
// Two implementations:
// - `BunSqliteDriver` — today's `bun:sqlite` path, used by the CLI via `openDatabase()`. Unchanged
//   behavior: same PRAGMAs, same raw BEGIN/COMMIT transaction wrapping.
// - `DoSqliteDriver` — wraps a Cloudflare Durable Object's `ctx.storage.sql`, for the read-only public
//   demo (issue #281). DO SQLite storage is real SQLite (FTS5, window functions, `json_*` all work —
//   confirmed against local Miniflare in the issue's de-risking spike), but the platform disallows raw
//   `BEGIN`/`SAVEPOINT` and manages the file/WAL/PRAGMA layer itself.
import { Database } from "bun:sqlite";

// Minimal structural slices of the Cloudflare Workers types this driver needs — declared locally
// rather than depending on `@cloudflare/workers-types` (a CLI-only package has no business pulling in
// a Workers-runtime type package). Real `SqlStorage`/`DurableObjectState` values satisfy these
// structurally, so a Worker constructing `DoSqliteDriver` with its actual `ctx` still type-checks.
export interface DoSqlCursor<T> {
  toArray(): T[];
}
export interface DoSqlStorage {
  exec<T = unknown>(query: string, ...bindings: unknown[]): DoSqlCursor<T>;
}
export interface DoTransactionCtx {
  storage: {
    transaction<T>(closure: () => Promise<T>): Promise<T>;
  };
}

/** The minimal SQL surface `store.ts` needs, factored out so a Durable Object (real SQLite, but no
 *  file/WAL/PRAGMA layer and no raw `BEGIN`) can back the same store code as the CLI's `bun:sqlite`
 *  connection. Every method here is synchronous — both backing engines execute SQL synchronously;
 *  the `async`ness callers see comes entirely from `SqliteStore`'s operation queue, not from these
 *  calls. `transaction` is the one method that's genuinely async on both sides, since `store.ts`'s
 *  `transaction()` wraps an arbitrary `() => Promise<T>` operation (its callers `await` other store
 *  helpers inside it, which can span microtask boundaries) — see `DoSqliteDriver.transaction` below
 *  for why that rules out `ctx.storage.transactionSync`. */
export interface SqlDriver {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): void;
  get<T>(sql: string, params?: unknown[]): T | undefined;
  all<T>(sql: string, params?: unknown[]): T[];
  /** Run `operation` as one atomic unit, rolling back on throw. */
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  close(): void;
  /** Whether this engine accepts arbitrary `PRAGMA` statements (WAL/synchronous/foreign_keys/
   *  application_id/user_version/quick_check, …). True for `bun:sqlite`. False for Cloudflare's DO
   *  SQLite storage (#281 Part B.2) — its `exec()` only understands a small, fixed set of pragmas, and
   *  the platform owns the file/WAL/checkpoint layer itself, so `store.ts`'s connection/init code must
   *  skip all of that on this driver rather than sending pragmas DO doesn't support. */
  readonly supportsPragmas: boolean;
  /** Safe upper bound on `?` placeholders in one statement, used to size batched INSERT/IN-list
   *  chunking (`store.ts`'s `insertRows` and the `chunk(ids, MAX_BOUND_PARAMS...)` call sites). Kept on
   *  the driver (not a shared module constant) because the two engines' real limits differ by 10x —
   *  sqlite3's compile-time default is 999, so `bun:sqlite` keeps `900` for headroom; Cloudflare's DO
   *  SQL API caps bound parameters per query at exactly 100 (confirmed against
   *  developers.cloudflare.com/durable-objects/platform/limits/), so `DoSqliteDriver` uses `90`. */
  readonly maxBoundParams: number;
}

/** `bun:sqlite`, unchanged from before the seam existed: raw `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`
 *  for transactions (bun:sqlite has no restriction against it, unlike DO SQLite), and the caller
 *  (`store.ts`'s `openDatabase`) owns the PRAGMAs, file permissions, and WAL/`-shm` cleanup — none of
 *  that belongs in this driver, which is purely the four query primitives plus transaction/close. */
export class BunSqliteDriver implements SqlDriver {
  readonly supportsPragmas = true;
  readonly maxBoundParams = 900;

  constructor(private readonly db: Database) {}

  run(sql: string, params: unknown[] = []): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.db.query(sql).run(...(params as any[]));
  }

  exec(sql: string): void {
    this.db.run(sql);
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.db.query<T, any[]>(sql).get(...(params as any[])) as T | null) ?? undefined;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.db.query<T, any[]>(sql).all(...(params as any[]));
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    this.exec("BEGIN IMMEDIATE");
    try {
      const value = await operation();
      this.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Cloudflare Durable Object SQLite storage, for the read-only public demo (#281). `ctx.storage.sql`
 *  exposes one method, `.exec(sql, ...bindings)`, returning a synchronous cursor — `.toArray()` for
 *  `all`, its first row for `get`, and draining it for a bare `run`/`exec` (a cursor that's never
 *  iterated leaves its statement unfinalized). No PRAGMAs, no file/WAL layer: the DO platform owns
 *  storage lifecycle entirely, which is the whole reason `store.ts`'s connection/init layer (WAL
 *  PRAGMAs, ownership stamping, `chmod`/symlink guards — see `openDatabase`/`prepareDatabaseFile`)
 *  never runs on this path — none of it is compiled into a Worker build in the first place. */
export class DoSqliteDriver implements SqlDriver {
  readonly supportsPragmas = false;
  readonly maxBoundParams = 90;

  constructor(private readonly sql: DoSqlStorage, private readonly ctx: DoTransactionCtx) {}

  run(sql: string, params: unknown[] = []): void {
    this.sql.exec(sql, ...params).toArray();
  }

  exec(sql: string): void {
    this.sql.exec(sql).toArray();
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    const rows = this.sql.exec<T>(sql, ...params).toArray();
    return rows[0];
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.sql.exec<T>(sql, ...params).toArray();
  }

  // DO SQLite rejects raw BEGIN/SAVEPOINT (confirmed in the #281 de-risking spike) — grouped writes
  // must go through the JS transaction API instead. There are two: `transactionSync` (fully
  // synchronous callback, gets automatic write coalescing) and `transaction` (async callback, no
  // coalescing guarantee but safe across await boundaries). `store.ts`'s `transaction()` wraps an
  // arbitrary `() => Promise<T>` whose `await`s on `run`/`get`/`all` are synchronous in substance but
  // still yield to the microtask queue — handing that to `transactionSync` would return control to
  // Workers before the callback's later statements had run, silently splitting the "transaction"
  // across multiple write batches. `transaction` (async) is therefore the correct primitive here,
  // even though the issue's original plan named `transactionSync` — the tradeoff (no automatic write
  // coalescing) is irrelevant for a low-write, nightly-reseeded demo store.
  transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.ctx.storage.transaction(operation);
  }

  close(): void {
    // No connection to close — the DO owns storage lifecycle for the life of the object.
  }
}
