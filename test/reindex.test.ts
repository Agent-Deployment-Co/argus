import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllIncrementalDetailed, reindexSession } from "../src/parse-incremental.ts";
import { openStore } from "../src/store.ts";
import type { ResolvedTaskExtraction } from "../src/config.ts";
import type { AgentSource } from "../src/types.ts";

const FIX = join(import.meta.dir, "fixtures");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-reindex-"));
  dirs.push(dir);
  return dir;
}

// A fake "command" provider: the same command serves both passes, so branch on the prompt body —
// pass 1 carries "Filtered user messages:", pass 2 carries "Dialogue:".
function fakeProviderCommand(root: string): string {
  const script = join(root, "fake-extractor.js");
  writeFileSync(
    script,
    `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
      if(s.includes("Filtered user messages:")){process.stdout.write(JSON.stringify({tasks:[{description:"say hello",messageIndexes:[0]}]}));}
      else{process.stdout.write(JSON.stringify({outcome:"success",frustration:"low",signals:["greeted"],reason:"the agent replied"}));}
    });`,
    "utf8",
  );
  return `"${process.execPath}" "${script}"`;
}

function commandExtraction(root: string): ResolvedTaskExtraction {
  return { enabled: true, provider: "command", command: fakeProviderCommand(root) };
}

async function indexCodex(root: string): Promise<string> {
  const codexSessionsDir = join(root, "codex-sessions");
  cpSync(join(FIX, "codex-sessions"), codexSessionsDir, { recursive: true });
  const storePath = join(root, "cache", "fragments.sqlite3");
  await parseAllIncrementalDetailed({
    codexSessionsDir,
    sources: ["codex"] as AgentSource[],
    storePath,
    agentsView: "off",
  });
  return storePath;
}

describe("reindexSession", () => {
  test("re-indexes one session and extracts tasks + outcome when enabled", async () => {
    const root = tempRoot();
    const storePath = await indexCodex(root);
    const store = await openStore({ path: storePath });
    try {
      const result = await reindexSession("codex:codex-sess1", {
        store,
        taskExtraction: commandExtraction(root),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]).toMatchObject({
        description: "say hello",
        outcome: "success",
        frustration: "low",
        signals: ["greeted"],
      });
      // Persisted: reading the session's tasks back returns the same outcome.
      const stored = await store.readSessionTasks("codex:codex-sess1");
      expect(stored[0]?.outcome).toBe("success");
    } finally {
      await store.close();
    }
  });

  test("without task extraction it re-materializes in isolation, producing no new tasks", async () => {
    const root = tempRoot();
    const storePath = await indexCodex(root);
    const store = await openStore({ path: storePath });
    try {
      const result = await reindexSession("codex:codex-sess1", { store });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.tasks).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test("404 for an unknown session", async () => {
    const root = tempRoot();
    const storePath = await indexCodex(root);
    const store = await openStore({ path: storePath });
    try {
      const result = await reindexSession("codex:nope", { store });
      expect(result).toMatchObject({ ok: false, status: 404 });
    } finally {
      await store.close();
    }
  });
});

describe("index-time extraction hook", () => {
  test("off by default: indexing produces no tasks", async () => {
    const root = tempRoot();
    const storePath = await indexCodex(root);
    const store = await openStore({ path: storePath });
    try {
      const tasks = await store.readSessionTasks("codex:codex-sess1");
      expect(tasks).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test("enabled: re-indexing the changed session extracts tasks during sync", async () => {
    const root = tempRoot();
    const codexSessionsDir = join(root, "codex-sessions");
    cpSync(join(FIX, "codex-sessions"), codexSessionsDir, { recursive: true });
    const storePath = join(root, "cache", "fragments.sqlite3");
    // Fresh store with extraction enabled — the session is new (changed), so the hook runs for it.
    await parseAllIncrementalDetailed({
      codexSessionsDir,
      sources: ["codex"] as AgentSource[],
      storePath,
      agentsView: "off",
      taskExtraction: commandExtraction(root),
    });
    const store = await openStore({ path: storePath });
    try {
      const tasks = await store.readSessionTasks("codex:codex-sess1");
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.outcome).toBe("success");
    } finally {
      await store.close();
    }
  });
});
