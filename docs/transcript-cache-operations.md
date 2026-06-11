# Transcript cache operations

Argus uses the transcript fragment cache by default for `report`, bare terminal overview,
and `push`. The cache is local SQLite storage for normalized parser fragments; it is not the
rendered dashboard and it is not uploaded by itself.

## Cache location

The cache database is `fragments.sqlite3` under the Argus cache directory:

- `ARGUS_CACHE_DIR/fragments.sqlite3` when `ARGUS_CACHE_DIR` is set.
- `$XDG_CACHE_HOME/argus/fragments.sqlite3` when `XDG_CACHE_HOME` is set.
- `~/Library/Caches/argus/fragments.sqlite3` on macOS.
- `%LOCALAPPDATA%\Argus\Cache\fragments.sqlite3` on Windows when `LOCALAPPDATA` is set.
- `~/.cache/argus/fragments.sqlite3` otherwise.

SQLite may also create sidecar files next to it:

- `fragments.sqlite3-wal`
- `fragments.sqlite3-shm`

The public CLI does not currently expose a `--cache-path` flag. Use `ARGUS_CACHE_DIR` when
you need a different cache directory for an invocation.

## Privacy properties

The cache is local. It is used to avoid reparsing unchanged local transcript files and does
not change the `report` privacy model or make `push` upload anything beyond the normal
dashboard snapshot.

On non-Windows platforms Argus creates the cache directory with mode `0700` and the database
and SQLite sidecars with mode `0600`. It refuses to use the cache path or sidecar paths when
they are symbolic links, and it refuses non-regular database files. Windows relies on normal
platform ACL behavior.

The cache stores normalized parser facts and provenance. Expect it to contain local paths,
session metadata, model/token usage, source IDs, first prompts, bounded tool/skill argument
strings, tool names, MCP names, file paths touched by tools, diagnostics, and approximate
tool-result token sizes. It does not store rendered HTML, final aggregate dashboards, raw
full transcripts as transcript blobs, raw argument objects, or raw full tool-result content.

Treat the cache as sensitive local developer telemetry. Delete it before sharing a machine
image or support bundle unless the recipient is allowed to see local usage metadata and
prompt snippets.

## Runtime controls

`argus report`, bare `argus`, and `argus push` use the cache by default. During parsing the
CLI prints a cache summary like:

```text
Cache: native cache: 12 hit, 3 parsed, 3 stored, 1 imported, 0 deleted, 0 unstable, 0 failed
```

The leading mode label can identify native cache use, raw-parser fallback, or an
AgentsView-assisted/provenance run depending on the selected sources and diagnostics.

Use `--no-cache` to bypass the incremental parser:

```bash
argus report --no-cache
argus push --no-cache
```

`--no-cache` parses native transcript files directly. It does not open or create the fragment
cache, and it also bypasses AgentsView import because AgentsView import is part of the
incremental cache path.

Use `cache-status` to inspect the cache without parsing transcripts:

```bash
argus cache-status
```

This opens the cache, creating or migrating it if needed, then prints the cache path, cache
size, successful/total fragment counts, status counts, kind counts, and successful fragment
counts by source. If the cache cannot be opened, it prints a recovery hint instead of falling
back to transcript parsing.

Use `cache-rebuild` to delete and recreate an empty local Argus fragment cache:

```bash
argus cache-rebuild
```

This removes `fragments.sqlite3`, `fragments.sqlite3-wal`, and `fragments.sqlite3-shm` at the
configured cache location, then initializes a fresh empty database. It does not parse
transcripts; the next cached report or push repopulates fragments.

## AgentsView controls

AgentsView import is enabled in auto-detect mode by default when the cache path is active.
The default database path is:

```text
${AGENTSVIEW_DATA_DIR:-${AGENT_VIEWER_DATA_DIR:-~/.agentsview}}/sessions.db
```

Controls:

- `--agentsview` keeps auto-detect mode enabled. This is also the default.
- `--no-agentsview` disables AgentsView discovery and import.
- `--agentsview-db <path>` reads a specific AgentsView `sessions.db`.

`--no-agentsview` wins over `--agentsview-db`: if AgentsView is disabled, Argus does not
inspect the database path. With `--no-cache`, all AgentsView flags are effectively ignored.

Argus opens AgentsView read-only, inspects schema compatibility, reads within a transaction,
and checks that the database fingerprint and schema do not change during probe/import. Argus
does not migrate, vacuum, or write to the AgentsView database.

## Native and AgentsView precedence

Native Argus transcript fragments are authoritative per source. When a selected run has any
native fragments for a source, matching AgentsView facts for that source are imported and
stored only for provenance; they do not feed the reconciled report.

AgentsView facts are used only when no native Argus fragments are available for that source
in the selected cached run. For example, a `--source codex` run can use AgentsView Codex
facts if no native Codex fragments are available, but native Codex fragments take precedence
as soon as they exist.

The cache diagnostics use these info codes for the merge decision:

- `agentsview_native_precedence`: imported for provenance, native source facts used.
- `agentsview_import_used`: imported facts used because native source fragments were absent.
- `agentsview_unavailable`: database missing, incompatible, changed during inspection, or
  otherwise not importable.
- `agentsview_disabled`: disabled by user control.

## Fallback diagnostics

For `report`, bare terminal overview, and `push`, cache failures are not fatal. If Argus
cannot open, validate, migrate, read, write, or reconcile through the fragment cache, it
records a `cache_fallback` diagnostic and falls back to uncached native parsing for the
current invocation.

The CLI prints non-info cache diagnostics and selected info diagnostics for user-visible
cache/import decisions, capped to the first few messages, and may also print a count of
additional omitted diagnostics. Common cache failure messages include:

- cache locked longer than the busy timeout
- corrupt or non-SQLite cache database
- incompatible or newer cache schema
- unsafe cache path, including symbolic links
- incomplete discovery that used still-valid cached fragments
- changed files, parser versions, or cache contract versions that force a reparse

`cache-status` and `cache-rebuild` are cache operations, so they do not fall back to direct
transcript parsing. They surface cache errors directly.

## Benchmarks

Use the fixture benchmark to compare cold-cache, warm-cache, and one-file-changed runs without
reading private local transcripts:

```bash
bun run bench:cache --smoke
bun run bench:cache --iterations 5 --json --pretty
```

The benchmark copies `test/fixtures` into a temporary workspace, disables AgentsView import,
and reports wall time, cache stats, estimated files opened, estimated bytes parsed, cache
database size, observed RSS memory, parse counts, and diagnostic counts. The byte and file
counts are controlled-workspace estimates rather than kernel-level tracing.

Use those results to decide whether byte-offset append parsing is worth the added parser
complexity. The default decision is to keep changed-file full reparsing: implement append
parsing only if a representative local-scale benchmark shows the one-file-changed scenario is
still a material bottleneck after the basic fragment cache is enabled.

## Manual deletion

Close other Argus processes before deleting cache files. Then remove the database and SQLite
sidecars at the configured cache location. For example, when `ARGUS_CACHE_DIR` is set:

```bash
rm -f "$ARGUS_CACHE_DIR/fragments.sqlite3" \
  "$ARGUS_CACHE_DIR/fragments.sqlite3-wal" \
  "$ARGUS_CACHE_DIR/fragments.sqlite3-shm"
```

On macOS with the default cache location:

```bash
rm -f "$HOME/Library/Caches/argus/fragments.sqlite3" \
  "$HOME/Library/Caches/argus/fragments.sqlite3-wal" \
  "$HOME/Library/Caches/argus/fragments.sqlite3-shm"
```

Missing sidecar files are normal. `argus cache-rebuild` is the safer built-in path because it
uses the configured cache location, removes only regular cache files, refuses symlinks, and
recreates the database with the expected schema and permissions.

## Known AgentsView schema and fidelity limits

AgentsView compatibility currently targets the schema documented in
`docs/agentsview-import.md`. The importer requires `sessions(id, agent)` and
`messages(id, session_id, ordinal, role)`. Optional tables and columns improve fidelity when
present, but missing optional data is represented as partial or missing import capability.

Known limits:

- AgentsView coverage is marked partial; compatibility does not prove it contains every local
  transcript that Argus native discovery can see.
- Claude `attributionSkill` is not stored by AgentsView.
- Claude subagent folding is partial because AgentsView relationships do not exactly match
  Argus transcript-derived folding.
- Codex accounting is partial because AgentsView rows do not preserve Argus's exact
  `token_count` replay boundaries.
- Gemini nested discovery is partial because AgentsView may not contain every nested
  transcript representation Argus discovers natively.
- AgentsView stores cache creation as one total. Argus preserves it in the `cacheWrite5m`
  bucket because there is no AgentsView 5-minute/1-hour split.
- `tool_result_events` are detected as partial capability, not complete parity. Imported tool
  result accounting is based on stored result lengths when available.
