// Dialogue reconstruction: the ordered human↔assistant TEXT exchange for a transcript, assembled as
// an in-memory intermediate to feed the two-pass task analysis (#91). It is built, consumed, and
// discarded — NO message text is ever persisted to the store. The dialogue is the "what" (the user
// asked X, the agent answered Y); the invocations/skills are the "how" and are deliberately omitted.
//
// Raw transcript shapes diverge by source (Claude/Cowork nest under `message.content`, Codex wraps
// the message in `payload`, Gemini puts content top-level), so this is source-aware — but it reuses
// the same text/filter helpers as task-candidate extraction so the user half stays consistent.
import { readFileSync } from "node:fs";
import {
  hasClaudeToolResultContent,
  isClaudeGeneratedContextText,
  isCodexEnvironmentContextText,
  textFromUserContent,
} from "./task-candidates.ts";
import type { AgentSource } from "./types.ts";

/** One turn of reconstructed dialogue. Timestamps align it with the reconciled message timeline. */
export interface DialogueTurn {
  role: "user" | "assistant";
  text: string;
  timestampMs?: number;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tsOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Walk a transcript file's records, tolerant of JSONL, a single JSON object, and the legacy/$set
 *  `messages` array forms (mirrors the traversal in summarize.ts). Malformed lines are skipped. */
function forEachRecord(filePath: string, visit: (record: Record<string, unknown>) => void): void {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  const fromContainer = (value: unknown): void => {
    const values = obj(value);
    const nested = Array.isArray(values.messages)
      ? values.messages
      : Array.isArray(obj(values.$set).messages)
        ? (obj(values.$set).messages as unknown[])
        : undefined;
    if (nested) {
      for (const message of nested) visit(obj(message));
    } else {
      visit(values);
    }
  };
  try {
    fromContainer(JSON.parse(raw));
  } catch {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        fromContainer(JSON.parse(line));
      } catch {
        // skip malformed line
      }
    }
  }
}

function pushTurn(turns: DialogueTurn[], role: DialogueTurn["role"], text: string, ts?: number): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  turns.push({ role, text: trimmed, ...(ts != null ? { timestampMs: ts } : {}) });
}

function reconstructClaudeLike(filePath: string): DialogueTurn[] {
  const turns: DialogueTurn[] = [];
  const seenAssistant = new Set<string>();
  forEachRecord(filePath, (record) => {
    const message = obj(record.message);
    const content = message.content ?? record.content;
    const ts = tsOf(record.timestamp ?? record._audit_timestamp);
    if (record.type === "user") {
      if (record.isCompactSummary === true || hasClaudeToolResultContent(content)) return;
      const text = textFromUserContent(content);
      if (text && !isClaudeGeneratedContextText(text)) pushTurn(turns, "user", text, ts);
    } else if (record.type === "assistant") {
      // Resumed/compacted sessions re-append earlier assistant messages verbatim — dedupe by id.
      const id = typeof message.id === "string" ? message.id : undefined;
      if (id && seenAssistant.has(id)) return;
      if (id) seenAssistant.add(id);
      pushTurn(turns, "assistant", textFromUserContent(content), ts);
    }
  });
  return turns;
}

function reconstructCodex(filePath: string): DialogueTurn[] {
  const turns: DialogueTurn[] = [];
  forEachRecord(filePath, (record) => {
    const payload = obj(record.payload);
    if (payload.type !== "message") return;
    const ts = tsOf(record.timestamp);
    const text = textFromUserContent(payload.content);
    if (payload.role === "user") {
      if (text && !isCodexEnvironmentContextText(text)) pushTurn(turns, "user", text, ts);
    } else if (payload.role === "assistant") {
      pushTurn(turns, "assistant", text, ts);
    }
  });
  return turns;
}

function reconstructGemini(filePath: string): DialogueTurn[] {
  const turns: DialogueTurn[] = [];
  forEachRecord(filePath, (record) => {
    const content = record.content ?? obj(record.message).content;
    const ts = tsOf(record.timestamp);
    if (record.type === "user") {
      const text = textFromUserContent(content);
      if (text) pushTurn(turns, "user", text, ts);
    } else if (record.type === "gemini") {
      pushTurn(turns, "assistant", textFromUserContent(content), ts);
    }
  });
  return turns;
}

/**
 * Reconstruct the ordered human↔assistant dialogue for a transcript on disk. Returns an empty array
 * if the file can't be read. The result is an analysis intermediate — never store it.
 */
export function reconstructDialogue(source: AgentSource, filePath: string): DialogueTurn[] {
  switch (source) {
    case "claude":
    case "cowork":
      return reconstructClaudeLike(filePath);
    case "codex":
      return reconstructCodex(filePath);
    case "gemini":
      return reconstructGemini(filePath);
    default:
      return [];
  }
}

/**
 * The turns belonging to one chapter, by timestamp: those with a timestamp in [startMs, endMs).
 * `endMs` undefined means "to the end". Undated turns can't be placed and are omitted (best effort).
 */
export function sliceDialogueByTime(
  turns: DialogueTurn[],
  startMs: number,
  endMs?: number,
): DialogueTurn[] {
  return turns.filter(
    (turn) =>
      turn.timestampMs != null &&
      turn.timestampMs >= startMs &&
      (endMs == null || turn.timestampMs < endMs),
  );
}
