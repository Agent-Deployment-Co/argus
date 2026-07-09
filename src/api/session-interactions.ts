// Serve-side shaping for the session timeline (GET /api/session/:id/interactions). Turns the store's
// interaction spine into one readable unit per interaction: the user prompt, a summary of the tool
// invocations + token usage inside the loop, and the agent response. Prompt/response text is present
// only when conversation-text retention was on at index time (#120); otherwise the timeline still
// shows structure + activity. Local-only — nothing here rides the sync wire.
import type {
  InteractionDisposition,
  InteractionFact,
  InteractionInitiator,
  SessionInvocation,
} from "../store/store-contract.ts";
import { totalTokens, type MessageRecord } from "../types.ts";

/** A tool used inside an interaction's loop, with how many times it was called. */
export interface TimelineTool {
  name: string;
  count: number;
}

/** One interaction rendered for the timeline: prompt -> loop summary -> response. */
export interface TimelineInteraction {
  seq: number;
  initiator: InteractionInitiator;
  disposition: InteractionDisposition;
  timestampMs?: number;
  /** The user's opening prompt, when retained. */
  promptText?: string;
  /** The agent's final response, when retained (absent if interrupted/incomplete or not retained). */
  responseText?: string;
  /** Total tokens metered across the interaction's loop. */
  totalTokens: number;
  /** Total tool calls in the loop. */
  toolCalls: number;
  /** Per-tool call counts, busiest first. */
  tools: TimelineTool[];
  /** Distinct models used in the loop, alphabetical. */
  models: string[];
}

export interface SessionInteractionsResponse {
  interactions: TimelineInteraction[];
  /** Whether any prompt/response text is present (text retention was on at index time). When false,
   *  the timeline renders structure + activity only. */
  retainedText: boolean;
}

/** Readable label for an invocation in the loop summary: `server / tool` for MCP calls, else the raw
 *  tool name. */
function invocationLabel(inv: SessionInvocation): string {
  if (inv.mcpServer) return inv.mcpTool ? `${inv.mcpServer} / ${inv.mcpTool}` : inv.mcpServer;
  return inv.tool;
}

/** Fold the interaction spine + its per-interaction invocations and usage into timeline units. Usage
 *  and invocations attribute to an interaction through their `interactionSeq` soft-link. */
export function buildSessionInteractions(
  interactions: InteractionFact[],
  invocations: SessionInvocation[],
  messages: MessageRecord[],
): SessionInteractionsResponse {
  const tokensBySeq = new Map<number, number>();
  const modelsBySeq = new Map<number, Set<string>>();
  for (const m of messages) {
    if (m.interactionSeq == null) continue;
    tokensBySeq.set(m.interactionSeq, (tokensBySeq.get(m.interactionSeq) ?? 0) + totalTokens(m.usage));
    if (m.model) {
      let set = modelsBySeq.get(m.interactionSeq);
      if (!set) modelsBySeq.set(m.interactionSeq, (set = new Set()));
      set.add(m.model);
    }
  }

  const toolsBySeq = new Map<number, Map<string, number>>();
  for (const inv of invocations) {
    if (inv.interactionSeq == null) continue;
    let byTool = toolsBySeq.get(inv.interactionSeq);
    if (!byTool) toolsBySeq.set(inv.interactionSeq, (byTool = new Map()));
    const label = invocationLabel(inv);
    byTool.set(label, (byTool.get(label) ?? 0) + 1);
  }

  let retainedText = false;
  const out = interactions.map((it) => {
    const byTool = toolsBySeq.get(it.seq);
    const tools: TimelineTool[] = byTool
      ? [...byTool.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([name, count]) => ({ name, count }))
      : [];
    if (it.promptText?.trim() || it.responseText?.trim()) retainedText = true;
    return {
      seq: it.seq,
      initiator: it.initiator,
      disposition: it.disposition,
      ...(it.timestampMs != null ? { timestampMs: it.timestampMs } : {}),
      ...(it.promptText ? { promptText: it.promptText } : {}),
      ...(it.responseText ? { responseText: it.responseText } : {}),
      totalTokens: tokensBySeq.get(it.seq) ?? 0,
      toolCalls: tools.reduce((n, t) => n + t.count, 0),
      tools,
      models: [...(modelsBySeq.get(it.seq) ?? [])].sort(),
    } satisfies TimelineInteraction;
  });

  return { interactions: out, retainedText };
}
