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
} from "../src/store.ts";
import {
  PARSED_FRAGMENT_CONTRACT_VERSION,
  type CacheFragment,
  type CompleteDiscovery,
  type ImportedFragment,
  type ParsedAuxiliaryFragment,
  type ParsedFileFragment,
} from "../src/store-contract.ts";
import type { AgentSource } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cachePath(): string {
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

function imported(id: string): ImportedFragment {
  return {
    kind: "external",
    id,
    contractVersion: PARSED_FRAGMENT_CONTRACT_VERSION,
    provenance: {
      importId: `import:${id}`,
      adapter: { name: "agentsview", version: "3" },
      database: {
        file: {
          id: `database:${id}`,
          rootId: "agentsview",
          role: "external_database",
          relativePath: "agentsview.db",
          path: "/private/agentsview/agentsview.db",
        },
        fingerprint: { sizeBytes: "8192", mtimeNs: "1717600000000000002" },
        attempts: 1,
      },
      schemaFingerprint: "agentsview-schema-v3",
      sqlite: { applicationId: 9, userVersion: 3, dataVersion: 12 },
      capabilities: { messages: "complete", attributionSkill: "partial" },
      coverage: [{ source: "codex", completeness: "partial", sourceSessionIds: ["session-2"] }],
      importedAtMs: 1_717_600_000_003,
    },
    facts: emptyFacts(),
    diagnostics: [],
  };
}

// Only auxiliary fragments round-trip through load() — transcripts/imports are re-parsed from disk,
// so load() returns undefined for them and their presence is verified via list().
async function expectStored(
  cache: Awaited<ReturnType<typeof openStore>>,
  fragment: CacheFragment,
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
    const path = cachePath();
    const cache = await openStore({ path, now: () => 100 });
    const fragments: CacheFragment[] = [
      transcript("claude", "claude:one"),
      transcript("codex", "codex:one"),
      transcript("gemini", "gemini:one"),
      auxiliary("auxiliary:one"),
      imported("external:one"),
    ];

    for (const fragment of fragments) {
      await cache.replace(fragment);
      await expectStored(cache, fragment);
    }

    expect((await cache.list("codex")).map(({ id }) => id)).toEqual(["codex:one"]);
    expect(await cache.list()).toHaveLength(5);

    const schema = await withRawDatabase(path, async (db) => ({
      applicationId: (await rawGet<{ application_id: number }>(db, "PRAGMA application_id"))
        ?.application_id,
      userVersion: (await rawGet<{ user_version: number }>(db, "PRAGMA user_version"))
        ?.user_version,
      provenance: (
        await rawGet<{ import_provenance_json: string }>(
          db,
          "SELECT import_provenance_json FROM index_files WHERE id = 'external:one'",
        )
      )?.import_provenance_json,
      dependencies: (
        await rawGet<{ count: number }>(
          db,
          "SELECT COUNT(*) AS count FROM index_dependencies WHERE file_id = 'claude:one'",
        )
      )?.count,
    }));
    expect(schema.applicationId).toBe(STORE_APPLICATION_ID);
    expect(schema.userVersion).toBe(STORE_SCHEMA_VERSION);
    expect(JSON.parse(schema.provenance ?? "{}").schemaFingerprint).toBe("agentsview-schema-v3");
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
    const path = cachePath();
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
    const path = cachePath();
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
    const path = cachePath();
    const cache = await openStore({ path });
    const keep = transcript("claude", "claude:keep", "shared-root");
    const missing = transcript("claude", "claude:missing", "shared-root");
    const otherRoot = transcript("claude", "claude:other-root", "other-root");
    const otherSource = transcript("codex", "codex:same-root", "shared-root");
    const external = imported("external:keep");
    for (const fragment of [keep, missing, otherRoot, otherSource, external]) {
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
    expect(ids.has(external.id)).toBe(true);
    await cache.close();
  });

  test("rejects non-authoritative cleanup even when forced through the type boundary", async () => {
    const path = cachePath();
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

  test("rebuilds an older-schema store from scratch (no migration path)", async () => {
    const path = cachePath();
    const initial = await openStore({ path });
    await initial.replace(imported("external:old"));
    await initial.close();

    // No migrations: reopening an older owned schema rebuilds from scratch (the store is derived).
    await withRawDatabase(path, (db) => rawExec(db, "PRAGMA user_version = 1"));

    const rebuilt = await openStore({ path });
    try {
      expect(await rebuilt.list()).toHaveLength(0); // prior data gone — rebuilt fresh
      await rebuilt.replace(imported("external:new"));
      expect((await rebuilt.list()).map((m) => m.id)).toEqual(["external:new"]);
    } finally {
      await rebuilt.close();
    }

    const version = await withRawDatabase(path, async (db) =>
      rawGet<{ user_version: number }>(db, "PRAGMA user_version"),
    );
    expect(version?.user_version).toBe(STORE_SCHEMA_VERSION);
  });

  test("reports newer schemas as incompatible without modifying them", async () => {
    const path = cachePath();
    const initial = await openStore({ path });
    await initial.close();
    await withRawDatabase(path, (db) => rawExec(db, "PRAGMA user_version = 999"));

    await expect(openStore({ path })).rejects.toMatchObject({
      code: "incompatible_schema",
      cachePath: path,
    });
    expect(readFileSync(path).subarray(0, 15).toString()).toBe("SQLite format 3");
  });

  test("reports a malformed current schema as incompatible", async () => {
    const path = cachePath();
    const initial = await openStore({ path });
    await initial.close();
    await withRawDatabase(path, (db) =>
      rawExec(db, "ALTER TABLE index_files DROP COLUMN import_provenance_json"),
    );

    await expect(openStore({ path })).rejects.toMatchObject({
      code: "incompatible_schema",
      cachePath: path,
    });
  });

  test("provides an explicit rebuild path for corrupt databases", async () => {
    const path = cachePath();
    const initial = await openStore({ path });
    await initial.close();
    writeFileSync(path, "not sqlite", { mode: 0o600 });

    await expect(openStore({ path })).rejects.toMatchObject({
      code: "corrupt",
      cachePath: path,
    });

    const rebuilt = await rebuildStore({ path });
    const fragment = transcript("codex", "codex:rebuilt");
    await rebuilt.replace(fragment);
    await expectStored(rebuilt, fragment);
    await rebuilt.close();
  });

  test("uses a bounded busy timeout and succeeds after contention clears", async () => {
    const path = cachePath();
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
    const path = cachePath();
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
    const path = cachePath();
    const initial = await openStore({ path });
    await initial.close();
    rmSync(path);
    symlinkSync(join(dirname(path), "missing.sqlite3"), path);

    await expect(openStore({ path })).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });
});
