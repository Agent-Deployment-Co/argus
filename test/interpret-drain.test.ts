// Store-level contract for the decoupled, throttled Interpret stage (#153): the interpretation-state
// columns, the eligibility query, the tasks-only write path, the rehydrated interaction text, and the
// persisted rate bucket. The drain's end-to-end behavior (interpret → write → idempotent) is covered
// against real fixtures in reindex.test.ts; here we pin the primitives deterministically without an LLM.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store/store.ts";
import { INTERPRETER_VERSION } from "../src/indexing/interpret/index.ts";
import type { MaterializeSession, TaskFact } from "../src/store/store-contract.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-interpret-"));
  dirs.push(dir);
  return join(dir, "argus.db");
}

/** A minimal session with one human interaction carrying prompt/response text — a task candidate. */
function humanSession(sid: string, ts: number, promptText = "do the thing"): MaterializeSession {
  return {
    meta: { source: "claude", sessionId: sid, project: "p", cwd: "/tmp/p", filePath: "/tmp/p/r.jsonl" },
    messages: [
      {
        source: "claude",
        sessionId: sid,
        project: "p",
        cwd: "/tmp/p",
        gitBranch: "",
        ts,
        date: "2026-06-01",
        model: "claude-opus-4",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        attributionSkill: null,
        toolUses: [],
      },
    ],
    interactions: [
      {
        id: `${sid}-i0`,
        source: "claude",
        sourceSessionId: sid,
        seq: 0,
        initiator: "human",
        disposition: "completed",
        compactionCount: 0,
        timestampMs: ts,
        promptPosition: { originKey: "f", recordIndex: 0, itemIndex: 0 },
        position: { originKey: "f", recordIndex: 0, itemIndex: 0 },
        promptText,
        responseText: "done",
      },
    ],
  };
}

function task(sid: string, ts: number): TaskFact {
  return {
    id: `task:${sid}`,
    source: "claude",
    sourceSessionId: sid,
    timestampMs: ts,
    description: "the task",
    evidence: "message indexes: 0",
    evidenceKind: "llm_inference",
    position: { originKey: "f", recordIndex: 0, itemIndex: 0 },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("interpretation eligibility + state (#153)", () => {
  test("a freshly materialized session with retained human text is eligible", async () => {
    const store = await openStore({ path: storePath() });
    try {
      await store.materializeSessions("claude", [humanSession("claude:s1", 1000)]);
      expect(await store.readPendingInterpretationSessions(10)).toEqual(["claude:s1"]);
      const progress = await store.interpretationProgress();
      expect(progress).toEqual({ interpreted: 0, pending: 1, outdated: 0 });
    } finally {
      await store.close();
    }
  });

  test("writeSessionTasks stamps interpreted_at even for zero tasks, de-queuing the session", async () => {
    const store = await openStore({ path: storePath() });
    try {
      await store.materializeSessions("claude", [humanSession("claude:s1", 1000)]);
      await store.writeSessionTasks("claude:s1", [], INTERPRETER_VERSION);
      expect(await store.readPendingInterpretationSessions(10)).toEqual([]);
      expect(await store.readSessionTasks("claude:s1")).toEqual([]);
      const progress = await store.interpretationProgress();
      expect(progress).toEqual({ interpreted: 1, pending: 0, outdated: 0 });
    } finally {
      await store.close();
    }
  });

  test("a content change after interpretation marks the session outdated and eligible again", async () => {
    const store = await openStore({ path: storePath() });
    try {
      await store.materializeSessions("claude", [humanSession("claude:s1", 1000)]);
      await tick();
      await store.writeSessionTasks("claude:s1", [task("claude:s1", 1000)], INTERPRETER_VERSION);
      expect(await store.readPendingInterpretationSessions(10)).toEqual([]);

      // Unchanged re-materialize keeps it current (content_indexed_at carried forward).
      await store.materializeSessions("claude", [humanSession("claude:s1", 1000)]);
      expect(await store.readPendingInterpretationSessions(10)).toEqual([]);
      expect(await store.readSessionTasks("claude:s1")).toHaveLength(1); // prior tasks preserved

      // Changed content bumps content_indexed_at past interpreted_at → outdated + eligible, but the
      // prior interpretation is preserved (not wiped) until re-interpreted.
      await tick();
      await store.materializeSessions("claude", [humanSession("claude:s1", 2000)]);
      expect(await store.readPendingInterpretationSessions(10)).toEqual(["claude:s1"]);
      expect(await store.readSessionTasks("claude:s1")).toHaveLength(1);
      expect(await store.interpretationProgress()).toEqual({ interpreted: 1, pending: 1, outdated: 1 });
    } finally {
      await store.close();
    }
  });

  test("a session indexed without text retention is never eligible", async () => {
    const store = await openStore({ path: storePath() });
    try {
      await store.materializeSessions("claude", [humanSession("claude:s1", 1000)], { retainText: false });
      expect(await store.readPendingInterpretationSessions(10)).toEqual([]);
      const interactions = await store.readSessionInteractions("claude:s1");
      expect(interactions).toHaveLength(1);
      expect(interactions[0]?.promptText).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  test("readSessionInteractions merges retained prompt/response text by interaction", async () => {
    const store = await openStore({ path: storePath() });
    try {
      await store.materializeSessions("claude", [humanSession("claude:s1", 1000, "please help")]);
      const interactions = await store.readSessionInteractions("claude:s1");
      expect(interactions).toHaveLength(1);
      expect(interactions[0]?.promptText).toBe("please help");
      expect(interactions[0]?.responseText).toBe("done");
      expect(interactions[0]?.initiator).toBe("human");
    } finally {
      await store.close();
    }
  });

  test("newest-first ordering by last_ts", async () => {
    const store = await openStore({ path: storePath() });
    try {
      await store.materializeSessions("claude", [
        humanSession("claude:old", 1000),
        humanSession("claude:new", 5000),
        humanSession("claude:mid", 3000),
      ]);
      expect(await store.readPendingInterpretationSessions(10)).toEqual([
        "claude:new",
        "claude:mid",
        "claude:old",
      ]);
    } finally {
      await store.close();
    }
  });
});

describe("interpretation rate limiter (#153)", () => {
  test("a fresh bucket starts full, decrements on grant, and refuses when empty", async () => {
    const store = await openStore({ path: storePath() });
    try {
      expect(await store.takeInterpretCredits(3, 10)).toBe(3); // full bucket of 10 credits, grant 3
      expect(await store.takeInterpretCredits(10, 10)).toBe(7); // ~7 left, grant the rest
      expect(await store.takeInterpretCredits(5, 10)).toBe(0); // empty until it refills
    } finally {
      await store.close();
    }
  });

  test("the ceiling persists across store reopens", async () => {
    const path = storePath();
    let store = await openStore({ path });
    expect(await store.takeInterpretCredits(10, 10)).toBe(10); // drain the bucket
    await store.close();
    store = await openStore({ path });
    try {
      expect(await store.takeInterpretCredits(5, 10)).toBe(0); // still empty right after reopen
    } finally {
      await store.close();
    }
  });

  test("a disabled rate (0/hr) grants nothing", async () => {
    const store = await openStore({ path: storePath() });
    try {
      expect(await store.takeInterpretCredits(5, 0)).toBe(0);
    } finally {
      await store.close();
    }
  });
});
