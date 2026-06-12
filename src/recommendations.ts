import type { Dashboard } from "./types.ts";

export type RecommendationSeverity = "tip" | "warning";

export interface Recommendation {
  /** Stable identifier — used to deduplicate and for future deep-link anchors. */
  id: string;
  severity: RecommendationSeverity;
  title: string;
  detail: string;
}

export function computeRecommendations(d: Dashboard): Recommendation[] {
  const rules: Array<(d: Dashboard) => Recommendation | null> = [
    ruleUnusedPlugins,
    ruleTokenGrowth,
    ruleHighInterruptions,
    ruleRejections,
    ruleFrequentCompactions,
    ruleUnpriced,
  ];
  return rules.map((r) => r(d)).filter((r): r is Recommendation => r !== null);
}

function ruleUnusedPlugins(d: Dashboard): Recommendation | null {
  const unused = d.byPlugin.filter((p) => p.enabled && !p.used);
  if (unused.length === 0) return null;
  const names = unused.map((p) => p.name).join(", ");
  return {
    id: "unused-plugins",
    severity: "tip",
    title: `${unused.length} plugin${unused.length > 1 ? "s" : ""} enabled but unused`,
    detail: `${names} — every enabled plugin's skills and MCP servers are included in every prompt's context. Disabling unused plugins reduces that overhead.`,
  };
}

function ruleTokenGrowth(d: Dashboard): Recommendation | null {
  const high = d.sessions.filter(
    (s) => s.health.tokenGrowth !== null && s.health.tokenGrowth >= 5,
  );
  if (high.length === 0) return null;
  const obs = d.frictionTotals.observableSessions || high.length;
  const pct = Math.round((100 * high.length) / obs);
  return {
    id: "token-growth",
    severity: high.length >= 3 ? "warning" : "tip",
    title: `${high.length} session${high.length > 1 ? "s" : ""} had rapidly growing context (≥ 5×)`,
    detail: `${pct}% of sessions saw token usage grow 5× or more from start to finish. Try using \`/compact\` earlier or breaking work into smaller sessions before context bloats.`,
  };
}

function ruleHighInterruptions(d: Dashboard): Recommendation | null {
  const { observableSessions, interruptions } = d.frictionTotals;
  if (!observableSessions || !interruptions) return null;
  const avg = interruptions / observableSessions;
  if (avg < 1) return null;
  return {
    id: "high-interruptions",
    severity: avg >= 2 ? "warning" : "tip",
    title: `${interruptions} interruptions across ${observableSessions} sessions (avg ${avg.toFixed(1)}/session)`,
    detail: `Frequent Esc presses may mean Claude is taking unexpected actions. Review your tool permissions or try more explicit prompts to reduce surprises.`,
  };
}

function ruleRejections(d: Dashboard): Recommendation | null {
  const { rejections } = d.frictionTotals;
  if (!rejections) return null;
  return {
    id: "rejections",
    severity: rejections >= 5 ? "warning" : "tip",
    title: `${rejections} tool use${rejections > 1 ? "s" : ""} rejected at the permission prompt`,
    detail: `If these were for trusted tools, consider pre-approving them (via \`settings.json\` or the permission prompt's "always allow" option) to reduce repeated interruptions.`,
  };
}

function ruleFrequentCompactions(d: Dashboard): Recommendation | null {
  const { observableSessions, compactions } = d.frictionTotals;
  if (!observableSessions || !compactions) return null;
  const rate = compactions / observableSessions;
  if (rate < 0.3) return null;
  return {
    id: "frequent-compactions",
    severity: rate >= 0.5 ? "warning" : "tip",
    title: `Context compacted in ${compactions} of ${observableSessions} sessions (${Math.round(100 * rate)}%)`,
    detail: `Sessions are regularly hitting context limits. Use \`/compact\` proactively when context grows large, or break long tasks into shorter sessions.`,
  };
}

function ruleUnpriced(d: Dashboard): Recommendation | null {
  if (!d.unpriced.length) return null;
  return {
    id: "unpriced-models",
    severity: "tip",
    title: `Cost estimates exclude ${d.unpriced.length} model${d.unpriced.length > 1 ? "s" : ""}`,
    detail: `No pricing data for: ${d.unpriced.join(", ")}. Add prices to \`~/.claude/argus-pricing.json\` for complete cost tracking.`,
  };
}
