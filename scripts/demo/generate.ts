// Deterministic expander: turns the authored scenarios into store-ready records. Given a fixed seed
// and anchor date it always produces the same corpus, so demo screenshots are reproducible. Reuses
// the real store/pricing/tool-category types and helpers so any contract drift fails typecheck.

import { categorizeTool, parseMcpTool } from "../../src/tool-categories.ts";
import { localDate } from "../../src/indexing/reconcile.ts";
import type { InteractionFact, MaterializeSession, TaskFact } from "../../src/store/store-contract.ts";
import {
  emptyUsage,
  type AgentSource,
  type MessageRecord,
  type PluginInfo,
  type SessionFriction,
  type ToolUse,
  type Usage,
} from "../../src/types.ts";
import {
  PLUGIN_CATALOG,
  PLUGIN_MARKETPLACE,
  PROJECTS,
  type FrictionProfile,
  type SessionTemplate,
} from "./scenarios.ts";

/** Sources whose transcripts expose friction signals (Claude Code + Cowork share the Claude reader).
 *  Codex and Claude Chat leave friction undefined. */
const FRICTION_SOURCES = new Set<AgentSource>(["claude", "cowork"]);

/** Sources with real cache accounting. Claude Chat usage is estimated (no cache buckets). */
const CACHE_SOURCES = new Set<AgentSource>(["claude", "cowork", "codex"]);

const DAY_MS = 86_400_000;
/** Sessions are spread across this many days ending at the anchor date. */
const WINDOW_DAYS = 42;

export interface DemoData {
  /** MaterializeSession lists keyed by owner (source), ready for `store.materializeSessions`. */
  sessionsByOwner: Map<AgentSource, MaterializeSession[]>;
  /** Per-session tasks, keyed by canonical session id, for `store.writeSessionTasks`. */
  tasksBySession: Map<string, TaskFact[]>;
  /** Contents for the sandbox `~/.claude/settings.json`. */
  settingsJson: { enabledPlugins: Record<string, boolean> };
  /** Contents for the sandbox `~/.claude/plugins/installed_plugins.json`. */
  installedPluginsJson: { plugins: Record<string, Array<{ version: string; installedAt: string }>> };
  /** The plugin inventory as `loadPlugins()` would return it, for tests that build a dashboard
   *  without reading the filesystem. */
  pluginsMap: Map<string, PluginInfo>;
  /** Coarse counts, for logging. */
  stats: { sessions: number; messages: number; tasks: number; bySource: Record<string, number> };
}

export interface GenerateOptions {
  /** Anchor date (epoch ms). Sessions land in the WINDOW_DAYS ending here. */
  asOfMs: number;
  /** PRNG seed. */
  seed: number;
}

/** Deterministic UUID (v4-shaped) from a stable key (cyrb128 hash), so a session always gets the
 *  same id across runs without Math.random. */
function deterministicUuid(key: string): string {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < key.length; i++) {
    const k = key.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const hex =
    (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0") +
    (h3 >>> 0).toString(16).padStart(8, "0") +
    (h4 >>> 0).toString(16).padStart(8, "0");
  const c = hex.split("");
  c[12] = "4"; // version nibble
  c[16] = ((parseInt(c[16]!, 16) & 0x3) | 0x8).toString(16); // variant nibble
  const u = c.join("");
  return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20, 32)}`;
}

/** A canonical session id: real ids are a UUID prefixed by the source, except Claude Code, which is
 *  a bare UUID for legacy reasons. Stable for a given logical session across runs. */
function sessionIdFor(source: AgentSource, key: string): string {
  const uuid = deterministicUuid(key);
  return source === "claude" ? uuid : `${source}:${uuid}`;
}

/** mulberry32: a tiny, fast, seedable PRNG so runs are reproducible without Math.random. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Base per-message token magnitudes by source. Claude Chat has no cache (estimated usage). */
function baseUsage(source: AgentSource, rng: () => number): Usage {
  const jitter = (lo: number, hi: number) => Math.round(lo + (hi - lo) * rng());
  const input = jitter(300, 1600);
  const output = jitter(150, 900);
  const u: Usage = { ...emptyUsage(), input, output };
  if (CACHE_SOURCES.has(source)) {
    u.cacheRead = jitter(3000, 26000);
    // Occasional cache writes on the Claude family; Codex reports none.
    if (source !== "codex" && rng() < 0.4) u.cacheWrite5m = jitter(200, 2200);
  }
  return u;
}

/** Scale a usage record's context-heavy fields (used to manufacture rapid growth within a session). */
function scaleUsage(u: Usage, factor: number): Usage {
  return {
    input: Math.round(u.input * factor),
    output: u.output,
    cacheRead: Math.round(u.cacheRead * factor),
    cacheWrite5m: Math.round(u.cacheWrite5m * factor),
    cacheWrite1h: Math.round(u.cacheWrite1h * factor),
  };
}

/** Build one ToolUse from a raw tool name, filling MCP/skill/file fields the way the parser would. */
function makeTool(name: string, opts: { filePath?: string; skill?: string; rng: () => number }): ToolUse {
  const category = categorizeTool(name);
  const tool: ToolUse = { name, category };
  const mcp = parseMcpTool(name);
  if (mcp) {
    tool.mcpServer = mcp.server;
    tool.mcpTool = mcp.tool;
    tool.approxResultTokens = Math.round(400 + 6000 * opts.rng());
  } else if (name === "Skill" || name === "activate_skill") {
    if (opts.skill) tool.skill = opts.skill;
    tool.args = "run the skill";
  } else if (category === "file-io") {
    if (opts.filePath) tool.filePath = opts.filePath;
    tool.approxResultTokens = Math.round(200 + 3500 * opts.rng());
  } else if (category === "web" || category === "shell") {
    tool.approxResultTokens = Math.round(300 + 4500 * opts.rng());
  }
  return tool;
}

/** Friction for a session, given its profile. Only called for friction-bearing sources. Values are
 *  chosen so the corpus crosses the recommendation thresholds (see recommendations.ts). */
function frictionFor(
  profile: FrictionProfile,
  turns: number,
  lastTs: number,
  rng: () => number,
): SessionFriction {
  const dur = () => Math.round(4000 + 90000 * rng());
  const turnDurationsMs = Array.from({ length: Math.max(1, Math.round(turns / 2)) }, dur);
  const base: SessionFriction = {
    interruptions: 0,
    rejections: 0,
    compactions: 0,
    turns,
    turnDurationsMs,
    stopReasons: { end_turn: 1, tool_use: Math.max(1, turns - 1) },
  };
  if (profile === "none") return base;
  if (profile === "light") return { ...base, interruptions: 1 };
  if (profile === "growth") return { ...base, interruptions: 1, compactions: 1 };
  // heavy: interruptions + rejections + a trailing interruption (=> "interrupted" outcome proxy).
  return {
    ...base,
    interruptions: 3,
    rejections: 2,
    compactions: 1,
    lastInterruptionMs: lastTs + 1000,
    stopReasons: { tool_use: turns },
  };
}

interface ExpandedSession {
  source: AgentSource;
  sessionId: string;
  project: string;
  cwd: string;
  template: SessionTemplate;
  model: string;
  secondaryModel?: string;
  dayOffset: number;
}

/** Assign each (project, template, instance) a session id and a spread-out day offset. */
function planSessions(rng: () => number): ExpandedSession[] {
  const planned: ExpandedSession[] = [];
  for (const project of PROJECTS) {
    project.sessions.forEach((template, ti) => {
      const instances = template.instances ?? 1;
      for (let inst = 0; inst < instances; inst++) {
        // Spread across the window with jitter so the daily chart isn't uniform.
        const dayOffset = Math.min(WINDOW_DAYS - 1, Math.floor(rng() * WINDOW_DAYS));
        planned.push({
          source: project.source,
          sessionId: sessionIdFor(project.source, `${project.source}|${project.project}|${ti}|${inst}`),
          project: project.project,
          cwd: `/Users/rachel/${project.project}`,
          template,
          model: project.model,
          secondaryModel: project.secondaryModel,
          dayOffset,
        });
      }
    });
  }
  return planned;
}

function buildMessages(plan: ExpandedSession, asOfMs: number, rng: () => number): MessageRecord[] {
  const turns = Math.max(3, (plan.template.turns ?? 6) + Math.round((rng() - 0.5) * 2));
  const dayStart = asOfMs - plan.dayOffset * DAY_MS;
  // Session starts somewhere in the working day; each turn a few minutes apart.
  const startTs = dayStart - Math.round((6 + 6 * rng()) * 3600_000);
  const tools = plan.template.tools ?? [];
  const files = plan.template.files ?? [];
  const skills = plan.template.skills ?? [];
  const primarySkill = skills[0];
  const grows = plan.template.friction === "growth";

  const messages: MessageRecord[] = [];
  for (let i = 0; i < turns; i++) {
    const ts = startTs + i * Math.round((2 + 8 * rng()) * 60_000);
    const model = plan.secondaryModel && i % 3 === 2 ? plan.secondaryModel : plan.model;

    let usage = baseUsage(plan.source, rng);
    if (grows) {
      // First ~40% small, last ~40% large so the last decile is >= 5x the first (token-growth rule).
      const frac = i / (turns - 1);
      const factor = frac < 0.4 ? 1 : frac > 0.6 ? 6 + 3 * rng() : 3;
      usage = scaleUsage(usage, factor);
    }

    const toolUses: ToolUse[] = [];
    // A Skill invocation on the first turn, if the session uses one.
    if (i === 0 && primarySkill) {
      toolUses.push(makeTool("Skill", { skill: primarySkill, rng }));
    }
    // Round-robin the template's other tools across turns, attaching files to file I/O.
    if (tools.length) {
      const name = tools[i % tools.length]!;
      const filePath = files.length ? files[i % files.length] : undefined;
      toolUses.push(makeTool(name, { filePath, rng }));
    }

    const isLast = i === turns - 1;
    const interrupted = plan.template.friction === "heavy" && isLast;
    const stopReason = isLast ? (interrupted ? "tool_use" : "end_turn") : "tool_use";

    messages.push({
      source: plan.source,
      sessionId: plan.sessionId,
      project: plan.project,
      cwd: plan.cwd,
      gitBranch: "",
      ts,
      date: localDate(ts),
      model,
      usage,
      attributionSkill: primarySkill ?? null,
      stopReason,
      toolUses,
    });
  }
  return messages;
}

/** Split n items into `parts` contiguous slice sizes, remainder on the earliest slices. */
function evenSlices(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const rem = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rem ? 1 : 0));
}

/** How many tasks a session gets, by size: bigger sessions (more turns, so more tokens) hold more
 *  work. Capped at the template's authored task pool. */
function targetTaskCount(messageCount: number): number {
  return messageCount >= 9 ? 3 : messageCount >= 6 ? 2 : 1;
}

/**
 * Give the session an interaction spine and tie tasks to it. This is what makes per-task metrics
 * work: usage attributes to a task through its owning interaction (usage.interaction_seq ->
 * interaction.task_seq), so without interactions every task shows 0 tokens and no tools.
 *
 * One interaction per task, over a contiguous slice of the session's messages. Each message is
 * stamped with its interaction's seq, and each task takes the timestamp of its interaction's first
 * message so the store's bookmark assignment (assignInteractionTaskSeqs) maps interaction k -> task k.
 */
function buildInteractionsAndTasks(
  plan: ExpandedSession,
  messages: MessageRecord[],
): { interactions: InteractionFact[]; tasks: TaskFact[] } {
  // Take 1-3 tasks from the pool, scaled by session size, never more than the messages can slice.
  // An empty pool yields parts = 0 (no interactions/tasks) rather than crashing.
  const pool = plan.template.tasks;
  const parts = Math.min(pool.length, targetTaskCount(messages.length), messages.length);
  const templates = pool.slice(0, parts);
  const sizes = evenSlices(messages.length, parts);
  const pos = (record: number, item: number) => ({
    originKey: `demo:${plan.sessionId}`,
    recordIndex: record,
    itemIndex: item,
  });

  // Sessions whose friction carries a compaction (heavy/growth on a friction-bearing source) get
  // exactly one, attributed to a single interaction, so the interaction spine sums to the session's
  // compaction count (frictionFor sets compactions: 1). Anything else stays at 0. Attributing it to
  // every interaction would overcount vs the session-level total.
  const hasCompaction =
    FRICTION_SOURCES.has(plan.source) &&
    (plan.template.friction === "heavy" || plan.template.friction === "growth");

  const interactions: InteractionFact[] = [];
  const tasks: TaskFact[] = [];
  let mi = 0;
  for (let k = 0; k < parts; k++) {
    const start = mi;
    for (let j = 0; j < sizes[k]!; j++) messages[mi++]!.interactionSeq = k;
    const startTs = messages[start]!.ts;
    const interrupted = plan.template.friction === "heavy" && k === parts - 1;

    interactions.push({
      id: `${plan.sessionId}#int-${k}`,
      source: plan.source,
      sourceSessionId: plan.sessionId,
      seq: k,
      initiator: "human",
      disposition: interrupted ? "interrupted" : "completed",
      compactionCount: hasCompaction && k === parts - 1 ? 1 : 0,
      timestampMs: startTs,
      promptPosition: pos(start, 0),
      ...(interrupted ? {} : { responsePosition: pos(mi - 1, 1) }),
      position: pos(start, 0),
    });

    const t = templates[k]!;
    tasks.push({
      id: `${plan.sessionId}#task-${k}`,
      source: plan.source,
      sourceSessionId: plan.sessionId,
      timestampMs: startTs,
      description: t.description,
      evidence: t.evidence,
      evidenceKind: "llm_inference",
      outcome: t.outcome,
      frustration: t.frustration,
      signals: t.signals,
      outcomeReason: t.outcomeReason,
      position: pos(start, 2),
    });
  }
  return { interactions, tasks };
}

/** Build the plugin side-files and the in-memory inventory map from the catalog. */
function buildPlugins(asOfMs: number): {
  settingsJson: DemoData["settingsJson"];
  installedPluginsJson: DemoData["installedPluginsJson"];
  pluginsMap: Map<string, PluginInfo>;
} {
  const enabledPlugins: Record<string, boolean> = {};
  const plugins: Record<string, Array<{ version: string; installedAt: string }>> = {};
  const pluginsMap = new Map<string, PluginInfo>();
  for (const p of PLUGIN_CATALOG) {
    const key = `${p.name}@${PLUGIN_MARKETPLACE}`;
    enabledPlugins[key] = p.enabled;
    const installedAt = new Date(asOfMs - p.installedDaysAgo * DAY_MS).toISOString();
    plugins[key] = [{ version: p.version, installedAt }];
    pluginsMap.set(p.name, {
      name: p.name,
      marketplace: PLUGIN_MARKETPLACE,
      enabled: p.enabled,
      version: p.version,
      installedAt,
    });
  }
  return { settingsJson: { enabledPlugins }, installedPluginsJson: { plugins }, pluginsMap };
}

/** Expand the authored scenarios into a full, deterministic demo dataset. */
export function generateDemoData(opts: GenerateOptions): DemoData {
  const rng = makeRng(opts.seed);
  const plans = planSessions(rng);

  const sessionsByOwner = new Map<AgentSource, MaterializeSession[]>();
  const tasksBySession = new Map<string, TaskFact[]>();
  const bySource: Record<string, number> = {};
  let messageCount = 0;
  let taskCount = 0;

  for (const plan of plans) {
    const messages = buildMessages(plan, opts.asOfMs, rng);
    const { interactions, tasks } = buildInteractionsAndTasks(plan, messages);
    const lastTs = messages[messages.length - 1]!.ts;

    const friction = FRICTION_SOURCES.has(plan.source)
      ? frictionFor(plan.template.friction ?? "none", messages.length, lastTs, rng)
      : undefined;

    // Agent messages are the assistant turns. User messages are the user-role records: the human
    // turn each assistant reply answers, plus the tool results returned into the conversation (those
    // are user-role records too), so tool-heavy sessions show more user messages than agent ones.
    const toolCalls = messages.reduce((n, m) => n + m.toolUses.length, 0);
    const agentMessages = messages.length;
    const userMessages = messages.length + toolCalls;

    const materialize: MaterializeSession = {
      meta: {
        source: plan.source,
        sessionId: plan.sessionId,
        project: plan.project,
        cwd: plan.cwd,
        filePath: `${plan.cwd}/session-${plan.sessionId}.jsonl`,
        firstPrompt: plan.template.title,
        rawTurns: messages.length,
        userMessages,
        agentMessages,
        ...(friction ? { friction } : {}),
      },
      messages,
      interactions,
    };

    const list = sessionsByOwner.get(plan.source) ?? [];
    list.push(materialize);
    sessionsByOwner.set(plan.source, list);

    tasksBySession.set(plan.sessionId, tasks);

    messageCount += messages.length;
    taskCount += tasks.length;
    bySource[plan.source] = (bySource[plan.source] ?? 0) + 1;
  }

  const { settingsJson, installedPluginsJson, pluginsMap } = buildPlugins(opts.asOfMs);

  return {
    sessionsByOwner,
    tasksBySession,
    settingsJson,
    installedPluginsJson,
    pluginsMap,
    stats: { sessions: plans.length, messages: messageCount, tasks: taskCount, bySource },
  };
}
