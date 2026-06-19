// Per-task metric rollups, computed on demand from the messages attributed to a task
// (resolved_messages.task_seq). This is deliberately NOT part of the big snapshot — it's read
// lazily per task, the direction #69 moves the web app toward (query the store directly).
import { cost } from "./pricing.ts";
import { addUsage, emptyUsage, totalTokens, type MessageRecord, type Usage } from "./types.ts";

export interface TaskMetrics {
  /** Attributed (assistant / usage-bearing) messages in the task's chapter. Can be 0 — a task whose
   *  user turn had no following assistant reply, a tie-collapsed chapter, or a timestamp-less task. */
  messages: number;
  usage: Usage;
  totalTokens: number;
  /** USD, priced per message by that message's own model (mixed-model tasks stay correct). */
  cost: number;
  /** Total tool calls across the task's messages. */
  toolCalls: number;
  /** Per-tool call counts, highest first. */
  toolCounts: Record<string, number>;
  /** Distinct models that produced messages in the task. */
  models: string[];
}

/** Roll up metrics from the messages attributed to a single task. */
export function computeTaskMetrics(messages: MessageRecord[]): TaskMetrics {
  const usage = emptyUsage();
  const toolCounts: Record<string, number> = {};
  const models = new Set<string>();
  let totalCost = 0;
  let toolCalls = 0;

  for (const m of messages) {
    addUsage(usage, m.usage);
    totalCost += cost(m.usage, m.model);
    if (m.model) models.add(m.model);
    for (const tu of m.toolUses) {
      toolCounts[tu.name] = (toolCounts[tu.name] ?? 0) + 1;
      toolCalls++;
    }
  }

  return {
    messages: messages.length,
    usage,
    totalTokens: totalTokens(usage),
    cost: totalCost,
    toolCalls,
    toolCounts: Object.fromEntries(Object.entries(toolCounts).sort((a, b) => b[1] - a[1])),
    models: [...models],
  };
}
