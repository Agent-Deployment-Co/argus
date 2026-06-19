// The shared, format-agnostic dialogue model. The actual reconstruction is owned by each producer
// (NativeProducer.reconstructDialogue) because the transcript file format is a producer-level concern
// — Claude/Cowork nest under message.content, Codex wraps in payload, Gemini replays an append-only
// log. This module holds only what every source agrees on: the turn shape and time-based slicing.
//
// The reconstructed dialogue is an in-memory analysis intermediate fed to the two-pass task pipeline
// (#91). It is built, consumed, and discarded — NO message text is ever persisted to the store.

/** One turn of reconstructed dialogue. Timestamps align it with the reconciled message timeline. */
export interface DialogueTurn {
  role: "user" | "assistant";
  text: string;
  timestampMs?: number;
}

/** Build a turn, trimming text and dropping empties / non-finite timestamps. Producers use this so
 *  the turn shape stays consistent without each re-implementing the trimming rules. */
export function dialogueTurn(
  role: DialogueTurn["role"],
  text: string,
  timestampMs?: number,
): DialogueTurn | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return {
    role,
    text: trimmed,
    ...(timestampMs != null && Number.isFinite(timestampMs) ? { timestampMs } : {}),
  };
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
