import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeFrictionEvents, foldFrictionEvents, type FrictionEvent } from "../src/friction.ts";
import {
  claudeHistoryFileIdentity,
  discoverClaudeTranscripts,
  parseClaudeTranscriptFile,
} from "../src/parse-claude.ts";
import { parseAllIncrementalDetailed } from "../src/parse-incremental.ts";
import { parseAll } from "../src/parse.ts";

const FIX = join(import.meta.dir, "fixtures");
const FRICTION_PROJECTS = join(FIX, "friction-projects");
const HISTORY = join(FIX, "history.jsonl");
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

describe("parseAll friction (legacy path)", () => {
  const parsed = parseAll({ projectsDir: FRICTION_PROJECTS, historyFile: HISTORY });
  const friction = parsed.sessions.get("frict1")?.friction;

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
    expect(parsed.messages.filter((m) => m.sessionId === "frict1").length).toBe(2);
  });

  test("counts a streamed message's stop_reason once, from its final line", () => {
    // fr-m2 streams two lines: stop_reason null then end_turn.
    expect(friction!.stopReasons.end_turn).toBe(1);
  });

  test("leaves friction undefined for non-Claude sources", () => {
    const codex = parseAll({ codexSessionsDir: join(FIX, "codex-sessions"), sources: ["codex"] });
    for (const meta of codex.sessions.values()) expect(meta.friction).toBeUndefined();
    const gemini = parseAll({ geminiDir: join(FIX, "gemini"), sources: ["gemini"] });
    for (const meta of gemini.sessions.values()) expect(meta.friction).toBeUndefined();
  });

  test("claude sessions with zero friction get explicit zeros, not undefined", () => {
    const calm = parseAll({ projectsDir: join(FIX, "projects"), historyFile: HISTORY });
    const meta = calm.sessions.get("sess1")!;
    expect(meta.friction).toMatchObject({ interruptions: 0, rejections: 0, compactions: 0, turns: 0 });
  });
});

describe("Claude fragment friction (incremental path)", () => {
  test("emits friction events on SessionFact and stopReason on MessageFact", () => {
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

  test("reconciles to the same friction as the legacy path, including across cache hits", async () => {
    const root = tempRoot();
    const projectsDir = join(root, "friction-projects");
    cpSync(FRICTION_PROJECTS, projectsDir, { recursive: true });
    cpSync(HISTORY, join(root, "history.jsonl"));
    const opts = {
      projectsDir,
      historyFile: join(root, "history.jsonl"),
      cachePath: join(root, "cache", "fragments.sqlite3"),
      agentsView: "off" as const,
    };

    const native = parseAll(opts).sessions.get("frict1")!.friction!;
    const first = await parseAllIncrementalDetailed(opts);
    const second = await parseAllIncrementalDetailed(opts);
    for (const run of [first, second]) {
      expect(run.stats.fallback).toBe(false);
      const friction = run.parsed.sessions.get("frict1")?.friction;
      expect(friction).toBeDefined();
      expect({ ...friction!, turnDurationsMs: [...friction!.turnDurationsMs].sort((a, b) => a - b) }).toEqual({
        ...native,
        turnDurationsMs: [...native.turnDurationsMs].sort((a, b) => a - b),
      });
    }
    expect(second.stats.hits).toBeGreaterThan(0);
    expect(second.stats.parsed).toBe(0);
  });
});
