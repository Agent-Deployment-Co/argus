// #281 Part 7 (security/robustness pass): ArgusDemoStore.ensureOpen must recover from a transient
// store-open failure rather than permanently poisoning the Durable Object instance. No real
// Cloudflare account is available in this environment, so this fakes `ctx.storage.sql`/
// `ctx.storage.transaction` over bun:sqlite, same approach as test/sql-driver.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArgusDemoStore } from "../src/worker/argus-demo-store.ts";

function isMultiStatement(sql: string): boolean {
  return sql.trim().replace(/;\s*$/, "").split(";").filter((s) => s.trim()).length > 1;
}

/** Same `ctx.storage.sql`-shaped fake as test/sql-driver.test.ts, wrapped so its first N `exec`
 *  calls throw — simulating a transient DO storage hiccup during the initial store open. */
function flakyDoSqlStorage(db: Database, failuresRemaining: { count: number }) {
  return {
    exec<T>(sql: string, ...bindings: unknown[]) {
      if (failuresRemaining.count > 0) {
        failuresRemaining.count--;
        throw new Error("simulated transient DO storage error");
      }
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

function fakeDoTransactionCtx() {
  return { storage: { transaction: <T,>(op: () => Promise<T>) => op() } };
}

const tmpDirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-demo-store-"));
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

describe("ArgusDemoStore.ensureOpen recovery (#281 Part 7)", () => {
  test("a transient open failure does not permanently poison the instance", async () => {
    const raw = new Database(tmpDbPath(), { create: true });
    const failuresRemaining = { count: 1 };
    const ctx = {
      ...fakeDoTransactionCtx(),
      storage: { ...fakeDoTransactionCtx().storage, sql: flakyDoSqlStorage(raw, failuresRemaining) },
    };
    const demoStore = new ArgusDemoStore(ctx as never, {});

    await expect(demoStore.fetch(new Request("https://argus-demo.example/api/health"))).rejects.toThrow(
      "simulated transient DO storage error",
    );

    // The failure budget is exhausted — a real retry should now succeed instead of re-awaiting the
    // same rejected promise forever.
    const res = await demoStore.fetch(new Request("https://argus-demo.example/api/health"));
    expect(res.status).not.toBe(500);
  });
});
