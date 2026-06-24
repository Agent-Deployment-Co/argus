import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sqlite3, { type Database } from "sqlite3";
import {
  STORE_APPLICATION_ID,
  STORE_SCHEMA_VERSION,
  StoreError,
  openStore,
  rebuildStore,
} from "../src/store/store.ts";
import {
  PARSED_FRAGMENT_CONTRACT_VERSION,
  type StoredFragment,
  type CompleteDiscovery,
  type ParsedAuxiliaryFragment,
  type ParsedFileFragment,
} from "../src/store/store-contract.ts";
import type { AgentSource } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-cache-store-"));
  tempDirs.push(dir);
  return join(dir, "private", "fragments.sqlite3");
}

function emptyFacts() {
  return {
    sessions: [],
    messages: [],
    invocations: [],
    toolResults: [],
    tasks: [],
    relationships: [],
  };
}

function transcript(
  source: AgentSource,
  id: string,
  rootId = `${source}-root`,
  parserVersion = "1",
): ParsedFileFragment {
  const fileId = `file:${id}`;
  return {
    kind: "transcript",
    id,
    contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
    parser: { name: `${source}-parser`, source, version: parserVersion },
    snapshot: {
      file: {
        id: fileId,
        source,
        rootId,
        role: "transcript",
        relativePath: `${id}.jsonl`,
        path: `/private/${source}/${id}.jsonl`,
      },
      fingerprint: {
        sizeBytes: "123",
        mtimeNs: "1717600000000000000",
        ctimeNs: "1717599999000000000",
        physicalId: { scheme: "posix_dev_inode", value: `7:${id.length}` },
      },
      attempts: 1,
    },
    facts: emptyFacts(),
    dependencies: [
      {
        inputId: `aux:${source}`,
        selector: id,
        affects: ["session_first_prompt"],
      },
    ],
    diagnostics: [],
  };
}

function transcriptWithFacts(id: string): ParsedFileFragment {
  const fragment = transcript("claude", id);
  const position = (recordIndex: number) => ({ originKey: `file:${id}`, recordIndex, itemIndex: 0 });
  fragment.facts = {
    sessions: [
      {
        id: `sess:${id}`,
        source: "claude",
        sourceSessionId: `s-${id}`,
        kind: "main",
        transcriptPath: `/private/claude/${id}.jsonl`,
        position: position(0),
      },
    ],
    messages: [
      {
        id: `msg:${id}`,
        source: "claude",
        sourceSessionId: `s-${id}`,
        providerMessageId: `pm-${id}`,
        timestampMs: 1_717_600_000_000,
        model: "claude-opus-4",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        attributionSkill: null,
        position: position(1),
      },
    ],
    invocations: [
      {
        id: `inv:${id}`,
        source: "claude",
        sourceSessionId: `s-${id}`,
        messageId: `msg:${id}`,
        name: "Bash",
        position: position(2),
      },
    ],
    toolResults: [
      {
        id: `tr:${id}`,
        source: "claude",
        sourceSessionId: `s-${id}`,
        approxTokens: 10,
        position: position(3),
      },
    ],
    tasks: [],
    relationships: [],
  };
  return fragment;
}

function auxiliary(id: string): ParsedAuxiliaryFragment {
  return {
    kind: "auxiliary",
    id,
    contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
    parser: { name: "claude-history", source: "claude", version: "2" },
    snapshot: {
      file: {
        id: `file:${id}`,
        source: "claude",
        rootId: "claude-history",
        role: "history",
        relativePath: "history.jsonl",
        path: "/private/claude/history.jsonl",
      },
      fingerprint: { sizeBytes: "45", mtimeNs: "1717600000000000001" },
      attempts: 1,
    },
    facts: [
      {
        id: "prompt:1",
        kind: "session_first_prompt",
        source: "claude",
        sourceSessionId: "session-1",
        firstPrompt: "Inspect the cache.",
        timestampMs: 1_717_600_000_000,
        position: { originKey: `file:${id}`, recordIndex: 0, itemIndex: 0 },
      },
    ],
    diagnostics: [],
  };
}

// Only auxiliary fragments round-trip through load() — transcripts/imports are re-parsed from disk,
// so load() returns undefined for them and their presence is verified via list().
async function expectStored(
  cache: Awaited<ReturnType<typeof openStore>>,
  fragment: StoredFragment,
): Promise<void> {
  if (fragment.kind === "auxiliary") {
    expect(await cache.load(fragment.id)).toEqual(fragment);
  } else {
    expect(await cache.load(fragment.id)).toBeUndefined();
    expect((await cache.list()).some((m) => m.id === fragment.id && m.status === "success")).toBe(true);
  }
}

function rawOpen(path: string): Promise<Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, (error) => {
      if (error) reject(error);
      else resolve(db);
    });
  });
}

function rawExec(db: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function rawGet<T>(db: Database, sql: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get<T>(sql, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function rawAll<T>(db: Database, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all<T>(sql, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function rawClose(db: Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function withRawDatabase<T>(path: string, operation: (db: Database) => Promise<T>): Promise<T> {
  const db = await rawOpen(path);
  try {
    return await operation(db);
  } finally {
    await rawClose(db);
  }
}

describe("SQLite store", () => {
  test("creates a private versioned database and round-trips every fragment kind", async () => {
    const path = storePath();
    const cache = await openStore({ path, now: () => 100 });
    const fragments: StoredFragment[] = [
      transcript("claude", "claude:one"),
      transcript("codex", "codex:one"),
      transcript("gemini", "gemini:one"),
      auxiliary("auxiliary:one"),
    ];

    for (const fragment of fragments) {
      await cache.replace(fragment);
      await expectStored(cache, fragment);
    }

    expect((await cache.list("codex")).map(({ id }) => id)).toEqual(["codex:one"]);
    expect(await cache.list()).toHaveLength(4);

    const schema = await withRawDatabase(path, async (db) => ({
      applicationId: (await rawGet<{ application_id: number }>(db, "PRAGMA application_id"))
        ?.application_id,
      userVersion: (await rawGet<{ user_version: number }>(db, "PRAGMA user_version"))
        ?.user_version,
      dependencies: (
        await rawGet<{ count: number }>(
          db,
          "SELECT COUNT(*) AS count FROM index_dependencies WHERE file_id = 'claude:one'",
        )
      )?.count,
    }));
    expect(schema.applicationId).toBe(STORE_APPLICATION_ID);
    expect(schema.userVersion).toBe(STORE_SCHEMA_VERSION);
    expect(schema.dependencies).toBe(1);

    if (process.platform !== "win32") {
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(`${path}${suffix}`)) {
          expect(statSync(`${path}${suffix}`).mode & 0o777).toBe(0o600);
        }
      }
    }
    await cache.close();
  });

  test("keeps the last successful fragment when a transactional replace fails", async () => {
    const path = storePath();
    const cache = await openStore({ path });
    const original = transcript("claude", "claude:atomic", "claude-root", "1");
    await cache.replace(original);

    const broken = transcript("claude", "claude:atomic", "claude-root", "2");
    broken.dependencies[0]!.inputId = null as unknown as string;
    await expect(cache.replace(broken)).rejects.toBeInstanceOf(StoreError);

    await expectStored(cache, original);
    expect((await cache.list())[0]).toMatchObject({
      id: original.id,
      parserVersion: "1",
      status: "success",
    });
    await cache.close();
  });

  test("invalidates without exposing stale JSON and can replace it successfully", async () => {
    const path = storePath();
    let now = 10;
    const cache = await openStore({ path, now: () => now++ });
    const first = transcript("gemini", "gemini:invalidate", "gemini-root", "1");
    await cache.replace(first);
    const successfulAt = (await cache.list())[0]!.updatedAtMs;

    await cache.invalidate([first.id], "parser_version");
    expect(await cache.load(first.id)).toBeUndefined();
    expect((await cache.list())[0]).toMatchObject({
      status: "failed",
      updatedAtMs: successfulAt + 1,
    });

    const second = transcript("gemini", first.id, "gemini-root", "2");
    await cache.replace(second);
    await expectStored(cache, second);
    expect((await cache.list())[0]).toMatchObject({ status: "success", parserVersion: "2" });

    await cache.invalidate([first.id], "file_changed");
    expect((await cache.list())[0]?.status).toBe("unstable");
    await cache.close();
  });

  test("removes missing files only for the authoritative source and root", async () => {
    const path = storePath();
    const cache = await openStore({ path });
    const keep = transcript("claude", "claude:keep", "shared-root");
    const missing = transcript("claude", "claude:missing", "shared-root");
    const otherRoot = transcript("claude", "claude:other-root", "other-root");
    const otherSource = transcript("codex", "codex:same-root", "shared-root");
    for (const fragment of [keep, missing, otherRoot, otherSource]) {
      await cache.replace(fragment);
    }

    const discovery: CompleteDiscovery = {
      status: "complete",
      source: "claude",
      rootId: "shared-root",
      rootPath: "/private/claude",
      files: [{ file: keep.snapshot.file, fingerprint: keep.snapshot.fingerprint }],
      diagnostics: [],
    };
    await cache.removeMissing(discovery);

    const ids = new Set((await cache.list()).map((m) => m.id));
    expect(ids.has(keep.id)).toBe(true);
    expect(ids.has(missing.id)).toBe(false);
    expect(ids.has(otherRoot.id)).toBe(true);
    expect(ids.has(otherSource.id)).toBe(true);
    await cache.close();
  });

  test("rejects non-authoritative cleanup even when forced through the type boundary", async () => {
    const path = storePath();
    const cache = await openStore({ path });
    const fragment = transcript("claude", "claude:not-authoritative");
    await cache.replace(fragment);

    await expect(
      cache.removeMissing({
        status: "partial",
        source: "claude",
        rootId: "claude-root",
        rootPath: "/private/claude",
        files: [],
        diagnostics: [],
      } as unknown as CompleteDiscovery),
    ).rejects.toThrow("complete authoritative");
    await expectStored(cache, fragment);
    await cache.close();
  });

  test("migrates a v4 store in place, preserving the retained read model", async () => {
    const path = storePath();
    const initial = await openStore({ path });
    // Materialize a session into the trusted read model, then degrade the store to look like v4
    // (no `archived` column) so reopening exercises the 4 -> 5 migration.
    await initial.materializeSessions("codex", [
      {
        meta: {
          source: "codex",
          sessionId: "codex:migrate-me",
          project: "p",
          cwd: "/tmp/p",
          filePath: "/tmp/p/rollout.jsonl",
        },
        messages: [],
      },
    ]);
    await initial.close();
    await withRawDatabase(path, async (db) => {
      await rawExec(db, "DROP INDEX IF EXISTS resolved_sessions_archived");
      await rawExec(db, "DROP INDEX IF EXISTS resolved_tasks_source");
      await rawExec(db, "DROP INDEX IF EXISTS resolved_tasks_ts");
      await rawExec(db, "DROP TABLE IF EXISTS resolved_tasks");
      // v10 renamed resolved_messages -> resolved_usage and re-created its indexes; restore the
      // pre-rename name (dropping the new-named indexes so the v9 -> v10 migration re-creates them
      // without conflict) and strip everything added after v4.
      await rawExec(db, "DROP INDEX IF EXISTS resolved_usage_date");
      await rawExec(db, "DROP INDEX IF EXISTS resolved_usage_ts");
      await rawExec(db, "DROP INDEX IF EXISTS resolved_usage_source");
      await rawExec(db, "DROP INDEX IF EXISTS resolved_usage_task");
      await rawExec(db, "DROP INDEX IF EXISTS resolved_usage_date_model");
      await rawExec(db, "DROP TABLE IF EXISTS resolved_interactions");
      await rawExec(db, "DROP TABLE IF EXISTS resolved_invocations");
      await rawExec(db, "ALTER TABLE resolved_usage RENAME TO resolved_messages");
      await rawExec(db, "ALTER TABLE resolved_messages DROP COLUMN interaction_seq");
      // v13 dropped resolved_usage.task_seq, and v4 predates it (added at 7 -> 8) — so there's nothing
      // to strip here; the 7 -> 8 migration re-adds it on the way up.
      await rawExec(db, "ALTER TABLE resolved_messages DROP COLUMN input_tokens");
      await rawExec(db, "ALTER TABLE resolved_messages DROP COLUMN output_tokens");
      await rawExec(db, "ALTER TABLE resolved_messages DROP COLUMN cache_read");
      await rawExec(db, "ALTER TABLE resolved_messages DROP COLUMN cache_write_5m");
      await rawExec(db, "ALTER TABLE resolved_messages DROP COLUMN cache_write_1h");
      await rawExec(db, "ALTER TABLE resolved_messages DROP COLUMN model");
      await rawExec(db, "ALTER TABLE resolved_messages DROP COLUMN attribution_skill");
      await rawExec(db, "ALTER TABLE resolved_messages DROP COLUMN stop_reason");
      await rawExec(db, "ALTER TABLE resolved_sessions DROP COLUMN archived");
      // v12 promoted friction columns onto resolved_sessions; strip them so the 11 -> 12 ADDs don't collide.
      for (const col of ["friction_interruptions", "friction_rejections", "friction_compactions", "friction_turns", "last_interruption_ms"]) {
        await rawExec(db, `ALTER TABLE resolved_sessions DROP COLUMN ${col}`);
      }
      // Recreate the v4-era base indexes under the old name so the 9 -> 10 rename migration's
      // `DROP INDEX IF EXISTS resolved_messages_*` actually drops populated indexes (fidelity).
      await rawExec(db, "CREATE INDEX resolved_messages_date ON resolved_messages(date)");
      await rawExec(db, "CREATE INDEX resolved_messages_ts ON resolved_messages(ts)");
      await rawExec(db, "CREATE INDEX resolved_messages_source ON resolved_messages(source)");
      // resolved_tool_results existed from v1; recreate it so the 11 -> 12 migration's DROP runs
      // against a populated table (fresh v12 schema no longer creates it).
      await rawExec(
        db,
        "CREATE TABLE resolved_tool_results (session_id TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, approx_tokens INTEGER NOT NULL, PRIMARY KEY (session_id, name))",
      );
      await rawExec(db, "PRAGMA user_version = 4");
    });

    const migrated = await openStore({ path });
    try {
      // The retained session survived the migration (NOT rebuilt from scratch).
      expect((await migrated.readResolved()).sessions.has("codex:migrate-me")).toBe(true);
      // The new column is usable.
      await migrated.setSessionsArchived(["codex:migrate-me"], true);
      expect(await migrated.listArchived()).toEqual(["codex:migrate-me"]);
    } finally {
      await migrated.close();
    }

    const version = await withRawDatabase(path, async (db) =>
      rawGet<{ user_version: number }>(db, "PRAGMA user_version"),
    );
    expect(version?.user_version).toBe(STORE_SCHEMA_VERSION);
  });

  test("rejects an older schema with no migration path instead of silently rebuilding", async () => {
    const path = storePath();
    const initial = await openStore({ path });
    await initial.replace(transcript("claude", "claude:old"));
    await initial.close();

    // A version with no migration entry must NOT be destroyed (the store is a durable archive).
    await withRawDatabase(path, (db) => rawExec(db, "PRAGMA user_version = 1"));

    await expect(openStore({ path })).rejects.toMatchObject({
      code: "incompatible_schema",
      storePath: path,
    });
    // The data is left intact for an explicit `reindex --force`.
    expect(readFileSync(path).subarray(0, 15).toString()).toBe("SQLite format 3");
  });

  test("reports newer schemas as incompatible without modifying them", async () => {
    const path = storePath();
    const initial = await openStore({ path });
    await initial.close();
    await withRawDatabase(path, (db) => rawExec(db, "PRAGMA user_version = 999"));

    await expect(openStore({ path })).rejects.toMatchObject({
      code: "incompatible_schema",
      storePath: path,
    });
    expect(readFileSync(path).subarray(0, 15).toString()).toBe("SQLite format 3");
  });

  test("reports a malformed current schema as incompatible", async () => {
    const path = storePath();
    const initial = await openStore({ path });
    await initial.close();
    await withRawDatabase(path, (db) =>
      rawExec(db, "ALTER TABLE index_files DROP COLUMN import_provenance_json"),
    );

    await expect(openStore({ path })).rejects.toMatchObject({
      code: "incompatible_schema",
      storePath: path,
    });
  });

  test("provides an explicit rebuild path for corrupt databases", async () => {
    const path = storePath();
    const initial = await openStore({ path });
    await initial.close();
    writeFileSync(path, "not sqlite", { mode: 0o600 });

    await expect(openStore({ path })).rejects.toMatchObject({
      code: "corrupt",
      storePath: path,
    });

    const rebuilt = await rebuildStore({ path });
    const fragment = transcript("codex", "codex:rebuilt");
    await rebuilt.replace(fragment);
    await expectStored(rebuilt, fragment);
    await rebuilt.close();
  });

  test("uses a bounded busy timeout and succeeds after contention clears", async () => {
    const path = storePath();
    const cache = await openStore({ path, busyTimeoutMs: 25 });
    const locker = await rawOpen(path);
    await rawExec(locker, "BEGIN IMMEDIATE");

    const startedAt = Date.now();
    await expect(cache.replace(transcript("claude", "claude:busy"))).rejects.toMatchObject({
      code: "busy",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    await rawExec(locker, "ROLLBACK");
    await rawClose(locker);
    await cache.replace(transcript("claude", "claude:after-busy"));
    expect((await cache.list()).some((m) => m.id === "claude:after-busy")).toBe(true);
    await cache.close();
  });

  test("refuses a cache database symlink", async () => {
    if (process.platform === "win32") return;
    const path = storePath();
    const initial = await openStore({ path });
    await initial.close();
    rmSync(path);
    const target = join(dirname(path), "target.sqlite3");
    writeFileSync(target, "");
    chmodSync(target, 0o600);
    symlinkSync(target, path);

    await expect(openStore({ path })).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });

  test("refuses a dangling cache database symlink", async () => {
    if (process.platform === "win32") return;
    const path = storePath();
    const initial = await openStore({ path });
    await initial.close();
    rmSync(path);
    symlinkSync(join(dirname(path), "missing.sqlite3"), path);

    await expect(openStore({ path })).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });

  test("materializeSessions guards against a partial re-parse overwriting a fuller record", async () => {
    const path = storePath();
    const store = await openStore({ path });
    try {
      const session = (count: number) => ({
        meta: {
          source: "claude" as const,
          sessionId: "claude:partial",
          project: "p",
          cwd: "/tmp/p",
          filePath: "/tmp/p/t.jsonl",
        },
        messages: Array.from({ length: count }, (_, i) => ({
          source: "claude" as const,
          sessionId: "claude:partial",
          project: "p",
          cwd: "/tmp/p",
          gitBranch: "",
          ts: 1000 + i,
          date: "2026-06-01",
          model: "claude-x",
          usage: { input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
          attributionSkill: null,
          toolUses: [],
        })),
      });

      const first = await store.materializeSessions("claude", [session(3)]);
      expect(first).toEqual([]); // fresh insert, no guard

      // A re-parse with FEWER messages must not shrink the record (a file may be missing this run).
      const guarded = await store.materializeSessions("claude", [session(1)]);
      expect(guarded).toEqual(["claude:partial"]);
      const countMessages = async () =>
        (await store.readResolved()).messages.filter((m) => m.sessionId === "claude:partial").length;
      expect(await countMessages()).toBe(3);
      // The guard does NOT flag archived — the file may still be on disk; archiving is decided by
      // discovery, not by a message-count dip.
      expect(await store.listArchived()).toEqual([]);

      // The guard is owner-agnostic: a handoff to another producer with fewer messages can't regress.
      const handoff = await store.materializeSessions("codex", [session(1)]);
      expect(handoff).toEqual(["claude:partial"]);
      expect(await countMessages()).toBe(3);
      expect(await store.resolvedSessionCounts()).toEqual([
        { owner: "claude", present: 1, archived: 0 },
      ]); // still owned by claude, not handed off to a shorter copy

      // An equal-or-larger re-parse replaces normally.
      expect(await store.materializeSessions("claude", [session(5)])).toEqual([]);
      expect(await countMessages()).toBe(5);
    } finally {
      await store.close();
    }
  });

  test("stores and reads task facts for a materialized session", async () => {
    const path = storePath();
    const store = await openStore({ path });
    try {
      const task = {
        id: "task:codex:one",
        source: "codex" as const,
        sourceSessionId: "codex:task-session",
        timestampMs: 1_780_000_000_000,
        description: "add the facts command",
        evidence: "message indexes: 0",
        evidenceKind: "llm_inference" as const,
        position: { originKey: "file:codex-task-session", recordIndex: 2, itemIndex: 0 },
      };
      const earlierTask = {
        ...task,
        id: "task:codex:earlier",
        timestampMs: 1_779_999_999_000,
        description: "read the existing facts command",
      };
      const { timestampMs: _timestampMs, ...untimestampedTask } = {
        ...task,
        id: "task:codex:untimestamped",
        description: "document the extraction behavior",
      };
      await store.materializeSessions("codex", [
        {
          meta: {
            source: "codex",
            sessionId: "codex:task-session",
            project: "p",
            cwd: "/tmp/p",
            filePath: "/tmp/p/rollout.jsonl",
          },
          messages: [],
          tasks: [task, untimestampedTask, earlierTask],
        },
      ]);

      expect(await store.readSessionTasks("codex:task-session")).toEqual([
        earlierTask,
        task,
        untimestampedTask,
      ]);
      expect(await store.readSessionTasks("codex:missing")).toEqual([]);

      expect((await store.readResolved()).tasksBySession?.get("codex:task-session")).toEqual([
        earlierTask,
        task,
        untimestampedTask,
      ]);
    } finally {
      await store.close();
    }
  });

  test("materializeSessions preserves extracted tasks only when the session is unchanged", async () => {
    const path = storePath();
    const store = await openStore({ path });
    try {
      const task = {
        id: "task:codex:preserve",
        source: "codex" as const,
        sourceSessionId: "codex:preserve-tasks",
        timestampMs: 1_780_000_000_000,
        description: "keep extracted task facts",
        evidence: "message indexes: 0",
        evidenceKind: "llm_inference" as const,
        position: { originKey: "file:codex-preserve-tasks", recordIndex: 1, itemIndex: 0 },
      };
      const message = (ts: number) => ({
        source: "codex" as const,
        sessionId: "codex:preserve-tasks",
        project: "p",
        cwd: "/tmp/p",
        gitBranch: "",
        ts,
        date: "2026-06-01",
        model: "gpt-5",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        attributionSkill: null,
        toolUses: [],
      });
      const materialized = (ts: number) => ({
        meta: {
          source: "codex" as const,
          sessionId: "codex:preserve-tasks",
          project: "p",
          cwd: "/tmp/p",
          filePath: "/tmp/p/rollout.jsonl",
        },
        messages: [message(ts)],
      });

      await store.materializeSessions("codex", [{ ...materialized(1000), tasks: [task] }]);
      expect(await store.readSessionTasks("codex:preserve-tasks")).toEqual([task]);

      await store.materializeSessions("codex", [materialized(1000)]);
      expect(await store.readSessionTasks("codex:preserve-tasks")).toEqual([task]);

      await store.materializeSessions("codex", [materialized(2000)]);
      expect(await store.readSessionTasks("codex:preserve-tasks")).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test("materializeSessions assigns tasks to interactions (#122) and joins task↔message through them", async () => {
    const path = storePath();
    const store = await openStore({ path });
    try {
      const sid = "codex:chapters";
      // Each message carries its owning interaction's seq (reconcile stamps this; here we set it
      // directly since we materialize a hand-built session). 4 messages across 2 interactions.
      const message = (ts: number, interactionSeq: number) => ({
        source: "codex" as const,
        sessionId: sid,
        project: "p",
        cwd: "/tmp/p",
        gitBranch: "",
        ts,
        date: "2026-06-01",
        model: "gpt-5",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        attributionSkill: null,
        interactionSeq,
        toolUses: [],
      });
      const interaction = (seq: number, ts: number) => ({
        id: `iact:${sid}:${seq}`,
        source: "codex" as const,
        sourceSessionId: sid,
        seq,
        initiator: "human" as const,
        disposition: "completed" as const,
        compactionCount: 0,
        timestampMs: ts,
        promptPosition: { originKey: "file:chapters", recordIndex: seq, itemIndex: 0 },
        position: { originKey: "file:chapters", recordIndex: seq, itemIndex: 0 },
      });
      const task = (seqLabel: string, ts: number) => ({
        id: `task:${sid}:${seqLabel}`,
        source: "codex" as const,
        sourceSessionId: sid,
        description: `task ${seqLabel}`,
        evidence: `task at ${ts}`,
        evidenceKind: "llm_inference" as const,
        timestampMs: ts,
        outcome: "success" as const,
        position: { originKey: "file:chapters", recordIndex: 0, itemIndex: 0 },
      });
      // interaction 0 (ts 1000) → task a; interaction 1 (ts 1002) → task b (bookmark: latest task whose
      // ts ≤ the interaction's). Messages inherit task via their interaction.
      await store.materializeSessions("codex", [
        {
          meta: { source: "codex", sessionId: sid, project: "p", cwd: "/tmp/p", filePath: "/tmp/p/r.jsonl" },
          messages: [message(1000, 0), message(1001, 0), message(1002, 1), message(1003, 1)],
          interactions: [interaction(0, 1000), interaction(1, 1002)],
          tasks: [task("a", 1000), task("b", 1002)],
        },
      ]);

      // Task membership lives on resolved_interactions.task_seq; the leaf has interaction_seq only.
      const iact = await withRawDatabase(path, (db) =>
        rawAll<{ seq: number; task_seq: number | null }>(
          db,
          `SELECT seq, task_seq FROM resolved_interactions WHERE session_id = '${sid}' ORDER BY seq`,
        ),
      );
      expect(iact).toEqual([
        { seq: 0, task_seq: 0 },
        { seq: 1, task_seq: 1 },
      ]);
      const usage = await withRawDatabase(path, (db) =>
        rawAll<{ seq: number; interaction_seq: number | null }>(
          db,
          `SELECT seq, interaction_seq FROM resolved_usage WHERE session_id = '${sid}' ORDER BY seq`,
        ),
      );
      expect(usage.map((r) => r.interaction_seq)).toEqual([0, 0, 1, 1]);
      const tasks = await store.readSessionTasks(sid);
      expect(tasks[0]?.outcome).toBe("success");

      // readSessionTaskMessages buckets each task's messages by joining usage → interaction → task.
      const byTask = await store.readSessionTaskMessages(sid);
      expect(byTask.get(`task:${sid}:a`)?.map((m) => m.ts)).toEqual([1000, 1001]);
      expect(byTask.get(`task:${sid}:b`)?.map((m) => m.ts)).toEqual([1002, 1003]);
      // A task that owns no attributed messages is simply absent from the map.
      expect(byTask.has("task:nope")).toBe(false);
    } finally {
      await store.close();
    }
  });

  test("materializeSessions mirrors usage/model/skill into promoted columns", async () => {
    const path = storePath();
    const store = await openStore({ path });
    try {
      const sid = "codex:usage-cols";
      await store.materializeSessions("codex", [
        {
          meta: { source: "codex", sessionId: sid, project: "p", cwd: "/tmp/p", filePath: "/tmp/p/r.jsonl" },
          messages: [
            {
              source: "codex",
              sessionId: sid,
              project: "p",
              cwd: "/tmp/p",
              gitBranch: "",
              ts: 1000,
              date: "2026-06-01",
              model: "gpt-5",
              usage: { input: 10, output: 20, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5 },
              attributionSkill: "plug:skill",
              toolUses: [],
            },
          ],
        },
      ]);
      const row = await withRawDatabase(path, (db) =>
        rawGet<{
          input_tokens: number;
          output_tokens: number;
          cache_read: number;
          cache_write_5m: number;
          cache_write_1h: number;
          model: string;
          attribution_skill: string;
        }>(
          db,
          `SELECT input_tokens, output_tokens, cache_read, cache_write_5m, cache_write_1h, model, attribution_skill
           FROM resolved_usage WHERE session_id = '${sid}' AND seq = 0`,
        ),
      );
      expect(row).toEqual({
        input_tokens: 10,
        output_tokens: 20,
        cache_read: 3,
        cache_write_5m: 4,
        cache_write_1h: 5,
        model: "gpt-5",
        attribution_skill: "plug:skill",
      });
    } finally {
      await store.close();
    }
  });

  test("readSessionAggregates rolls up per-model token sums and respects date filters", async () => {
    const path = storePath();
    const store = await openStore({ path });
    try {
      const msg = (sid: string, date: string, model: string, input: number) => ({
        source: "codex" as const,
        sessionId: sid,
        project: "p",
        cwd: "/tmp/proj-a",
        gitBranch: "",
        ts: Date.parse(`${date}T00:00:00Z`),
        date,
        model,
        usage: { input, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        attributionSkill: null,
        toolUses: [],
      });
      await store.materializeSessions("codex", [
        {
          meta: { source: "codex", sessionId: "codex:a", project: "p", cwd: "/tmp/proj-a", filePath: "/tmp/proj-a/r.jsonl" },
          // two models, two dates
          messages: [msg("codex:a", "2026-06-01", "gpt-5", 10), msg("codex:a", "2026-06-01", "gpt-5", 5), msg("codex:a", "2026-06-03", "gpt-4", 7)],
        },
        {
          meta: { source: "codex", sessionId: "codex:b", project: "p", cwd: "/tmp/proj-b", filePath: "/tmp/proj-b/r.jsonl" },
          messages: [msg("codex:b", "2026-06-02", "gpt-5", 3)],
        },
      ]);

      const all = await store.readSessionAggregates();
      const a = all.find((s) => s.meta.sessionId === "codex:a")!;
      expect(a.messageCount).toBe(3);
      const aByModel = Object.fromEntries(a.byModel.map((m) => [m.model, m.usage.input]));
      expect(aByModel).toEqual({ "gpt-5": 15, "gpt-4": 7 });
      expect(all.map((s) => s.meta.sessionId).sort()).toEqual(["codex:a", "codex:b"]);

      // Date filter SELECTS sessions (codex:a has a message on/before 2026-06-01; codex:b doesn't),
      // but the token sums are WHOLE-session, not windowed — codex:a still reports both its models.
      const early = await store.readSessionAggregates({ until: "2026-06-01" });
      expect(early.map((s) => s.meta.sessionId)).toEqual(["codex:a"]);
      expect(Object.fromEntries(early[0]!.byModel.map((m) => [m.model, m.usage.input]))).toEqual({ "gpt-5": 15, "gpt-4": 7 });
      expect(early[0]!.messageCount).toBe(3);

      // Project filter matches cwd substring.
      const projB = await store.readSessionAggregates({ projectSubstring: "proj-b" });
      expect(projB.map((s) => s.meta.sessionId)).toEqual(["codex:b"]);

      const messages = await store.readSessionMessages("codex:a");
      expect(messages.map((m) => m.date)).toEqual(["2026-06-01", "2026-06-01", "2026-06-03"]);
    } finally {
      await store.close();
    }
  });

  test("migrates a v8 store to v9, backfilling usage columns from record_json", async () => {
    const path = storePath();
    const sid = "codex:backfill";
    const initial = await openStore({ path });
    await initial.materializeSessions("codex", [
      {
        meta: { source: "codex", sessionId: sid, project: "p", cwd: "/tmp/p", filePath: "/tmp/p/r.jsonl" },
        messages: [
          {
            source: "codex",
            sessionId: sid,
            project: "p",
            cwd: "/tmp/p",
            gitBranch: "",
            ts: 1000,
            date: "2026-06-01",
            model: "gpt-5",
            usage: { input: 7, output: 11, cacheRead: 1, cacheWrite5m: 2, cacheWrite1h: 3 },
            attributionSkill: "plug:skill",
            toolUses: [],
          },
        ],
      },
    ]);
    await initial.close();

    // Degrade to v8: drop the promoted columns/index and stamp the older version. record_json is
    // untouched, so the 8 -> 9 migration must reconstruct the columns from it.
    await withRawDatabase(path, async (db) => {
      // v10 renamed resolved_messages -> resolved_usage; restore the pre-rename name (dropping the
      // new-named indexes so the v9 -> v10 migration re-creates them) before stripping the v9 columns.
      await rawExec(db, "DROP INDEX IF EXISTS resolved_usage_date");
      await rawExec(db, "DROP INDEX IF EXISTS resolved_usage_ts");
      await rawExec(db, "DROP INDEX IF EXISTS resolved_usage_source");
      await rawExec(db, "DROP INDEX IF EXISTS resolved_usage_task");
      await rawExec(db, "DROP INDEX IF EXISTS resolved_usage_date_model");
      await rawExec(db, "DROP TABLE IF EXISTS resolved_interactions");
      await rawExec(db, "DROP TABLE IF EXISTS resolved_invocations");
      await rawExec(db, "ALTER TABLE resolved_usage RENAME TO resolved_messages");
      await rawExec(db, "ALTER TABLE resolved_messages DROP COLUMN interaction_seq");
      for (const col of ["input_tokens", "output_tokens", "cache_read", "cache_write_5m", "cache_write_1h", "model", "attribution_skill", "stop_reason"]) {
        await rawExec(db, `ALTER TABLE resolved_messages DROP COLUMN ${col}`);
      }
      // v12 promoted friction columns onto resolved_sessions; strip them so the 11 -> 12 ADDs don't collide.
      for (const col of ["friction_interruptions", "friction_rejections", "friction_compactions", "friction_turns", "last_interruption_ms"]) {
        await rawExec(db, `ALTER TABLE resolved_sessions DROP COLUMN ${col}`);
      }
      // Recreate the v8-era indexes under the old name (v8 had date/ts/source + the v7 task index) so
      // the 9 -> 10 rename migration drops populated indexes, not no-ops.
      await rawExec(db, "CREATE INDEX resolved_messages_date ON resolved_messages(date)");
      await rawExec(db, "CREATE INDEX resolved_messages_ts ON resolved_messages(ts)");
      await rawExec(db, "CREATE INDEX resolved_messages_source ON resolved_messages(source)");
      // v13 dropped resolved_usage.task_seq; re-add it (v8 had it, from 7 -> 8) so the v7 task index
      // and the migration chain's eventual 12 -> 13 DROP COLUMN have a column to act on.
      await rawExec(db, "ALTER TABLE resolved_messages ADD COLUMN task_seq INTEGER");
      await rawExec(db, "CREATE INDEX resolved_messages_task ON resolved_messages(session_id, task_seq)");
      // Recreate resolved_tool_results (present since v1) so the 11 -> 12 migration's DROP runs.
      await rawExec(
        db,
        "CREATE TABLE resolved_tool_results (session_id TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, approx_tokens INTEGER NOT NULL, PRIMARY KEY (session_id, name))",
      );
      await rawExec(db, "PRAGMA user_version = 8");
    });

    const migrated = await openStore({ path });
    try {
      const row = await withRawDatabase(path, (db) =>
        rawGet<{ input_tokens: number; output_tokens: number; cache_read: number; model: string; attribution_skill: string }>(
          db,
          `SELECT input_tokens, output_tokens, cache_read, model, attribution_skill
           FROM resolved_usage WHERE session_id = '${sid}' AND seq = 0`,
        ),
      );
      expect(row).toEqual({
        input_tokens: 7,
        output_tokens: 11,
        cache_read: 1,
        model: "gpt-5",
        attribution_skill: "plug:skill",
      });
    } finally {
      await migrated.close();
    }

    const version = await withRawDatabase(path, (db) =>
      rawGet<{ user_version: number }>(db, "PRAGMA user_version"),
    );
    expect(version?.user_version).toBe(STORE_SCHEMA_VERSION);
  });

  test("materializeSessions writes resolved_interactions and resolved_invocations (#119)", async () => {
    const path = storePath();
    const sid = "claude:iact";
    const store = await openStore({ path });
    await store.materializeSessions("claude", [
      {
        meta: { source: "claude", sessionId: sid, project: "p", cwd: "/tmp/p", filePath: "/tmp/p/r.jsonl" },
        messages: [
          {
            source: "claude",
            sessionId: sid,
            project: "p",
            cwd: "/tmp/p",
            gitBranch: "",
            ts: 1000,
            date: "2026-06-01",
            model: "claude-opus-4",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
            attributionSkill: null,
            toolUses: [
              { name: "Bash", category: "shell", approxResultTokens: 42 },
              { name: "mcp__srv__do", category: "mcp", mcpServer: "srv", mcpTool: "do" },
            ],
          },
        ],
        // Passed out of seq order on purpose: the row's seq must come from interaction.seq, not the
        // array index — so seq 1 (agent) must land at seq 1 even though it's first in the array.
        interactions: [
          {
            id: "i1",
            source: "claude",
            sourceSessionId: sid,
            seq: 1,
            initiator: "agent",
            disposition: "incomplete",
            compactionCount: 0,
            timestampMs: 2000,
            promptPosition: { originKey: "f", recordIndex: 2, itemIndex: 0 },
            position: { originKey: "f", recordIndex: 2, itemIndex: 0 },
          },
          {
            id: "i0",
            source: "claude",
            sourceSessionId: sid,
            seq: 0,
            initiator: "human",
            disposition: "completed",
            compactionCount: 0,
            timestampMs: 1000,
            promptPosition: { originKey: "f", recordIndex: 0, itemIndex: 0 },
            position: { originKey: "f", recordIndex: 0, itemIndex: 0 },
          },
        ],
      },
    ]);
    await store.close();

    const rows = await withRawDatabase(path, async (db) => ({
      interactions: await rawAll<{ seq: number; initiator: string; disposition: string }>(
        db,
        `SELECT seq, initiator, disposition FROM resolved_interactions WHERE session_id = '${sid}' ORDER BY seq`,
      ),
      invocations: await rawAll<{ tool: string; category: string; mcp_server: string | null; approx_result_tokens: number }>(
        db,
        `SELECT tool, category, mcp_server, approx_result_tokens FROM resolved_invocations WHERE session_id = '${sid}' ORDER BY seq`,
      ),
    }));
    expect(rows.interactions).toEqual([
      { seq: 0, initiator: "human", disposition: "completed" },
      { seq: 1, initiator: "agent", disposition: "incomplete" },
    ]);
    // Each row is the call+result unit (#130): the Bash call carries its paired result size; the
    // result-less MCP call defaults to 0.
    expect(rows.invocations).toEqual([
      { tool: "Bash", category: "shell", mcp_server: null, approx_result_tokens: 42 },
      { tool: "mcp__srv__do", category: "mcp", mcp_server: "srv", approx_result_tokens: 0 },
    ]);
  });

  test("v10 -> v11 backfills resolved_invocations from record_json.toolUses (#119)", async () => {
    const path = storePath();
    const sid = "claude:backfill-inv";
    const initial = await openStore({ path });
    await initial.materializeSessions("claude", [
      {
        meta: { source: "claude", sessionId: sid, project: "p", cwd: "/tmp/p", filePath: "/tmp/p/r.jsonl" },
        messages: [
          {
            source: "claude",
            sessionId: sid,
            project: "p",
            cwd: "/tmp/p",
            gitBranch: "",
            ts: 1000,
            date: "2026-06-01",
            model: "claude-opus-4",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
            attributionSkill: null,
            toolUses: [
              { name: "Read", category: "file-io" },
              { name: "Bash", category: "shell" },
            ],
          },
        ],
      },
    ]);
    await initial.close();

    // Degrade to v10: drop the v11 additions so re-opening runs the 10 -> 11 backfill over record_json.
    await withRawDatabase(path, async (db) => {
      await rawExec(db, "DROP TABLE IF EXISTS resolved_interactions");
      await rawExec(db, "DROP TABLE IF EXISTS resolved_invocations");
      await rawExec(db, "ALTER TABLE resolved_usage DROP COLUMN interaction_seq");
      await rawExec(db, "ALTER TABLE resolved_usage DROP COLUMN stop_reason");
      // v13 dropped resolved_usage.task_seq; re-add it (v10 had it) so the eventual 12 -> 13 DROP COLUMN
      // has a column to act on.
      await rawExec(db, "ALTER TABLE resolved_usage ADD COLUMN task_seq INTEGER");
      await rawExec(db, "CREATE INDEX resolved_usage_task ON resolved_usage(session_id, task_seq)");
      // v12 promoted friction columns onto resolved_sessions; strip them so the 11 -> 12 ADDs don't collide.
      for (const col of ["friction_interruptions", "friction_rejections", "friction_compactions", "friction_turns", "last_interruption_ms"]) {
        await rawExec(db, `ALTER TABLE resolved_sessions DROP COLUMN ${col}`);
      }
      // resolved_tool_results existed at v10; recreate it so the 11 -> 12 migration's DROP runs.
      await rawExec(
        db,
        "CREATE TABLE resolved_tool_results (session_id TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, approx_tokens INTEGER NOT NULL, PRIMARY KEY (session_id, name))",
      );
      await rawExec(db, "PRAGMA user_version = 10");
    });

    const migrated = await openStore({ path });
    await migrated.close();
    const invocations = await withRawDatabase(path, (db) =>
      rawAll<{ tool: string; category: string }>(
        db,
        `SELECT tool, category FROM resolved_invocations WHERE session_id = '${sid}' ORDER BY seq`,
      ),
    );
    expect(invocations).toEqual([
      { tool: "Read", category: "file-io" },
      { tool: "Bash", category: "shell" },
    ]);
  });

  test("v11 -> v12 folds resolved_tool_results onto resolved_invocations, then drops it (#130)", async () => {
    const path = storePath();
    const sid = "claude:fold-results";
    const initial = await openStore({ path });
    // Two Bash calls + one Read call. Per-tool result totals live in resolved_tool_results at v11.
    const friction = {
      interruptions: 3,
      rejections: 1,
      compactions: 0,
      turns: 4,
      turnDurationsMs: [10],
      stopReasons: { end_turn: 1 },
      lastInterruptionMs: 999,
    };
    await initial.materializeSessions("claude", [
      {
        meta: { source: "claude", sessionId: sid, project: "p", cwd: "/work/proj", filePath: "/tmp/p/r.jsonl", friction, rawTurns: 4 },
        messages: [
          {
            source: "claude",
            sessionId: sid,
            project: "p",
            cwd: "/work/proj",
            gitBranch: "",
            ts: 1000,
            date: "2026-06-01",
            model: "claude-opus-4",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
            attributionSkill: null,
            stopReason: "end_turn",
            toolUses: [
              { name: "Bash", category: "shell" },
              { name: "Bash", category: "shell" },
              { name: "Read", category: "file-io" },
            ],
          },
        ],
      },
    ]);
    await initial.close();

    // Degrade to v11: strip the v12 columns/indexes and re-create resolved_tool_results with per-name totals.
    await withRawDatabase(path, async (db) => {
      for (const idx of ["resolved_invocations_tool", "resolved_invocations_date", "resolved_invocations_mcp_server", "resolved_invocations_skill"]) {
        await rawExec(db, `DROP INDEX IF EXISTS ${idx}`);
      }
      await rawExec(db, "ALTER TABLE resolved_invocations DROP COLUMN date");
      await rawExec(db, "ALTER TABLE resolved_invocations DROP COLUMN cwd");
      await rawExec(db, "ALTER TABLE resolved_invocations DROP COLUMN args");
      await rawExec(db, "ALTER TABLE resolved_invocations DROP COLUMN approx_result_tokens");
      await rawExec(db, "ALTER TABLE resolved_usage DROP COLUMN stop_reason");
      // v13 moved task membership: dropped resolved_usage.task_seq, added resolved_interactions.task_seq.
      // Simulate v11 — re-add the former (so 12 -> 13's DROP COLUMN has a target) and strip the latter
      // (so 12 -> 13's ADD COLUMN doesn't collide).
      await rawExec(db, "ALTER TABLE resolved_usage ADD COLUMN task_seq INTEGER");
      await rawExec(db, "CREATE INDEX resolved_usage_task ON resolved_usage(session_id, task_seq)");
      await rawExec(db, "DROP INDEX IF EXISTS resolved_interactions_task");
      await rawExec(db, "ALTER TABLE resolved_interactions DROP COLUMN task_seq");
      for (const col of ["friction_interruptions", "friction_rejections", "friction_compactions", "friction_turns", "last_interruption_ms"]) {
        await rawExec(db, `ALTER TABLE resolved_sessions DROP COLUMN ${col}`);
      }
      await rawExec(
        db,
        "CREATE TABLE resolved_tool_results (session_id TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, approx_tokens INTEGER NOT NULL, PRIMARY KEY (session_id, name))",
      );
      await rawExec(db, `INSERT INTO resolved_tool_results VALUES ('${sid}', 'Bash', 2, 100), ('${sid}', 'Read', 1, 30)`);
      await rawExec(db, "PRAGMA user_version = 11");
    });

    const migrated = await openStore({ path });
    await migrated.close();
    const result = await withRawDatabase(path, async (db) => ({
      rows: await rawAll<{ seq: number; tool: string; approx_result_tokens: number; date: string | null; cwd: string | null }>(
        db,
        `SELECT seq, tool, approx_result_tokens, date, cwd FROM resolved_invocations WHERE session_id = '${sid}' ORDER BY seq`,
      ),
      nullDates: await rawGet<{ n: number }>(db, "SELECT COUNT(*) AS n FROM resolved_invocations WHERE date IS NULL"),
      stopReason: await rawGet<{ stop_reason: string | null }>(
        db,
        `SELECT stop_reason FROM resolved_usage WHERE session_id = '${sid}' AND seq = 0`,
      ),
      session: await rawGet<{ fi: number | null; fr: number | null; ft: number | null; lim: number | null }>(
        db,
        `SELECT friction_interruptions AS fi, friction_rejections AS fr, friction_turns AS ft, last_interruption_ms AS lim
         FROM resolved_sessions WHERE session_id = '${sid}'`,
      ),
      toolResultsTable: await rawGet<{ name: string }>(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resolved_tool_results'",
      ),
    }));
    // approx_result_tokens: the per-(session, tool) total lands on that tool's first invocation row;
    // same-name siblings stay 0, so a GROUP BY tool SUM reproduces the old per-name totals exactly.
    // date + cwd are re-derived from the owning message (every row resolves — no NULL date is left).
    expect(result.rows).toEqual([
      { seq: 0, tool: "Bash", approx_result_tokens: 100, date: "2026-06-01", cwd: "/work/proj" },
      { seq: 1, tool: "Bash", approx_result_tokens: 0, date: "2026-06-01", cwd: "/work/proj" },
      { seq: 2, tool: "Read", approx_result_tokens: 30, date: "2026-06-01", cwd: "/work/proj" },
    ]);
    expect(result.nullDates?.n).toBe(0); // backfill leaves no NULL date to silently drop from filtered views
    expect(result.stopReason?.stop_reason).toBe("end_turn"); // promoted from record_json
    // friction promoted from meta_json (friction_turns prefers rawTurns).
    expect(result.session).toEqual({ fi: 3, fr: 1, ft: 4, lim: 999 });
    expect(result.toolResultsTable).toBeUndefined(); // table dropped
  });

  test("v12 -> v13 moves task membership from resolved_usage onto resolved_interactions (#122)", async () => {
    const path = storePath();
    const sid = "claude:v13";
    const store = await openStore({ path });
    // A materialized v13 session with two interactions; messages link to them.
    await store.materializeSessions("claude", [
      {
        meta: { source: "claude", sessionId: sid, project: "p", cwd: "/tmp/p", filePath: "/tmp/p/r.jsonl" },
        messages: [
          { source: "claude", sessionId: sid, project: "p", cwd: "/tmp/p", gitBranch: "", ts: 1000, date: "2026-06-01", model: "claude-opus-4", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, attributionSkill: null, interactionSeq: 0, toolUses: [] },
          { source: "claude", sessionId: sid, project: "p", cwd: "/tmp/p", gitBranch: "", ts: 1002, date: "2026-06-01", model: "claude-opus-4", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, attributionSkill: null, interactionSeq: 1, toolUses: [] },
        ],
        interactions: [
          { id: "i0", source: "claude", sourceSessionId: sid, seq: 0, initiator: "human", disposition: "completed", compactionCount: 0, timestampMs: 1000, promptPosition: { originKey: "f", recordIndex: 0, itemIndex: 0 }, position: { originKey: "f", recordIndex: 0, itemIndex: 0 } },
          { id: "i1", source: "claude", sourceSessionId: sid, seq: 1, initiator: "human", disposition: "completed", compactionCount: 0, timestampMs: 1002, promptPosition: { originKey: "f", recordIndex: 1, itemIndex: 0 }, position: { originKey: "f", recordIndex: 1, itemIndex: 0 } },
        ],
      },
    ]);
    await store.close();

    // Degrade to v12: re-add resolved_usage.task_seq (with data, as a v12 store carried) and strip
    // resolved_interactions.task_seq (added at v13).
    await withRawDatabase(path, async (db) => {
      await rawExec(db, "DROP INDEX IF EXISTS resolved_interactions_task");
      await rawExec(db, "ALTER TABLE resolved_interactions DROP COLUMN task_seq");
      await rawExec(db, "ALTER TABLE resolved_usage ADD COLUMN task_seq INTEGER");
      await rawExec(db, "CREATE INDEX resolved_usage_task ON resolved_usage(session_id, task_seq)");
      await rawExec(db, `UPDATE resolved_usage SET task_seq = 0 WHERE session_id = '${sid}'`);
      await rawExec(db, "PRAGMA user_version = 12");
    });

    const migrated = await openStore({ path });
    await migrated.close();
    const shape = await withRawDatabase(path, async (db) => ({
      usageHasTaskSeq: await rawGet<{ n: number }>(db, "SELECT COUNT(*) AS n FROM pragma_table_info('resolved_usage') WHERE name = 'task_seq'"),
      interactionsHasTaskSeq: await rawGet<{ n: number }>(db, "SELECT COUNT(*) AS n FROM pragma_table_info('resolved_interactions') WHERE name = 'task_seq'"),
      interactions: await rawAll<{ seq: number; task_seq: number | null }>(db, `SELECT seq, task_seq FROM resolved_interactions WHERE session_id = '${sid}' ORDER BY seq`),
      usageRows: await rawGet<{ n: number }>(db, `SELECT COUNT(*) AS n FROM resolved_usage WHERE session_id = '${sid}'`),
    }));
    expect(shape.usageHasTaskSeq?.n).toBe(0); // dropped from the leaf
    expect(shape.interactionsHasTaskSeq?.n).toBe(1); // moved onto the interaction
    // No backfill (interaction membership is reconcile-derived) — task_seq starts NULL until re-index.
    expect(shape.interactions).toEqual([
      { seq: 0, task_seq: null },
      { seq: 1, task_seq: null },
    ]);
    expect(shape.usageRows?.n).toBe(2); // existing rows preserved
  });

  test("clearIndex drops the structural index but preserves the resolved read model", async () => {
    const path = storePath();
    const store = await openStore({ path });
    try {
      await store.replace(transcript("codex", "codex:idx"));
      await store.setCoverage("codex", "digest", 1);
      await store.materializeSessions("codex", [
        {
          meta: {
            source: "codex",
            sessionId: "codex:keep",
            project: "p",
            cwd: "/tmp/p",
            filePath: "/tmp/p/r.jsonl",
          },
          messages: [],
        },
      ]);

      await store.clearIndex();

      expect(await store.list()).toHaveLength(0); // structural index gone
      expect(await store.getCoverage("codex")).toBeUndefined(); // coverage gone
      expect((await store.readResolved()).sessions.has("codex:keep")).toBe(true); // archive preserved
    } finally {
      await store.close();
    }
  });
});
