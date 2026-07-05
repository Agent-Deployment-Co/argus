import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeFrictionEvents, foldFrictionEvents, type FrictionEvent } from "../src/indexing/friction.ts";
import {
  claudeHistoryFileIdentity,
  discoverClaudeTranscripts,
  parseClaudeTranscriptFile,
} from "../src/indexing/parse/producers/claude/parser.ts";
import { parseAllIncrementalDetailed } from "../src/indexing/pipeline.ts";
import { parseFixtures } from "./helpers/parse-fixtures.ts";
import { buildSessionRow } from "../src/reporting/aggregate.ts";
import { openStore } from "../src/store/store.ts";
import {
  emptySessionFriction,
  type MessageRecord,
  type ParseResult,
  type SessionFriction,
  type SessionRow,
} from "../src/types.ts";

const FIX = join(import.meta.dir, "fixtures");
const FRICTION_PROJECTS = join(FIX, "friction-projects");
const HISTORY = join(FIX, "history.jsonl");
// Parse the friction fixture once via the real pipeline (temp store); the describe blocks below read it.
const frictionParsed = await parseFixtures({ projectsDir: FRICTION_PROJECTS, historyFile: HISTORY });
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-friction-"));
  tempDirs.push(dir);
  return dir;
}

describe("claudeFrictionEvents", () => {
  test("detects interruptions from text parts and plain-string content", () => {
    const fromParts = claudeFrictionEvents({
      type: "user",
      uuid: "u1",
      message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
    });
    expect(fromParts).toEqual([{ kind: "interruption", eventId: "u1" }]);
    const fromString = claudeFrictionEvents({
      type: "user",
      uuid: "u2",
      message: { content: "[Request interrupted by user for tool use]" },
    });
    expect(fromString).toEqual([{ kind: "interruption", eventId: "u2" }]);
  });

  test("detects permission rejections per tool_result, keyed by tool_use_id", () => {
    const events = claudeFrictionEvents({
      type: "user",
      uuid: "u3",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_a",
            is_error: true,
            content: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_b",
            is_error: true,
            content: [{ type: "text", text: "The user doesn't want to proceed with this tool use. STOP." }],
          },
          { type: "tool_result", tool_use_id: "toolu_c", content: "ordinary result" },
        ],
      },
    });
    expect(events).toEqual([
      { kind: "rejection", eventId: "toolu_a" },
      { kind: "rejection", eventId: "toolu_b" },
    ]);
  });

  test("detects turn durations, compact boundaries, and compact summaries", () => {
    expect(
      claudeFrictionEvents({ type: "system", subtype: "turn_duration", uuid: "u4", durationMs: 1234 }),
    ).toEqual([{ kind: "turn", eventId: "u4", durationMs: 1234 }]);
    expect(
      claudeFrictionEvents({ type: "system", subtype: "turn_duration", uuid: "u5" }),
    ).toEqual([{ kind: "turn", eventId: "u5" }]);
    expect(
      claudeFrictionEvents({ type: "system", subtype: "compact_boundary", uuid: "u6" }),
    ).toEqual([{ kind: "compact_boundary", eventId: "u6" }]);
    expect(
      claudeFrictionEvents({ type: "user", uuid: "u7", isCompactSummary: true, message: { content: "summary" } }),
    ).toEqual([{ kind: "compact_summary", eventId: "u7" }]);
  });

  test("falls back to kind+session+timestamp identity when uuid is missing", () => {
    const events = claudeFrictionEvents({
      type: "system",
      subtype: "turn_duration",
      sessionId: "s1",
      timestamp: "2026-06-01T10:00:00.000Z",
      durationMs: 10,
    });
    expect(events[0]?.eventId).toBe("turn:s1:2026-06-01T10:00:00.000Z");
  });

  test("ignores ordinary records", () => {
    expect(claudeFrictionEvents({ type: "user", message: { content: "normal prompt" } })).toEqual([]);
    expect(claudeFrictionEvents({ type: "system", subtype: "stop_hook_summary" })).toEqual([]);
    expect(claudeFrictionEvents({ type: "assistant", message: { content: [] } })).toEqual([]);
  });
});

describe("foldFrictionEvents", () => {
  test("counts kinds and collects turn durations", () => {
    const events: FrictionEvent[] = [
      { kind: "interruption", eventId: "a" },
      { kind: "rejection", eventId: "b" },
      { kind: "turn", eventId: "c", durationMs: 100 },
      { kind: "turn", eventId: "d" },
    ];
    expect(foldFrictionEvents(events)).toEqual({
      interruptions: 1,
      rejections: 1,
      compactions: 0,
      turns: 2,
      turnDurationsMs: [100],
      stopReasons: {},
    });
  });

  test("resolves compactions as max(boundaries, summaries) to avoid double-counting", () => {
    const fold = (kinds: Array<"compact_boundary" | "compact_summary">) =>
      foldFrictionEvents(kinds.map((kind, i) => ({ kind, eventId: String(i) }))).compactions;
    expect(fold(["compact_boundary", "compact_summary"])).toBe(1);
    expect(fold(["compact_boundary", "compact_boundary", "compact_summary"])).toBe(2);
    expect(fold(["compact_summary"])).toBe(1);
  });
});

describe("session friction (pipeline)", () => {
  const friction = frictionParsed.sessions.get("frict1")?.friction;

  test("folds per-session counters from the transcript", () => {
    expect(friction).toBeDefined();
    expect(friction!.rejections).toBe(1);
    expect(friction!.compactions).toBe(1);
    expect(friction!.stopReasons).toEqual({ tool_use: 1, end_turn: 1 });
  });

  test("dedupes replayed records across resumed-session files", () => {
    // resume-frict1.jsonl replays u-int-1, u-turn-1, u-cb-1, and fr-m1 verbatim and adds
    // one new interruption + one new turn. Replays must not double-count.
    expect(friction!.interruptions).toBe(3);
    expect(friction!.turns).toBe(3);
    expect([...friction!.turnDurationsMs].sort((a, b) => a - b)).toEqual([5000, 13000, 47000]);
    expect(frictionParsed.messages.filter((m) => m.sessionId === "frict1").length).toBe(2);
  });

  test("counts a streamed message's stop_reason once, from its final line", () => {
    // fr-m2 streams two lines: stop_reason null then end_turn.
    expect(friction!.stopReasons.end_turn).toBe(1);
  });

  test("leaves friction undefined for non-Claude sources", async () => {
    const codex = await parseFixtures({ codexSessionsDir: join(FIX, "codex-sessions"), sources: ["codex"] });
    for (const meta of codex.sessions.values()) expect(meta.friction).toBeUndefined();
    const gemini = await parseFixtures({ geminiDir: join(FIX, "gemini"), sources: ["gemini"] });
    for (const meta of gemini.sessions.values()) expect(meta.friction).toBeUndefined();
  });

  test("claude sessions with zero friction get explicit zeros, not undefined", async () => {
    const calm = await parseFixtures({ projectsDir: join(FIX, "projects"), historyFile: HISTORY });
    const meta = calm.sessions.get("sess1")!;
    expect(meta.friction).toMatchObject({ interruptions: 0, rejections: 0, compactions: 0, turns: 0 });
  });
});

describe("Claude fragment friction (incremental path)", () => {
  test("emits friction events on SessionFact and stopReason on UsageFact", () => {
    const discovery = discoverClaudeTranscripts(FRICTION_PROJECTS);
    expect(discovery.status).toBe("complete");
    const file = discovery.files.find((f) => f.file.relativePath.endsWith("/frict1.jsonl"))!;
    const result = parseClaudeTranscriptFile(file, {
      historyInputId: claudeHistoryFileIdentity(HISTORY).id,
    });
    expect(result.status).toBe("current");
    if (result.status !== "current") throw new Error("expected current fragment");

    const events = result.fragment.facts.sessions[0]?.frictionEvents ?? [];
    expect(events.map((e) => e.kind).sort()).toEqual([
      "compact_boundary",
      "compact_summary",
      "interruption",
      "interruption",
      "rejection",
      "turn",
      "turn",
    ]);
    expect(events.find((e) => e.kind === "rejection")?.eventId).toBe("ft1");

    const stopReasons = result.fragment.facts.messages.map((m) => [m.providerMessageId, m.stopReason]);
    expect(stopReasons).toEqual([
      ["fr-m1", "tool_use"],
      ["fr-m2", "end_turn"], // streamed: null on first line, backfilled from the continuation
    ]);
  });

  test("reconciles friction consistently, including across cache hits", async () => {
    const root = tempRoot();
    const projectsDir = join(root, "friction-projects");
    cpSync(FRICTION_PROJECTS, projectsDir, { recursive: true });
    cpSync(HISTORY, join(root, "history.jsonl"));
    const opts = {
      projectsDir,
      historyFile: join(root, "history.jsonl"),
      storePath: join(root, "cache", "fragments.sqlite3"),
    };

    const first = await parseAllIncrementalDetailed(opts);
    const second = await parseAllIncrementalDetailed(opts);
    for (const run of [first, second]) {
      expect(run.stats.fallback).toBe(false);
      const friction = run.parsed.sessions.get("frict1")?.friction;
      expect(friction).toBeDefined();
      expect({
        ...friction!,
        turnDurationsMs: [...friction!.turnDurationsMs].sort((a, b) => a - b),
      }).toMatchObject({
        interruptions: 3,
        rejections: 1,
        compactions: 1,
        turns: 3,
        turnDurationsMs: [5000, 13000, 47000],
        stopReasons: { tool_use: 1, end_turn: 1 },
      });
    }
    expect(second.stats.hits).toBeGreaterThan(0);
    expect(second.stats.parsed).toBe(0);
  });
});

// ---- #38: session health aggregation ----

function syntheticMessage(over: Partial<MessageRecord> & { ts: number }): MessageRecord {
  return {
    source: "claude",
    sessionId: "syn1",
    project: "syn/proj",
    cwd: "/syn/proj",
    gitBranch: "",
    date: "2026-06-01",
    model: "claude-sonnet-4-6",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    attributionSkill: null,
    toolUses: [],
    ...over,
  };
}

function syntheticParse(messages: MessageRecord[], friction?: SessionFriction): ParseResult {
  return {
    messages,
    sessions: new Map([
      [
        "syn1",
        {
          source: "claude" as const,
          sessionId: "syn1",
          project: "syn/proj",
          cwd: "/syn/proj",
          filePath: "/tmp/syn1.jsonl",
          ...(friction ? { friction } : {}),
        },
      ],
    ]),
    toolResults: new Map(),
  };
}

/** Build each session's row the way /api/session(s) does now — buildSessionRow per session, instead
 *  of the deleted monolithic aggregate(). */
function sessionRowsFor(parsed: ParseResult): SessionRow[] {
  const bySession = new Map<string, MessageRecord[]>();
  for (const m of parsed.messages) {
    (bySession.get(m.sessionId) ?? bySession.set(m.sessionId, []).get(m.sessionId)!).push(m);
  }
  return [...bySession].map(([id, msgs]) =>
    buildSessionRow(id, msgs, parsed.sessions.get(id), "", parsed.tasksBySession?.get(id) ?? []),
  );
}

/** The friction rollup now lives in SQL (readHealthRollups). Seed a throwaway store from an in-memory
 *  ParseResult and read it back, so the rollup is exercised end to end like the /api/health endpoint. */
async function healthRollupsFor(parsed: ParseResult) {
  const store = await openStore({ path: join(tempRoot(), "argus.db") });
  try {
    const bySession = new Map<string, MessageRecord[]>();
    for (const m of parsed.messages) {
      (bySession.get(m.sessionId) ?? bySession.set(m.sessionId, []).get(m.sessionId)!).push(m);
    }
    const sessions = [...bySession].map(([id, messages]) => ({ meta: parsed.sessions.get(id)!, messages }));
    await store.materializeSessions("claude", sessions);
    return await store.readHealthRollups();
  } finally {
    await store.close();
  }
}

describe("session health (#38)", () => {
  const rows = sessionRowsFor(frictionParsed);
  const row = rows.find((s) => s.sessionId === "frict1")!;

  test("folds friction onto SessionRow.health", () => {
    expect(row.health).toMatchObject({
      interruptions: 3,
      rejections: 1,
      compactions: 1,
      turns: 3,
      medianTurnMs: 13000,
      maxTurnMs: 47000,
      stopReasons: { tool_use: 1, end_turn: 1 },
      tokenGrowth: null, // only 2 messages — too short for a decile trend
    });
  });

  test("rolls friction up to totals and per-project meta", async () => {
    const health = await healthRollupsFor(frictionParsed);
    expect(health.frictionTotals).toEqual({
      observableSessions: 1,
      interruptions: 3,
      rejections: 1,
      compactions: 1,
      turns: 3,
    });
    const project = health.projectFriction.find((p) => p.project === "fixture/frict")!;
    expect(project.friction).toEqual({
      observableSessions: 1,
      interruptions: 3,
      rejections: 1,
      compactions: 1,
      turns: 3,
    });
  });

  test("friction is null (not zero) for a source that doesn't observe it", () => {
    const codex = sessionRowsFor({
      messages: [syntheticMessage({ ts: 1, source: "codex", sessionId: "cx", project: "p" })],
      sessions: new Map(),
      toolResults: new Map(),
    })[0]!.health;
    expect(codex.interruptions).toBeNull();
    expect(codex.stopReasons).toBeNull();
  });

  test("tokenGrowth compares last-decile to first-decile mean tokens per message", () => {
    // 20 messages whose total tokens are i*1000: first decile mean 500, last 18500 → 37.
    const msgs = Array.from({ length: 20 }, (_, i) =>
      syntheticMessage({
        ts: i * 1000,
        usage: { input: 0, output: 0, cacheRead: i * 1000, cacheWrite5m: 0, cacheWrite1h: 0 },
      }),
    );
    const health = sessionRowsFor(syntheticParse(msgs, emptySessionFriction()))[0]!.health;
    expect(health.tokenGrowth).toBe(37);

    const short = sessionRowsFor(syntheticParse(msgs.slice(0, 9), emptySessionFriction()));
    expect(short[0]!.health.tokenGrowth).toBeNull();
  });

  test("non-Claude sessions report null friction fields but still get tokenGrowth", () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      syntheticMessage({
        ts: i,
        source: "codex",
        sessionId: "cx2",
        usage: { input: 100 * (i + 1), output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      }),
    );
    const health = sessionRowsFor({ messages: msgs, sessions: new Map(), toolResults: new Map() })[0]!.health;
    expect(health.interruptions).toBeNull();
    expect(health.tokenGrowth).toBe(10); // 1000/100
  });
});
