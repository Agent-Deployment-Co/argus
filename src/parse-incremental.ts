import { basename } from "node:path";
import { AgentsViewImporter } from "./agentsview-import.ts";
import {
  compareReconciliationOrder,
  isAuthoritativeDiscovery,
  sameFileFingerprint,
  type AuxiliaryParserAdapter,
  type CachedFragmentMetadata,
  type CacheFragment,
  type CompleteDiscovery,
  type DiscoveryResult,
  type Store,
  type ImportedFragment,
  type MaterializeSession,
  type ParsedAuxiliaryFragment,
  type ParsedFileFragment,
  type ParserDiagnostic,
  type ReconciliationInput,
  type ResolvedQuery,
  type TranscriptParserAdapter,
} from "./store-contract.ts";
import { openStore, rebuildStore } from "./store.ts";
import { foldFrictionEvents, type FrictionEvent } from "./friction.ts";
import {
  CLAUDE_TRANSCRIPT_PARSER,
  createClaudeHistoryParserAdapter,
  createClaudeTranscriptDiscoveryAdapter,
  createClaudeTranscriptParserAdapter,
  discoverClaudeHistory,
} from "./parse-claude.ts";
import {
  createCodexTranscriptDiscoveryAdapter,
  createCodexTranscriptParserAdapter,
} from "./parse-codex.ts";
import {
  createGeminiAuxiliaryParserAdapter,
  createGeminiTranscriptDiscoveryAdapter,
  createGeminiTranscriptParserAdapter,
  discoverGeminiAuxiliaryFiles,
} from "./parse-gemini.ts";
import { parseAll, projectLabel, type ParseOptions, type TranscriptSource } from "./parse.ts";
import {
  canonicalSessionIds,
  convertImported,
  reconcileSessions,
  type ReconcileResult,
} from "./reconcile.ts";
import type { ImportProducer, ProducerContext } from "./producer.ts";
import { IMPORT_PRODUCERS, NATIVE_PRODUCERS } from "./producers/index.ts";
import { categorizeTool, parseMcpTool } from "./tool-categories.ts";
import type {
  AgentSource,
  MessageRecord,
  ParseResult,
  SessionMeta,
  ToolResultStat,
  ToolUse,
} from "./types.ts";

export interface IncrementalCacheStats {
  hits: number;
  parsed: number;
  replaced: number;
  imported: number;
  deleted: number;
  unstable: number;
  failed: number;
  incompleteDiscoveries: number;
  fallback: boolean;
}

export interface IncrementalParseDetails {
  parsed: ParseResult;
  stats: IncrementalCacheStats;
  diagnostics: ParserDiagnostic[];
}

export interface IncrementalParseOptions extends ParseOptions {
  cachePath?: string;
  cache?: Store;
  noCache?: boolean;
  rebuildCache?: boolean;
  agentsView?: "auto" | "off";
  agentsViewDatabasePath?: string;
  /** SQL-pushdown filters applied when reading the materialized model. */
  query?: ResolvedQuery;
}

const EMPTY_STATS: IncrementalCacheStats = {
  hits: 0,
  parsed: 0,
  replaced: 0,
  imported: 0,
  deleted: 0,
  unstable: 0,
  failed: 0,
  incompleteDiscoveries: 0,
  fallback: false,
};

function cloneStats(): IncrementalCacheStats {
  return { ...EMPTY_STATS };
}

function localDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeSources(sources: TranscriptSource[] | undefined): TranscriptSource[] {
  if (!sources?.length) return ["claude"];
  return [...new Set(sources)];
}

function diagnostic(
  code: string,
  message: string,
  severity: ParserDiagnostic["severity"] = "warning",
): ParserDiagnostic {
  return { code, severity, phase: "reconcile", message };
}

function transcriptStoreable(
  fragment: CacheFragment | undefined,
  parser: TranscriptParserAdapter,
  file: CompleteDiscovery["files"][number],
): fragment is ParsedFileFragment {
  return (
    fragment?.kind === "transcript" &&
    fragment.contractVersion === 1 &&
    fragment.parser.name === parser.parser.name &&
    fragment.parser.source === parser.parser.source &&
    fragment.parser.version === parser.parser.version &&
    sameFileFingerprint(fragment.snapshot.fingerprint, file.fingerprint)
  );
}

function auxiliaryStoreable(
  fragment: CacheFragment | undefined,
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

function cacheMissDiagnostic(
  metadata: CachedFragmentMetadata | undefined,
  fragment: CacheFragment | undefined,
  parser: { name: string; source: AgentSource; version: string },
  file: CompleteDiscovery["files"][number],
  kind: "transcript" | "auxiliary",
): ParserDiagnostic | undefined {
  if (!metadata) return undefined;
  const label = `${parser.source} ${kind} ${file.file.relativePath}`;
  if (metadata.status !== "success") {
    return diagnostic(
      "cache_previous_fragment_not_successful",
      `Reparsing ${label} because the previous cached fragment is ${metadata.status}.`,
      "info",
    );
  }
  if (!fragment) {
    return diagnostic(
      "cache_fragment_unavailable",
      `Reparsing ${label} because cached metadata exists but the fragment could not be loaded.`,
      "warning",
    );
  }
  if (fragment.kind !== kind) {
    return diagnostic(
      "cache_fragment_kind_changed",
      `Reparsing ${label} because the cached fragment kind changed from ${fragment.kind}.`,
      "info",
    );
  }
  if (fragment.contractVersion !== 1) {
    return diagnostic(
      "cache_contract_version_changed",
      `Reparsing ${label} because the cached contract version is ${fragment.contractVersion}.`,
      "info",
    );
  }
  if (
    fragment.parser.name !== parser.name ||
    fragment.parser.source !== parser.source ||
    fragment.parser.version !== parser.version
  ) {
    return diagnostic(
      "cache_parser_version_changed",
      `Reparsing ${label} because the parser changed from ${fragment.parser.name}@${fragment.parser.version} to ${parser.name}@${parser.version}.`,
      "info",
    );
  }
  if (!sameFileFingerprint(fragment.snapshot.fingerprint, file.fingerprint)) {
    return diagnostic(
      "cache_file_changed",
      `Reparsing ${label} because its filesystem fingerprint changed.`,
      "info",
    );
  }
  return diagnostic(
    "cache_fragment_not_reusable",
    `Reparsing ${label} because the cached fragment was not reusable.`,
    "info",
  );
}

async function cachedFragmentsForRoot(
  cache: Store,
  source: AgentSource,
  rootId: string,
): Promise<Array<ParsedFileFragment | ParsedAuxiliaryFragment>> {
  const out: Array<ParsedFileFragment | ParsedAuxiliaryFragment> = [];
  for (const metadata of await cache.list(source)) {
    if (metadata.status !== "success") continue;
    const fragment = await cache.load(metadata.id);
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

async function collectTranscriptFragments(
  cache: Store,
  discovery: DiscoveryResult,
  parser: TranscriptParserAdapter,
  stats: IncrementalCacheStats,
  diagnostics: ParserDiagnostic[],
  changed?: Set<string>,
): Promise<ParsedFileFragment[]> {
  diagnostics.push(...discovery.diagnostics);
  if (!isAuthoritativeDiscovery(discovery)) {
    stats.incompleteDiscoveries++;
    diagnostics.push(
      diagnostic(
        "incomplete_discovery_using_cached_fragments",
        `Using cached ${discovery.source} fragments because discovery was ${discovery.status}: ${discovery.rootPath}`,
      ),
    );
    return (await cachedFragmentsForRoot(cache, discovery.source, discovery.rootId))
      .filter((fragment): fragment is ParsedFileFragment => fragment.kind === "transcript");
  }

  const metadataByFile = new Map(
    (await cache.list(discovery.source))
      .filter((metadata) => metadata.fileId)
      .map((metadata) => [metadata.fileId!, metadata]),
  );
  const fragments: ParsedFileFragment[] = [];
  for (const file of discovery.files) {
    const metadata = metadataByFile.get(file.file.id);
    const cached = metadata?.status === "success" ? await cache.load(metadata.id) : undefined;
    if (transcriptStoreable(cached, parser, file)) {
      stats.hits++;
      fragments.push(cached);
      continue;
    }
    const miss = cacheMissDiagnostic(metadata, cached, parser.parser, file, "transcript");
    if (miss) diagnostics.push(miss);

    const result = parser.parseFile(file);
    if (result.status === "current") {
      diagnostics.push(...result.fragment.diagnostics);
      stats.parsed++;
      stats.replaced++;
      await cache.replace(result.fragment);
      fragments.push(result.fragment);
      changed?.add(result.fragment.id);
    } else {
      diagnostics.push(...result.diagnostics);
      if (metadata) await cache.invalidate([metadata.id], "file_changed");
      if (result.status === "unstable") stats.unstable++;
      else stats.failed++;
    }
  }

  const before = await cache.list(discovery.source);
  await cache.removeMissing(discovery);
  const afterIds = new Set((await cache.list(discovery.source)).map((metadata) => metadata.id));
  stats.deleted += before.filter(
    (metadata) => metadata.status === "success" && !afterIds.has(metadata.id),
  ).length;
  return fragments;
}

async function collectAuxiliaryFragments(
  cache: Store,
  discovery: DiscoveryResult,
  parser: AuxiliaryParserAdapter,
  stats: IncrementalCacheStats,
  diagnostics: ParserDiagnostic[],
  changed?: Set<string>,
): Promise<ParsedAuxiliaryFragment[]> {
  diagnostics.push(...discovery.diagnostics);
  if (!isAuthoritativeDiscovery(discovery)) {
    stats.incompleteDiscoveries++;
    diagnostics.push(
      diagnostic(
        "incomplete_auxiliary_discovery_using_cached_fragments",
        `Using cached auxiliary fragments because discovery was ${discovery.status}: ${discovery.rootPath}`,
      ),
    );
    return (await cachedFragmentsForRoot(cache, discovery.source, discovery.rootId))
      .filter((fragment): fragment is ParsedAuxiliaryFragment => fragment.kind === "auxiliary");
  }

  const metadataByFile = new Map(
    (await cache.list(discovery.source))
      .filter((metadata) => metadata.fileId)
      .map((metadata) => [metadata.fileId!, metadata]),
  );
  const fragments: ParsedAuxiliaryFragment[] = [];
  for (const file of discovery.files) {
    const metadata = metadataByFile.get(file.file.id);
    const cached = metadata?.status === "success" ? await cache.load(metadata.id) : undefined;
    if (auxiliaryStoreable(cached, parser, file)) {
      stats.hits++;
      fragments.push(cached);
      continue;
    }
    const miss = cacheMissDiagnostic(metadata, cached, parser.parser, file, "auxiliary");
    if (miss) diagnostics.push(miss);

    const result = parser.parseFile(file);
    if (result.status === "current") {
      diagnostics.push(...result.fragment.diagnostics);
      stats.parsed++;
      stats.replaced++;
      await cache.replace(result.fragment);
      fragments.push(result.fragment);
      changed?.add(result.fragment.id);
    } else {
      diagnostics.push(...result.diagnostics);
      if (metadata) await cache.invalidate([metadata.id], "auxiliary_input_changed");
      if (result.status === "unstable") stats.unstable++;
      else stats.failed++;
    }
  }
  await cache.removeMissing(discovery);
  return fragments;
}

function selectAlternateRepresentations(fragments: ParsedFileFragment[]): ParsedFileFragment[] {
  const selected = new Map<string, ParsedFileFragment>();
  const out: ParsedFileFragment[] = [];
  for (const fragment of fragments) {
    const alternate = fragment.alternateRepresentation;
    if (!alternate) {
      out.push(fragment);
      continue;
    }
    const previous = selected.get(alternate.logicalId);
    if (
      !previous ||
      alternate.preference > previous.alternateRepresentation!.preference ||
      (alternate.preference === previous.alternateRepresentation!.preference &&
        (alternate.updatedAtMs ?? -Infinity) >
          (previous.alternateRepresentation!.updatedAtMs ?? -Infinity)) ||
      (alternate.preference === previous.alternateRepresentation!.preference &&
        (alternate.updatedAtMs ?? -Infinity) ===
          (previous.alternateRepresentation!.updatedAtMs ?? -Infinity) &&
        fragment.id > previous.id)
    ) {
      selected.set(alternate.logicalId, fragment);
    }
  }
  out.push(...selected.values());
  return out;
}

function toolUseFromInvocation(invocation: ParsedFileFragment["facts"]["invocations"][number]): ToolUse {
  const toolUse: ToolUse = {
    name: invocation.name,
    category: categorizeTool(invocation.name),
  };
  if (invocation.skill) toolUse.skill = invocation.skill;
  if (invocation.args) toolUse.args = invocation.args;
  const mcp = parseMcpTool(invocation.name);
  if (invocation.mcpServer || mcp) toolUse.mcpServer = invocation.mcpServer ?? mcp?.server;
  if (invocation.mcpTool || mcp) toolUse.mcpTool = invocation.mcpTool ?? mcp?.tool;
  if (invocation.filePath) toolUse.filePath = invocation.filePath;
  return toolUse;
}

function orderedMessages(fragments: ParsedFileFragment[]) {
  return fragments
    .flatMap((fragment) => fragment.facts.messages)
    .sort((a, b) =>
      compareReconciliationOrder(
        {
          timestampMs: a.timestampMs,
          source: a.source,
          sourceSessionId: a.sourceSessionId,
          position: a.position,
          stableId: a.id,
        },
        {
          timestampMs: b.timestampMs,
          source: b.source,
          sourceSessionId: b.sourceSessionId,
          position: b.position,
          stableId: b.id,
        },
      ),
    );
}

export function reconcileFragments(input: ReconciliationInput): ParseResult {
  const nativeSources = new Set(input.nativeFragments.map((fragment) => fragment.parser.source));
  const importedFragments = input.importedFragments.flatMap((fragment) => {
    const source = fragment.provenance.coverage[0]?.source;
    if (!source || nativeSources.has(source)) return [];
    const converted: ParsedFileFragment = {
      kind: "transcript",
      id: fragment.id,
      contractVersion: fragment.contractVersion,
      parser: { name: "agentsview", source, version: fragment.provenance.adapter.version },
      snapshot: fragment.provenance.database,
      facts: fragment.facts,
      dependencies: [],
      diagnostics: fragment.diagnostics,
    };
    return [converted];
  });
  const fragments = selectAlternateRepresentations([...input.nativeFragments, ...importedFragments]);
  const sessions = new Map<string, SessionMeta>();
  const firstPrompts = new Map<string, { text: string; timestampMs: number }>();
  const projectRoots = new Map<string, string>();
  const dependencySelectorsBySession = new Map<string, string[]>();
  const parentByClaudeChild = new Map<string, string>();

  for (const fragment of input.auxiliaryFragments) {
    for (const fact of fragment.facts) {
      if (fact.kind === "session_first_prompt") {
        const previous = firstPrompts.get(fact.sourceSessionId);
        if (!previous || fact.timestampMs < previous.timestampMs) {
          firstPrompts.set(fact.sourceSessionId, {
            text: fact.firstPrompt,
            timestampMs: fact.timestampMs,
          });
        }
      } else if (fact.kind === "project_root") {
        if (!projectRoots.has(fact.selector)) projectRoots.set(fact.selector, fact.cwd);
      }
    }
  }

  for (const fragment of fragments) {
    for (const session of fragment.facts.sessions) {
      const selectors = dependencySelectorsBySession.get(session.sourceSessionId) ?? [];
      for (const dependency of fragment.dependencies) selectors.push(dependency.selector);
      dependencySelectorsBySession.set(session.sourceSessionId, selectors);
    }
    for (const relationship of fragment.facts.relationships) {
      if (relationship.source === "claude") {
        parentByClaudeChild.set(
          relationship.childSourceSessionId,
          relationship.parentSourceSessionId,
        );
      }
    }
  }

  const canonicalSessionId = (source: AgentSource, sourceSessionId: string): string =>
    source === "claude" ? parentByClaudeChild.get(sourceSessionId) ?? sourceSessionId : sourceSessionId;

  const cwdForSession = (session: ParsedFileFragment["facts"]["sessions"][number]): string => {
    if (session.source === "gemini") {
      const selectors = [
        session.rawProjectId,
        ...(dependencySelectorsBySession.get(session.sourceSessionId) ?? []),
      ].filter((value): value is string => !!value);
      for (const selector of selectors) {
        const cwd = projectRoots.get(selector);
        if (cwd) return cwd;
      }
    }
    return session.cwd ?? "";
  };

  const sessionFacts = fragments
    .flatMap((fragment) => fragment.facts.sessions)
    .sort((a, b) =>
      compareReconciliationOrder(
        {
          timestampMs: 0,
          source: a.source,
          sourceSessionId: a.sourceSessionId,
          position: a.position,
          stableId: a.id,
        },
        {
          timestampMs: 0,
          source: b.source,
          sourceSessionId: b.sourceSessionId,
          position: b.position,
          stableId: b.id,
        },
      ),
    );

  for (const fact of sessionFacts) {
    const sid = canonicalSessionId(fact.source, fact.sourceSessionId);
    if (sid !== fact.sourceSessionId && sessions.has(sid)) continue;
    const cwd = cwdForSession(fact);
    const firstPrompt =
      firstPrompts.get(sid)?.text ??
      firstPrompts.get(fact.sourceSessionId)?.text ??
      fact.firstPrompt;
    const existing = sessions.get(sid);
    if (!existing) {
      sessions.set(sid, {
        source: fact.source,
        sessionId: sid,
        project: cwd ? projectLabel(cwd) : fact.source === "gemini" ? `gemini/${basename(fact.transcriptPath)}` : "(unknown)",
        cwd,
        filePath: fact.transcriptPath,
        ...(firstPrompt ? { firstPrompt } : {}),
      });
      continue;
    }
    if (!existing.cwd && cwd) {
      existing.cwd = cwd;
      existing.project = projectLabel(cwd);
    }
    if (!existing.firstPrompt && firstPrompt) existing.firstPrompt = firstPrompt;
  }

  // Session friction (#37): only native Claude transcript fragments observe friction, so
  // AgentsView-imported sessions stay undefined (unknown) rather than a misleading zero.
  // Events are identified stably (record uuid / tool_use_id), so a resumed session that
  // replays records into a second file dedupes here instead of double-counting.
  const frictionEventsBySession = new Map<string, FrictionEvent[]>();
  const seenFrictionEventIds = new Set<string>();
  for (const fragment of fragments) {
    if (fragment.parser.name !== CLAUDE_TRANSCRIPT_PARSER.name) continue;
    for (const fact of fragment.facts.sessions) {
      const sid = canonicalSessionId(fact.source, fact.sourceSessionId);
      const events = frictionEventsBySession.get(sid) ?? [];
      if (!frictionEventsBySession.has(sid)) frictionEventsBySession.set(sid, events);
      for (const event of fact.frictionEvents ?? []) {
        const key = `${event.kind} ${event.eventId}`;
        if (seenFrictionEventIds.has(key)) continue;
        seenFrictionEventIds.add(key);
        events.push(event);
      }
    }
  }
  for (const [sid, events] of frictionEventsBySession) {
    const session = sessions.get(sid);
    if (session) session.friction = foldFrictionEvents(events);
  }

  const invocationByMessage = new Map<string, ParsedFileFragment["facts"]["invocations"]>();
  const invocationByFactId = new Map<string, ParsedFileFragment["facts"]["invocations"][number]>();
  for (const invocation of fragments.flatMap((fragment) => fragment.facts.invocations)) {
    const list = invocationByMessage.get(invocation.messageId) ?? [];
    list.push(invocation);
    invocationByMessage.set(invocation.messageId, list);
    invocationByFactId.set(invocation.id, invocation);
  }

  const messages: MessageRecord[] = [];
  const seenClaudeProviderMessages = new Set<string>();
  for (const fact of orderedMessages(fragments)) {
    if (fact.source === "claude" && fact.providerMessageId) {
      if (seenClaudeProviderMessages.has(fact.providerMessageId)) continue;
      seenClaudeProviderMessages.add(fact.providerMessageId);
    }
    const sessionId = canonicalSessionId(fact.source, fact.sourceSessionId);
    const session = sessions.get(sessionId);
    if (fact.stopReason && session?.friction) {
      session.friction.stopReasons[fact.stopReason] =
        (session.friction.stopReasons[fact.stopReason] ?? 0) + 1;
    }
    const cwd = fact.cwd ?? session?.cwd ?? "";
    const toolUses = (invocationByMessage.get(fact.id) ?? [])
      .sort((a, b) =>
        a.position.recordIndex - b.position.recordIndex ||
        a.position.itemIndex - b.position.itemIndex ||
        a.id.localeCompare(b.id),
      )
      .map(toolUseFromInvocation);
    messages.push({
      source: fact.source,
      sessionId,
      project: cwd ? projectLabel(cwd) : session?.project ?? "(unknown)",
      cwd,
      gitBranch: fact.gitBranch ?? "",
      ts: fact.timestampMs,
      date: localDate(fact.timestampMs),
      model: fact.model,
      usage: fact.usage,
      attributionSkill: fact.attributionSkill,
      ...(fact.stopReason ? { stopReason: fact.stopReason } : {}),
      toolUses,
    });
  }

  const toolResults = new Map<string, ToolResultStat>();
  for (const result of fragments.flatMap((fragment) => fragment.facts.toolResults)) {
    const name =
      result.observedToolName ??
      (result.resolvedInvocationFactId
        ? invocationByFactId.get(result.resolvedInvocationFactId)?.name
        : undefined);
    if (!name) continue;
    const stat = toolResults.get(name) ?? { count: 0, approxTokens: 0 };
    stat.count += 1;
    stat.approxTokens += result.approxTokens;
    toolResults.set(name, stat);
  }

  messages.sort((a, b) => a.ts - b.ts || a.source.localeCompare(b.source) || a.sessionId.localeCompare(b.sessionId));
  return {
    messages,
    sessions,
    toolResults,
  };
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
 */
async function syncStore(
  opts: IncrementalParseOptions,
  cache: Store,
  stats: IncrementalCacheStats,
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
            cache,
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
      const existing = await cache.resolvedSessionIdsForOwner(producer.id);
      nativeFragmentCount += existing.length;
      if (existing.length) nativeSources.add(producer.source);
      continue;
    }

    const parser = producer.transcriptParser();
    const before = await cache.transcriptIndex(producer.source);
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
            "cache_file_changed",
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
        await cache.replace(result.fragment); // writes the light index only
        changedFragments.push(result.fragment);
        parsedById.set(result.fragment.id, result.fragment);
      } else {
        diagnostics.push(...result.diagnostics);
        if (stored) await cache.invalidate([stored.fragmentId], "file_changed");
        if (result.status === "unstable") stats.unstable++;
        else stats.failed++;
      }
    }

    await cache.removeMissing(discovery);
    const after = await cache.transcriptIndex(producer.source);
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
      await cache.materializeSessions(producer.id, toMaterializeSessions(output));
    }

    const prevOwned = await cache.resolvedSessionIdsForOwner(producer.id);
    await cache.retractSessions(prevOwned.filter((id) => !currentCanonical.has(id)));
    await cache.setCoverage(producer.id, null, currentCanonical.size);
  }

  for (const producer of IMPORT_PRODUCERS) {
    const imported = await gatherImportedFragments(
      producer,
      ctx,
      cache,
      stats,
      diagnostics,
      requested,
      nativeSources,
    );
    importedCount += imported.length;
    // Read ownership *after* natives materialized, so handed-off sessions are excluded.
    const prevOwned = await cache.resolvedSessionIdsForOwner(producer.id);
    const nativeOwned = await cache.ownedSessionIdsExcept(producer.id);
    const converted = imported
      .map(convertImported)
      .filter((fragment): fragment is ParsedFileFragment => !!fragment);
    let unowned = new Set<string>();
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
      await cache.materializeSessions(producer.id, toMaterializeSessions(output));
    }
    await cache.retractSessions(prevOwned.filter((id) => !unowned.has(id)));
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
  cache: Store,
  stats: IncrementalCacheStats,
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

  const staleExternal = (await cache.list())
    .filter((metadata) => metadata.kind === "external" && metadata.status === "success")
    .map((metadata) => metadata.id);
  if (staleExternal.length) await cache.invalidate(staleExternal, "external_import_changed");

  const imported = (await importer.importFragments(probe)).filter((fragment) => {
    const source = fragment.provenance.coverage[0]?.source;
    return !!source && requestedSources.has(source);
  });
  for (const fragment of imported) await cache.replace(fragment);
  stats.imported += imported.length;

  for (const fragment of imported) {
    const source = fragment.provenance.coverage[0]?.source;
    if (!source) continue;
    diagnostics.push(
      diagnostic(
        nativeSources.has(source) ? "agentsview_native_precedence" : "agentsview_import_used",
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
  if (opts.noCache) {
    return {
      parsed: parseAll(opts),
      stats: { ...cloneStats(), fallback: true },
      diagnostics: [],
    };
  }

  const stats = cloneStats();
  const diagnostics: ParserDiagnostic[] = [];
  let cache = opts.cache;
  let ownsCache = false;
  try {
    if (!cache) {
      cache = opts.rebuildCache
        ? await rebuildStore({ path: opts.cachePath })
        : await openStore({ path: opts.cachePath });
      ownsCache = true;
    }
    // Producers reconcile + materialize the trusted read model; the reader just SELECTs it (with
    // optional SQL pushdown). The legacy monolithic `reconcileFragments` is retained (exported) only
    // as the test oracle.
    await syncStore(opts, cache, stats, diagnostics);
    return {
      parsed: await cache.readResolved({
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
        "cache_fallback",
        `Falling back to uncached parsing because the fragment cache failed: ${
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
    if (ownsCache && cache) await cache.close();
  }
}

export async function parseAllIncremental(
  opts: IncrementalParseOptions = {},
): Promise<ParseResult> {
  return (await parseAllIncrementalDetailed(opts)).parsed;
}

export function cacheRunModeSummary(
  stats: IncrementalCacheStats,
  diagnostics: ParserDiagnostic[] = [],
): string {
  if (stats.fallback) return "raw parser fallback";
  const agentsViewUsed = diagnostics.some((entry) => entry.code === "agentsview_import_used");
  const agentsViewProvenance = diagnostics.some(
    (entry) => entry.code === "agentsview_native_precedence",
  );
  const nativeTouched =
    stats.hits > 0 ||
    stats.parsed > 0 ||
    stats.replaced > 0 ||
    stats.deleted > 0 ||
    stats.unstable > 0 ||
    stats.failed > 0 ||
    stats.incompleteDiscoveries > 0;
  if (agentsViewUsed && nativeTouched) return "mixed native + AgentsView cache";
  if (agentsViewUsed || (stats.imported > 0 && !nativeTouched)) return "AgentsView-assisted cache";
  if (agentsViewProvenance || stats.imported > 0) return "native cache with AgentsView provenance";
  return "native cache";
}

export function cacheStatsSummary(
  stats: IncrementalCacheStats,
  diagnostics: ParserDiagnostic[] = [],
): string {
  if (stats.fallback) return cacheRunModeSummary(stats, diagnostics);
  return `${cacheRunModeSummary(stats, diagnostics)}: ${stats.hits} hit, ${stats.parsed} parsed, ${stats.replaced} stored, ${stats.imported} imported, ${stats.deleted} deleted, ${stats.unstable} unstable, ${stats.failed} failed`;
}
