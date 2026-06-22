import { describe, expect, test } from "bun:test";
import { computeRecommendations } from "../src/recommendations.ts";
import type { Dashboard, FrictionTotals, PluginRow } from "../src/types.ts";

function ft(over: Partial<FrictionTotals> = {}): FrictionTotals {
  return { observableSessions: 0, interruptions: 0, rejections: 0, compactions: 0, turns: 0, ...over };
}

function plugin(name: string, enabled: boolean, used: boolean): PluginRow {
  return { name, marketplace: "test", enabled, used, skills: [], skillMessages: 0, skillTokens: 0, skillCost: 0, mcpCalls: 0 };
}

function baseDash(over: Partial<Dashboard> = {}): Dashboard {
  return {
    generatedAtMs: 0,
    range: { start: "2026-06-01", end: "2026-06-02" },
    totals: { sessions: 0, messages: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, total: 0, cost: 0 },
    unpriced: [],
    daily: [],
    byModel: [],
    bySource: [],
    bySkill: [],
    skillInvocations: [],
    byMcpServer: [],
    byTool: [],
    byToolCategory: [],
    heaviestToolResults: [],
    byPlugin: [],
    byProject: [],
    sessions: [],
    frictionTotals: ft(),
    highTokenGrowthSessions: 0,
    byModelDaily: [],
    bySkillDaily: [],
    ...over,
  };
}

describe("computeRecommendations", () => {
  test("returns empty list when nothing to flag", () => {
    expect(computeRecommendations(baseDash())).toEqual([]);
  });

  test("ids are stable and unique", () => {
    const d = baseDash({
      byPlugin: [plugin("jj", true, false)],
      highTokenGrowthSessions: 1,
      frictionTotals: ft({ observableSessions: 1, interruptions: 2, rejections: 3, compactions: 1 }),
    });
    const ids = computeRecommendations(d).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("ruleUnusedPlugins", () => {
  test("fires for enabled-but-unused plugins, lists their names", () => {
    const d = baseDash({ byPlugin: [plugin("jj", true, false), plugin("gh", true, true)] });
    const [rec] = computeRecommendations(d);
    expect(rec).toBeDefined();
    expect(rec!.id).toBe("unused-plugins");
    expect(rec!.title).toContain("1 plugin enabled but unused");
    expect(rec!.detail).toContain("jj");
    expect(rec!.detail).not.toContain("gh");
  });

  test("silent when all plugins are used or disabled", () => {
    const d = baseDash({ byPlugin: [plugin("jj", true, true), plugin("gh", false, false)] });
    expect(computeRecommendations(d)).toHaveLength(0);
  });
});

describe("ruleTokenGrowth", () => {
  test("fires when any session had high token growth", () => {
    const d = baseDash({ highTokenGrowthSessions: 1, frictionTotals: ft({ observableSessions: 1 }) });
    const recs = computeRecommendations(d);
    const r = recs.find((x) => x.id === "token-growth")!;
    expect(r).toBeDefined();
    expect(r.severity).toBe("tip"); // only 1 session
    expect(r.title).toContain("1 session");
  });

  test("escalates to warning at 3+ high-growth sessions", () => {
    const d = baseDash({ highTokenGrowthSessions: 3, frictionTotals: ft({ observableSessions: 3 }) });
    const r = computeRecommendations(d).find((x) => x.id === "token-growth")!;
    expect(r.severity).toBe("warning");
  });

  test("silent when no session had high token growth", () => {
    const d = baseDash({ highTokenGrowthSessions: 0 });
    expect(computeRecommendations(d).find((x) => x.id === "token-growth")).toBeUndefined();
  });
});

describe("ruleHighInterruptions", () => {
  test("fires when avg interruptions >= 1/session", () => {
    const d = baseDash({ frictionTotals: ft({ observableSessions: 3, interruptions: 4 }) });
    const r = computeRecommendations(d).find((x) => x.id === "high-interruptions")!;
    expect(r).toBeDefined();
    expect(r.severity).toBe("tip"); // avg 1.33, below 2
    expect(r.title).toContain("4 interruptions");
  });

  test("escalates to warning at avg >= 2", () => {
    const d = baseDash({ frictionTotals: ft({ observableSessions: 2, interruptions: 5 }) });
    const r = computeRecommendations(d).find((x) => x.id === "high-interruptions")!;
    expect(r.severity).toBe("warning"); // avg 2.5
  });

  test("silent when interruptions < 1/session on average", () => {
    const d = baseDash({ frictionTotals: ft({ observableSessions: 10, interruptions: 5 }) });
    expect(computeRecommendations(d).find((x) => x.id === "high-interruptions")).toBeUndefined();
  });

  test("silent when no observable sessions", () => {
    const d = baseDash({ frictionTotals: ft({ observableSessions: 0, interruptions: 5 }) });
    expect(computeRecommendations(d).find((x) => x.id === "high-interruptions")).toBeUndefined();
  });
});

describe("ruleRejections", () => {
  test("fires for any rejection", () => {
    const d = baseDash({ frictionTotals: ft({ rejections: 1 }) });
    const r = computeRecommendations(d).find((x) => x.id === "rejections")!;
    expect(r).toBeDefined();
    expect(r.severity).toBe("tip");
  });

  test("escalates to warning at 5+", () => {
    const d = baseDash({ frictionTotals: ft({ rejections: 5 }) });
    expect(computeRecommendations(d).find((x) => x.id === "rejections")!.severity).toBe("warning");
  });

  test("silent when no rejections", () => {
    expect(computeRecommendations(baseDash())).toHaveLength(0);
  });
});

describe("ruleFrequentCompactions", () => {
  test("fires when >= 30% of sessions were compacted", () => {
    const d = baseDash({ frictionTotals: ft({ observableSessions: 10, compactions: 3 }) });
    const r = computeRecommendations(d).find((x) => x.id === "frequent-compactions")!;
    expect(r).toBeDefined();
    expect(r.severity).toBe("tip");
  });

  test("escalates to warning at >= 50%", () => {
    const d = baseDash({ frictionTotals: ft({ observableSessions: 4, compactions: 2 }) });
    expect(computeRecommendations(d).find((x) => x.id === "frequent-compactions")!.severity).toBe("warning");
  });

  test("silent below 30%", () => {
    const d = baseDash({ frictionTotals: ft({ observableSessions: 10, compactions: 2 }) });
    expect(computeRecommendations(d).find((x) => x.id === "frequent-compactions")).toBeUndefined();
  });
});

describe("ruleUnpriced", () => {
  test("fires when unpriced models are present", () => {
    const d = baseDash({ unpriced: ["gpt-99", "llama-3"] });
    const r = computeRecommendations(d).find((x) => x.id === "unpriced-models")!;
    expect(r).toBeDefined();
    expect(r.title).toContain("2 models");
    expect(r.detail).toContain("gpt-99");
  });

  test("silent when all models are priced", () => {
    expect(computeRecommendations(baseDash())).toHaveLength(0);
  });
});
