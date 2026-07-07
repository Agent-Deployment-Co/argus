import { describe, expect, test } from "bun:test";
import { buildSessionDetail, buildSessionList } from "../src/api/session-list.ts";
import type { SessionAggregate } from "../src/store/store-contract.ts";
import type { MessageRecord, SessionMeta, Usage } from "../src/types.ts";

function usage(input: number): Usage {
  return { input, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

function agg(sessionId: string, over: Partial<SessionMeta> & { input: number; start: number }): SessionAggregate {
  const { input, start, ...meta } = over;
  return {
    meta: {
      source: "codex",
      sessionId,
      project: "p",
      cwd: "/tmp/p",
      filePath: "/tmp/p/r.jsonl",
      firstPrompt: sessionId,
      ...meta,
    } as SessionMeta,
    byModel: [{ model: "gpt-5", usage: usage(input) }],
    firstTs: start,
    lastTs: start,
    messageCount: 1,
    title: null,
    summary: null,
  };
}

describe("buildSessionList", () => {
  const aggregates: SessionAggregate[] = [
    agg("small", { input: 10, start: 300 }),
    agg("big", { input: 1000, start: 100 }),
    agg("mid", { input: 100, start: 200 }),
  ];

  test("sorts by most recent (start desc) by default", () => {
    const page = buildSessionList(aggregates, { sort: "recent", limit: 10, offset: 0 });
    expect(page.rows.map((r) => r.sessionId)).toEqual(["small", "mid", "big"]);
    expect(page.total).toBe(3);
  });

  test("sorts by tokens desc", () => {
    const page = buildSessionList(aggregates, { sort: "tokens", limit: 10, offset: 0 });
    expect(page.rows.map((r) => r.sessionId)).toEqual(["big", "mid", "small"]);
    expect(page.rows[0]!.total).toBe(1000);
    expect(page.rows[0]!.cost).toBeGreaterThan(0); // gpt-5 is priced
  });

  test("paginates with limit/offset while reporting the full total", () => {
    const page = buildSessionList(aggregates, { sort: "tokens", limit: 1, offset: 1 });
    expect(page.rows.map((r) => r.sessionId)).toEqual(["mid"]);
    expect(page.total).toBe(3);
    expect(page.offset).toBe(1);
    expect(page.limit).toBe(1);
  });

  test("hides Argus-generated sessions unless includeGenerated", () => {
    const withGenerated = [...aggregates, agg("gen", { input: 5, start: 400, firstPrompt: "Task extraction run" })];
    const hidden = buildSessionList(withGenerated, { sort: "recent", limit: 10, offset: 0 });
    expect(hidden.rows.map((r) => r.sessionId)).not.toContain("gen");
    const shown = buildSessionList(withGenerated, { sort: "recent", limit: 10, offset: 0, includeGenerated: true });
    expect(shown.rows.map((r) => r.sessionId)).toContain("gen");
  });

  test("filters by project label and free-text", () => {
    const mixed = [
      agg("a", { input: 1, start: 1, project: "web/app", firstPrompt: "fix login" }),
      agg("b", { input: 1, start: 2, project: "cli/tool", firstPrompt: "add flag" }),
    ];
    expect(buildSessionList(mixed, { sort: "recent", limit: 10, offset: 0, project: "web" }).rows.map((r) => r.sessionId)).toEqual(["a"]);
    expect(buildSessionList(mixed, { sort: "recent", limit: 10, offset: 0, q: "flag" }).rows.map((r) => r.sessionId)).toEqual(["b"]);
  });

  test("attaches a search match onto its row without touching non-matching rows (#155)", () => {
    const mixed = [
      agg("a", { input: 1, start: 1, project: "web/app", firstPrompt: "totally unrelated" }),
      agg("b", { input: 1, start: 2, project: "cli/tool", firstPrompt: "totally unrelated too" }),
    ];
    const matches = new Map([["b", { count: 2, snippet: "the pricing bug", source: "conversation" as const }]]);
    const page = buildSessionList(mixed, { sort: "recent", limit: 10, offset: 0, matches });
    expect(page.rows.find((r) => r.sessionId === "a")?.match).toBeUndefined();
    expect(page.rows.find((r) => r.sessionId === "b")?.match).toEqual(matches.get("b"));
  });

  test("omitting q when matches is set doesn't re-apply the plain metadata substring filter", () => {
    // Simulates the serve-side wiring: a session that matched ONLY via FTS (title/project/source
    // don't contain the search term) must survive here — the caller passes q: undefined once a
    // store-side search already ran, so this plain metadata check must not re-exclude it.
    const mixed = [agg("a", { input: 1, start: 1, project: "p", firstPrompt: "no keyword here" })];
    const matches = new Map([["a", { count: 1, snippet: "s", source: "task" as const }]]);
    const page = buildSessionList(mixed, { sort: "recent", limit: 10, offset: 0, matches });
    expect(page.rows.map((r) => r.sessionId)).toEqual(["a"]);
  });
});

describe("buildSessionDetail", () => {
  test("builds a full SessionRow with tool counts, files, and cost", () => {
    const meta: SessionMeta = {
      source: "codex",
      sessionId: "codex:d",
      project: "p",
      cwd: "/tmp/p",
      filePath: "/tmp/p/r.jsonl",
      firstPrompt: "do the thing",
    };
    const messages: MessageRecord[] = [
      {
        source: "codex",
        sessionId: "codex:d",
        project: "p",
        cwd: "/tmp/p",
        gitBranch: "",
        ts: 1000,
        date: "2026-06-01",
        model: "gpt-5",
        usage: usage(50),
        attributionSkill: null,
        toolUses: [{ name: "Edit", category: "file-io", filePath: "a.ts" }],
      },
    ];
    const row = buildSessionDetail("codex:d", messages, meta, []);
    expect(row.sessionId).toBe("codex:d");
    expect(row.total).toBe(50);
    expect(row.cost).toBeGreaterThan(0);
    expect(row.toolCounts).toEqual({ Edit: 1 });
    expect(row.filesTouched).toEqual(["a.ts"]);
    expect(row.firstPrompt).toBe("do the thing");
    // Summary comes from the shared summaryFactsFromMessages derivation (matches the dashboard path).
    expect(row.summary).toContain("do the thing");
    expect(row.summary).toContain("Edit");
  });
});
