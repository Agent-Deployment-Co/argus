// Secret-detection rule definitions (#327), adapted from gitleaks.
//
// The patterns, entropy floors, allowlists, and stopwords below are derived from the gitleaks
// default configuration:
//
//   https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml
//
// gitleaks is MIT licensed, copyright (c) 2019 Zachary Rice
// (https://github.com/gitleaks/gitleaks/blob/master/LICENSE). Rule ids and matching semantics
// (capture group 1 is the secret, per-rule entropy floor, regex/stopword allowlists) follow
// gitleaks; the regexes are adapted from RE2/TOML to JavaScript RegExp, and gitleaks' keyword
// prefilter and path allowlists are omitted (we scan session text directly, not files).
//
// ── Updating ────────────────────────────────────────────────────────────────────────────────
// This file is intentionally data-only (no matching logic) so the rules can be refreshed without
// touching the scanner. To update:
//   1. Diff the rule ids below against config/gitleaks.toml at upstream master.
//   2. For each changed rule, port `regex`, `entropy`, and any `allowlists`/`stopwords` entries.
//   3. Port regexes carefully: RE2 supports inline flags mid-pattern (e.g. `(?-i:...)`) and JS
//      does not — hoist or restructure them (see generic_secret for the pattern).
//   4. Bump PINNED_COMMIT and re-run `bun test test/secret-scan.test.ts`.
//
// Synced against gitleaks master commit:
const PINNED_COMMIT = "b58d3f102cf3"; // 2026-07-22 — https://github.com/gitleaks/gitleaks/commit/b58d3f102cf3

import type { SecretFindingCategory } from "../store/store-contract.ts";

// The generic rule's stopword core: common English words, placeholder shapes, and config prose
// that show up in assignment values without being credentials. Sourced from gitleaks' list.
const GENERIC_STOPWORDS = [
  "example",
  "sample",
  "dummy",
  "placeholder",
  "your-",
  "your_",
  "changeme",
  "change-me",
  "not-a-real",
  "not_real",
  "xxxx",
  "******",
  "process.env",
  "os.environ",
  "localhost",
  "127.0.0.1",
  "todo",
  "fixme",
  "test",
  "debug",
] as const;

/** One gitleaks `[[rules.allowlists]]` block: a candidate matching any of `regexes` is dropped.
 *  `regexTarget` picks what the regexes are tested against — `"secret"` (gitleaks' default) is the
 *  extracted value, `"match"` is the rule pattern's whole match. The distinction is load-bearing:
 *  the generic rule's suppressions are written against the key NAME (`key_name`, `csrf_token`,
 *  `public_token`, …), which only exists in the whole match, so testing them against the value
 *  alone would silently suppress nothing. */
export interface SecretRuleAllowlist {
  regexTarget?: "secret" | "match";
  regexes: RegExp[];
}

/** One detection rule. `pattern` matches a candidate; when it has a capture group, group 1 is the
 *  secret value (gitleaks' `secretGroup` convention), otherwise the whole match is. `entropy` is
 *  the minimum Shannon entropy (bits/char) the value must reach — gitleaks' per-rule `entropy`.
 *  `allowlists` drop matching candidates (gitleaks `[[rules.allowlists]]`), and `stopwords` drop
 *  any value containing one (gitleaks `stopwords`). */
export interface SecretRuleDefinition {
  id: string;
  category: SecretFindingCategory;
  pattern: RegExp;
  entropy?: number;
  allowlists?: SecretRuleAllowlist[];
  stopwords?: readonly string[];
}

// Well-known credential shapes. Patterns are gitleaks' with the trailing boundary group
// `(?:[\x60'"\s;]|\\[nr]|$)` (a RE2 idiom matching a real delimiter, an escaped newline in a
// string literal, or end-of-text) — it ports to JS unchanged.
export const SECRET_RULES: SecretRuleDefinition[] = [
  {
    // gitleaks id "aws-access-token". The `.+EXAMPLE$` allowlist keeps AWS's own documentation
    // example keys (e.g. AKIAIOSFODNN7EXAMPLE) out — those are placeholders, not leaks.
    id: "aws-access-token",
    category: "aws_access_key",
    pattern: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/g,
    entropy: 3,
    allowlists: [{ regexes: [/.+EXAMPLE$/] }],
  },
  {
    id: "github-pat",
    category: "github_token",
    pattern: /ghp_[0-9a-zA-Z]{36}/g,
    entropy: 3,
  },
  {
    id: "github-fine-grained-pat",
    category: "github_token",
    pattern: /github_pat_\w{82}/g,
    entropy: 3,
  },
  {
    id: "github-oauth",
    category: "github_token",
    pattern: /gho_[0-9a-zA-Z]{36}/g,
    entropy: 3,
  },
  {
    id: "github-app-token",
    category: "github_token",
    pattern: /(?:ghu|ghs)_[0-9a-zA-Z]{36}/g,
    entropy: 3,
  },
  {
    id: "github-refresh-token",
    category: "github_token",
    pattern: /ghr_[0-9a-zA-Z]{36}/g,
    entropy: 3,
  },
  {
    // gitleaks id "anthropic-api-key".
    id: "anthropic-api-key",
    category: "anthropic_api_key",
    pattern: /\b(sk-ant-api03-[a-zA-Z0-9_-]{93}AA)(?:[\x60'"\s;]|\\[nr]|$)/g,
  },
  {
    // gitleaks id "anthropic-admin-api-key".
    id: "anthropic-admin-api-key",
    category: "anthropic_api_key",
    pattern: /\b(sk-ant-admin01-[a-zA-Z0-9_-]{93}AA)(?:[\x60'"\s;]|\\[nr]|$)/g,
  },
  {
    // gitleaks id "openai-api-key", legacy shape (sk-…T3BlbkFJ…). The `T3BlbkFJ` marker
    // distinguishes real OpenAI keys from the shape alone, keeping precision high. gitleaks writes
    // this and the current shape as one alternation; we split them into two rules because JS regex
    // alternation is ordered — the legacy branch would otherwise shadow the current one.
    id: "openai-api-key-legacy",
    category: "openai_api_key",
    pattern: /\b(sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[\x60'"\s;]|\\[nr]|$)/g,
    entropy: 3,
  },
  {
    // gitleaks id "openai-api-key", current shape (sk-proj-/sk-svcacct-/sk-admin-).
    id: "openai-api-key",
    category: "openai_api_key",
    pattern:
      /\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58}))(?:[\x60'"\s;]|\\[nr]|$)/g,
    entropy: 3,
  },
  {
    id: "stripe-access-token",
    category: "stripe_key",
    pattern: /\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[\x60'"\s;]|\\[nr]|$)/g,
    entropy: 2,
  },
  {
    id: "slack-bot-token",
    category: "slack_token",
    pattern: /xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/g,
    entropy: 3,
  },
  {
    id: "slack-user-token",
    category: "slack_token",
    pattern: /xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}/g,
    entropy: 2,
  },
  {
    id: "slack-app-token",
    category: "slack_token",
    pattern: /xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+/gi,
    entropy: 2,
  },
  {
    id: "slack-config-access-token",
    category: "slack_token",
    pattern: /xoxe.xox[bp]-\d-[A-Z0-9]{163,166}/gi,
    entropy: 2,
  },
  {
    // gitleaks id "private-key": the BEGIN header through the matching END line. For findings we
    // never store any of the block — the hint is the key-type label extracted from the header.
    id: "private-key",
    category: "private_key",
    pattern: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----/gi,
  },
  {
    id: "jwt",
    category: "jwt",
    pattern: /\b(ey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/_-]{17,}\.(?:[a-zA-Z0-9/_-]{10,}={0,2})?)(?:[\x60'"\s;]|\\[nr]|$)/g,
    entropy: 3,
  },
  {
    // gitleaks id "generic-api-key". Upstream uses inline flag groups ((?i)…(?-i:…)), which JS
    // lacks, so the keyword alternation is written case-sensitively with explicit casings.
    id: "generic-api-key",
    category: "generic_secret",
    pattern:
      /[\w.-]{0,50}?(?:access|auth|Api|API|credential|creds|key|passw(?:or)?d|secret|token)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([\w.=-]{10,150}|[a-z0-9][a-z0-9+/]{11,}={0,3})(?:[\x60'"\s;]|\\[nr]|$)/g,
    entropy: 3.5,
    // gitleaks' "Allowlist for Generic API Keys", verbatim — two blocks with different targets.
    allowlists: [
      // Against the secret: a bare identifier/path (no digits) is never a credential.
      { regexes: [/^[a-zA-Z_.-]+$/] },
      // Against the whole match: these suppress by KEY NAME (`key_name`, `csrf_token`,
      // `public_token`, …), which lives in the match, not in the extracted value.
      {
        regexTarget: "match",
        regexes: [
          /(?:access(?:ibility|or)|access[_.-]?id|random[_.-]?access|api[_.-]?(?:id|name|version)|rapid|capital|[a-z0-9-]*?api[a-z0-9-]*?:jar:|author|X-MS-Exchange-Organization-Auth|Authentication-Results|(?:credentials?[_.-]?id|withCredentials)|(?:bucket|foreign|hot|idx|natural|primary|pub(?:lic)?|schema|sequence)[_.-]?key|(?:turkey)|key[_.-]?(?:alias|board|code|frame|id|length|mesh|name|pair|press(?:ed)?|ring|selector|signature|size|stone|storetype|word|up|down|left|right)|key[_.-]?vault[_.-]?(?:id|name)|keyVaultToStoreSecrets|key(?:store|tab)[_.-]?(?:file|path)|issuerkeyhash|(?:[DdMm]onkey)|keying|(?:secret)[_.-]?(?:length|name|size)|UserSecretsId|(?:csrf)[_.-]?token|(?:io\.jsonwebtoken[ \t]?:[ \t]?[\w-]+)|(?:api|credentials|token)[_.-]?(?:endpoint|ur[il])|public[_.-]?token|(?:key|token)[_.-]?file|(?:[A-Z_]+=\n[A-Z_]+=|[a-z_]+=\n[a-z_]+=)(?:\n|$)|(?:[A-Z.]+\n[a-z.]+=)(?:\n|$))/i,
        ],
      },
    ],
    // gitleaks' generic-api-key stopwords (trimmed to a representative core — the full upstream
    // list is ~1,400 English words; a value containing any of these is prose or code, not a key).
    stopwords: GENERIC_STOPWORDS,
  },
];
