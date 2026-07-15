// A build-time-only stand-in for `bun:sqlite`, aliased in wrangler.toml. store.ts imports `Database`/
// `SQLiteError` from `bun:sqlite` unconditionally (for BunSqliteDriver + the CLI's error-mapping) — a
// real dependency on the CLI path, but dead code from the Worker's perspective: the Worker only ever
// calls `openStoreWithDriver` with a `DoSqliteDriver`, never `openStore`/`openDatabase`, so nothing here
// is reachable at runtime. It exists purely so wrangler's bundler has *something* to resolve
// "bun:sqlite" to — esbuild can't leave an import unresolved even when the code path is dead (#281 Part
// B.4's de-risking spike confirmed `bun:sqlite` has no Workers equivalent and errors the build outright
// without this alias). If either symbol is ever actually invoked in a Worker context, that's a real bug
// in this Worker's own code, not something to silently paper over — hence throwing rather than a no-op.
export class Database {
  constructor(..._args: unknown[]) {
    throw new Error("bun:sqlite is not available in the Workers runtime.");
  }
}

export class SQLiteError extends Error {
  code?: string;
}
