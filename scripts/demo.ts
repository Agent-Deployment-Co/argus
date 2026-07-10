#!/usr/bin/env bun
// Stand up a realistic Argus demo in a sandbox, then (optionally) open the web app on it. Seeds a
// synthetic argus.db directly through the store API from the authored scenarios in scripts/demo/,
// writes the sandbox side-files the app reads live (plugin settings), and leaves the developer's real
// Argus store untouched. Deterministic given --seed and --as-of, so screenshots are reproducible.
//
//   bun run demo                     # seed into .demo/ and open the app
//   bun run scripts/demo.ts --no-serve --as-of 2026-07-01 --seed 7
//
// The data models Rachel, a go-to-market knowledge worker at Tyrell Corporation (see scripts/demo/).

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTERPRETER_VERSION } from "./../src/indexing/interpret/index.ts";
import { openStore } from "./../src/store/store.ts";
import { generateDemoData } from "./demo/generate.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Args {
  out: string;
  asOfMs: number;
  asOfLabel: string;
  seed: number;
  serve: boolean;
  port?: number;
}

function parseArgs(argv: string[]): Args {
  const out = { dir: join(REPO_ROOT, ".demo"), asOf: "", seed: 42, serve: true, port: undefined as number | undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? "";
    if (a === "--out") out.dir = next();
    else if (a === "--as-of") out.asOf = next();
    else if (a === "--seed") out.seed = Number(next());
    else if (a === "--serve") out.serve = true;
    else if (a === "--no-serve") out.serve = false;
    else if (a === "--port" || a === "-p") out.port = Number(next());
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: bun run scripts/demo.ts [--out <dir>] [--as-of YYYY-MM-DD] [--seed <n>] [--no-serve] [--port <n>]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isFinite(out.seed)) throw new Error("--seed must be a number");

  let asOfMs: number;
  let asOfLabel: string;
  if (out.asOf) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(out.asOf);
    if (!m) throw new Error(`--as-of must be YYYY-MM-DD, got: ${out.asOf}`);
    // Anchor to the end of the given local day so the whole day is in range.
    const parsed = new Date(`${out.asOf}T23:59:59`);
    // JS rolls invalid dates over (Feb 30 -> Mar 2), so confirm the parsed date round-trips the input.
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getFullYear() !== Number(m[1]) ||
      parsed.getMonth() + 1 !== Number(m[2]) ||
      parsed.getDate() !== Number(m[3])
    ) {
      throw new Error(`--as-of is not a real calendar date: ${out.asOf}`);
    }
    asOfMs = parsed.getTime();
    asOfLabel = out.asOf;
  } else {
    asOfMs = Date.now();
    asOfLabel = "today";
  }
  return { out: out.dir, asOfMs, asOfLabel, seed: out.seed, serve: out.serve, port: out.port };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Sandbox layout: ARGUS_HOME=<out> puts the store under <out>/data and Argus config under
  // <out>/config; CLAUDE_CONFIG_DIR=<out>/claude holds the plugin inventory the app reads live.
  const dataDir = join(args.out, "data");
  const configDir = join(args.out, "config");
  const claudeDir = join(args.out, "claude");
  const storePath = join(dataDir, "argus.db");

  console.log(`Building demo data (as-of ${args.asOfLabel}, seed ${args.seed}) in ${args.out}`);
  const demo = generateDemoData({ asOfMs: args.asOfMs, seed: args.seed });

  // Start from a clean store so re-runs don't stack old sessions on top of new ones.
  rmSync(storePath, { force: true });
  rmSync(`${storePath}-wal`, { force: true });
  rmSync(`${storePath}-shm`, { force: true });
  mkdirSync(dataDir, { recursive: true });

  // Seed the store: sessions/messages per source, then pre-baked tasks per session. The corpus is
  // deterministic on its own (dates and day-buckets come from --as-of, all other variation from
  // --seed); pinning the store clock just keeps any timestamps it stamps on the anchor date. (The
  // store's own bookkeeping columns, e.g. content_indexed_at_ms, aren't surfaced in the app.)
  const store = await openStore({ path: storePath, now: () => args.asOfMs });
  try {
    for (const [owner, sessions] of demo.sessionsByOwner) {
      await store.materializeSessions(owner, sessions);
    }
    for (const [sessionId, tasks] of demo.tasksBySession) {
      const interp = demo.interpretationBySession.get(sessionId);
      await store.writeSessionTasks(
        sessionId,
        tasks,
        INTERPRETER_VERSION,
        interp?.title ?? null,
        interp?.summary ?? null,
      );
    }
  } finally {
    await store.close();
  }

  // Side-files the dashboard reads from disk (not from the store): the plugin inventory, and an
  // Argus config. Task extraction is on by default, so the demo leaves it on to match what a real
  // user sees; tasks are pre-seeded and serving never re-indexes, so nothing actually re-runs.
  writeJson(join(claudeDir, "settings.json"), demo.settingsJson);
  writeJson(join(claudeDir, "plugins", "installed_plugins.json"), demo.installedPluginsJson);
  writeJson(join(configDir, "argus.json"), { taskExtraction: { enabled: true } });

  const bySource = Object.entries(demo.stats.bySource)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([s, n]) => `${s}: ${n}`)
    .join(", ");
  console.log(
    `Seeded ${demo.stats.sessions} sessions (${bySource}), ${demo.stats.messages} messages, ${demo.stats.tasks} tasks.`,
  );

  if (!args.serve) {
    console.log("\nTo open the app on this data:");
    console.log(`  ARGUS_HOME=${args.out} CLAUDE_CONFIG_DIR=${claudeDir} \\`);
    console.log(`    bun run src/cli.ts serve --open`);
    return;
  }

  console.log("\nStarting the web app on the demo data...");
  const serveArgs = ["run", join(REPO_ROOT, "src/cli.ts"), "serve", "--open"];
  if (args.port !== undefined) serveArgs.push("--port", String(args.port));
  const child = spawn("bun", serveArgs, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, ARGUS_HOME: args.out, CLAUDE_CONFIG_DIR: claudeDir },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => child.kill(sig));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
