// Session-level friction signals (#37): the per-record detection and per-session fold
// shared by both parse paths (parse.ts directly, producers/claude/parser.ts via SessionFact fragments).
//
// Per-source support matrix:
// - claude: interruptions, permission rejections, compactions, turn durations, stop reasons —
//           all read from native `~/.claude/projects` JSONL records.
// - codex:  none yet. Rollout transcripts don't expose interruptions, permission prompts,
//           compaction, or turn timing in a shape Argus currently consumes.
// - gemini: none yet. Chat snapshots carry no friction markers.
// Sessions from non-Claude sources (and AgentsView imports) leave `SessionMeta.friction`
// undefined rather than reporting a misleading zero.
import { emptySessionFriction, type SessionFriction } from "./types.ts";

export type FrictionEventKind =
  | "interruption"
  | "rejection"
  | "compact_boundary"
  | "compact_summary"
  | "turn";

/** One friction occurrence, identified stably so transcript replays dedupe. */
export interface FrictionEvent {
  /**
   * Identity that survives resumed/compacted sessions re-appending records verbatim:
   * the record uuid (or the tool_use_id for rejections). Best-effort fallback when a
   * transcript predates uuids: kind + session + timestamp.
   */
  eventId: string;
  kind: FrictionEventKind;
  /** kind === "turn": wall-clock duration of the completed turn. */
  durationMs?: number;
  /** Record timestamp, when present — lets aggregation order events against messages. */
  timestampMs?: number;
}

const INTERRUPTION_MARKERS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);
const REJECTION_PREFIX = "The user doesn't want to proceed with this tool use.";

/** Text parts of a message/tool_result content value (string or content-block array). */
function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string") {
      out.push((part as any).text);
    }
  }
  return out;
}

/** Extract every friction event carried by one raw Claude JSONL record. */
export function claudeFrictionEvents(record: Record<string, any>): FrictionEvent[] {
  const events: FrictionEvent[] = [];
  const recordId = (kind: FrictionEventKind): string =>
    typeof record.uuid === "string" && record.uuid
      ? record.uuid
      : `${kind}:${record.sessionId ?? ""}:${record.timestamp ?? ""}`;
  const ts = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  const at = Number.isFinite(ts) ? { timestampMs: ts } : {};

  if (record.type === "system") {
    if (record.subtype === "turn_duration") {
      const durationMs = Number(record.durationMs);
      events.push({
        kind: "turn",
        eventId: recordId("turn"),
        ...(Number.isFinite(durationMs) ? { durationMs } : {}),
        ...at,
      });
    } else if (record.subtype === "compact_boundary") {
      events.push({ kind: "compact_boundary", eventId: recordId("compact_boundary"), ...at });
    }
    return events;
  }

  if (record.type !== "user") return events;

  if (record.isCompactSummary === true) {
    events.push({ kind: "compact_summary", eventId: recordId("compact_summary"), ...at });
  }

  const content = record.message?.content;
  if (textParts(content).some((text) => INTERRUPTION_MARKERS.has(text.trim()))) {
    events.push({ kind: "interruption", eventId: recordId("interruption"), ...at });
  }

  if (Array.isArray(content)) {
    for (const [itemIndex, part] of content.entries()) {
      if (!part || part.type !== "tool_result") continue;
      const text = textParts(part.content)[0] ?? "";
      if (!text.startsWith(REJECTION_PREFIX)) continue;
      events.push({
        kind: "rejection",
        eventId:
          typeof part.tool_use_id === "string" && part.tool_use_id
            ? part.tool_use_id
            : `${recordId("rejection")}:${itemIndex}`,
        ...at,
      });
    }
  }
  return events;
}

/**
 * Fold deduped events into per-session counters. Pass the session's full event list:
 * compactions resolve to max(boundary records, summary records) because one compaction
 * may write either marker shape or both, and counting both would double it.
 */
export function foldFrictionEvents(events: Iterable<FrictionEvent>): SessionFriction {
  const friction = emptySessionFriction();
  let boundaries = 0;
  let summaries = 0;
  for (const event of events) {
    switch (event.kind) {
      case "interruption":
        friction.interruptions++;
        break;
      case "rejection":
        friction.rejections++;
        break;
      case "compact_boundary":
        boundaries++;
        break;
      case "compact_summary":
        summaries++;
        break;
      case "turn":
        friction.turns++;
        if (typeof event.durationMs === "number") friction.turnDurationsMs.push(event.durationMs);
        break;
    }
    if (event.kind === "interruption" && typeof event.timestampMs === "number") {
      friction.lastInterruptionMs = Math.max(friction.lastInterruptionMs ?? -Infinity, event.timestampMs);
    }
  }
  friction.compactions = Math.max(boundaries, summaries);
  return friction;
}
