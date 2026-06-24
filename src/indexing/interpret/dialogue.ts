// The shared, format-agnostic dialogue shape fed to pass-2 outcome judging. The dialogue is no longer
// "reconstructed" from role tags (#122): it's the projection of each task's interactions' prompt and
// response text, which reconcile carries in-memory on the interactions. This module holds only the
// turn shape both halves agree on. NO message text is ever persisted to the store.

/** One turn of the dialogue projection: a prompt (user) or response (assistant) of one interaction. */
export interface DialogueTurn {
  role: "user" | "assistant";
  text: string;
}
