import { describe, expect, test } from "bun:test";
import { consoleOverview, isBareInvocation } from "../src/console-report.ts";
import type { Dashboard } from "../src/types.ts";

function dashboard(): Dashboard {
  return {
    generatedAtMs: 0,
    range: { start: "2026-06-01", end: "2026-06-02" },
    totals: {
      sessions: 3,
      messages: 12,
      usage: { input: 100, output: 50, cacheRead: 850, cacheWrite5m: 0, cacheWrite1h: 0 },
      total: 1_000,
      cost: 0.25,
    },
    unpriced: [],
    daily: [
      { date: "2026-06-01", input: 50, output: 25, cacheRead: 425, cacheWrite: 0, total: 500, cost: 0.1 },
      { date: "2026-06-02", input: 50, output: 25, cacheRead: 425, cacheWrite: 0, total: 500, cost: 0.15 },
    ],
    byModel: [],
    bySource: [],
    bySkill: [
      { name: "jj:jj", messages: 4, total: 600, cost: 0.1 },
      { name: "(none)", messages: 8, total: 400, cost: 0.15 },
    ],
    skillInvocations: [],
    byMcpServer: [
      { server: "fathom", calls: 5, approxResultTokens: 200, topTools: [] },
    ],
    byTool: [],
    byToolCategory: [],
    heaviestToolResults: [],
    byPlugin: [],
    byProject: [
      { name: "adc/argus", messages: 12, total: 1_000, cost: 0.25, meta: { sessions: 3 } },
    ],
    sessions: [],
    frictionTotals: {
      observableSessions: 0,
      interruptions: 0,
      rejections: 0,
      compactions: 0,
      turns: 0,
    },
    byModelDaily: [],
  };
}

describe("consoleOverview", () => {
  test("renders the requested overview tables", () => {
    const output = consoleOverview(dashboard());
    expect(output).toContain("Overview");
    expect(output).toContain("Tokens by day");
    expect(output).toContain("Top skills");
    expect(output).toContain("Top MCP servers");
    expect(output).toContain("Tokens by project");
    expect(output).toContain("jj:jj");
    expect(output).toContain("Run `argus report --open` to view the full HTML report.");
    expect(output).not.toContain("(none)");
  });

  test("omits the MCP section when no servers were used", () => {
    const value = dashboard();
    value.byMcpServer = [];
    expect(consoleOverview(value)).not.toContain("Top MCP servers");
  });
});

describe("isBareInvocation", () => {
  test("matches only argus with no arguments", () => {
    expect(isBareInvocation([])).toBe(true);
    expect(isBareInvocation(["report"])).toBe(false);
    expect(isBareInvocation(["--open"])).toBe(false);
  });
});
