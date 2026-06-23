import type { MessageRecord } from "../../types.ts";

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** The session facts `heuristicSummary` consumes. */
export interface SummaryFacts {
  firstPrompt: string;
  topSkills: string[];
  toolCounts: Record<string, number>;
  filesTouched: string[];
}

/** Derive the summary facts from a session's messages: skills and touched files in first-appearance
 *  order, per-tool call counts. Shared by the dashboard summary pass (dashboard-builder.ts) and the
 *  on-demand /api/session/:id detail (api/session-list.ts) so both produce an identical summary for
 *  the same session — `heuristicSummary` joins `topSkills` verbatim, so the derivation must not drift. */
export function summaryFactsFromMessages(messages: MessageRecord[], firstPrompt: string): SummaryFacts {
  const topSkills: string[] = [];
  const toolCounts: Record<string, number> = {};
  const filesTouched: string[] = [];
  for (const m of messages) {
    if (m.attributionSkill && !topSkills.includes(m.attributionSkill)) topSkills.push(m.attributionSkill);
    for (const tu of m.toolUses) {
      toolCounts[tu.name] = (toolCounts[tu.name] || 0) + 1;
      if (tu.filePath && !filesTouched.includes(tu.filePath)) filesTouched.push(tu.filePath);
    }
  }
  return { firstPrompt, topSkills, toolCounts, filesTouched };
}

/** Free, instant summary from already-aggregated session facts. */
export function heuristicSummary(opts: SummaryFacts): string {
  const parts: string[] = [];
  if (opts.firstPrompt) parts.push(`"${truncate(opts.firstPrompt, 140)}"`);
  if (opts.topSkills.length) parts.push(`skills: ${opts.topSkills.join(", ")}`);
  const topTools = Object.entries(opts.toolCounts)
    .filter(([n]) => n !== "Skill")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([n, c]) => `${c}×${n}`);
  if (topTools.length) parts.push(topTools.join(" "));
  if (opts.filesTouched.length) parts.push(`${opts.filesTouched.length} file(s) edited`);
  return parts.join(" · ") || "(no activity recorded)";
}
