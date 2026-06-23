// `argus run`: one foreground process that keeps the dashboard live — it indexes new sessions,
// serves the local web app, and uploads the team snapshot, all against one shared store. It runs the
// reusable loops in-process (not as child processes) under a single shutdown handler, supervising
// each leg so one failing never takes the others down. Foreground only: a service manager (systemd,
// launchd, Docker) owns backgrounding, restarts, and logging.
import { superviseLoop } from "./backoff.ts";
import type { BuildDashboardOptions, Log } from "./reporting/dashboard-builder.ts";
import { startServer } from "./api/serve.ts";
import { watchIndex, watchSync } from "./watch.ts";
import type { SyncOptions } from "./cli-options.ts";
import type { TaskExtractionOptions } from "./indexing/interpret/task-extraction.ts";

export interface RunOptions extends SyncOptions {
  port: number;
  indexIntervalMin: number;
  syncIntervalMin: number;
  endpoint: string;
  taskExtraction: TaskExtractionOptions;
}

/**
 * Fail fast (the only nonzero-exit path here) when the home directory can't be resolved. Service
 * managers launch with a minimal environment — no shell, possibly no $HOME — and `paths.ts` resolves
 * the local store relative to it. Without this, the store would silently resolve to the wrong place.
 */
export function assertHomeResolved(log: Log): void {
  const hasHome = process.platform === "win32" ? !!process.env.USERPROFILE : !!process.env.HOME;
  const hasExplicit = !!(
    process.env.ARGUS_HOME ||
    process.env.ARGUS_DATA_DIR ||
    process.env.ARGUS_CONFIG_DIR ||
    process.env.XDG_DATA_HOME
  );
  if (!hasHome && !hasExplicit) {
    log("Can't find your home directory. Set HOME (or ARGUS_HOME) to locate the local store, then start again.");
    process.exit(1);
  }
}

/** The web-server leg: run the server until shutdown, restarting with backoff if it errors. */
async function serveLeg(
  opts: { port: number; build: BuildDashboardOptions; taskExtraction: TaskExtractionOptions },
  log: Log,
  signal: AbortSignal,
): Promise<void> {
  await superviseLoop(
    "serving",
    async (sig) => {
      const handle = await startServer(
        {
          port: opts.port,
          open: false,
          build: opts.build,
          taskExtraction: opts.taskExtraction,
          installSignalHandlers: false,
          signal: sig,
        },
        log,
      );
      await handle.closed;
    },
    { signal, log },
  );
}

/** Start all three legs in one process under one shutdown handler. Blocks until terminated. */
export async function runRun(opts: RunOptions, log: Log): Promise<void> {
  assertHomeResolved(log);

  const src: SyncOptions = {
    source: opts.source,
  };
  // The web + upload legs read the store unfiltered; `run` exposes only source selection, not the
  // date/project filters. They read the store **read-only** — the index leg is the sole writer, so
  // serve/upload must not also materialize (concurrent writers would contend and could fall back to
  // a direct disk parse that omits archived sessions).
  const build: BuildDashboardOptions = { ...src, readOnly: true };

  const ac = new AbortController();
  const onSignal = () => {
    log("Shutting down…");
    ac.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  log(
    `Running: reading transcripts every ${opts.indexIntervalMin} min, serving on ` +
      `http://localhost:${opts.port}, uploading every ${opts.syncIntervalMin} min. Press Ctrl-C to stop.`,
  );

  try {
    // Each leg is independently supervised, so a serve crash never stops indexing and an index hiccup
    // never stops serving. The sync leg stays dormant (rather than failing) when not logged in.
    await Promise.all([
      watchIndex({ ...src, intervalMin: opts.indexIntervalMin }, log, ac.signal),
      serveLeg({ port: opts.port, build, taskExtraction: opts.taskExtraction }, log, ac.signal),
      watchSync(
        { ...build, endpoint: opts.endpoint, intervalMin: opts.syncIntervalMin, onUnauthenticated: "dormant" },
        log,
        ac.signal,
      ),
    ]);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  log("Stopped.");
}
