// The `argus index` command bodies, extracted from cli.ts so both the CLI command table and the
// long-running watch loop (watch.ts) can call them. These are the only writers to the local store.
import { createInterface } from "node:readline";
import { sourcesFor, type Log } from "./dashboard-builder.ts";
import { syncStatsSummary } from "./parse-incremental.ts";
import { openSessionStore } from "./session-store.ts";
import { openStore, rebuildStore } from "./store.ts";
import type { DeleteOptions, SyncOptions } from "./cli-options.ts";

/** Bring the store up to date for the requested sources (producers reconcile + materialize). */
export async function runIndex(opts: SyncOptions, log: Log): Promise<void> {
  const store = openSessionStore({
    sources: sourcesFor(opts.source),
    agentsView: opts.agentsView,
    agentsViewDatabasePath: opts.agentsViewDatabasePath,
  });
  try {
    const parsed = await store.read({});
    if (store.stats) log(syncStatsSummary(store.stats, store.diagnostics));
    log(`Local store now has ${parsed.sessions.size} sessions and ${parsed.messages.length} messages.`);
  } finally {
    await store.close();
  }
}

/** Ask a y/N question on the terminal. Caller must confirm a TTY first. */
function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Destructive: drop the entire store, including archived (off-disk) sessions that cannot be
 *  re-derived from disk, then re-read everything. Gated behind a confirmation prompt (or --force). */
export async function runIndexRebuild(opts: SyncOptions & { force: boolean }, log: Log): Promise<void> {
  // Counting archived sessions is best-effort — a damaged store can't be read, but the rebuild still
  // proceeds and replaces it.
  let archived: string[] = [];
  try {
    const store = await openStore();
    try {
      archived = await store.listArchived();
    } finally {
      await store.close();
    }
  } catch {
    // store unreadable; the rebuild below replaces it regardless
  }

  if (!opts.force) {
    if (!process.stdin.isTTY) {
      // Non-interactive (a script or pipe): refuse rather than silently destroy. Re-run with --force.
      log("Rebuilding re-reads every transcript and permanently removes any sessions no longer on disk. Re-run with --force to confirm.");
      process.exit(2);
    }
    const note = archived.length
      ? `This permanently removes ${archived.length} session${archived.length === 1 ? "" : "s"} no longer on disk. `
      : "";
    const confirmed = await promptYesNo(`Rebuild the local store from your transcripts? ${note}[y/N] `);
    if (!confirmed) {
      log("Cancelled. Left the store as it is.");
      return;
    }
  } else if (archived.length) {
    log(`! --force will permanently delete ${archived.length} archived session(s) no longer on disk.`);
  }

  const rebuilt = await rebuildStore();
  await rebuilt.close();
  log("Rebuilt the local store from scratch. Re-reading all transcripts from disk…");
  await runIndex(opts, log);
}

/** Non-destructive: re-derive the structural index from disk while preserving the trusted read
 *  model (resolved_*), so aged-out archived sessions survive. */
export async function runIndexRefresh(opts: SyncOptions, log: Log): Promise<void> {
  const store = await openStore();
  try {
    await store.clearIndex();
  } finally {
    await store.close();
  }
  log("Re-reading all transcripts from disk…");
  await runIndex(opts, log);
}

/** Permanently remove the given session(s) — explicit ids, or every archived (off-disk) session. */
export async function runIndexDelete(opts: DeleteOptions, log: Log): Promise<void> {
  const store = await openStore();
  try {
    const targets = opts.archived
      ? await store.listArchived(opts.source === "all" ? undefined : opts.source)
      : opts.ids;
    if (!targets.length) {
      log(
        opts.archived
          ? "No sessions to remove."
          : "Usage: argus index delete <session-id>… (or --archived to remove every session no longer on disk).",
      );
      return;
    }
    await store.retractSessions(targets);
    log(`Removed ${targets.length} session(s) from the local store.`);
  } finally {
    await store.close();
  }
}
