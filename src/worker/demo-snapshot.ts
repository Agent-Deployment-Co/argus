// The JSON wire format `/admin/seed` accepts (#281 Part B.3). Owned here (not under scripts/demo/,
// which is Bun-only and never runs in a Worker) so the Worker's parsing side and the nightly Action's
// serializing side share one type instead of two hand-kept-in-sync shapes. Maps aren't JSON-native, so
// every Map field on `DemoData` (scripts/demo/generate.ts) becomes an array of `[key, value]` entries;
// `toDemoSnapshot` is the one direction scripts/demo needs, `parseDemoSnapshot` is the one this Worker
// needs, and neither side has to import the other's runtime code.
import type { MaterializeSession, TaskFact } from "../store/store-contract.ts";
import type { AgentSource } from "../types.ts";

export interface DemoSnapshot {
  sessionsByOwner: [AgentSource, MaterializeSession[]][];
  tasksBySession: [string, TaskFact[]][];
  interpretationBySession: [string, { title: string; summary: string }][];
  /** Contents for the sandbox `~/.claude/settings.json` — same shape `loadPlugins()` reads. */
  settingsJson: unknown;
  /** Contents for the sandbox `~/.claude/plugins/installed_plugins.json`. */
  installedPluginsJson: unknown;
}

/** The subset of `DemoData` (scripts/demo/generate.ts) the snapshot carries — typed structurally
 *  here rather than importing that module's type, since this file must stay importable from a Worker
 *  bundle and `generate.ts` pulls in the rest of scripts/demo's Bun-only scenario-authoring code. */
interface DemoDataLike {
  sessionsByOwner: Map<AgentSource, MaterializeSession[]>;
  tasksBySession: Map<string, TaskFact[]>;
  interpretationBySession: Map<string, { title: string; summary: string }>;
  settingsJson: unknown;
  installedPluginsJson: unknown;
}

export function toDemoSnapshot(demo: DemoDataLike): DemoSnapshot {
  return {
    sessionsByOwner: [...demo.sessionsByOwner],
    tasksBySession: [...demo.tasksBySession],
    interpretationBySession: [...demo.interpretationBySession],
    settingsJson: demo.settingsJson,
    installedPluginsJson: demo.installedPluginsJson,
  };
}

function isEntryArray(value: unknown): value is [unknown, unknown][] {
  return Array.isArray(value) && value.every((entry) => Array.isArray(entry) && entry.length === 2);
}

/** Validate an unknown JSON body is shaped like a `DemoSnapshot` before trusting it — this is the one
 *  boundary where an external caller's data (the nightly Action's POST) enters the store, so malformed
 *  input must be rejected with a clear 400 rather than throwing deep inside `materializeSessions`. */
export function parseDemoSnapshot(body: unknown): DemoSnapshot {
  if (typeof body !== "object" || body === null) throw new Error("Seed payload must be a JSON object.");
  const b = body as Record<string, unknown>;
  if (!isEntryArray(b.sessionsByOwner)) throw new Error("sessionsByOwner must be an array of [owner, sessions] entries.");
  if (!isEntryArray(b.tasksBySession)) throw new Error("tasksBySession must be an array of [sessionId, tasks] entries.");
  if (!isEntryArray(b.interpretationBySession))
    throw new Error("interpretationBySession must be an array of [sessionId, interpretation] entries.");
  return {
    sessionsByOwner: b.sessionsByOwner as DemoSnapshot["sessionsByOwner"],
    tasksBySession: b.tasksBySession as DemoSnapshot["tasksBySession"],
    interpretationBySession: b.interpretationBySession as DemoSnapshot["interpretationBySession"],
    settingsJson: b.settingsJson,
    installedPluginsJson: b.installedPluginsJson,
  };
}
