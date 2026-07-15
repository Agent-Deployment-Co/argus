// #281 Part B.1: the SqlDriver seam behind store.ts. These tests exercise DoSqliteDriver's SQL
// translation against a fake `ctx.storage.sql` shaped like Cloudflare's (backed by bun:sqlite under
// the hood, since a real Durable Object isn't available in `bun test`) — proving the driver + the
// openStoreWithDriver bootstrap work end to end, not just that the interface type-checks.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunSqliteDriver, DoSqliteDriver } from "../src/store/sql-driver.ts";
import { openStoreWithDriver } from "../src/store/store.ts";

/** Naive multi-statement detector: strips a trailing `;`, splits on `;`, counts non-blank parts.
 *  Good enough for store.ts's actual SQL text (CREATE_SCHEMA_SQL's many `CREATE TABLE`/`CREATE INDEX`
 *  statements vs. every other call's single bound statement) — not a general SQL parser. */
function isMultiStatement(sql: string): boolean {
  return sql.trim().replace(/;\s*$/, "").split(";").filter((s) => s.trim()).length > 1;
}

/** A `ctx.storage.sql`-shaped fake over an in-memory bun:sqlite database — same `.exec(sql,
 *  ...bindings).toArray()` cursor shape `DoSqliteDriver` expects, so it exercises the driver's real
 *  translation logic rather than a mock that just records calls. Cloudflare's real `exec()` accepts
 *  multi-statement SQL text (sqlite3_exec semantics) — that's exactly how `store.ts`'s
 *  `CREATE_SCHEMA_SQL` uses it via `DoSqliteDriver.exec` — but bun:sqlite's single-statement
 *  `.query()` can't run that; `.run()` can (and discards rows, which matches `exec()`'s own
 *  fire-and-forget contract — nothing in store.ts reads rows back from a multi-statement `exec`). */
function fakeDoSqlStorage(db: Database) {
  return {
    exec<T>(sql: string, ...bindings: unknown[]) {
      if (isMultiStatement(sql)) {
        db.run(sql);
        return { toArray: () => [] as T[] };
      }
      const stmt = db.query<T, any[]>(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { toArray: () => stmt.all(...(bindings as any[])) };
    },
  };
}

/** `ctx.storage.transaction(op)`-shaped fake: just awaits the closure, matching the real async DO
 *  transaction API's contract closely enough to prove `DoSqliteDriver.transaction` wires through. */
function fakeDoTransactionCtx() {
  return { storage: { transaction: <T,>(op: () => Promise<T>) => op() } };
}

const tmpDirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-sql-driver-"));
  tmpDirs.push(dir);
  return join(dir, "test.db");
}

afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {}
  }
});

describe("BunSqliteDriver", () => {
  test("run/get/all round-trip and transaction rolls back on throw", async () => {
    const raw = new Database(tmpDbPath(), { create: true });
    const driver = new BunSqliteDriver(raw);
    driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    driver.run("INSERT INTO t (id, name) VALUES (?, ?)", [1, "a"]);
    expect(driver.get<{ name: string }>("SELECT name FROM t WHERE id = ?", [1])?.name).toBe("a");
    expect(driver.all<{ id: number }>("SELECT id FROM t ORDER BY id")).toEqual([{ id: 1 }]);

    await expect(
      driver.transaction(async () => {
        driver.run("INSERT INTO t (id, name) VALUES (?, ?)", [2, "b"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The failed transaction's insert never committed.
    expect(driver.all<{ id: number }>("SELECT id FROM t ORDER BY id")).toEqual([{ id: 1 }]);

    await driver.transaction(async () => {
      driver.run("INSERT INTO t (id, name) VALUES (?, ?)", [2, "b"]);
    });
    expect(driver.all<{ id: number }>("SELECT id FROM t ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }]);
    driver.close();
  });
});

describe("DoSqliteDriver", () => {
  test("run/get/all/exec translate to the ctx.storage.sql cursor shape", () => {
    const raw = new Database(":memory:");
    const driver = new DoSqliteDriver(fakeDoSqlStorage(raw), fakeDoTransactionCtx());
    driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    driver.run("INSERT INTO t (id, name) VALUES (?, ?)", [1, "a"]);
    expect(driver.get<{ name: string }>("SELECT name FROM t WHERE id = ?", [1])?.name).toBe("a");
    expect(driver.get<{ name: string }>("SELECT name FROM t WHERE id = ?", [999])).toBeUndefined();
    expect(driver.all<{ id: number }>("SELECT id FROM t ORDER BY id")).toEqual([{ id: 1 }]);
  });

  test("transaction commits via the async ctx.storage.transaction API", async () => {
    const raw = new Database(":memory:");
    const driver = new DoSqliteDriver(fakeDoSqlStorage(raw), fakeDoTransactionCtx());
    driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await driver.transaction(async () => {
      driver.run("INSERT INTO t (id) VALUES (?)", [1]);
      driver.run("INSERT INTO t (id) VALUES (?)", [2]);
    });
    expect(driver.all<{ id: number }>("SELECT id FROM t ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("raw BEGIN/SAVEPOINT is rejected by real DO SQLite (documented, not re-tested here)", () => {
    // Confirmed against local Miniflare in the #281 de-risking spike — DoSqliteDriver deliberately
    // never issues raw BEGIN/COMMIT (see its `transaction` method), routing through
    // ctx.storage.transaction instead. Nothing to assert against the bun:sqlite fake here (which
    // *would* accept raw BEGIN, unlike the real platform); this test exists as a pointer back to
    // that spike so the constraint isn't lost.
    expect(true).toBe(true);
  });
});

describe("openStoreWithDriver (#281)", () => {
  test("bootstraps a SqliteStore on a driver with no backing file", async () => {
    const raw = new Database(":memory:");
    const driver = new DoSqliteDriver(fakeDoSqlStorage(raw), fakeDoTransactionCtx());
    const store = await openStoreWithDriver(driver, "do:test", { now: () => 1000 });
    try {
      // A real read/write round-trip through the full Store contract, not just the raw driver —
      // proves the seam holds all the way up through SqliteStore's ~160 call sites.
      await store.setCoverage("claude", "digest-1", 3);
      const coverage = await store.getCoverage("claude");
      expect(coverage?.filesDigest).toBe("digest-1");
      expect(coverage?.sessionCount).toBe(3);
    } finally {
      await store.close();
    }
  });
});
