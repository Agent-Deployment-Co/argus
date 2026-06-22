// The reconcile engine: turns a producer's parsed fragments into a "safe" (fully reconciled) set of
// session facts for the sessions that producer owns. This is the logic each producer runs at index
// time so the reader never reconciles.
//
// It is parameterized by per-producer **capabilities** rather than branching on source, so adding a
// new producer never edits this engine — the producer declares what it observes (subagent
// canonicalization, provider-message-id dedup, friction) and the engine reads those flags. The
// capability defaults reproduce today's behavior exactly (see src/producers/*).
//
// `reconcileSessions` is single-producer and optionally scopeable to a set of canonical session ids
// (session-incremental re-materialization). `mergeReconciled` combines per-producer results, applying
// per-session ownership and the global timeline order.
import { basename } from "node:path";
import {
  compareReconciliationOrder,
  type ParsedAuxiliaryFragment,
  type ParsedFileFragment,
  type SessionFact,
  type TaskFact,
} from "./store-contract.ts";
import { foldFrictionEvents, type FrictionEvent } from "./friction.ts";
import { projectLabel } from "./parse.ts";
import { categorizeTool, parseMcpTool } from "./tool-categories.ts";
import type {
  AgentSource,
  MessageRecord,
  ParseResult,
  SessionMeta,
  ToolResultStat,
  ToolUse,
} from "./types.ts";

/** What a producer observes, read generically by the engine instead of source conditionals. */
export interface ProducerCapabilities {
  /** Use `relationship` facts to canonicalize subagent sessions onto their parent. */
  canonicalizeSubagents: boolean;
  /** Drop repeat messages sharing a `providerMessageId` (resumed/compacted replays). */
  dedupeByProviderMessageId: boolean;
  /** Friction is observed, so a session with no events folds to zero (not "unknown"). */
  observesFriction: boolean;
  /** Project label for a session with no resolvable cwd. Defaults to "(unknown)". */
  unknownProjectLabel?: (session: SessionFact) => string;
}

export interface ReconcileInput {
  caps: ProducerCapabilities;
  /** This producer's transcript (or import-as-transcript) fragments. */
  fragments: ParsedFileFragment[];
  /** This producer's auxiliary fragments (history first-prompts, gemini project roots). */
  auxiliaryFragments: ParsedAuxiliaryFragment[];
  /** Restrict output to these canonical session ids (session-incremental). Omit for all. */
  canonicalIds?: Set<string>;
}

/** reconcileSessions output: a ParseResult plus tool-result stats attributed per session. */
export interface ReconcileResult extends ParseResult {
  toolResultsBySession: Map<string, Map<string, ToolResultStat>>;
  tasksBySession: Map<string, TaskFact[]>;
}

/**
 * The canonical session ids a producer's fragments resolve to (subagent children fold onto parents
 * when the producer canonicalizes). Used to compute touched/current session sets for materialization.
 */
export function canonicalSessionIds(
  caps: ProducerCapabilities,
  fragments: ParsedFileFragment[],
): Set<string> {
  const parentByChild = new Map<string, string>();
  if (caps.canonicalizeSubagents) {
    for (const fragment of fragments) {
      for (const relationship of fragment.facts.relationships) {
        parentByChild.set(relationship.childSourceSessionId, relationship.parentSourceSessionId);
      }
    }
  }
  const ids = new Set<string>();
  for (const fragment of fragments) {
    for (const session of fragment.facts.sessions) {
      ids.add(
        caps.canonicalizeSubagents
          ? parentByChild.get(session.sourceSessionId) ?? session.sourceSessionId
          : session.sourceSessionId,
      );
    }
  }
  return ids;
}

/** Label for a session with no resolvable cwd; gemini falls back to its transcript basename. */
export function defaultUnknownProjectLabel(session: SessionFact): string {
  return session.source === "gemini" ? `gemini/${basename(session.transcriptPath)}` : "(unknown)";
}

export function localDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function selectAlternateRepresentations(
  fragments: ParsedFileFragment[],
): ParsedFileFragment[] {
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

export function toolUseFromInvocation(
  invocation: ParsedFileFragment["facts"]["invocations"][number],
): ToolUse {
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

function orderedTasks(fragments: ParsedFileFragment[]): TaskFact[] {
  return fragments
    .flatMap((fragment) => fragment.facts.tasks ?? [])
    .sort((a, b) =>
      compareReconciliationOrder(
        {
          timestampMs: a.timestampMs ?? 0,
          source: a.source,
          sourceSessionId: a.sourceSessionId,
          position: a.position,
          stableId: a.id,
        },
        {
          timestampMs: b.timestampMs ?? 0,
          source: b.source,
          sourceSessionId: b.sourceSessionId,
          position: b.position,
          stableId: b.id,
        },
      ),
    );
}

/**
 * Reconcile one producer's fragments into sessions + messages + tool-result stats. Generic over
 * `caps`; optionally scoped to `canonicalIds`. Mirrors the legacy monolithic reconciler for a single
 * source, with source conditionals replaced by capability checks.
 */
export function reconcileSessions(input: ReconcileInput): ReconcileResult {
  const { caps, auxiliaryFragments, canonicalIds } = input;
  const fragments = selectAlternateRepresentations(input.fragments);
  const sessions = new Map<string, SessionMeta>();
  const firstPrompts = new Map<string, { text: string; timestampMs: number }>();
  const projectRoots = new Map<string, string>();
  const dependencySelectorsBySession = new Map<string, string[]>();
  const parentByChild = new Map<string, string>();

  for (const fragment of auxiliaryFragments) {
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
    if (caps.canonicalizeSubagents) {
      for (const relationship of fragment.facts.relationships) {
        parentByChild.set(relationship.childSourceSessionId, relationship.parentSourceSessionId);
      }
    }
  }

  const canonicalSessionId = (sourceSessionId: string): string =>
    caps.canonicalizeSubagents ? parentByChild.get(sourceSessionId) ?? sourceSessionId : sourceSessionId;

  const cwdForSession = (session: SessionFact): string => {
    const selectors = [
      session.rawProjectId,
      ...(dependencySelectorsBySession.get(session.sourceSessionId) ?? []),
    ].filter((value): value is string => !!value);
    for (const selector of selectors) {
      const cwd = projectRoots.get(selector);
      if (cwd) return cwd;
    }
    return session.cwd ?? "";
  };

  const unknownLabel = (session: SessionFact): string =>
    caps.unknownProjectLabel?.(session) ?? "(unknown)";

  const wanted = (canonicalId: string): boolean => !canonicalIds || canonicalIds.has(canonicalId);

  const sessionFacts = fragments
    .flatMap((fragment) => fragment.facts.sessions)
    .sort((a, b) =>
      compareReconciliationOrder(
        { timestampMs: 0, source: a.source, sourceSessionId: a.sourceSessionId, position: a.position, stableId: a.id },
        { timestampMs: 0, source: b.source, sourceSessionId: b.sourceSessionId, position: b.position, stableId: b.id },
      ),
    );

  for (const fact of sessionFacts) {
    const sid = canonicalSessionId(fact.sourceSessionId);
    if (!wanted(sid)) continue;
    if (sid !== fact.sourceSessionId && sessions.has(sid)) continue;
    const cwd = cwdForSession(fact);
    const firstPrompt =
      firstPrompts.get(sid)?.text ?? firstPrompts.get(fact.sourceSessionId)?.text ?? fact.firstPrompt;
    const userMessages = fact.userMessages;
    const agentMessages = fact.agentMessages;
    const rawTurns = fact.rawTurns;
    const existing = sessions.get(sid);
    if (!existing) {
      sessions.set(sid, {
        source: fact.source,
        sessionId: sid,
        project: cwd ? projectLabel(cwd) : unknownLabel(fact),
        cwd,
        filePath: fact.transcriptPath,
        ...(firstPrompt ? { firstPrompt } : {}),
        ...(userMessages != null ? { userMessages } : {}),
        ...(agentMessages != null ? { agentMessages } : {}),
        ...(rawTurns != null ? { rawTurns } : {}),
      });
      continue;
    }
    if (!existing.cwd && cwd) {
      existing.cwd = cwd;
      existing.project = projectLabel(cwd);
    }
    if (!existing.firstPrompt && firstPrompt) existing.firstPrompt = firstPrompt;
    if (userMessages != null) existing.userMessages = Math.max(existing.userMessages ?? 0, userMessages);
    if (agentMessages != null) existing.agentMessages = Math.max(existing.agentMessages ?? 0, agentMessages);
    if (rawTurns != null) existing.rawTurns = Math.max(existing.rawTurns ?? 0, rawTurns);
  }

  // Friction (#37): folded only for producers that observe it; absence then means zero, not unknown.
  // Events carry stable ids so resumed-session replays dedupe here instead of double-counting.
  if (caps.observesFriction) {
    const frictionEventsBySession = new Map<string, FrictionEvent[]>();
    const seenFrictionEventIds = new Set<string>();
    for (const fragment of fragments) {
      for (const fact of fragment.facts.sessions) {
        const sid = canonicalSessionId(fact.sourceSessionId);
        if (!wanted(sid)) continue;
        const events = frictionEventsBySession.get(sid) ?? [];
        if (!frictionEventsBySession.has(sid)) frictionEventsBySession.set(sid, events);
        for (const event of fact.frictionEvents ?? []) {
          const key = `${event.kind} ${event.eventId}`;
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
  const seenProviderMessages = new Set<string>();
  for (const fact of orderedMessages(fragments)) {
    if (caps.dedupeByProviderMessageId && fact.providerMessageId) {
      if (seenProviderMessages.has(fact.providerMessageId)) continue;
      seenProviderMessages.add(fact.providerMessageId);
    }
    const sessionId = canonicalSessionId(fact.sourceSessionId);
    if (!wanted(sessionId)) continue;
    const session = sessions.get(sessionId);
    if (fact.stopReason && session?.friction) {
      session.friction.stopReasons[fact.stopReason] =
        (session.friction.stopReasons[fact.stopReason] ?? 0) + 1;
    }
    const cwd = fact.cwd ?? session?.cwd ?? "";
    const toolUses = (invocationByMessage.get(fact.id) ?? [])
      .sort(
        (a, b) =>
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

  const tasksBySession = new Map<string, TaskFact[]>();
  for (const fact of orderedTasks(fragments)) {
    const sessionId = canonicalSessionId(fact.sourceSessionId);
    if (!wanted(sessionId)) continue;
    const tasks = tasksBySession.get(sessionId) ?? [];
    tasks.push(fact);
    tasksBySession.set(sessionId, tasks);
  }

  const toolResults = new Map<string, ToolResultStat>();
  const toolResultsBySession = new Map<string, Map<string, ToolResultStat>>();
  for (const result of fragments.flatMap((fragment) => fragment.facts.toolResults)) {
    const sid = canonicalSessionId(result.sourceSessionId);
    if (canonicalIds && !canonicalIds.has(sid)) continue;
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
    let perSession = toolResultsBySession.get(sid);
    if (!perSession) {
      perSession = new Map<string, ToolResultStat>();
      toolResultsBySession.set(sid, perSession);
    }
    const sessionStat = perSession.get(name) ?? { count: 0, approxTokens: 0 };
    sessionStat.count += 1;
    sessionStat.approxTokens += result.approxTokens;
    perSession.set(name, sessionStat);
  }

  return {
    messages,
    sessions,
    toolResults,
    toolResultsBySession,
    tasksBySession,
  };
}

export type { AgentSource };
