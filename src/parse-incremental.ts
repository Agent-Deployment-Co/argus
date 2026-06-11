import { basename } from "node:path";
import { AgentsViewImporter } from "./agentsview-import.ts";
import {
  compareReconciliationOrder,
  isAuthoritativeDiscovery,
  sameFileFingerprint,
  type AuxiliaryParserAdapter,
  type CacheFragment,
  type CompleteDiscovery,
  type DiscoveryResult,
  type FragmentCache,
  type ImportedFragment,
  type ParsedAuxiliaryFragment,
  type ParsedFileFragment,
  type ParserDiagnostic,
  type ReconciliationInput,
  type TranscriptParserAdapter,
} from "./cache-contract.ts";
import { openFragmentCache, rebuildFragmentCache } from "./cache-store.ts";
import {
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
  cache?: FragmentCache;
  noCache?: boolean;
  rebuildCache?: boolean;
  agentsView?: "auto" | "off";
  agentsViewDatabasePath?: string;
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

function transcriptFragmentCacheable(
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

function auxiliaryFragmentCacheable(
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

async function cachedFragmentsForRoot(
  cache: FragmentCache,
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
  cache: FragmentCache,
  discovery: DiscoveryResult,
  parser: TranscriptParserAdapter,
  stats: IncrementalCacheStats,
  diagnostics: ParserDiagnostic[],
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
    if (transcriptFragmentCacheable(cached, parser, file)) {
      stats.hits++;
      fragments.push(cached);
      continue;
    }

    const result = parser.parseFile(file);
    if (result.status === "current") {
      diagnostics.push(...result.fragment.diagnostics);
      stats.parsed++;
      stats.replaced++;
      await cache.replace(result.fragment);
      fragments.push(result.fragment);
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
  cache: FragmentCache,
  discovery: DiscoveryResult,
  parser: AuxiliaryParserAdapter,
  stats: IncrementalCacheStats,
  diagnostics: ParserDiagnostic[],
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
    if (auxiliaryFragmentCacheable(cached, parser, file)) {
      stats.hits++;
      fragments.push(cached);
      continue;
    }

    const result = parser.parseFile(file);
    if (result.status === "current") {
      diagnostics.push(...result.fragment.diagnostics);
      stats.parsed++;
      stats.replaced++;
      await cache.replace(result.fragment);
      fragments.push(result.fragment);
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

async function gatherNativeFragments(
  opts: IncrementalParseOptions,
  cache: FragmentCache,
  stats: IncrementalCacheStats,
  diagnostics: ParserDiagnostic[],
): Promise<{ nativeFragments: ParsedFileFragment[]; auxiliaryFragments: ParsedAuxiliaryFragment[] }> {
  const sources = normalizeSources(opts.sources);
  const nativeFragments: ParsedFileFragment[] = [];
  const auxiliaryFragments: ParsedAuxiliaryFragment[] = [];

  if (sources.includes("claude")) {
    nativeFragments.push(
      ...(await collectTranscriptFragments(
        cache,
        createClaudeTranscriptDiscoveryAdapter(opts.projectsDir).discover(),
        createClaudeTranscriptParserAdapter(),
        stats,
        diagnostics,
      )),
    );
    auxiliaryFragments.push(
      ...(await collectAuxiliaryFragments(
        cache,
        discoverClaudeHistory(opts.historyFile),
        createClaudeHistoryParserAdapter(),
        stats,
        diagnostics,
      )),
    );
  }

  if (sources.includes("codex")) {
    nativeFragments.push(
      ...(await collectTranscriptFragments(
        cache,
        createCodexTranscriptDiscoveryAdapter(opts.codexSessionsDir).discover(),
        createCodexTranscriptParserAdapter(),
        stats,
        diagnostics,
      )),
    );
  }

  if (sources.includes("gemini")) {
    nativeFragments.push(
      ...(await collectTranscriptFragments(
        cache,
        createGeminiTranscriptDiscoveryAdapter(opts.geminiDir).discover(),
        createGeminiTranscriptParserAdapter(),
        stats,
        diagnostics,
      )),
    );
    auxiliaryFragments.push(
      ...(await collectAuxiliaryFragments(
        cache,
        discoverGeminiAuxiliaryFiles(opts.geminiDir),
        createGeminiAuxiliaryParserAdapter(),
        stats,
        diagnostics,
      )),
    );
  }

  return { nativeFragments, auxiliaryFragments };
}

async function gatherAgentsViewFragments(
  opts: IncrementalParseOptions,
  cache: FragmentCache,
  stats: IncrementalCacheStats,
  diagnostics: ParserDiagnostic[],
  nativeFragments: ParsedFileFragment[],
): Promise<ImportedFragment[]> {
  if (opts.agentsView === "off") {
    diagnostics.push(
      diagnostic("agentsview_disabled", "AgentsView import disabled by user control.", "info"),
    );
    return [];
  }

  const importer = new AgentsViewImporter({ databasePath: opts.agentsViewDatabasePath });
  const probe = await importer.probe();
  if (!probe.compatible) {
    diagnostics.push(
      diagnostic(
        "agentsview_unavailable",
        `AgentsView import unavailable: ${probe.reason}`,
        "info",
      ),
    );
    return [];
  }

  const staleExternal = (await cache.list())
    .filter((metadata) => metadata.kind === "external" && metadata.status === "success")
    .map((metadata) => metadata.id);
  if (staleExternal.length) await cache.invalidate(staleExternal, "external_import_changed");

  const requestedSources = new Set(normalizeSources(opts.sources));
  const imported = (await importer.importFragments(probe)).filter((fragment) => {
    const source = fragment.provenance.coverage[0]?.source;
    return !!source && requestedSources.has(source);
  });
  for (const fragment of imported) await cache.replace(fragment);
  stats.imported += imported.length;

  const nativeSources = new Set(nativeFragments.map((fragment) => fragment.parser.source));
  for (const fragment of imported) {
    const source = fragment.provenance.coverage[0]?.source;
    if (!source) continue;
    diagnostics.push(
      diagnostic(
        nativeSources.has(source)
          ? "agentsview_native_precedence"
          : "agentsview_import_used",
        nativeSources.has(source)
          ? `AgentsView ${source} facts imported for provenance; native Argus fragments remain authoritative.`
          : `AgentsView ${source} facts used because no native Argus fragments were available for that source.`,
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
        ? await rebuildFragmentCache({ path: opts.cachePath })
        : await openFragmentCache({ path: opts.cachePath });
      ownsCache = true;
    }
    const { nativeFragments, auxiliaryFragments } = await gatherNativeFragments(
      opts,
      cache,
      stats,
      diagnostics,
    );
    const importedFragments = await gatherAgentsViewFragments(
      opts,
      cache,
      stats,
      diagnostics,
      nativeFragments,
    );
    if (
      nativeFragments.length === 0 &&
      importedFragments.length === 0 &&
      diagnostics.some(
        (entry) => entry.phase === "discovery" && entry.code === "missing_root",
      )
    ) {
      throw new Error("No transcript roots were available for incremental parsing");
    }
    return {
      parsed: reconcileFragments({
        nativeFragments,
        auxiliaryFragments,
        importedFragments,
        diagnostics,
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

export function cacheStatsSummary(stats: IncrementalCacheStats): string {
  if (stats.fallback) return "cache fallback";
  return `${stats.hits} hit, ${stats.parsed} parsed, ${stats.replaced} stored, ${stats.imported} imported, ${stats.deleted} deleted, ${stats.unstable} unstable, ${stats.failed} failed`;
}
