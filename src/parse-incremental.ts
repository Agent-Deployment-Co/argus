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
  const label = `${parser.source} ${kind} ${file.file.relativePath}`;
  if (metadata.status !== "success") {
    return diagnostic(
      "reindex_previous_not_successful",
      `Reparsing ${label} because the previous stored fragment is ${metadata.status}.`,
      "info",
    );
  }
  if (!fragment) {
    return diagnostic(
      "reindex_fragment_unavailable",
      `Reparsing ${label} because stored metadata exists but the fragment could not be loaded.`,
      "warning",
    );
  }
  if (fragment.kind !== kind) {
    return diagnostic(
      "reindex_kind_changed",
      `Reparsing ${label} because the stored fragment kind changed from ${fragment.kind}.`,
      "info",
    );
  }
  if (fragment.contractVersion !== 1) {
    return diagnostic(
      "reindex_contract_version_changed",
      `Reparsing ${label} because the stored contract version is ${fragment.contractVersion}.`,
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
      `Reparsing ${label} because the parser changed from ${fragment.parser.name}@${fragment.parser.version} to ${parser.name}@${parser.version}.`,
      "info",
    );
  }
  if (!sameFileFingerprint(fragment.snapshot.fingerprint, file.fingerprint)) {
    return diagnostic(
      "reindex_file_changed",
      `Reparsing ${label} because its filesystem fingerprint changed.`,
      "info",
    );
  }
  return diagnostic(
    "reindex_not_reusable",
    `Reparsing ${label} because the stored fragment was not reusable.`,
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
        `Using stored auxiliary fragments because discovery was ${discovery.status}: ${discovery.rootPath}`,
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
  let nativeFragmentCount = 0;
  let importedCount = 0;
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
          `Keeping existing ${discovery.source} sessions because discovery was ${discovery.status}: ${discovery.rootPath}`,
        ),
      );
      const existing = await store.resolvedSessionIdsForOwner(producer.id);
      nativeFragmentCount += existing.length;
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
            `Reparsing ${producer.source} transcript ${file.file.relativePath} because it changed.`,
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
    nativeFragmentCount += after.fragments.length;
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

    let guardedArchived: string[] = [];
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
      // materializeSessions marks these present (archived = 0), except sessions whose files partially
      // aged out — it keeps the fuller stored copy and flags them archived (returned here).
      guardedArchived = await store.materializeSessions(producer.id, toMaterializeSessions(output));
    }

    // Durable archive: sessions we owned that are no longer discoverable on disk are RETAINED and
    // flagged archived (never deleted). A reappearing file is always a parse miss (its index row was
    // tombstoned), so it re-materializes as present — no separate un-archive pass is needed.
    const prevOwned = await store.resolvedSessionIdsForOwner(producer.id);
    const disappeared = prevOwned.filter((id) => !currentCanonical.has(id));
    await store.setSessionsArchived(disappeared, true);
    stats.archived += disappeared.length + guardedArchived.length;
    await store.setCoverage(producer.id, filesDigest(discovery.files), currentCanonical.size);
  }

  for (const producer of IMPORT_PRODUCERS) {
    const imported = await gatherImportedFragments(
      producer,
      ctx,
      store,
      stats,
      diagnostics,
      requested,
      nativeSources,
    );
    importedCount += imported.length;
    // Read ownership *after* natives materialized, so handed-off sessions are excluded.
    const prevOwned = await store.resolvedSessionIdsForOwner(producer.id);
    const nativeOwned = await store.ownedSessionIdsExcept(producer.id);
    const converted = imported
      .map(convertImported)
      .filter((fragment): fragment is ParsedFileFragment => !!fragment);
    let unowned = new Set<string>();
    let importGuard: string[] = [];
    if (converted.length) {
      const full = reconcileSessions({
        caps: producer.capabilities,
        fragments: converted,
        auxiliaryFragments: allAuxiliary,
      });
      unowned = new Set([...full.sessions.keys()].filter((id) => !nativeOwned.has(id)));
      const output =
        unowned.size === full.sessions.size
          ? full
          : reconcileSessions({
              caps: producer.capabilities,
              fragments: converted,
              auxiliaryFragments: allAuxiliary,
              canonicalIds: unowned,
            });
      importGuard = await store.materializeSessions(producer.id, toMaterializeSessions(output));
    }
    // Sessions we owned that vanished from the import source (e.g. AgentsView aged them out) but that
    // no native producer has taken over: RETAIN as archived, never delete. A genuine handoff to a
    // native owner already replaced the resolved row, so it no longer appears in prevOwned.
    const vanished = prevOwned.filter((id) => !unowned.has(id));
    await store.setSessionsArchived(vanished, true);
    stats.archived += vanished.length + importGuard.length;
  }

  if (
    nativeFragmentCount === 0 &&
    importedCount === 0 &&
    diagnostics.some((entry) => entry.phase === "discovery" && entry.code === "missing_root")
  ) {
    throw new Error("No transcript roots were available for incremental parsing");
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
): Promise<ImportedFragment[]> {
  const importer = producer.importer(ctx);
  if (!importer) {
    diagnostics.push(
      diagnostic(`${producer.id}_disabled`, `${producer.id} import disabled by user control.`, "info"),
    );
    return [];
  }

  const probe = await importer.probe();
  if (!probe.compatible) {
    diagnostics.push(
      diagnostic(
        `${producer.id}_unavailable`,
        `${producer.id} import unavailable: ${probe.reason}`,
        "info",
      ),
    );
    return [];
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
          ? `AgentsView ${source} facts imported; native sessions take precedence per session.`
          : `AgentsView ${source} facts used because no native fragments were available for that source.`,
        "info",
      ),
    );
  }
  return imported;
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
    // optional SQL pushdown). `parseAll` (direct disk parse) is the test oracle.
    await syncStore(opts, store, stats, diagnostics);
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
        `Falling back to unstored parsing because the store failed: ${
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
      const currentDigest = isAuthoritativeDiscovery(discovery)
        ? filesDigest(discovery.files)
        : null;
      out.push({
        source: producer.id,
        sessionCount: coverage?.sessionCount ?? 0,
        archivedCount: await store.archivedCountForOwner(producer.id),
        lastSyncAtMs: coverage?.lastSyncAtMs ?? null,
        upToDate: !!coverage && currentDigest != null && coverage.filesDigest === currentDigest,
      });
    }
    return out;
  } finally {
    if (!opts.store) await store.close();
  }
}

export function syncModeSummary(
  stats: SyncStats,
  diagnostics: ParserDiagnostic[] = [],
): string {
  if (stats.fallback) return "raw parser fallback";
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
  if (agentsViewUsed && nativeTouched) return "mixed native + AgentsView index";
  if (agentsViewUsed || (stats.imported > 0 && !nativeTouched)) return "AgentsView-assisted index";
  if (agentsViewProvenance || stats.imported > 0) return "native index with AgentsView provenance";
  return "native index";
}

export function syncStatsSummary(
  stats: SyncStats,
  diagnostics: ParserDiagnostic[] = [],
): string {
  if (stats.fallback) return syncModeSummary(stats, diagnostics);
  return `${syncModeSummary(stats, diagnostics)}: ${stats.hits} hit, ${stats.parsed} parsed, ${stats.replaced} stored, ${stats.imported} imported, ${stats.deleted} deleted, ${stats.archived} archived, ${stats.unstable} unstable, ${stats.failed} failed`;
}
