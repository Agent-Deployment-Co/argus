// The `argus search` command body: a one-shot CLI entry point over the same store-side search
// (`store.searchSessions`, #155) and list-shaping (`buildSessionList`) the web app's Sessions list
// uses, so results and ordering never drift between the two surfaces.
import { sourcesFor } from "./reporting/dashboard-builder.ts";
import { openStore } from "./store/store.ts";
import { buildSessionList, type SessionListItem } from "./api/session-list.ts";
import type { SessionSearchMatch } from "./store/store-contract.ts";
import { CliUsageError, type Source } from "./cli-options.ts";
import type { Log } from "./logger.ts";

export interface SearchOptions {
  source: Source;
  query?: string;
  file?: string;
  project?: string;
  since?: string;
  until?: string;
  limit: number;
  json: boolean;
}

// snippet() sentinels the store wraps matched spans in (see store-contract.ts's SessionSearchMatch) —
// the web layer turns these into <mark>; a terminal turns them into bold, or strips them for --json/
// non-TTY output where they'd just be stray control characters.
const SENTINEL_RE = /\x01|\x02/g;

function highlight(snippet: string, tty: boolean): string {
  if (!tty) return snippet.replace(SENTINEL_RE, "");
  let bold = false;
  return snippet.replace(SENTINEL_RE, () => {
    bold = !bold;
    return bold ? "\x1b[1m" : "\x1b[0m";
  });
}

/** Order results the way a user scans them: strongest match first, then most recent. A session with
 *  no `.match` (a metadata-only hit — title/project/source substring, or a bare `--file` search with
 *  no FTS match) sorts after every FTS match, then by recency among itself. */
function compareResults(a: SessionListItem, b: SessionListItem): number {
  const am = a.match;
  const bm = b.match;
  if (am && !bm) return -1;
  if (!am && bm) return 1;
  if (am && bm) {
    if (am.count !== bm.count) return bm.count - am.count;
    const rank = (s: SessionSearchMatch["source"]) => (s === "both" ? 0 : 1);
    const r = rank(am.source) - rank(bm.source);
    if (r !== 0) return r;
  }
  return b.start - a.start;
}

function formatWhen(ts: number): string {
  return ts ? new Date(ts).toISOString().slice(0, 19).replace("T", " ") : "unknown";
}

function printResult(item: SessionListItem, tty: boolean): void {
  const kind = item.match ? ` · ${item.match.source} match (${item.match.count})` : "";
  process.stdout.write(
    `${item.sessionId}  ${item.source}  ${item.project}  ${formatWhen(item.start)}${kind}\n`,
  );
  if (item.match?.snippet) {
    process.stdout.write(`    ${highlight(item.match.snippet, tty)}\n`);
  } else if (item.firstPrompt) {
    process.stdout.write(`    ${item.firstPrompt.slice(0, 200)}\n`);
  }
}

/** `argus search`: run the store-side search, shape it through the same `buildSessionList` the web
 *  app's `/api/sessions?q=&file=` uses, then print (or `--json`-emit) the matches. */
export async function runSearch(opts: SearchOptions, log: Log): Promise<void> {
  const query = opts.query?.trim();
  const file = opts.file?.trim();
  if (!query && !file) {
    throw new CliUsageError("Usage: argus search <query> [--file <substring>] (need one of the two)");
  }

  const sources = sourcesFor(opts.source);
  const store = await openStore();
  try {
    const search = await store.searchSessions({
      sources,
      since: opts.since,
      until: opts.until,
      text: query,
      file,
    });
    if (search.ids.size === 0) {
      if (opts.json) process.stdout.write("[]\n");
      else log("No sessions matched.");
      return;
    }

    const aggregates = await store.readSessionAggregates({
      sources,
      since: opts.since,
      until: opts.until,
      sessionIds: [...search.ids],
    });
    // Ask for everything back (own sort/limit below beat buildSessionList's recency-only default), then
    // re-sort by match relevance and slice to --limit ourselves.
    const { rows } = buildSessionList(aggregates, {
      sort: "recent",
      limit: aggregates.length,
      offset: 0,
      project: opts.project,
      matches: search.matches,
    });
    rows.sort(compareResults);
    const shown = rows.slice(0, opts.limit);

    if (opts.json) {
      process.stdout.write(JSON.stringify(shown) + "\n");
      return;
    }
    if (!shown.length) {
      log("No sessions matched.");
      return;
    }
    const tty = process.stdout.isTTY === true;
    for (const item of shown) printResult(item, tty);
    if (rows.length > shown.length) {
      log(`Showing ${shown.length} of ${rows.length} matches. Raise --limit to see more.`);
    }
  } finally {
    await store.close();
  }
}
