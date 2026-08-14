// Secret scanning (#327): a cheap, deterministic pass over a session's retained prompt/response
// text that flags likely exposed credentials (pasted API keys, tokens, private key blocks). Runs at
// materialize time on the in-memory interaction text — no LLM call, no throttle, and independent of
// the retainText setting (the text is in memory at write time either way).
//
// This module is the matching ENGINE only. The detection rules (patterns, entropy floors,
// allowlists, stopwords) live in ./secret-scan-rules.ts, a data-only file adapted from gitleaks
// (https://github.com/gitleaks/gitleaks, MIT — see that file for full attribution and how to
// refresh the rules). Keeping rules separate from the engine means a rule-set update is a data
// edit, not a logic change.
//
// The cardinal rule: a finding NEVER stores the matched secret, nor enough of it to reconstruct the
// value. Only the category, the location (interaction + prompt/response slot), and a short redacted
// "hint" (industry-standard first/last characters, like a card statement's last-4) so the user can
// recognize WHICH credential it was. Findings are local-only — push.ts never reads this table, the
// same structural guarantee resolved_interaction_text gets.
//
// Precision beats recall, deliberately: a missed obfuscated key costs little, a crying-wolf banner
// erodes the warning.
import { createHash } from "node:crypto";
import type {
  InteractionFact,
  SecretFinding,
  SecretFindingCategory,
} from "../store/store-contract.ts";
import { SECRET_RULES, type SecretRuleDefinition } from "./secret-scan-rules.ts";

export type { SecretFinding, SecretFindingCategory } from "../store/store-contract.ts";

/** Cap on stored findings per session: a dumped key list shouldn't produce unbounded rows. Sessions
 *  at the cap are vanishingly rare; the banner's message doesn't change past the first few. */
const MAX_FINDINGS_PER_SESSION = 100;

/** How many characters of the matched value a hint may reveal at each end. Well-known prefixed
 *  tokens follow the card-statement last-4 convention; generic secrets and JWTs reveal less because
 *  more of the value *is* the secret; private keys reveal nothing of the block. */
const HINT_EDGES: Record<SecretFindingCategory, number> = {
  aws_access_key: 4,
  github_token: 4,
  anthropic_api_key: 4,
  openai_api_key: 4,
  stripe_key: 4,
  slack_token: 4,
  private_key: 0,
  jwt: 2,
  generic_secret: 2,
};

function redact(category: SecretFindingCategory, value: string): string {
  const edge = HINT_EDGES[category];
  if (!edge || value.length <= edge * 2) return "";
  return `${value.slice(0, edge)}…${value.slice(-edge)}`;
}

/** Shannon entropy in bits per character — gitleaks' per-rule floor against prose and code
 *  identifiers, which sit well below real credentials. */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** The private-key rule matches the whole BEGIN…END block; the hint must never carry any of it, so
 *  extract just the key-type label from the header ("RSA", "OPENSSH", …). */
function privateKeyLabel(block: string): string {
  const m = /-----BEGIN ([A-Z0-9 _-]{0,100}?PRIVATE KEY)(?: BLOCK)?-----/i.exec(block);
  return m?.[1] ? m[1].toUpperCase() : "PRIVATE KEY";
}

/** Whether a candidate survives a rule's precision guards: entropy floor, regex allowlists, and
 *  stopwords (gitleaks' semantics). Entropy and stopwords are evaluated against the extracted
 *  secret; each allowlist picks its own target, since some suppressions are written against the
 *  key name and so only exist in the whole match. */
function passesGuards(rule: SecretRuleDefinition, value: string, match: string): boolean {
  if (rule.entropy != null && shannonEntropy(value) < rule.entropy) return false;
  for (const allowlist of rule.allowlists ?? []) {
    const target = allowlist.regexTarget === "match" ? match : value;
    if (allowlist.regexes.some((re) => re.test(target))) return false;
  }
  const lower = value.toLowerCase();
  if (rule.stopwords?.some((w) => lower.includes(w))) return false;
  return true;
}

/** The catch-all generic rule overlaps every well-known shape, so run the precise rules first and
 *  let them claim the value (see `claimed` below). */
const RULES_BY_PRECISION = [...SECRET_RULES].sort(
  (a, b) => Number(a.category === "generic_secret") - Number(b.category === "generic_secret"),
);

/** State shared across one session's chunks. `seen` (keyed `${rule.id} ${value}`) makes a
 *  credential repeated in several prompts/responses flag once, at its first location; `claimed`
 *  holds the values a precise rule already matched, so the generic rule doesn't report the same
 *  credential a second time under a vaguer category. */
export interface SecretScanState {
  seen: Set<string>;
  claimed: string[];
}

export function newSecretScanState(): SecretScanState {
  return { seen: new Set(), claimed: [] };
}

/** Scan one piece of text, returning one finding per distinct credential. Callers scanning a whole
 *  session pass one `state` across every chunk; standalone callers (tests) get a fresh one. */
export function scanTextForSecrets(
  text: string,
  location: { interactionSeq: number; chunkType: "prompt" | "response" },
  state: SecretScanState = newSecretScanState(),
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of RULES_BY_PRECISION) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      // gitleaks' secretGroup convention: capture group 1 is the secret when present, else the
      // whole match (e.g. the GitHub/Slack token rules have no group).
      const value = m[1] ?? m[0];
      if (!passesGuards(rule, value, m[0])) continue;
      // `TOKEN="ghp_…"` matches both github-pat and generic-api-key: one pasted credential, which
      // must count once, under the precise category. The values need not be identical — the
      // generic rule's charset can clip a JWT short — so overlap either way counts as the same
      // credential.
      if (
        rule.category === "generic_secret" &&
        state.claimed.some((v) => v.includes(value) || value.includes(v))
      ) {
        continue;
      }
      const key = `${rule.id} ${value}`;
      if (state.seen.has(key)) continue;
      state.seen.add(key);
      if (rule.category !== "generic_secret") state.claimed.push(value);
      findings.push({
        category: rule.category,
        interactionSeq: location.interactionSeq,
        chunkType: location.chunkType,
        hint:
          rule.category === "private_key"
            ? privateKeyLabel(m[0])
            : redact(rule.category, value),
      });
    }
  }
  return findings;
}

/** Scan every retained prompt/response text of a session's interactions. One scan state spans the
 *  whole session, so the same credential pasted into two interactions yields one finding (at its
 *  first location) rather than inflating the count. Pure and synchronous — cheap enough to run
 *  inline at materialize time for every session. */
export function scanSessionForSecrets(session: {
  interactions?: Pick<InteractionFact, "seq" | "promptText" | "responseText">[];
}): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const state = newSecretScanState();
  for (const interaction of session.interactions ?? []) {
    if (interaction.promptText) {
      findings.push(
        ...scanTextForSecrets(
          interaction.promptText,
          { interactionSeq: interaction.seq, chunkType: "prompt" },
          state,
        ),
      );
    }
    if (interaction.responseText) {
      findings.push(
        ...scanTextForSecrets(
          interaction.responseText,
          { interactionSeq: interaction.seq, chunkType: "response" },
          state,
        ),
      );
    }
    if (findings.length >= MAX_FINDINGS_PER_SESSION) {
      return findings.slice(0, MAX_FINDINGS_PER_SESSION);
    }
  }
  return findings;
}

/** A stable digest of a session's finding set: what a dismissal is anchored to. When the findings
 *  change (new content, new matches), the digest changes and the warning returns. */
export function secretFindingsDigest(findings: SecretFinding[]): string {
  const canonical = findings
    .map((f) => `${f.category}${f.interactionSeq}${f.chunkType}${f.hint}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}
