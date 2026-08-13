// Secret scanning (#327): a cheap, deterministic, regex-based pass over a session's retained
// prompt/response text that flags likely exposed credentials (pasted API keys, tokens, private key
// blocks). Runs at materialize time on the in-memory interaction text — no LLM call, no throttle,
// and independent of the retainText setting (the text is in memory at write time either way).
//
// The cardinal rule: a finding NEVER stores the matched secret, nor enough of it to reconstruct the
// value. Only the category, the location (interaction + prompt/response slot), and a short redacted
// "hint" (industry-standard first/last characters, like a card statement's last-4) so the user can
// recognize WHICH credential it was. Findings are local-only — push.ts never reads this table, the
// same structural guarantee resolved_interaction_text gets.
//
// The rule set is a small, high-precision subset in the spirit of gitleaks' rules: well-known
// credential shapes with anchored prefixes, plus a guarded generic KEY=... assignment rule with an
// entropy floor and placeholder blocklist to keep false positives low enough that the warning stays
// trustworthy. Precision beats recall here — a missed obfuscated key is fine, a crying-wolf banner
// is not.
import { createHash } from "node:crypto";
import type {
  InteractionFact,
  SecretFinding,
  SecretFindingCategory,
} from "../store/store-contract.ts";

export type { SecretFinding, SecretFindingCategory } from "../store/store-contract.ts";

/** Cap on stored findings per session: a dumped key list shouldn't produce unbounded rows. Sessions
 *  at the cap are vanishingly rare; the banner's message doesn't change past the first few. */
const MAX_FINDINGS_PER_SESSION = 100;

/** How many characters of the matched value a hint may reveal at each end. Well-known prefixed
 *  tokens follow the card-statement last-4 convention; generic secrets reveal less because their
 *  whole value is the secret. */
const HINT_EDGES: Record<SecretFindingCategory, number> = {
  aws_access_key: 4,
  github_token: 4,
  anthropic_api_key: 4,
  openai_api_key: 4,
  stripe_key: 4,
  slack_token: 4,
  private_key: 0, // no substring of the block is shown; the hint names the key type instead
  jwt: 2,
  generic_secret: 2,
};

function redact(category: SecretFindingCategory, value: string): string {
  const edge = HINT_EDGES[category];
  if (!edge || value.length <= edge * 2) return "";
  return `${value.slice(0, edge)}…${value.slice(-edge)}`;
}

interface SecretRule {
  category: SecretFindingCategory;
  pattern: RegExp;
  /** Extract the canonical secret value from a match (defaults to the whole match). */
  value?: (m: RegExpExecArray) => string;
  /** Extra precision guard; return false to drop the match. */
  keep?: (value: string) => boolean;
}

/** Shannon entropy in bits per character — the generic rule's floor against prose and code
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

/** Placeholder / non-secret shapes the generic assignment rule must not flag. */
const GENERIC_PLACEHOLDER =
  /^(?:your[-_ ]?|\$\{|.*\$\{|<[^>]*>$|x+$|\*+$|change[-_ ]?me|example|sample|dummy|placeholder|process\.env\.)/i;

/** True when a generic KEY=value match looks like a real credential: long enough, high-entropy,
 *  mixes letters and digits, and isn't a recognizable placeholder or code expression. Precision
 *  over recall, deliberately. */
function looksLikeSecret(value: string): boolean {
  if (value.length < 16) return false;
  if (GENERIC_PLACEHOLDER.test(value)) return false;
  if (value.includes("..")) return false; // a path or property chain, not a token
  if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) return false;
  return shannonEntropy(value) >= 3.6;
}

// The rules. Order matters only where prefixes overlap (sk-ant-… must win over sk-…); each rule is
// applied independently, and overlapping matches are deduped by (category, hint) afterwards.
const RULES: SecretRule[] = [
  { category: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    category: "github_token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  },
  { category: "anthropic_api_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  {
    category: "openai_api_key",
    // (?!ant-) keeps Anthropic keys out of the OpenAI bucket.
    pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  { category: "stripe_key", pattern: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { category: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    category: "private_key",
    pattern: /-----BEGIN ((?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY(?: BLOCK)?)-----/g,
    value: (m) => m[1] ?? m[0],
  },
  {
    category: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
  },
  {
    category: "generic_secret",
    pattern:
      /\b(?:api[_-]?key|apikey|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd)\s*["']?\s*[:=]\s*["']?([A-Za-z0-9/_+=$.~_-]{16,})["']?/gi,
    value: (m) => m[1] ?? m[0],
    keep: looksLikeSecret,
  },
];

/** Scan one piece of text, returning one finding per distinct (category, value) match. */
export function scanTextForSecrets(
  text: string,
  location: { interactionSeq: number; chunkType: "prompt" | "response" },
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      const value = rule.value ? rule.value(m) : m[0];
      if (rule.keep && !rule.keep(value)) continue;
      // Dedupe on the value itself (via its hint) so a key pasted twice flags once; private keys
      // have no safe substring, so dedupe on category+location-free type label instead.
      const key = `${rule.category}${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        category: rule.category,
        interactionSeq: location.interactionSeq,
        chunkType: location.chunkType,
        hint:
          rule.category === "private_key"
            ? value // for private keys the "value" is the header label, e.g. "RSA PRIVATE KEY"
            : redact(rule.category, value),
      });
    }
  }
  return findings;
}

/** Scan every retained prompt/response text of a session's interactions. Pure and synchronous —
 *  cheap enough to run inline at materialize time for every session. */
export function scanSessionForSecrets(session: {
  interactions?: Pick<InteractionFact, "seq" | "promptText" | "responseText">[];
}): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const interaction of session.interactions ?? []) {
    if (interaction.promptText) {
      findings.push(
        ...scanTextForSecrets(interaction.promptText, {
          interactionSeq: interaction.seq,
          chunkType: "prompt",
        }),
      );
    }
    if (interaction.responseText) {
      findings.push(
        ...scanTextForSecrets(interaction.responseText, {
          interactionSeq: interaction.seq,
          chunkType: "response",
        }),
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
