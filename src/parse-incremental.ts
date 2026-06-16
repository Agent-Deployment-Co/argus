import { createHash } from "node:crypto";
import {
  isAuthoritativeDiscovery,
  sameFileFingerprint,
  type AuxiliaryParserAdapter,
  type FragmentMetadata,
  type StoredFragment,
  type CompleteDiscovery,
  type DiscoveredFile,
  type DiscoveryResult,
  type ImportedFragment,
  type MaterializeSession,
  type ParsedAuxiliaryFragment,
  type ParsedFileFragment,
  type ParserDiagnostic,
  type ResolvedQuery,
  type Store,
} from "./store-contract.ts";
import { openStore, rebuildStore } from "./store.ts";
import { parseAll, type ParseOptions, type TranscriptSource } from "./parse.ts";
import {
  canonicalSessionIds,
  convertImported,
  reconcileSessions,
  type ReconcileResult,
} from "./reconcile.ts";
import type { ImportProducer, ProducerContext } from "./producer.ts";
import { IMPORT_PRODUCERS, NATIVE_PRODUCERS } from "./producers/index.ts";
import type { AgentSource, MessageRecord, ParseResult } from "./types.ts";

export interface SyncStats {
  hits: number;
  parsed: number;
  replaced: number;
  imported: number;
  /** Index fragments tombstoned because their file is no longer on disk. */
  deleted: number;
  /** Sessions retained but flagged archived because their source went off disk (durable archive). */
  archived: number;
  unstable: number;
  failed: number;
  incompleteDiscoveries: number;
  fallback: boolean;
}

export interface IncrementalParseDetails {
  parsed: ParseResult;
  stats: SyncStats;
  diagnostics: ParserDiagnostic[];
}

export interface IncrementalParseOptions extends ParseOptions {
  storePath?: string;
  store?: Store;
  rebuild?: boolean;
  agentsView?: "auto" | "off";
  agentsViewDatabasePath?: string;
  /** SQL-pushdown filters applied when reading the materialized model. */
  query?: ResolvedQuery;
  /** Read the already-materialized store without reconciling/materializing first (no writes). Used by
   *  the read-only legs of `argus run`, where the index leg is the sole writer. */
  skipSync?: boolean;
}

const EMPTY_STATS: SyncStats = {
  hits: 0,
  parsed: 0,
  replaced: 0,
  imported: 0,
  deleted: 0,
  archived: 0,
  unstable: 0,
  failed: 0,
  incompleteDiscoveries: 0,
  fallback: false,
};

function cloneStats(): SyncStats {
  return { ...EMPTY_STATS };
}

function normalizeSources(sources: TranscriptSource[] | undefined): TranscriptSource[] {
  if (!sources?.length) return ["claude"];
  return [...new Set(sources)];
}

/** Stable digest of a source's discovered files + fingerprints, for freshness attestation. */
function filesDigest(files: DiscoveredFile[]): string {
  const hash = createHash("sha256");
  for (const { file, fingerprint } of [...files].sort((a, b) => (a.file.id < b.file.id ? -1 : 1))) {
    hash.update(
      `${file.id}${fingerprint.sizeBytes}${fingerprint.mtimeNs}${fingerprint.ctimeNs ?? ""}\n`,
    );
  }
  return hash.digest("hex");
}

function diagnostic(
  code: string,
  message: string,
  severity: ParserDiagnostic["severity"] = "warning",
): ParserDiagnostic {
  return { code, severity, phase: "reconcile", message };
}

function auxiliaryStoreable(
  fragment: StoredFragment | undefined,
  parser: AuxiliaryParserAdapter,
  file: CompleteDiscovery["files"][number],
): fragment is ParsedAuxiliaryFragment {
  return (
    fragment?.kind === "auxiliary" &&
    fragment.contractVersion === 1 &&
    fragment.parser.name === parser.parser.name &&
    fragment.parser.source === parser.parser.source &&
    fragment.parser.version === parser.parser.version &&
    sameFileFingerprint(fragment.snapshot.fingerprint, file.fingerprint)
  );
}

function reparseReason(
  metadata: FragmentMetadata | undefined,
  fragment: StoredFragment | undefined,
  parser: { name: string; source: AgentSource; version: string },
  file: CompleteDiscovery["files"][number],
  kind: "transcript" | "auxiliary",
): ParserDiagnostic | undefined {
  if (!metadata) return undefined;
  const label = `${parser.source} ${file.file.relativePath}`;
  if (metadata.status !== "success") {
    return diagnostic(
      "reindex_previous_not_successful",
      `Re-reading ${label} (the last read didn't finish).`,
      "info",
    );
  }
  if (!fragment) {
    return diagnostic(
      "reindex_fragment_unavailable",
      `Re-reading ${label} (couldn't reuse the saved copy).`,
      "warning",
    );
  }
  if (fragment.kind !== kind) {
    return diagnostic(
      "reindex_kind_changed",
      `Re-reading ${label} (the file's type changed).`,
      "info",
    );
  }
  if (fragment.contractVersion !== 1) {
    return diagnostic(
      "reindex_contract_version_changed",
      `Re-reading ${label} (Argus changed how it stores this data).`,
      "info",
    );
  }
  if (
    fragment.parser.name !== parser.name ||
    fragment.parser.source !== parser.source ||
    fragment.parser.version !== parser.version
  ) {
    return diagnostic(
      "reindex_parser_version_changed",
      `Re-reading ${label} (Argus updated how it reads this file).`,
      "info",
    );
  }
  if (!sameFileFingerprint(fragment.snapshot.fingerprint, file.fingerprint)) {
    return diagnostic(
      "reindex_file_changed",
      `Re-reading ${label} (the file changed).`,
      "info",
    );
  }
  return diagnostic(
    "reindex_not_reusable",
    `Re-reading ${label} (couldn't reuse the saved copy).`,
    "info",
  );
}

async function storedFragmentsForRoot(
  store: Store,
  source: AgentSource,
  rootId: string,
): Promise<Array<ParsedFileFragment | ParsedAuxiliaryFragment>> {
  const out: Array<ParsedFileFragment | ParsedAuxiliaryFragment> = [];
  for (const metadata of await store.list(source)) {
    if (metadata.status !== "success") continue;
    const fragment = await store.load(metadata.id);
    if (
      fragment?.kind !== "transcript" &&
      fragment?.kind !== "auxiliary"
    ) {
      continue;
    }
    if (fragment.snapshot.file.rootId === rootId) out.push(fragment);
  }
  return out;
}

async function collectAuxiliaryFragments(
  store: Store,
  discovery: DiscoveryResult,
  parser: AuxiliaryParserAdapter,
  stats: SyncStats,
  diagnostics: ParserDiagnostic[],
  changed?: Set<string>,
): Promise<ParsedAuxiliaryFragment[]> {
  diagnostics.push(...discovery.diagnostics);
  if (!isAuthoritativeDiscovery(discovery)) {
    stats.incompleteDiscoveries++;
    diagnostics.push(
      diagnostic(
        "incomplete_auxiliary_discovery_using_stored_fragments",
        `Couldn't fully read supporting data (${discovery.status}); used the saved copy: ${discovery.rootPath}`,
      ),
    );
    return (await storedFragmentsForRoot(store, discovery.source, discovery.rootId))
      .filter((fragment): fragment is ParsedAuxiliaryFragment => fragment.kind === "auxiliary");
  }

  const metadataByFile = new Map(
    (await store.list(discovery.source))
      .filter((metadata) => metadata.fileId)
      .map((metadata) => [metadata.fileId!, metadata]),
  );
  const fragments: ParsedAuxiliaryFragment[] = [];
  for (const file of discovery.files) {
    const metadata = metadataByFile.get(file.file.id);
    const stored = metadata?.status === "success" ? await store.load(metadata.id) : undefined;
    if (auxiliaryStoreable(stored, parser, file)) {
      stats.hits++;
      fragments.push(stored);
      continue;
    }
    const miss = reparseReason(metadata, stored, parser.parser, file, "auxiliary");
    if (miss) diagnostics.push(miss);

    const result = parser.parseFile(file);
    if (result.status === "current") {
      diagnostics.push(...result.fragment.diagnostics);
      stats.parsed++;
      stats.replaced++;
      await store.replace(result.fragment);
      fragments.push(result.fragment);
      changed?.add(result.fragment.id);
    } else {
      diagnostics.push(...result.diagnostics);
      if (metadata) await store.invalidate([metadata.id], "auxiliary_input_changed");
      if (result.status === "unstable") stats.unstable++;
      else stats.failed++;
    }
  }
  await store.removeMissing(discovery);
  return fragments;
}

function producerContext(opts: IncrementalParseOptions): ProducerContext {
  return {
    projectsDir: opts.projectsDir,
    historyFile: opts.historyFile,
    codexSessionsDir: opts.codexSessionsDir,
    geminiDir: opts.geminiDir,
    coworkSessionsDir: opts.coworkSessionsDir,
    agentsViewDatabasePath: opts.agentsViewDatabasePath,
    agentsView: opts.agentsView,
  };
}

/** Group a reconcile result into per-session payloads ready to materialize. */
function toMaterializeSessions(output: ReconcileResult): MaterializeSession[] {
  const messagesBySession = new Map<string, MessageRecord[]>();
  for (const message of output.messages) {
    let list = messagesBySession.get(message.sessionId);
    if (!list) {
      list = [];
      messagesBySession.set(message.sessionId, list);
    }
    list.push(message);
  }
  const sessions: MaterializeSession[] = [];
  for (const [sid, meta] of output.sessions) {
    const perSession = output.toolResultsBySession.get(sid);
    const toolResults = perSession
      ? [...perSession].map(([name, stat]) => ({
          name,
          count: stat.count,
          approxTokens: stat.approxTokens,
        }))
      : [];
    sessions.push({ meta, messages: messagesBySession.get(sid) ?? [], toolResults });
  }
  return sessions;
}

/** Map a source session id to its canonical id (subagent child -> parent) for a producer. */
function canonicalizer(
  caps: { canonicalizeSubagents: boolean },
  relationships: Array<{ child: string; parent: string }>,
): (sourceSessionId: string) => string {
  if (!caps.canonicalizeSubagents) return (sid) => sid;
  const parentByChild = new Map(relationships.map((r) => [r.child, r.parent]));
  return (sid) => parentByChild.get(sid) ?? sid;
}

/**
 * The coordinator: each native producer discovers + parses its sessions and re-materializes the
 * **touched** canonical sessions into the trusted read model; dependent import producers then fill
 * in only sessions no native owns. Reconciliation happens here (the producer), never at read.
 *
 * The store is a DURABLE ARCHIVE, not a mirror of disk: sources age out (Claude keeps ~30 days), so
 * a previously-materialized session that is no longer discoverable is RETAINED and flagged archived,
 * never deleted. The only way a resolved session leaves the store is the explicit `forget` command.
 */
async function syncStore(
  opts: IncrementalParseOptions,
  store: Store,
  stats: SyncStats,
  diagnostics: ParserDiagnostic[],
): Promise<void> {
  const ctx = producerContext(opts);
  const requested = new Set<string>(normalizeSources(opts.sources));
  const nativeSources = new Set<string>();
  const allAuxiliary: ParsedAuxiliaryFragment[] = [];

  for (const producer of NATIVE_PRODUCERS) {
    if (!requested.has(producer.source)) continue;
    const discovery = producer.discoverTranscripts(ctx);
    diagnostics.push(...discovery.diagnostics);

    // Auxiliary facts are small and still reconstructed from rows (re-parsing history.jsonl every
    // run would be costly). They feed reconcile (cwd/first-prompt) and the auxChanged signal.
    const auxChanged = new Set<string>();
    const aux =
      producer.discoverAuxiliary && producer.auxiliaryParser
        ? await collectAuxiliaryFragments(
            store,
            producer.discoverAuxiliary(ctx),
            producer.auxiliaryParser(),
            stats,
            diagnostics,
            auxChanged,
          )
        : [];
    allAuxiliary.push(...aux);

    if (!isAuthoritativeDiscovery(discovery)) {
      // Can't re-parse reliably or detect deletions; keep existing resolved sessions (last-known).
      stats.incompleteDiscoveries++;
      diagnostics.push(
        diagnostic(
          "incomplete_discovery_keeps_resolved",
          `Couldn't fully read ${discovery.source} sessions (${discovery.status}); kept what's already saved: ${discovery.rootPath}`,
        ),
      );
      const existing = await store.resolvedSessionIdsForOwner(producer.id);
      if (existing.length) nativeSources.add(producer.source);
      continue;
    }

    const parser = producer.transcriptParser();
    const before = await store.transcriptIndex(producer.source);
    const storedByFileId = new Map(before.fragments.map((entry) => [entry.file.id, entry]));
    const parsedById = new Map<string, ParsedFileFragment>();
    const changedFragments: ParsedFileFragment[] = [];

    // Scan: parse only files whose fingerprint changed (no reconstruct of unchanged files).
    for (const file of discovery.files) {
      const stored = storedByFileId.get(file.file.id);
      const hit =
        !!stored &&
        stored.status === "success" &&
        stored.parserName === parser.parser.name &&
        stored.parserVersion === parser.parser.version &&
        sameFileFingerprint(stored.fingerprint, file.fingerprint);
      if (hit) {
        stats.hits++;
        continue;
      }
      if (stored) {
        diagnostics.push(
          diagnostic(
            "reindex_file_changed",
            `Re-reading ${producer.source} ${file.file.relativePath} (the file changed).`,
            "info",
          ),
        );
      }
      const result = parser.parseFile(file);
      if (result.status === "current") {
        stats.parsed++;
        stats.replaced++;
        diagnostics.push(...result.fragment.diagnostics);
        await store.replace(result.fragment); // writes the light index only
        changedFragments.push(result.fragment);
        parsedById.set(result.fragment.id, result.fragment);
      } else {
        diagnostics.push(...result.diagnostics);
        if (stored) await store.invalidate([stored.fragmentId], "file_changed");
        if (result.status === "unstable") stats.unstable++;
        else stats.failed++;
      }
    }

    await store.removeMissing(discovery);
    const after = await store.transcriptIndex(producer.source);
    const afterIds = new Set(after.fragments.map((entry) => entry.fragmentId));
    const deletions = before.fragments.some(
      (entry) => entry.status === "success" && !afterIds.has(entry.fragmentId),
    );
    if (deletions) {
      stats.deleted += before.fragments.filter(
        (entry) => entry.status === "success" && !afterIds.has(entry.fragmentId),
      ).length;
    }
    if (after.fragments.length) nativeSources.add(producer.source);

    const canon = canonicalizer(producer.capabilities, after.relationships);
    const currentCanonical = new Set<string>();
    for (const entry of after.fragments) {
      for (const sid of entry.sourceSessionIds) currentCanonical.add(canon(sid));
    }

    // Touched = canonical sessions of changed files; widen to everything on deletion / aux change
    // (both can affect sessions whose own files didn't change). Keeps results == a full reindex.
    const touched =
      auxChanged.size > 0 || deletions
        ? currentCanonical
        : canonicalSessionIds(producer.capabilities, changedFragments);

    if (touched.size) {
      // Re-parse every file of each touched session from disk (reuse already-parsed changed files).
      const fragments: ParsedFileFragment[] = [];
      for (const entry of after.fragments) {
        if (!entry.sourceSessionIds.some((sid) => touched.has(canon(sid)))) continue;
        const existing = parsedById.get(entry.fragmentId);
        if (existing) {
          fragments.push(existing);
          continue;
        }
        const result = parser.parseFile({ file: entry.file, fingerprint: entry.fingerprint });
        if (result.status === "current") fragments.push(result.fragment);
      }
      const output = reconcileSessions({
        caps: producer.capabilities,
        fragments,
        auxiliaryFragments: aux,
        canonicalIds: touched,
      });
      // Marks these present (archived = 0); the store's don't-regress guard keeps the fuller stored
      // copy if a re-parse came back short (e.g. a file partly aged out or failed to parse this run).
      await store.materializeSessions(producer.id, toMaterializeSessions(output));
    }

    // Durable archive: sessions we owned that are no longer discoverable on disk are RETAINED and
    // flagged archived (never deleted). A reappearing file is always a parse miss (its index row was
    // tombstoned), so it re-materializes as present — no separate un-archive pass is needed.
    const prevOwned = await store.resolvedSessionIdsForOwner(producer.id);
    const disappeared = prevOwned.filter((id) => !currentCanonical.has(id));
    await store.setSessionsArchived(disappeared, true);
    stats.archived += disappeared.length;
    await store.setCoverage(producer.id, filesDigest(discovery.files), currentCanonical.size);
  }

  for (const producer of IMPORT_PRODUCERS) {
    const result = await gatherImportedFragments(
      producer,
      ctx,
      store,
      stats,
      diagnostics,
      requested,
      nativeSources,
    );
    // If we couldn't actually read the import source (disabled / locked / incompatible), we have NO
    // information about what it currently holds — keep prior imported sessions as last-known and do
    // NOT archive, exactly like an incomplete native discovery. Only an authoritative read archives.
    if (!result.authoritative) continue;

    // Read ownership *after* natives materialized, so handed-off sessions are excluded.
    const prevOwned = await store.resolvedSessionIdsForOwner(producer.id);
    const nativeOwned = await store.ownedSessionIdsExcept(producer.id);
    const converted = result.fragments
      .map(convertImported)
      .filter((fragment): fragment is ParsedFileFragment => !!fragment);
    let unowned = new Set<string>();
    if (converted.length) {
      // Reconcile once to learn the canonical session set, then materialize only the sessions no
      // native producer owns (filtering the result is equivalent to re-reconciling scoped to them).
      const full = reconcileSessions({
        caps: producer.capabilities,
        fragments: converted,
        auxiliaryFragments: allAuxiliary,
      });
      unowned = new Set([...full.sessions.keys()].filter((id) => !nativeOwned.has(id)));
      const sessions = toMaterializeSessions(full).filter((s) => unowned.has(s.meta.sessionId));
      await store.materializeSessions(producer.id, sessions);
    }
    // Sessions we owned that vanished from the import source (e.g. AgentsView aged them out) but that
    // no native producer has taken over: RETAIN as archived, never delete. A genuine handoff to a
    // native owner already replaced the resolved row, so it no longer appears in prevOwned.
    const vanished = prevOwned.filter((id) => !unowned.has(id));
    await store.setSessionsArchived(vanished, true);
    stats.archived += vanished.length;
  }
}

async function gatherImportedFragments(
  producer: ImportProducer,
  ctx: ProducerContext,
  store: Store,
  stats: SyncStats,
  diagnostics: ParserDiagnostic[],
  requestedSources: Set<string>,
  nativeSources: Set<string>,
): Promise<{ fragments: ImportedFragment[]; authoritative: boolean }> {
  const importer = producer.importer(ctx);
  if (!importer) {
    diagnostics.push(
      diagnostic(`${producer.id}_disabled`, `AgentsView import is turned off.`, "info"),
    );
    // Disabled is not "the source has no sessions" — it's "we didn't look". Not authoritative.
    return { fragments: [], authoritative: false };
  }

  const probe = await importer.probe();
  if (!probe.compatible) {
    diagnostics.push(
      diagnostic(
        `${producer.id}_unavailable`,
        `Can't use AgentsView: ${probe.reason}`,
        "info",
      ),
    );
    // Couldn't read the database (locked / missing / schema mismatch) — no information, not authoritative.
    return { fragments: [], authoritative: false };
  }

  const staleExternal = (await store.list())
    .filter((metadata) => metadata.kind === "external" && metadata.status === "success")
    .map((metadata) => metadata.id);
  if (staleExternal.length) await store.invalidate(staleExternal, "external_import_changed");

  const imported = (await importer.importFragments(probe)).filter((fragment) => {
    const source = fragment.provenance.coverage[0]?.source;
    return !!source && requestedSources.has(source);
  });
  for (const fragment of imported) await store.replace(fragment);
  stats.imported += imported.length;

  for (const fragment of imported) {
    const source = fragment.provenance.coverage[0]?.source;
    if (!source) continue;
    diagnostics.push(
      diagnostic(
        nativeSources.has(source) ? "agentsview_import_merged" : "agentsview_import_used",
        nativeSources.has(source)
          ? `Loaded extra ${source} sessions from AgentsView; your on-disk sessions take precedence.`
          : `Loaded ${source} sessions from AgentsView (no ${source} transcripts found on disk).`,
        "info",
      ),
    );
  }
  // We successfully read the import source: its current contents are authoritative (even if empty).
  return { fragments: imported, authoritative: true };
}

export async function parseAllIncrementalDetailed(
  opts: IncrementalParseOptions = {},
): Promise<IncrementalParseDetails> {
  const stats = cloneStats();
  const diagnostics: ParserDiagnostic[] = [];
  let store = opts.store;
  let ownsStore = false;
  try {
    if (!store) {
      store = opts.rebuild
        ? await rebuildStore({ path: opts.storePath })
        : await openStore({ path: opts.storePath });
      ownsStore = true;
    }
    // Producers reconcile + materialize the trusted read model; the reader just SELECTs it (with
    // optional SQL pushdown). `parseAll` (direct disk parse) is the test oracle. `skipSync` reads the
    // store as-is without materializing — for the read-only legs of `argus run` (the index leg writes).
    if (!opts.skipSync) await syncStore(opts, store, stats, diagnostics);
    return {
      parsed: await store.readResolved({
        sources: normalizeSources(opts.sources) as AgentSource[],
        since: opts.query?.since,
        until: opts.query?.until,
        projectSubstring: opts.query?.projectSubstring,
      }),
      stats,
      diagnostics,
    };
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "store_fallback",
        `Couldn't open the local store; read transcripts directly instead: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      ),
    );
    return {
      parsed: parseAll(opts),
      stats: { ...stats, fallback: true },
      diagnostics,
    };
  } finally {
    if (ownsStore && store) await store.close();
  }
}

export async function parseAllIncremental(
  opts: IncrementalParseOptions = {},
): Promise<ParseResult> {
  return (await parseAllIncrementalDetailed(opts)).parsed;
}

/** Per-source freshness attestation: what the store has indexed vs. what's currently on disk. */
export interface SourceScan {
  source: string;
  /** Present (on-disk) sessions covered at the last sync. */
  sessionCount: number;
  /** Retained sessions whose source has aged off disk (durable archive). */
  archivedCount: number;
  lastSyncAtMs: number | null;
  /** True when the store's indexed file set matches the current discovery (nothing pending). */
  upToDate: boolean;
  /** True when this source has any data — transcripts on disk, a prior sync, or archived sessions.
   *  False means the user doesn't use this tool (nothing on disk and nothing stored). */
  inUse: boolean;
}

/**
 * Read-only scan: compares each native source's current on-disk discovery digest to the stored
 * coverage digest, without materializing. Answers "is the store current / anything non-indexed?".
 */
export async function scanStore(opts: IncrementalParseOptions = {}): Promise<SourceScan[]> {
  const ctx = producerContext(opts);
  const requested = new Set<string>(normalizeSources(opts.sources));
  const store = opts.store ?? (await openStore({ path: opts.storePath }));
  try {
    const out: SourceScan[] = [];
    for (const producer of NATIVE_PRODUCERS) {
      if (!requested.has(producer.source)) continue;
      const coverage = await store.getCoverage(producer.id);
      const discovery = producer.discoverTranscripts(ctx);
      const authoritative = isAuthoritativeDiscovery(discovery);
      const currentDigest = authoritative ? filesDigest(discovery.files) : null;
      const discoveredFiles = authoritative ? discovery.files.length : 0;
      const archivedCount = await store.archivedCountForOwner(producer.id);
      out.push({
        source: producer.id,
        sessionCount: coverage?.sessionCount ?? 0,
        archivedCount,
        lastSyncAtMs: coverage?.lastSyncAtMs ?? null,
        upToDate: !!coverage && currentDigest != null && coverage.filesDigest === currentDigest,
        inUse: !!coverage || discoveredFiles > 0 || archivedCount > 0,
      });
    }
    return out;
  } finally {
    if (!opts.store) await store.close();
  }
}

/** A plain-language phrase describing where this sync's data came from. */
export function syncModeSummary(
  stats: SyncStats,
  diagnostics: ParserDiagnostic[] = [],
): string {
  if (stats.fallback) return "Read transcripts directly (couldn't open the local store)";
  const agentsViewUsed = diagnostics.some((entry) => entry.code === "agentsview_import_used");
  const agentsViewProvenance = diagnostics.some(
    (entry) => entry.code === "agentsview_import_merged",
  );
  const nativeTouched =
    stats.hits > 0 ||
    stats.parsed > 0 ||
    stats.replaced > 0 ||
    stats.deleted > 0 ||
    stats.archived > 0 ||
    stats.unstable > 0 ||
    stats.failed > 0 ||
    stats.incompleteDiscoveries > 0;
  if (agentsViewUsed && nativeTouched) return "Read transcripts and filled gaps from AgentsView";
  if (agentsViewUsed || (stats.imported > 0 && !nativeTouched)) return "Loaded sessions from AgentsView";
  if (agentsViewProvenance || stats.imported > 0) return "Read transcripts (AgentsView also available)";
  return "Read transcripts";
}

/** One-line, plain-language summary of what a sync did, for the user. */
export function syncStatsSummary(
  stats: SyncStats,
  diagnostics: ParserDiagnostic[] = [],
): string {
  const mode = syncModeSummary(stats, diagnostics);
  if (stats.fallback) return mode;
  const parts = [`${stats.parsed} new or changed`];
  if (stats.hits) parts.push(`${stats.hits} unchanged`);
  if (stats.imported) parts.push(`${stats.imported} from AgentsView`);
  // Sessions retained after their transcripts aged off disk are working as intended; mentioning the
  // count on every pass just invites concern. `argus status` is where that total belongs.
  const unreadable = stats.unstable + stats.failed;
  if (unreadable) parts.push(`${unreadable} couldn't be read`);
  return `${mode} — ${parts.join(", ")}`;
}
