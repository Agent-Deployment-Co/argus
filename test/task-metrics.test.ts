import { describe, expect, test } from "bun:test";
import { computeTaskMetrics } from "../src/api/task-metrics.ts";
import type { MessageRecord, ToolUse } from "../src/types.ts";

function tool(name: string): ToolUse {
  return { name, category: "other" };
}

function msg(over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    source: "claude",
    sessionId: "s1",
    project: "p",
    cwd: "/tmp/p",
    gitBranch: "",
    ts: 1,
    date: "2026-06-01",
    model: "unpriced-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    attributionSkill: null,
    toolUses: [],
    ...over,
  };
}

describe("computeTaskMetrics", () => {
  test("sums tokens and tallies tools/models across messages", () => {
    const metrics = computeTaskMetrics([
      msg({ model: "m1", usage: { input: 10, output: 5, cacheRead: 1, cacheWrite5m: 2, cacheWrite1h: 0 }, toolUses: [tool("Bash"), tool("Edit")] }),
      msg({ model: "m2", usage: { input: 20, output: 7, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 3 }, toolUses: [tool("Bash")] }),
    ]);

    expect(metrics.messages).toBe(2);
    expect(metrics.usage).toEqual({ input: 30, output: 12, cacheRead: 1, cacheWrite5m: 2, cacheWrite1h: 3 });
    expect(metrics.totalTokens).toBe(48);
    expect(metrics.toolCalls).toBe(3);
    expect(metrics.toolCounts).toEqual({ Bash: 2, Edit: 1 });
    expect(metrics.models.sort()).toEqual(["m1", "m2"]);
  });

  test("tool counts are ordered highest first", () => {
    const metrics = computeTaskMetrics([
      msg({ toolUses: [tool("Read"), tool("Bash"), tool("Bash"), tool("Bash"), tool("Read")] }),
    ]);
    expect(Object.keys(metrics.toolCounts)).toEqual(["Bash", "Read"]);
  });

  test("empty task yields zeroed metrics", () => {
    const metrics = computeTaskMetrics([]);
    expect(metrics.messages).toBe(0);
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.cost).toBe(0);
    expect(metrics.toolCalls).toBe(0);
    expect(metrics.toolCounts).toEqual({});
    expect(metrics.models).toEqual([]);
  });

  test("unpriced models cost 0 (not NaN)", () => {
    const metrics = computeTaskMetrics([msg({ usage: { input: 100, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } })]);
    expect(metrics.cost).toBe(0);
  });
});
