# Secret scanning: finding exposed credentials in sessions

Users paste real credentials into agent sessions — API keys, tokens, `.env` contents, private key
blocks — and that text sits in local transcripts indefinitely. The secret scanner (#327) is a cheap,
deterministic pass that flags sessions whose text looks like it contains a credential, so the user
knows to rotate it (and knows before that session's data is shared).

Two properties dominate the design:

1. **A finding never contains the secret.** Not the value, not enough of it to reconstruct the
   value. A finding is a category, a location, and a short redacted hint.
2. **Local-only.** Findings are never uploaded by `sync` — the same structural guarantee retained
   conversation text gets (`push.ts` never reads the table, so findings stay off the wire by
   construction, not by a strip step).

## What runs where

The scanner engine (`src/indexing/secret-scan.ts`) is pure regex plus per-rule entropy checks — no
LLM call, no network, no throttle — over rules defined in `src/indexing/secret-scan-rules.ts`
(adapted from gitleaks). It runs **inline at materialize time**, inside `toMaterializeSessions` in
`src/indexing/pipeline.ts`, over the reconciled interactions' in-memory prompt/response text. That
placement was chosen over a drain (like interpret) for two reasons:

- It's cheap enough to run on every materialized session, so there's nothing to throttle.
- It scans text *in memory*, so it works even when conversation-text retention (`retainText`) is
  off — a drain reading `resolved_interaction_text` back from the store would find nothing there.

Scope is deliberately the same text the Interpret stage reads (`prompt`/`response` chunks), per the
issue's sketch. Tool *result* text (e.g. the output of `cat .env`) is not covered: it is never
retained anywhere in the read model today, so there is nothing to scan at write time. Covering it
would mean plumbing result text through the pipeline; that's a possible follow-up, not v1.

## The rule set

The detection rules come from **gitleaks**
([config/gitleaks.toml](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml), MIT
licensed) rather than being invented here: anchored, well-known credential shapes — AWS access keys
(`AKIA`/`ASIA`/`ABIA`/`ACCA`), GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`),
Anthropic (`sk-ant-api03-`/`sk-ant-admin01-`), OpenAI (`sk-…T3BlbkFJ…` and `sk-proj-`/…), Stripe
(`sk_`/`rk_` `test`/`live`/`prod`), Slack (`xoxb`/`xoxp`/`xoxe`/`xapp`), PEM private-key blocks,
JWTs, and a guarded generic `KEY=value` rule.

The rules live in **`src/indexing/secret-scan-rules.ts`, a data-only file** (patterns, entropy
floors, allowlists, stopwords — no matching logic), with full attribution and a pinned upstream
commit; the scanner engine in `secret-scan.ts` consumes it. That separation is deliberate: a
rule-set refresh is a data edit against upstream, not a logic change, and the file documents the
update procedure.

Matching follows gitleaks' semantics: capture group 1 is the secret when a rule has one, each rule
carries its own entropy floor, and regex allowlists / stopwords drop candidates (gitleaks'
`[[rules.allowlists]]` and `stopwords`). Each allowlist keeps gitleaks' `regexTarget`, which is
load-bearing: the key-shape suppressions match the key *name*, so they are tested against the whole
match, not the extracted value. The generic rule is where false positives live, so it keeps
gitleaks' guards — entropy 3.5, an allowlist of non-secret key shapes (e.g. `bucket_key`,
`api_version`, `csrf_token`), and a stopword core — on top of the anchored assignment shape.
Precision beats recall: a missed obfuscated key costs little; a crying-wolf banner erodes the
warning.

Each match stores:

- `category` — the credential kind (a controlled vocabulary, plain TEXT like invocation categories).
- `interaction_seq` + `chunk_type` — which prompt or response it appeared in.
- `hint` — the redacted locator: first/last few characters (the card-statement last-4 convention,
  e.g. `AKIA…WXYZ`), or the key-type label for private keys. Generic secrets and JWTs reveal fewer
  characters because more of the value *is* the secret.

One credential is one finding: the same value pasted twice flags once, at its first location, and a
value the generic catch-all rule also matches is reported only under its precise category. Findings
are capped per session so a dumped key list can't produce unbounded rows.

## Storage and dismissal

One table, `resolved_secret_findings` (schema v24), FK-chained to `resolved_sessions` with
`ON DELETE CASCADE` like every other leaf: re-materializing a session replaces its findings
wholesale, and retracting a session removes them. Every row carries `findings_digest` — the
scanner's stable hash of the session's whole finding set — denormalized so SQL can compare the
current set against a dismissal without a second read.

Dismissal (the "acknowledge" answer): dismissing a session's warning records the current digest on
`resolved_sessions.secret_scan_dismissed` (local-only UI state, carried forward by materialize like
`is_hidden`). A re-scan producing the same findings stays dismissed; different findings (new
content, new matches) re-warn. This is "I've seen *these* findings", not "mute this session
forever".

## What syncs

**Nothing, in v1.** `push.ts` never reads `resolved_secret_findings` or `secret_scan_dismissed`, so
findings can't cross the wire. The issue floated syncing a bare count as an org-level signal; that
is an explicit future decision, not a default. If it ever happens, the shape should be a count per
session at most — never a category-and-hint row, since even a redacted locator tells an org admin
which of a user's sessions contained a credential.

## Surfacing

- **Session detail**: a warning banner listing each finding (kind, hint, prompt vs response) with a
  Dismiss action; a dismissed banner collapses to a muted line with "Show again".
- **Session list**: a red count badge on rows with undismissed findings, plus a `flagged` filter
  (`GET /api/sessions?flagged=1`) that narrows to them. It is the one filter that shows hidden
  sessions, marked as hidden on the row: the count below includes them, so leaving them out would
  make a flagged session both counted and unreachable.
- **Recommendations** (`/api/recommendations`): an "N sessions may contain exposed credentials"
  warning that leads the list, so the signal reaches users who never open the session. It carries a
  link to the flagged list, scoped by whatever date range and source the view already had.

MCP (`/mcp`) gates findings behind the same transcript-access setting as prompt text: findings are
derived from transcript text, so agents without transcript access don't get them either.

## Rescanning

Findings re-derive on every materialize of a session, and `argus index refresh` re-reads every
transcript — so a rule-set improvement lands everywhere on the next refresh. There is no scanner
version stamp in v1 (unlike the interpreter's): the scan is deterministic and free, and a refresh
is the explicit re-run path.
