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
  createFactId,
  type InteractionDisposition,
  type InteractionFact,
  type InteractionInitiator,
  type ParsedAuxiliaryFragment,
  type ParsedFileFragment,
  type PromptFact,
  type SessionFact,
  type SourcePosition,
  type TaskFact,
} from "../store/store-contract.ts";
import { foldFrictionEvents, type FrictionEvent } from "./friction.ts";
import { projectLabel } from "./discover.ts";
import { categorizeTool, parseMcpTool } from "../tool-categories.ts";
import type {
  AgentSource,
  MessageRecord,
  ParseResult,
  SessionMeta,
  ToolResultStat,
  ToolUse,
} from "../types.ts";

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

/** reconcileSessions output: a ParseResult plus per-session tasks/interactions. Tool-result sizes
 *  are folded onto each call (MessageRecord.toolUses[].approxResultTokens, #130), not aggregated into
 *  a separate per-session map — resolved_tool_results is retired. */
export interface ReconcileResult extends ParseResult {
  tasksBySession: Map<string, TaskFact[]>;
  /** Interactions (#117), derived here by grouping the deduped/ordered timeline. */
  interactions: InteractionFact[];
  /** Result facts (#130) that didn't correlate to any parsed call — their tokens are dropped from
   *  the per-tool result-size totals (the call deduped away on a resumed session, lives in an
   *  unparsed sibling, etc.). Surfaced for a one-line log; usually 0. */
  orphanResultCount: number;
  orphanResultTokens: number;
}

/** Append `value` to the array at `key`, creating it on first use. */
function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** A timeline entry used to derive interactions: an opening prompt or an assistant turn.
 *  Exported for tests of the timeline ordering. */
export type TimelineEntry = {
  sid: string;
  kind: "prompt" | "turn";
  ts: number;
  position: SourcePosition;
  /** Set on prompt entries — the interaction it opens inherits this initiator. */
  initiator?: InteractionInitiator;
  /** Set on turn entries — true if this turn was folded from a subagent (a different source session).
   *  Folded turns are loop content, never the main agent's response slot. */
  folded?: boolean;
};

/**
 * Timeline order: a genuine total order by `(ts, originKey, recordIndex, itemIndex)`. It relies on
 * `seedMissingTimestamps` having run first so every entry has a `ts` consistent with its record order
 * within its file — that's what both keeps a timestamp-less prompt from sorting ahead of real turns
 * and keeps the comparator transitive (mixing position-within-file with ts-across-files is not).
 */
export function compareTimeline(a: TimelineEntry, b: TimelineEntry): number {
  return (
    a.ts - b.ts ||
    (a.position.originKey < b.position.originKey ? -1 : a.position.originKey > b.position.originKey ? 1 : 0) ||
    a.position.recordIndex - b.position.recordIndex ||
    a.position.itemIndex - b.position.itemIndex
  );
}

/**
 * Make `ts` monotonic with record order *within each file*: a timestamp-less entry (a prompt whose
 * producer left `ts` at 0) inherits the timestamp of the preceding entry in record order. Without
 * this a ts→0 prompt would sort to the front of the timeline, and a comparator that special-cased
 * within-file ordering to fix that would be intransitive (→ undefined V8 sort). After seeding, a
 * single `(ts, position)` comparator is a correct total order. Mutates the entries in place.
 */
export function seedMissingTimestamps(entries: TimelineEntry[]): void {
  const byFile = new Map<string, TimelineEntry[]>();
  for (const entry of entries) pushInto(byFile, entry.position.originKey, entry);
  for (const group of byFile.values()) {
    group.sort(
      (a, b) => a.position.recordIndex - b.position.recordIndex || a.position.itemIndex - b.position.itemIndex,
    );
    let lastTs = 0;
    for (const entry of group) {
      if (entry.ts) lastTs = entry.ts;
      else entry.ts = lastTs;
    }
  }
}

/** Per-session friction timestamps used to set interaction disposition/compactionCount. Compaction
 *  boundary and summary markers are kept apart because a single compaction emits both — counting the
 *  concatenation would double it (mirrors friction.ts's max(boundaries, summaries)). */
type SpanSignals = {
  interruptionMs: number[];
  compactBoundaryMs: number[];
  compactSummaryMs: number[];
};

/**
 * Group a session's opening prompts + assistant turns into interactions: each opening prompt opens
 * one, the turns until the next opening are its loop, and the last turn *from the interaction's own
 * session* (not a folded subagent turn) is the response slot. Disposition reuses folded friction
 * (interruption in the span → interrupted); compactionCount = max(boundary, summary) markers in the
 * span. Folded subagent prompts aren't openings — they're loop content — which is what keeps subagent
 * prompts from spawning phantom interactions (#118).
 *
 * Span attribution: an interaction owns `[startTs, endTs]`, but the boundary `ts` (which equals the
 * next interaction's start) belongs to the *earlier* interaction — so an interrupt sharing a coarse
 * millisecond with the following prompt is credited to the interaction it actually ended, not the
 * next one.
 */
function deriveInteractions(
  source: AgentSource,
  promptsBySession: Map<string, TimelineEntry[]>,
  turnsBySession: Map<string, TimelineEntry[]>,
  signalsBySession: Map<string, SpanSignals>,
): InteractionFact[] {
  const out: InteractionFact[] = [];
  for (const [sid, prompts] of promptsBySession) {
    const turns = turnsBySession.get(sid) ?? [];
    const events = [...prompts, ...turns];
    seedMissingTimestamps(events);
    events.sort(compareTimeline);
    const signals = signalsBySession.get(sid) ?? { interruptionMs: [], compactBoundaryMs: [], compactSummaryMs: [] };
    let open: TimelineEntry | null = null;
    let responsePosition: SourcePosition | undefined;
    let seq = 0;
    const flush = (endTs: number) => {
      if (!open) return;
      const startTs = open.ts;
      // Lower bound is inclusive only for the first interaction; otherwise the boundary ts belongs to
      // the previous interaction (the one it ended), not this one.
      const lowerInclusive = seq === 0;
      const inSpan = (ms: number) => (lowerInclusive ? ms >= startTs : ms > startTs) && ms <= endTs;
      const interrupted = signals.interruptionMs.some(inSpan);
      const disposition: InteractionDisposition = interrupted
        ? "interrupted"
        : responsePosition
          ? "completed"
          : "incomplete";
      const compactionCount = Math.max(
        signals.compactBoundaryMs.filter(inSpan).length,
        signals.compactSummaryMs.filter(inSpan).length,
      );
      out.push({
        id: createFactId("interaction", source, sid, open.position),
        source,
        sourceSessionId: sid,
        seq: seq++,
        initiator: open.initiator ?? "human",
        disposition,
        compactionCount,
        timestampMs: open.ts,
        promptPosition: open.position,
        ...(responsePosition ? { responsePosition } : {}),
        position: open.position,
      });
      open = null;
      responsePosition = undefined;
    };
    for (const event of events) {
      if (event.kind === "prompt") {
        flush(event.ts);
        open = event;
        responsePosition = undefined;
      } else if (open && !event.folded) {
        // Only the interaction's own (non-folded) turns are the response — a folded subagent turn is
        // loop content, and must not become the parent interaction's response slot.
        responsePosition = event.position;
      }
    }
    flush(Number.POSITIVE_INFINITY);
  }
  return out;
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
  /** Per-invocation-fact result-token sums (#130): the call+result unit's result size, folded onto
   *  the call here so it rides inside the message record and lands on resolved_invocations. */
  resultTokensByInvocationFactId?: Map<string, number>,
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
  const resultTokens = resultTokensByInvocationFactId?.get(invocation.id);
  if (resultTokens) toolUse.approxResultTokens = resultTokens;
  return toolUse;
}

/** A fact that carries the fields the global reconciliation order needs. */
type OrderableFact = {
  timestampMs?: number;
  source: AgentSource;
  sourceSessionId: string;
  position: SourcePosition;
  id: string;
};

/** Sort facts by the canonical global timeline order (a missing timestamp sorts as 0). */
function orderedByReconciliation<T extends OrderableFact>(facts: T[]): T[] {
  const key = (fact: T) => ({
    timestampMs: fact.timestampMs ?? 0,
    source: fact.source,
    sourceSessionId: fact.sourceSessionId,
    position: fact.position,
    stableId: fact.id,
  });
  return facts.sort((a, b) => compareReconciliationOrder(key(a), key(b)));
}

const orderedMessages = (fragments: ParsedFileFragment[]) =>
  orderedByReconciliation(fragments.flatMap((fragment) => fragment.facts.messages));
const orderedPrompts = (fragments: ParsedFileFragment[]): PromptFact[] =>
  orderedByReconciliation(fragments.flatMap((fragment) => fragment.facts.prompts ?? []));
const orderedTasks = (fragments: ParsedFileFragment[]): TaskFact[] =>
  orderedByReconciliation(fragments.flatMap((fragment) => fragment.facts.tasks ?? []));

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
  // Interruption/compaction timestamps are also bucketed per session (boundary and summary kept
  // apart, since one compaction emits both) so interaction derivation can set disposition=interrupted
  // / compactionCount per span (#117).
  const signalsBySession = new Map<string, SpanSignals>();
  const spanSignalsFor = (sid: string): SpanSignals => {
    let signals = signalsBySession.get(sid);
    if (!signals) {
      signals = { interruptionMs: [], compactBoundaryMs: [], compactSummaryMs: [] };
      signalsBySession.set(sid, signals);
    }
    return signals;
  };
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
          if (event.timestampMs == null) continue;
          if (event.kind === "interruption") spanSignalsFor(sid).interruptionMs.push(event.timestampMs);
          else if (event.kind === "compact_boundary") spanSignalsFor(sid).compactBoundaryMs.push(event.timestampMs);
          else if (event.kind === "compact_summary") spanSignalsFor(sid).compactSummaryMs.push(event.timestampMs);
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
  // tool_use_id (scoped to its source session) -> invocation fact, for correlating a result back to
  // its call when the producer didn't already resolve it (resolvedInvocationFactId absent).
  const invocationByScopedId = new Map<string, ParsedFileFragment["facts"]["invocations"][number]>();
  for (const invocation of fragments.flatMap((fragment) => fragment.facts.invocations)) {
    const list = invocationByMessage.get(invocation.messageId) ?? [];
    list.push(invocation);
    invocationByMessage.set(invocation.messageId, list);
    invocationByFactId.set(invocation.id, invocation);
    if (invocation.invocationId) {
      invocationByScopedId.set(`${invocation.sourceSessionId}\0${invocation.invocationId}`, invocation);
    }
  }

  // The result half of each call+result unit (#130): fold every tool result's approx token weight
  // onto the call it correlates to (prefer the producer-resolved fact id, else match by tool_use_id).
  // Stored on the invocation row via the message's toolUses, so per-tool result-size GROUP BYs read
  // one table. A result that resolves to no parsed call is an orphan — its tokens are dropped (the
  // call deduped away on a resumed session, lives in an unparsed sibling, etc.); we count them so the
  // pipeline can log the (usually zero) drift. resolved_tool_results, the old per-name aggregate, is gone.
  const resultTokensByInvocationFactId = new Map<string, number>();
  let orphanResultCount = 0;
  let orphanResultTokens = 0;
  for (const result of fragments.flatMap((fragment) => fragment.facts.toolResults)) {
    const sid = canonicalSessionId(result.sourceSessionId);
    if (canonicalIds && !canonicalIds.has(sid)) continue;
    const invocation =
      (result.resolvedInvocationFactId ? invocationByFactId.get(result.resolvedInvocationFactId) : undefined) ??
      (result.invocationId ? invocationByScopedId.get(`${result.sourceSessionId}\0${result.invocationId}`) : undefined);
    if (!invocation) {
      orphanResultCount += 1;
      orphanResultTokens += result.approxTokens;
      continue;
    }
    resultTokensByInvocationFactId.set(
      invocation.id,
      (resultTokensByInvocationFactId.get(invocation.id) ?? 0) + result.approxTokens,
    );
  }

  const messages: MessageRecord[] = [];
  const turnsBySession = new Map<string, TimelineEntry[]>();
  const seenProviderMessages = new Set<string>();
  for (const fact of orderedMessages(fragments)) {
    if (caps.dedupeByProviderMessageId && fact.providerMessageId) {
      if (seenProviderMessages.has(fact.providerMessageId)) continue;
      seenProviderMessages.add(fact.providerMessageId);
    }
    const sessionId = canonicalSessionId(fact.sourceSessionId);
    if (!wanted(sessionId)) continue;
    // Surviving (deduped) assistant turn on the timeline — an input to interaction derivation (#117).
    // `folded` marks a turn whose own session canonicalizes to a different (parent) session — a
    // subagent turn folded into the parent: loop content, never the parent's response slot.
    pushInto(turnsBySession, sessionId, {
      sid: sessionId,
      kind: "turn",
      ts: fact.timestampMs,
      position: fact.position,
      folded: fact.sourceSessionId !== sessionId,
    });
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
      .map((invocation) => toolUseFromInvocation(invocation, resultTokensByInvocationFactId));
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

  // Interaction openings (#117): a prompt opens an interaction in its *own* session. A prompt whose
  // session canonicalizes to a different (parent) session is a folded subagent prompt — loop content
  // of the parent, never an opening (this is what stops subagent prompts becoming phantom
  // interactions, #118). A non-folded subagent session (e.g. gemini, which doesn't canonicalize)
  // keeps its own agent-initiated openings. Dedupe replays by (session, replay-stable key).
  const promptsBySession = new Map<string, TimelineEntry[]>();
  const seenPrompts = new Set<string>();
  for (const prompt of orderedPrompts(fragments)) {
    const sid = canonicalSessionId(prompt.sourceSessionId);
    if (sid !== prompt.sourceSessionId) continue; // folded subagent prompt → loop content, not an opening
    if (!wanted(sid)) continue;
    const key = `${sid}\0${prompt.dedupKey ?? `${prompt.position.originKey}:${prompt.position.recordIndex}:${prompt.position.itemIndex}`}`;
    if (seenPrompts.has(key)) continue;
    seenPrompts.add(key);
    pushInto(promptsBySession, sid, {
      sid,
      kind: "prompt",
      ts: prompt.timestampMs ?? 0,
      position: prompt.position,
      initiator: prompt.initiator,
    });
  }
  const interactions = deriveInteractions(
    fragments[0]?.parser.source ?? ("claude" as AgentSource),
    promptsBySession,
    turnsBySession,
    signalsBySession,
  );

  return {
    messages,
    sessions,
    // Per-tool result-size totals are not built here anymore (#130): result tokens ride on each
    // call (toolUses[].approxResultTokens) and land on resolved_invocations; readResolved derives
    // the per-tool map from that table. Left empty so the in-memory result stays a valid ParseResult.
    toolResults: new Map<string, ToolResultStat>(),
    tasksBySession,
    interactions,
    orphanResultCount,
    orphanResultTokens,
  };
}

export type { AgentSource };
