// The demo generator must keep producing a corpus that fills every major view. It seeds a real store
// through the same store API the pipeline uses, so this also guards against store-contract drift: if
// materializeSessions / writeSessionTasks / the fact types change shape, this fails to typecheck or
// run. Asserts non-empty breakdowns, the recommendations the corpus is designed to trigger, and that
// pre-baked tasks round-trip.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeRecommendations } from "../src/api/recommendations.ts";
import { computeTaskMetrics } from "../src/api/task-metrics.ts";
import { buildPlugins } from "../src/api/plugins.ts";
import { buildByMcpServer, buildByTool, buildSkills, foldBySkill } from "../src/api/tools.ts";
import { buildUsageByModel, buildUsageByProject, buildUsageBySource, buildUsageDaily } from "../src/api/usage.ts";
import { INTERPRETER_VERSION } from "../src/indexing/interpret/index.ts";
import { cost, unpricedModels } from "../src/pricing.ts";
import { openStore } from "../src/store/store.ts";
import { emptyUsage, totalTokens } from "../src/types.ts";
import { generateDemoData } from "../scripts/demo/generate.ts";

const ANCHOR = new Date("2026-07-01T12:00:00").getTime();
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function seedAndAggregate() {
  const demo = generateDemoData({ asOfMs: ANCHOR, seed: 42 });
  const dir = mkdtempSync(join(tmpdir(), "argus-demo-test-"));
  dirs.push(dir);
  const path = join(dir, "argus.db");

  const write = await openStore({ path, now: () => ANCHOR });
  try {
    for (const [owner, sessions] of demo.sessionsByOwner) await write.materializeSessions(owner, sessions);
    for (const [id, tasks] of demo.tasksBySession) {
      const interp = demo.interpretationBySession.get(id);
      await write.writeSessionTasks(id, tasks, INTERPRETER_VERSION, interp?.title ?? null, interp?.summary ?? null);
    }
  } finally {
    await write.close();
  }

  const store = await openStore({ path });
  try {
    // Build each view the way the serve endpoints do — per-view store reads + the pure builders,
    // rather than the deleted monolithic aggregate().
    const plugins = demo.pluginsMap;
    const [
      byDateModel, sessionsBySource, bySourceModel, byProjectModel, sessionsByProject,
      bySkillModel, skillTokensByDate, activeDates, toolStats, toolResults, mcpServers, mcpServerTools, health,
    ] = await Promise.all([
      store.readUsageByDateModel(),
      store.readSessionsBySource(),
      store.readUsageBySourceModel(),
      store.readUsageByProjectModel(),
      store.readSessionsByProject(),
      store.readUsageBySkillModel(),
      store.readSkillTokensByDate(),
      store.readActiveDates(),
      store.readToolStats(),
      store.readToolResultStats(),
      store.readMcpServers(),
      store.readMcpServerTools(),
      store.readHealthRollups(),
    ]);
    const views = {
      daily: buildUsageDaily(byDateModel, sessionsBySource.reduce((n, r) => n + r.sessions, 0)),
      byModel: buildUsageByModel(byDateModel),
      bySource: buildUsageBySource(bySourceModel, sessionsBySource),
      byProject: buildUsageByProject(byProjectModel, sessionsByProject),
      skills: buildSkills(bySkillModel, skillTokensByDate, activeDates, plugins),
      byTool: buildByTool(toolStats, toolResults),
      byMcpServer: buildByMcpServer(mcpServers, mcpServerTools, toolResults),
      health,
    };
    const { byPlugin } = buildPlugins(foldBySkill(bySkillModel, plugins), mcpServers, plugins);
    const recs = computeRecommendations({
      byPlugin,
      highTokenGrowthSessions: health.highTokenGrowthSessions,
      frictionTotals: health.frictionTotals,
      unpriced: unpricedModels(),
    });
    const firstSessionId = [...demo.tasksBySession.keys()][0]!;
    const roundTrippedTasks = await store.readSessionTasks(firstSessionId);
    const roundTrippedInterp = await store.readSessionInterpretation(firstSessionId);

    // Roll up per-task metrics the way the /task-metrics endpoint does: a task's messages come from
    // usage -> interaction -> task_seq, so this is zero unless the interaction spine is seeded.
    let taskTokens = 0;
    let taskToolCalls = 0;
    let tasksWithMessages = 0;
    let totalTasks = 0;
    for (const sessionId of demo.tasksBySession.keys()) {
      totalTasks += demo.tasksBySession.get(sessionId)!.length;
      const byTask = await store.readSessionTaskMessages(sessionId);
      for (const [, msgs] of byTask) {
        const m = computeTaskMetrics(msgs);
        taskTokens += m.totalTokens;
        taskToolCalls += m.toolCalls;
        if (msgs.length > 0) tasksWithMessages++;
      }
    }
    const taskMetrics = { taskTokens, taskToolCalls, tasksWithMessages, totalTasks };
    return { demo, views, recs, roundTrippedTasks, roundTrippedInterp, firstSessionId, taskMetrics };
  } finally {
    await store.close();
  }
}

test("the demo corpus fills every major breakdown", async () => {
  const { demo, views } = await seedAndAggregate();

  expect(views.daily.totals.sessions).toBe(demo.stats.sessions);
  expect(views.daily.totals.messages).toBe(demo.stats.messages);
  expect(views.daily.totals.cost).toBeGreaterThan(0);

  // Trends have several distinct days across the window.
  expect(views.daily.daily.length).toBeGreaterThan(5);

  // All four sources are represented (no Gemini in the demo).
  const sources = new Set(views.bySource.bySource.map((r) => r.name));
  for (const s of ["claude", "cowork", "claude-chat", "codex"]) expect(sources.has(s)).toBe(true);

  expect(views.byModel.byModel.length).toBeGreaterThanOrEqual(4);
  expect(views.byProject.byProject.length).toBeGreaterThanOrEqual(8);
  expect(views.byTool.byTool.length).toBeGreaterThan(0);
  expect(views.byMcpServer.byMcpServer.length).toBeGreaterThan(0);
  // At least one attributed skill (bySkill also carries the "(none)" bucket).
  expect(views.skills.bySkill.some((s) => s.name !== "(none)")).toBe(true);

  // Every model the demo uses is priced, so cost is fully accounted for and no unpriced-models
  // notice appears. Check the demo's own models directly: `unpricedModels()` is pricing.ts's
  // process-global accumulator, which other tests pollute in a full run.
  const demoModels = new Set(
    [...demo.sessionsByOwner.values()].flat().flatMap((s) => s.messages.map((m) => m.model)),
  );
  for (const model of demoModels) {
    expect(cost({ ...emptyUsage(), input: 1000 }, model)).toBeGreaterThan(0);
  }

  // Manufactured rapid-growth sessions register.
  expect(views.health.highTokenGrowthSessions).toBeGreaterThanOrEqual(1);
});

test("the corpus triggers the recommendations it's designed for", async () => {
  const { recs } = await seedAndAggregate();
  const ids = new Set(recs.map((r) => r.id));
  for (const id of ["unused-plugins", "token-growth", "rejections", "frequent-compactions"]) {
    expect(ids.has(id)).toBe(true);
  }
});

test("pre-baked tasks round-trip with their outcomes", async () => {
  const { demo, roundTrippedTasks, firstSessionId } = await seedAndAggregate();
  expect(roundTrippedTasks.length).toBe(demo.tasksBySession.get(firstSessionId)!.length);

  // Across the corpus there are tasks with each kind of outcome, so the interpretation view has variety.
  const allOutcomes = new Set([...demo.tasksBySession.values()].flat().map((t) => t.outcome));
  for (const outcome of ["success", "failure", "unclear"]) expect(allOutcomes.has(outcome as never)).toBe(true);
});

test("sessions have realistic ids and non-empty message counts", () => {
  const demo = generateDemoData({ asOfMs: ANCHOR, seed: 42 });
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const [source, sessions] of demo.sessionsByOwner) {
    for (const s of sessions) {
      const id = s.meta.sessionId;
      // Claude Code ids are a bare uuid (legacy); every other source is `<source>:<uuid>`.
      if (source === "claude") expect(id).toMatch(UUID);
      else {
        expect(id.startsWith(`${source}:`)).toBe(true);
        expect(id.slice(source.length + 1)).toMatch(UUID);
      }
      expect(s.meta.userMessages ?? 0).toBeGreaterThan(0);
      expect(s.meta.agentMessages ?? 0).toBeGreaterThan(0);
    }
  }
  // Ids are stable across identical runs.
  const ids = (d: ReturnType<typeof generateDemoData>) =>
    [...d.sessionsByOwner.values()].flat().map((s) => s.meta.sessionId).sort();
  expect(ids(demo)).toEqual(ids(generateDemoData({ asOfMs: ANCHOR, seed: 42 })));
});

test("task counts are 1-3 per session and scale with session size", () => {
  const demo = generateDemoData({ asOfMs: ANCHOR, seed: 42 });
  const tokensByCount: Record<number, number[]> = { 1: [], 2: [], 3: [] };
  for (const [, sessions] of demo.sessionsByOwner) {
    for (const s of sessions) {
      const n = demo.tasksBySession.get(s.meta.sessionId)!.length;
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(3);
      tokensByCount[n]!.push(s.messages.reduce((sum, m) => sum + totalTokens(m.usage), 0));
    }
  }
  // A healthy share of sessions have more than one task.
  const multiTask = tokensByCount[2]!.length + tokensByCount[3]!.length;
  expect(multiTask).toBeGreaterThanOrEqual(15);
  expect(tokensByCount[3]!.length).toBeGreaterThan(0);
  // Bigger sessions (more tokens) carry more tasks.
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  expect(avg(tokensByCount[2]!)).toBeGreaterThan(avg(tokensByCount[1]!));
  expect(avg(tokensByCount[3]!)).toBeGreaterThan(avg(tokensByCount[2]!));
});

test("interaction compaction counts reconcile with session-level friction", () => {
  const demo = generateDemoData({ asOfMs: ANCHOR, seed: 42 });
  for (const [, sessions] of demo.sessionsByOwner) {
    for (const s of sessions) {
      // A session's compaction count must equal the sum over its interactions; anything else is a
      // state real data can't reach (session says compacted, but no interaction did).
      const sessionCompactions = s.meta.friction?.compactions ?? 0;
      const interactionCompactions = (s.interactions ?? []).reduce((n, i) => n + i.compactionCount, 0);
      expect(interactionCompactions).toBe(sessionCompactions);
    }
  }
});

test("every session gets an interpreted title and summary that round-trip", async () => {
  const { demo, roundTrippedInterp, firstSessionId } = await seedAndAggregate();
  // Every session has a non-empty authored title + summary.
  for (const [, sessions] of demo.sessionsByOwner) {
    for (const s of sessions) {
      const interp = demo.interpretationBySession.get(s.meta.sessionId);
      expect((interp?.title ?? "").length).toBeGreaterThan(0);
      expect((interp?.summary ?? "").length).toBeGreaterThan(0);
    }
  }
  // And they come back off the store as the interpreted title/summary (not blank).
  const expected = demo.interpretationBySession.get(firstSessionId)!;
  expect(roundTrippedInterp?.title).toBe(expected.title);
  expect(roundTrippedInterp?.summary).toBe(expected.summary);
  expect(roundTrippedInterp?.interpreted).toBe(true);
});

test("tasks span one or more interactions", () => {
  const demo = generateDemoData({ asOfMs: ANCHOR, seed: 42 });
  let multiInteractionSessions = 0;
  for (const [, sessions] of demo.sessionsByOwner) {
    for (const s of sessions) {
      const nInteractions = s.interactions?.length ?? 0;
      const nTasks = demo.tasksBySession.get(s.meta.sessionId)!.length;
      // At least one interaction per task, and never more interactions than there are messages
      // to slice across them.
      expect(nInteractions).toBeGreaterThanOrEqual(nTasks);
      expect(nInteractions).toBeLessThanOrEqual(s.messages.length);
      if (nInteractions > nTasks) multiInteractionSessions++;
    }
  }
  // The point of the multi-interaction change: plenty of tasks span more than one interaction.
  expect(multiInteractionSessions).toBeGreaterThanOrEqual(10);
});

test("every task carries its token and tool activity (tied to interactions)", async () => {
  const { taskMetrics } = await seedAndAggregate();
  // The regression this guards: tasks with no interaction spine show 0 tokens / no tools.
  expect(taskMetrics.totalTasks).toBeGreaterThan(0);
  expect(taskMetrics.tasksWithMessages).toBe(taskMetrics.totalTasks);
  expect(taskMetrics.taskTokens).toBeGreaterThan(0);
  expect(taskMetrics.taskToolCalls).toBeGreaterThan(0);
});
