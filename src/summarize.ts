function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Free, instant summary from already-aggregated session facts. */
export function heuristicSummary(opts: {
  firstPrompt: string;
  topSkills: string[];
  toolCounts: Record<string, number>;
  filesTouched: string[];
}): string {
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
