# Architecture: producers, the store, and consumers

Argus turns scattered local agent transcripts into one queryable, trusted dataset. The flow is
one-directional:

```
  Claude / Codex / Gemini transcripts on disk        AgentsView database
                │                                            │
        native producers                            import producer
                │                                            │
                └───────────────┬────────────────────────────┘
                                ▼
                      the coordinator (indexing)
                 reconcile → materialize per session
                                ▼
                      the store  (argus.db)
                                ▼
                       consumers (read only)
                  report · serve · sync · status
```

Three ideas carry the whole design:

1. **A producer owns one source.** Adding a tool is one new directory; nothing else changes.
2. **The store is reconciled at write time, never at read time.** Consumers `SELECT` finished rows.
3. **The store is a durable archive, not a mirror of disk.** Transcripts age out (~30 days); the
   store keeps what it has already read.

---

## Producers

A producer (`src/producers/<id>/`) knows everything source-specific: where its sessions live, how to
read them, and what it can observe. The registry is `src/producers/index.ts` — **adding a source is a
new directory plus one line there.** The contract is `src/producer.ts`.

There are two kinds:

- **Native producers** (`claude`, `codex`, `gemini`) read local transcript files.
  - `discoverTranscripts(ctx)` — find the source's files on disk (an authoritative list, or a
    "couldn't read" result).
  - `transcriptParser()` — read one file into a fragment of *normalized facts* (sessions, messages,
    tool calls, tool results, subagent relationships).
  - `discoverAuxiliary()` / `auxiliaryParser()` *(optional)* — side inputs like Claude's
    `history.jsonl` first prompts or Gemini's project roots.
  - `capabilities` — flags the reconcile engine reads generically (e.g. `canonicalizeSubagents`,
    `dedupeByProviderMessageId`) so the engine never branches on the source name.

- **Import producers** (`agentsview`) are *dependent*: they read sessions from another tool's database
  and **only contribute sessions no native producer owns**. They expose an `importer()` with
  `probe()` + `importFragments()` instead of file discovery.

Each source also keeps a second, independent parser in `src/parse.ts` — a from-scratch reader used as
a **test oracle** (the producer pipeline is checked against it) and as a **fallback** when the store
can't be opened. See the header comment in `parse.ts`.

---

## The store

One SQLite file, `argus.db` (`src/store.ts`). Three layers:

1. **Structural index** — `index_files` + `index_sessions` / `index_relationships` /
   `index_auxiliary` / `index_dependencies`. A thin map of *which files exist, their fingerprints
   (for change detection), and which sessions each file maps to*. No message content. **Fully
   re-derivable from disk** — `index refresh` rebuilds it freely.

2. **Trusted read model** — `resolved_sessions` / `resolved_messages` / `resolved_tool_results`.
   The finished, reconciled rows consumers read directly. **Not re-derivable** once a transcript ages
   off disk, so it is preserved across schema changes via real migrations (never silently dropped).

3. **Bookkeeping** — `source_coverage` (per-source freshness digest) and `session_ownership`
   (which producer owns each canonical session).

**Durable archive.** When a session's transcript disappears from disk, its `resolved_*` rows are
**kept and flagged `archived`**, not deleted. The only thing that removes a retained session is the
explicit `argus index delete` command. `resolved_sessions.archived` distinguishes live (on disk) from
archived (kept after leaving disk).

---

## The coordinator: how producers feed the store

`syncStore()` in `src/parse-incremental.ts` is the only writer. Its job is to take what producers
parse and turn it into finished rows, using two steps — **reconcile**, then **materialize**.

### What "reconcile" means

*Reconcile* combines the raw facts a producer parsed from **all the files that make up a session**
into one correct session. A single session often spans several files: a resumed session re-appends its
earlier transcript, and subagents write their own files. Reconciling (`src/reconcile.ts`):

- **groups files by canonical session** — subagent transcripts fold onto their parent session;
- **drops duplicate messages** that replays re-append (same provider message id → first one wins);
- **orders everything onto one timeline**;
- **attaches details from side inputs** — working directory, project label, first prompt.

The result is one clean, deduplicated, fully-attributed view per session: the "figure out what
actually happened" step. It is driven by the producer's declared **capabilities** (canonicalize
subagents? dedupe by message id?), never by checking the source name — so the engine never changes when
you add a source.

### What "materialize" means

*Materialize* writes a reconciled session into the read-model tables (`resolved_sessions` /
`resolved_messages` / `resolved_tool_results`) as finished rows — replacing any earlier rows for that
session and recording which producer owns it (`materializeSessions` in `src/store.ts`). "Materialized"
means **stored as real rows a consumer can `SELECT` as-is**, not a view recomputed on every read. It is
the "save the answer" step that makes reads cheap and reconcile-free.

### Per run, per native producer

1. Discover files; **parse only the ones whose fingerprint changed** (unchanged files are skipped).
2. **Reconcile** each *touched* session and **materialize** it into `resolved_*` (replacing its old
   rows).
3. **Archive, don't delete:** sessions the producer used to own that are no longer on disk are flagged
   `archived` and retained. (A partial re-read of a session whose files partly aged out can't shrink
   the stored copy — the fuller one wins.)

Then each import producer fills in only the sessions no native producer owns. `session_ownership`
makes hand-offs clean: when a native source gains a file for a session AgentsView used to provide, the
native producer takes ownership and the AgentsView copy steps aside.

Both steps happen **here**, once, at write time — never on read.

---

## Consumers: how they read

Consumers go through `SessionStore.read()` (`src/session-store.ts`), which ensures the store is current
and then returns the reconciled `ParseResult` straight from `resolved_*` — **no reconciling, no
re-parsing, no in-memory filtering.** Query filters (`--since` / `--until` / `--project` / `--source`)
are pushed down to SQL. Archived sessions are included, so reporting survives transcript retention.

- `report` / `sync` — read → `aggregate.ts` builds the dashboard → render HTML / JSON / upload snapshot.
- `serve` — the same read → `aggregate.ts` path, exposed as a JSON API and an interactive web app
  (see [web-app.md](./web-app.md)). The built dashboard is cached briefly between requests.
- `status` — a read-only scan (`scanStore`) that reports per-source counts, freshness, and the totals.
- `argus report --console` — same read path, rendered as a compact overview in the terminal.

Because the read model is self-sufficient, a report can be produced even after the original transcripts
are gone.

---

## Command map

| Command  | Touches the store | What it does |
|----------|-------------------|--------------|
| `index`  | writes            | Read new/changed transcripts; update the store. `--watch` keeps reading on an interval. |
| `index refresh` | rebuilds index | Re-read all transcripts; keeps sessions no longer on disk. |
| `index rebuild` | rebuilds store | Rebuild from scratch; **drops sessions no longer on disk** (confirm, or `--force`). |
| `index delete` | deletes      | Permanently remove sessions (`<id>…` or `--archived`). |
| `report` | reads (+ indexes) | Build the dashboard from the store as a self-contained HTML file. |
| `serve`  | reads (+ indexes) | Serve the dashboard as an interactive local web app (JSON API + SPA). |
| `sync`   | reads (+ indexes) | Build a snapshot and upload it to the team Worker. `--watch` uploads on an interval. |
| `status` | reads             | Show per-source counts, freshness, and archived totals. |
| `run`    | writes + reads    | One long-running process: `index --watch` + `serve` + `sync --watch` against one store, under one shutdown handler, each leg supervised. |

---

## Key rules

- **Reconcile at write, read raw.** Consumers never reconcile.
- **Per-session ownership.** Native sources win over importers; AgentsView only fills gaps.
- **The index is disposable; the read model is not.** `index refresh` rebuilds the index from disk;
  the trusted rows (including archived sessions) are preserved. `index rebuild` wipes everything.
- **Nothing is uploaded except by `sync`** (one-shot, `sync --watch`, or the upload leg of `run`).
  `report` and `serve` are entirely local.
- **Indexing is the only writer.** Under `run`, the index leg writes; `serve` and the upload leg only
  read. SQLite WAL makes one writer + concurrent readers safe.

## Adding a source

1. Create `src/producers/<id>/` with `index.ts` (the descriptor + capabilities) and `parser.ts`
   (discovery + parsing into normalized facts).
2. Register it in `src/producers/index.ts`.

The coordinator, store, and consumers need no changes.
