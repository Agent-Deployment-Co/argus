#!/usr/bin/env bun
/**
 * Reset task interpretation so Argus re-analyzes every session.
 *
 * A session is eligible for (re)interpretation iff
 *   content_indexed_at_ms > COALESCE(interpreted_at_ms, 0)
 * (see resolved_sessions in src/store/store.ts). This script does the inverse of
 * writeSessionTasks: it drops all extracted tasks, clears each interaction's task
 * attribution, and unstamps interpreted_at_ms / interpretation_version — so on the
 * next `argus index` (or the background drain) every session looks freshly indexed
 * but never interpreted, and gets re-analyzed from scratch.
 *
 * It touches ONLY interpretation state. Structural facts (usage, invocations,
 * interactions, friction) are left intact — this does not force a re-read from disk.
 *
 * Usage:
 *   bun run scripts/reset-task-interpretation.ts            # do it
 *   bun run scripts/reset-task-interpretation.ts --dry-run  # show what would change
 *
 * Stop any running `argus` (serve/run/index --watch) first so it isn't writing
 * concurrently. Honors ARGUS_HOME / ARGUS_DATA_DIR just like the CLI.
 */
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { STORE_FILE } from "../src/paths.ts";

const dryRun = process.argv.includes("--dry-run");

if (!existsSync(STORE_FILE)) {
  console.error(`No store found at ${STORE_FILE}. Nothing to reset.`);
  process.exit(1);
}

const db = dryRun
  ? new Database(STORE_FILE, { readonly: true })
  : new Database(STORE_FILE, { readwrite: true });

const count = (sql: string): number =>
  (db.query(sql).get() as { n: number }).n;

const taskCount = count("SELECT COUNT(*) AS n FROM resolved_tasks");
const interpretedSessions = count(
  "SELECT COUNT(*) AS n FROM resolved_sessions WHERE interpreted_at_ms IS NOT NULL",
);
const attributedInteractions = count(
  "SELECT COUNT(*) AS n FROM resolved_interactions WHERE task_seq IS NOT NULL",
);

console.log(`Store: ${STORE_FILE}`);
console.log(`  ${taskCount} extracted task(s)`);
console.log(`  ${interpretedSessions} interpreted session(s)`);
console.log(`  ${attributedInteractions} task-attributed interaction(s)`);

if (dryRun) {
  console.log("\nDry run — no changes written. Re-run without --dry-run to apply.");
  db.close();
  process.exit(0);
}

db.transaction(() => {
  db.run("DELETE FROM resolved_tasks");
  db.run("UPDATE resolved_interactions SET task_seq = NULL WHERE task_seq IS NOT NULL");
  // Unstamp interpretation state so every session is eligible again. Backfill any
  // NULL content_indexed_at_ms to now so eligibility (content > interpreted) holds
  // even for rows that never recorded a content timestamp.
  db.run(
    "UPDATE resolved_sessions SET content_indexed_at_ms = COALESCE(content_indexed_at_ms, strftime('%s','now')*1000), interpreted_at_ms = NULL, interpretation_version = NULL",
  );
})();

console.log(
  "\nDone. Cleared all tasks and reset interpretation timestamps.\n" +
    "Run `argus index` (or start `argus run`) to re-analyze every session.",
);
db.close();
