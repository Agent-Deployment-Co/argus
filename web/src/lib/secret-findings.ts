// Shared shaping for the secret-scan findings the web app shows (#327, #336): the plain-word
// category labels, the order findings are listed in, and the per-interaction grouping the timeline
// marks turns with. Pure and framework-free, so the banner, the timeline and their tests all read a
// finding the same way.
//
// A finding records only where a credential appeared and a redacted hint — never the credential. It
// also records only the FIRST place a given credential appeared: the scanner dedupes across the
// whole session, so a key pasted once and echoed later marks the turn where it first showed up.
import type { SecretFinding } from "../types";

/** User-facing labels for the scanner's categories (plain words, not rule ids). */
export const SECRET_CATEGORY_LABELS: Record<SecretFinding["category"], string> = {
  aws_access_key: "AWS access key",
  github_token: "GitHub token",
  anthropic_api_key: "Anthropic API key",
  openai_api_key: "OpenAI API key",
  stripe_key: "Stripe key",
  slack_token: "Slack token",
  private_key: "Private key",
  jwt: "JWT",
  generic_secret: "Possible secret",
};

/** The category in plain words plus the redacted hint, e.g. "AWS access key (AKIA…WXYZ)". Shapes
 *  that can't reveal anything safely (private keys, short generic values) carry no hint. */
export function secretFindingLabel(f: SecretFinding): string {
  const label = SECRET_CATEGORY_LABELS[f.category] ?? f.category;
  return f.hint ? `${label} (${f.hint})` : label;
}

/** Which half of the interaction the credential sat in. */
export function secretFindingWhere(f: SecretFinding): string {
  return f.chunkType === "prompt" ? "in your prompt" : "in the agent's reply";
}

/** How the user counts the interaction in the timeline. `interactionSeq` is the store's 0-based
 *  ordinal, and the timeline numbers interactions from 1. */
export function interactionNumber(interactionSeq: number): number {
  return interactionSeq + 1;
}

/** One full line for the banner: where in the session, what, and in which half. */
export function secretFindingLine(f: SecretFinding): string {
  return `Interaction ${interactionNumber(f.interactionSeq)}: ${secretFindingLabel(f)} ${secretFindingWhere(f)}`;
}

/** A stable key for one finding. Category + location + hint is the tuple the store's dismissal
 *  digest is built from, so it's unique within a session's finding set. */
export function secretFindingKey(f: SecretFinding): string {
  return `${f.category}-${f.interactionSeq}-${f.chunkType}-${f.hint}`;
}

/** Finding display order (documented, per the repo's ordered-list rule): chronological by
 *  interaction, the prompt before the response within an interaction, then category and hint to
 *  break ties. The scanner emits rule-order within a chunk; the user cares about where in the
 *  session a credential appeared, so we sort here rather than trust arrival order. */
export function orderSecretFindings(findings: SecretFinding[]): SecretFinding[] {
  return [...findings].sort(
    (a, b) =>
      a.interactionSeq - b.interactionSeq ||
      (a.chunkType === b.chunkType ? 0 : a.chunkType === "prompt" ? -1 : 1) ||
      a.category.localeCompare(b.category) ||
      a.hint.localeCompare(b.hint),
  );
}

/** The findings that landed in one interaction, split by the half they landed in. */
export interface InteractionSecretFindings {
  prompt: SecretFinding[];
  response: SecretFinding[];
}

/** Group findings by the interaction they were found in so the timeline can mark each turn. Both
 *  halves come out in the display order above, and interactions with no finding are simply absent. */
export function groupSecretFindingsByInteraction(
  findings: SecretFinding[],
): Map<number, InteractionSecretFindings> {
  const byInteraction = new Map<number, InteractionSecretFindings>();
  for (const f of orderSecretFindings(findings)) {
    let entry = byInteraction.get(f.interactionSeq);
    if (!entry) byInteraction.set(f.interactionSeq, (entry = { prompt: [], response: [] }));
    entry[f.chunkType].push(f);
  }
  return byInteraction;
}
