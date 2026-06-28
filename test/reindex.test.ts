import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllIncrementalDetailed, reindexSession } from "../src/indexing/pipeline.ts";
import { runInterpretationDrain } from "../src/indexing/interpret/index.ts";
import { runIndexRefresh } from "../src/index-ops.ts";
import { openStore } from "../src/store/store.ts";
import type { ResolvedTaskExtraction } from "../src/config.ts";
import type { AgentSource } from "../src/types.ts";

const FIX = join(import.meta.dir, "fixtures");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.ARGUS_TASK_PROVIDER;
  delete process.env.ARGUS_TASK_COMMAND;
  process.exitCode = 0; // a targeted refresh of a missing id sets exitCode; don't leak to the runner
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
  return { enabled: true, maxSessionsPerHour: 30, llm: { provider: "command", command: fakeProviderCommand(root) } };
}

async function indexCodex(root: string): Promise<string> {
  const codexSessionsDir = join(root, "codex-sessions");
  cpSync(join(FIX, "codex-sessions"), codexSessionsDir, { recursive: true });
  const storePath = join(root, "cache", "fragments.sqlite3");
  await parseAllIncrementalDetailed({
    codexSessionsDir,
    sources: ["codex"] as AgentSource[],
    storePath,
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

  test("reports an imported / no-local-transcript session clearly, not 'not readable' (#93)", async () => {
    const root = tempRoot();
    const storePath = join(root, "cache", "fragments.sqlite3");
    const store = await openStore({ path: storePath });
    try {
      // Imported sessions are stored under a native source but carry an empty filePath.
      await store.materializeSessions("agentsview", [
        {
          meta: { source: "codex", sessionId: "codex:imported1", project: "p", cwd: "/tmp/p", filePath: "" },
          messages: [],
        },
      ]);
      const result = await reindexSession("codex:imported1", { store });
      expect(result).toMatchObject({ ok: false, status: 422 });
      if (!result.ok) expect(result.message).toContain("no local transcript");
    } finally {
      await store.close();
    }
  });

  test("rediscovers subagent transcripts from disk, including ones added since the last index (#2)", async () => {
    const root = tempRoot();
    const projectsDir = join(root, "projects");
    cpSync(join(FIX, "projects"), projectsDir, { recursive: true });
    const storePath = join(root, "cache", "fragments.sqlite3");
    await parseAllIncrementalDetailed({
      projectsDir,
      sources: ["claude"] as AgentSource[],
      storePath,
      });
    const store = await openStore({ path: storePath });
    try {
      const countFor = (rs: { messages: { sessionId: string }[] }, id: string) =>
        rs.messages.filter((m) => m.sessionId === id).length;
      const before = await store.readResolved();
      const parent = [...before.sessions.values()].find(
        (s) => s.source === "claude" && /sess1\.jsonl$/.test(s.filePath),
      );
      expect(parent).toBeDefined();
      const id = parent!.sessionId;
      const countBefore = countFor(before, id);

      // Add a NEW subagent transcript on disk AFTER indexing — the structural index doesn't know it,
      // so only a from-disk rediscovery will fold it in. Distinct message id so it isn't deduped.
      const subDir = join(projectsDir, "-Users-fixture-proj", "sess1", "subagents");
      const a1 = readFileSync(join(subDir, "agent-a1.jsonl"), "utf8");
      writeFileSync(join(subDir, "agent-a2.jsonl"), a1.replace(/"m3"/g, '"m4"'));

      const result = await reindexSession(id, { store, context: { projectsDir } });
      expect(result.ok).toBe(true);
      // Growth isn't masked by the don't-regress guard, so this fails if the new subagent is missed.
      expect(countFor(await store.readResolved(), id)).toBe(countBefore + 1);
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

describe("decoupled interpretation drain (#153)", () => {
  test("a bulk index does NOT extract tasks (interpretation is decoupled)", async () => {
    const root = tempRoot();
    // Even with extraction configured, the structural index alone must not fire model calls.
    const codexSessionsDir = join(root, "codex-sessions");
    cpSync(join(FIX, "codex-sessions"), codexSessionsDir, { recursive: true });
    const storePath = join(root, "cache", "fragments.sqlite3");
    await parseAllIncrementalDetailed({
      codexSessionsDir,
      sources: ["codex"] as AgentSource[],
      storePath,
      taskExtraction: commandExtraction(root),
    });
    const store = await openStore({ path: storePath });
    try {
      expect(await store.readSessionTasks("codex:codex-sess1")).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test("the throttled drain interprets eligible sessions from the store after indexing", async () => {
    const root = tempRoot();
    const codexSessionsDir = join(root, "codex-sessions");
    cpSync(join(FIX, "codex-sessions"), codexSessionsDir, { recursive: true });
    const storePath = join(root, "cache", "fragments.sqlite3");
    // Structural index first (retains text by default), then drain — the decoupled order.
    await parseAllIncrementalDetailed({
      codexSessionsDir,
      sources: ["codex"] as AgentSource[],
      storePath,
    });
    const store = await openStore({ path: storePath });
    try {
      expect(await store.readSessionTasks("codex:codex-sess1")).toEqual([]); // not yet interpreted
      await runInterpretationDrain(store, commandExtraction(root));
      const tasks = await store.readSessionTasks("codex:codex-sess1");
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.outcome).toBe("success");
      // Idempotent: a second drain pass finds nothing eligible and changes nothing.
      await runInterpretationDrain(store, commandExtraction(root));
      expect(await store.readSessionTasks("codex:codex-sess1")).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  test("the drain logs per-pass progress", async () => {
    const root = tempRoot();
    const codexSessionsDir = join(root, "codex-sessions");
    cpSync(join(FIX, "codex-sessions"), codexSessionsDir, { recursive: true });
    const storePath = join(root, "cache", "fragments.sqlite3");
    await parseAllIncrementalDetailed({
      codexSessionsDir,
      sources: ["codex"] as AgentSource[],
      storePath,
    });
    const store = await openStore({ path: storePath });
    const logs: string[] = [];
    try {
      await runInterpretationDrain(store, commandExtraction(root), (s) => logs.push(s));
    } finally {
      await store.close();
    }
    expect(logs.some((l) => l.includes("Interpreting 1 session this pass"))).toBe(true);
    expect(logs.some((l) => l.includes("Interpreted 1 session this pass"))).toBe(true);
  });
});

describe("runIndexRefresh (targeted, #93)", () => {
  const base = { source: "codex" as const };

  test("refreshes a named session and reports it; --extract-tasks false forces no extraction", async () => {
    const root = tempRoot();
    const storePath = await indexCodex(root);
    const logs: string[] = [];
    await runIndexRefresh(
      { ...base, ids: ["codex:codex-sess1"], extractTasks: false, storePath },
      (s) => logs.push(s),
    );
    expect(logs).toContain("Refreshed codex:codex-sess1.");
    expect(logs).toContain("Refreshed 1 session(s).");
    const store = await openStore({ path: storePath });
    try {
      expect(await store.readSessionTasks("codex:codex-sess1")).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test("--extract-tasks true extracts for the targeted session (provider via env)", async () => {
    const root = tempRoot();
    const storePath = await indexCodex(root);
    // index commands expose no --task-provider, so the provider comes from config/env; inject a fake.
    process.env.ARGUS_TASK_PROVIDER = "command";
    process.env.ARGUS_TASK_COMMAND = fakeProviderCommand(root);
    const logs: string[] = [];
    await runIndexRefresh(
      { ...base, ids: ["codex:codex-sess1"], extractTasks: true, storePath },
      (s) => logs.push(s),
    );
    expect(logs).toContain("Refreshed codex:codex-sess1 (1 task).");
    const store = await openStore({ path: storePath });
    try {
      expect((await store.readSessionTasks("codex:codex-sess1"))[0]?.outcome).toBe("success");
    } finally {
      await store.close();
    }
  });

  test("preserves aux-derived firstPrompt (Claude history) — regression for the wipe-on-refresh bug", async () => {
    const root = tempRoot();
    const projectsDir = join(root, "projects");
    cpSync(join(FIX, "projects"), projectsDir, { recursive: true });
    const historyFile = join(root, "history.jsonl");
    cpSync(join(FIX, "history.jsonl"), historyFile);
    const storePath = join(root, "cache", "fragments.sqlite3");
    // Full index resolves firstPrompt from history.jsonl (an auxiliary input).
    await parseAllIncrementalDetailed({
      projectsDir,
      historyFile,
      sources: ["claude"] as AgentSource[],
      storePath,
      });
    const store = await openStore({ path: storePath });
    try {
      const resolved = await store.readResolved();
      const withPrompt = [...resolved.sessions.values()].find(
        (s) => s.source === "claude" && (s.firstPrompt?.trim().length ?? 0) > 0,
      );
      expect(withPrompt).toBeDefined();
      const id = withPrompt!.sessionId;
      const prompt = withPrompt!.firstPrompt;
      // Targeted refresh in isolation: must keep the aux-derived firstPrompt, not wipe it back to empty.
      const res = await reindexSession(id, { store, context: { historyFile, projectsDir } });
      expect(res.ok).toBe(true);
      expect((await store.readSessionMeta(id))?.firstPrompt).toBe(prompt);
    } finally {
      await store.close();
    }
  });

  test("a missing session reports a clear error, changes nothing, and exits non-zero", async () => {
    const root = tempRoot();
    const storePath = await indexCodex(root);
    const logs: string[] = [];
    await runIndexRefresh({ ...base, ids: ["codex:nope"], storePath }, (s) => logs.push(s));
    expect(logs.some((l) => l.includes("No session found for codex:nope"))).toBe(true);
    expect(logs).toContain("Refreshed 0 session(s), 1 couldn't be refreshed.");
    expect(process.exitCode).toBe(1);
    // The real session is untouched.
    const store = await openStore({ path: storePath });
    try {
      expect((await store.readResolved()).sessions.has("codex:codex-sess1")).toBe(true);
    } finally {
      await store.close();
    }
  });
});
