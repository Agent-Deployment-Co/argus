# Transcript cache architecture

Issue #16 establishes the contracts and runtime decision for the incremental transcript
cache. It does not implement persistence or change `parseAll` behavior.

## Runtime and SQLite decision

The published CLI remains a Node-targeted npm executable. Cache persistence will use
`sqlite3@6`, a packaged N-API SQLite dependency, rather than `bun:sqlite`.

The reasons are:

- `npx @agentdeploymentco/argus` is the primary installation path. Requiring a Bun shebang
  would make the published command depend on a separately installed Bun runtime.
- The current build already emits `dist/index.js` with a Node shebang. Development and tests
  can continue to use Bun while the installed artifact runs under Node.
- `sqlite3@6` provides N-API prebuilt binaries that work with the published Node runtime and
  the Bun-based development/test workflow. Storage and import interfaces are asynchronous;
  source parsing may remain synchronous behind those boundaries.
- SQLite provides atomic transactions, read-only connections for AgentsView imports, schema
  introspection, and bounded lock handling without inventing a custom persistence format.

The storage issue (#17) owns pinning and integrating `sqlite3@6`. Its native package adds
installation implications: supported Node/platform combinations need prebuilt binaries or a
working native toolchain. The packaged CLI smoke tests in #25 must exercise the supported
Node versions and operating systems. Moving to a Bun-only artifact would require an explicit
product/distribution change rather than being hidden inside cache implementation.

## Ownership boundaries

The cache stores normalized parser facts, not `Dashboard` output. The existing
`ParseResult` remains the only input to aggregation.

`src/cache-contract.ts` separates five responsibilities:

1. Discovery adapters return source-scoped file sets and whether traversal was complete.
2. Parser adapters turn one stable file snapshot into JSON-safe normalized facts.
3. The fragment cache persists successful fragments and removes files only after a complete,
   authoritative discovery.
4. Reconciliation combines fragments, applies global invariants, and returns `ParseResult`.
5. External importers expose compatible read-only facts and provenance without pretending
   the database is a transcript file or owning cache persistence/merge precedence.

Claude, Codex, and Gemini parsers remain source-specific. Storage and reconciliation do not
branch on raw transcript shapes.

## Stable snapshots and identities

A successful native fragment is identified by source, configured root, role, and relative
path. It records the file size, modification time, and physical device/inode or platform file
identity where available. Potentially 64-bit filesystem values are decimal strings so
serialized fragments do not lose precision.

Canonical helpers hash length-prefixed identity parts. File IDs use source, configured root,
role, and normalized relative path; absolute paths are observed metadata rather than the sole
identity. Fact IDs use fact kind, source session, source position, and a source identity such
as a provider message or invocation ID. Replayed provider messages remain separate observed
facts until deterministic global deduplication.

Orchestration must fingerprint a file before and after reading it. If the fingerprints differ,
the parse is retried within a bounded policy or reported as unstable. The new facts and their
fingerprint commit together; failed or unstable reads cannot advance successful cache
metadata.

Message, tool invocation, result, and relationship facts carry stable IDs and source
positions. Invocations and results also retain source session identity so reused invocation
IDs cannot cross-correlate between sessions. Global reconciliation sorts by timestamp,
source, source session, origin, record index, item index, and stable ID. This total order
keeps first-occurrence deduplication deterministic even when timestamps tie or SQLite returns
rows in a different order.

## Local and global invariants

File-local parsing owns:

- JSON/JSONL replay within one file
- usage normalization into observed message facts
- raw tool invocation and result facts
- alternate-representation metadata such as Gemini logical session, JSON/JSONL preference,
  and source `lastUpdated`
- source positions and parser diagnostics
- source-specific session facts

Global reconciliation owns:

- Claude provider-message replay deduplication across files
- subagent-to-parent folding
- Gemini duplicate JSON/JSONL conversation selection
- call/result correlation that crosses fragment boundaries
- conversion of observed facts into derived project/date/tool categories
- session metadata selection
- final message ordering and tool-result aggregation
- capability-event generation exactly once from reconciled messages

For Gemini alternate representations, reconciliation preserves the existing CLI policy:
group fragments by logical session, prefer replayable JSONL over legacy JSON, then prefer the
newest `lastUpdated` value within the same representation. A stable fragment ID breaks any
remaining tie so filesystem traversal order cannot change the selected conversation.

## Discovery and deletion

Discovery results distinguish `complete`, `missing`, `unreadable`, and `partial` scans.
Only `complete` is authoritative for deleting cached files absent from the observed set.
A source-filtered run acts only on selected sources. Missing roots and partial traversal
produce diagnostics rather than silently converting cached files into deletions.

## Auxiliary inputs

Not every output dependency is a transcript:

- Claude `history.jsonl` supplies first prompts.
- Gemini `projects.json` and per-project `.project_root` files resolve project roots.

Transcript fragments record dependencies by source-specific selector. Separately
fingerprinted auxiliary fragments store first-prompt and project-root facts. Orchestration can
therefore update derived metadata without reparsing unrelated transcript contents.

## AgentsView imports

AgentsView is an optional, read-only external importer. Its fragments use the same normalized
fact model, but carry external-import provenance rather than a transcript snapshot. They
record database identity, schema fingerprint, data version when available, capability
coverage, source coverage, and import time. Compatibility does not imply complete or current
coverage. The later merge issue (#23) owns selection controls, freshness checks, persistence
of provenance, targeted native enrichment, and deterministic precedence.

Argus never migrates, vacuums, or writes to an AgentsView database.

## Privacy

The contract contains local paths, first prompts, bounded skill arguments, and approximate
result sizes. Cache storage must therefore use private platform-appropriate permissions.
Fragments do not contain rendered HTML, final aggregates, raw full tool results, or raw
argument objects. Cache use remains local and does not change `push` behavior.
