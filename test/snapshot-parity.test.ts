// #121 parity: the SQL-grouped serve snapshot (readDashboardAggregates -> assembleDashboard) must
// produce the same breakdowns as the JS walk over messages (aggregate()), for the fields the serve UI
// consumes. Cost is compared to well under a cent (pricing is linear, so SUM-then-price equals
// price-then-SUM up to float-addition order). Per-tool result-size totals reflect the #130 unification
// (orphan results — results with no matching call — drop from totals).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../src/reporting/aggregate.ts";
import { assembleDashboard } from "../src/reporting/snapshot.ts";
import { parseAllIncremental } from "../src/indexing/pipeline.ts";
import { openStore } from "../src/store/store.ts";
import type { Dashboard, NamedUsage, PluginInfo } from "../src/types.ts";
import type { ResolvedQuery as StoreQuery } from "../src/store/store-contract.ts";

const FIX = join(import.meta.dir, "fixtures");
const PLUGINS = new Map<string, PluginInfo>();

async function buildBoth(query?: StoreQuery): Promise<{ js: Dashboard; sql: Dashboard }> {
  const dir = mkdtempSync(join(tmpdir(), "argus-parity-"));
  const path = join(dir, "argus.db");
  try {
    const parsed = await parseAllIncremental({
      storePath: path,
      projectsDir: join(FIX, "projects"),
      historyFile: join(FIX, "history.jsonl"),
      query,
    });
    const js = aggregate(parsed, PLUGINS, new Map());
    const store = await openStore({ path });
    try {
      const sql = assembleDashboard(await store.readDashboardAggregates(query), PLUGINS);
      return { js, sql };
    } finally {
      await store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Index a NamedUsage[] by name for order-independent comparison (the two paths may tie-break differently). */
const byName = (rows: NamedUsage[]): Map<string, NamedUsage> => new Map(rows.map((r) => [r.name, r]));

function expectNamedUsageParity(js: NamedUsage[], sql: NamedUsage[]): void {
  const a = byName(js);
  const b = byName(sql);
  expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
  for (const [name, jr] of a) {
    const sr = b.get(name)!;
    expect(sr.messages).toBe(jr.messages);
    expect(sr.total).toBe(jr.total);
    expect(sr.cost).toBeCloseTo(jr.cost, 6);
    expect(sr.meta?.sessions).toBe(jr.meta?.sessions);
  }
}

describe("snapshot SQL parity with the JS aggregate", () => {
  test("totals, daily, and per-dimension breakdowns match (unfiltered)", async () => {
    const { js, sql } = await buildBoth();

    expect(sql.totals.sessions).toBe(js.totals.sessions);
    expect(sql.totals.messages).toBe(js.totals.messages);
    expect(sql.totals.total).toBe(js.totals.total);
    expect(sql.totals.cost).toBeCloseTo(js.totals.cost, 6);
    expect(sql.range).toEqual(js.range);

    // daily, by date
    const jsDaily = new Map(js.daily.map((d) => [d.date, d]));
    expect(sql.daily.length).toBe(js.daily.length);
    for (const d of sql.daily) {
      const j = jsDaily.get(d.date)!;
      expect({ ...d, cost: 0 }).toEqual({ ...j, cost: 0 });
      expect(d.cost).toBeCloseTo(j.cost, 6);
    }

    expectNamedUsageParity(js.byModel, sql.byModel);
    expectNamedUsageParity(js.bySource, sql.bySource);
    expectNamedUsageParity(js.bySkill, sql.bySkill);
    expectNamedUsageParity(js.byProject, sql.byProject);

    expect(sql.byModelDaily).toEqual(js.byModelDaily);
    expect(sql.bySkillDaily).toEqual(js.bySkillDaily);
  });

  test("tool / MCP / skill / plugin breakdowns match (unfiltered)", async () => {
    const { js, sql } = await buildBoth();

    expect(new Map(sql.byTool.map((t) => [t.name, t]))).toEqual(new Map(js.byTool.map((t) => [t.name, t])));
    expect(new Map(sql.byToolCategory.map((t) => [t.category, t]))).toEqual(
      new Map(js.byToolCategory.map((t) => [t.category, t])),
    );
    expect(new Map(sql.byMcpServer.map((m) => [m.server, m]))).toEqual(
      new Map(js.byMcpServer.map((m) => [m.server, m])),
    );
    // skillInvocations: name/count/plugin must match; sampleArgs is a cosmetic sample (presence only).
    const jsInv = new Map(js.skillInvocations.map((s) => [s.name, s]));
    const sqlInv = new Map(sql.skillInvocations.map((s) => [s.name, s]));
    expect([...sqlInv.keys()].sort()).toEqual([...jsInv.keys()].sort());
    for (const [name, j] of jsInv) {
      const s = sqlInv.get(name)!;
      expect(s.count).toBe(j.count);
      expect(s.plugin).toBe(j.plugin);
      if (j.sampleArgs) expect(s.sampleArgs.length).toBeGreaterThan(0);
    }
    expect(sql.heaviestToolResults).toEqual(js.heaviestToolResults);
    expect(new Map(sql.byPlugin.map((p) => [p.name, p]))).toEqual(new Map(js.byPlugin.map((p) => [p.name, p])));
  });

  test("friction / growth scalars match (unfiltered)", async () => {
    const { js, sql } = await buildBoth();
    expect(sql.frictionTotals).toEqual(js.frictionTotals);
    expect(sql.highTokenGrowthSessions).toBe(js.highTokenGrowthSessions);
  });

  test("a source filter narrows both paths identically", async () => {
    const { js, sql } = await buildBoth({ sources: ["claude"] });
    expect(sql.totals.total).toBe(js.totals.total);
    expect(sql.totals.cost).toBeCloseTo(js.totals.cost, 6);
    expectNamedUsageParity(js.byModel, sql.byModel);
    expect(new Map(sql.byTool.map((t) => [t.name, t]))).toEqual(new Map(js.byTool.map((t) => [t.name, t])));
  });

  // A genuinely NARROWING date filter (one that slices a session's messages, and the date-windowed
  // outcome divergence it can cause) is covered against a multi-date store in
  // snapshot-parity-synthetic.test.ts — the single-session fixture here can't slice meaningfully.
});
