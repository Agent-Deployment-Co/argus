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
is the primary path, chosen over a drain (like interpret) for two reasons:

- It's cheap enough to run on every materialized session, so there's nothing to throttle.
- It scans text *in memory*, so it works even when conversation-text retention (`retainText`) is
  off — a drain reading `resolved_interaction_text` back from the store would find nothing there.

Inline scanning only ever covers sessions the incremental pipeline **touched**, though, which leaves
everything already in the store unscanned. A second path closes that gap: the version-stamped
**backlog drain** (`src/indexing/secret-scan-drain.ts`). See "Rescanning" below.

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

One table, `resolved_secret_findings` (schema v24), plus one column on `resolved_sessions` recording
which scanner version last looked at each session (`secret_scan_version`, schema v25; see
"Rescanning"). The findings table is FK-chained to `resolved_sessions` with
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

- **Session detail**: a warning banner listing each finding (interaction, kind, hint, prompt vs
  response) with a Dismiss action; a dismissed banner collapses to a muted line with "Show again".
  Each listed finding is a link into the Timeline at the interaction it came from (#336).
- **Timeline**: the turn a credential appeared in carries a shield marker naming the category and
  the redacted hint, on the prompt or the response half it matched (`SessionTimeline` takes the
  session's findings as a prop — `/api/session/:id` already returns them, so there's no new
  endpoint). Three things worth knowing about the marker:
  - It doesn't need retained text. With `retainText` off the timeline shows no prompt or response
    body, and the marker still says which turn and which kind of credential — which is the part the
    user acts on.
  - It marks the **first** place a credential appeared, not every place. The scanner dedupes across
    the whole session, so a key pasted once and echoed in three later replies is one finding at its
    first location.
  - It ignores dismissal. Dismissing silences the banner ("I know about this"); the marker is an
    annotation on a turn the user navigated to on purpose, so it stays.

  The banner and the timeline are two separate fetches (`/api/session/:id` and
  `…/interactions`), so a re-index under an open tab can leave a finding pointing at an interaction
  the timeline no longer has. In the store the two can't disagree — findings and the interaction
  spine are written from the same array in one transaction — so this is a client-side staleness
  window only. A link that lands nowhere scrolls nowhere and says so
  (`unresolvedFocusNote`), rather than switching tabs and silently highlighting nothing.
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

Findings re-derive on every materialize of a session, but the incremental pipeline only materializes
**touched** sessions. Inline scanning alone would therefore mean a user who upgrades gets findings only
for sessions that happen to change afterwards, leaving their back catalogue silently never scanned. The
same gap applies to a rule-set refresh: improving `secret-scan-rules.ts` would change nothing for
sessions already in the store.

`SECRET_SCAN_VERSION` (`src/indexing/secret-scan.ts`) plus a drain closes it, mirroring how
interpretation is decoupled from the structural index (#153) without the model calls that make that
drain expensive:

- **The stamp.** `resolved_sessions.secret_scan_version` records the scanner version that last
  scanned each session; NULL means never scanned. Materialize writes it from the scan it just ran. A
  materialize that *didn't* scan writes NULL, because the wholesale replace cascades the old findings
  away and keeping the stamp would claim a scan with nothing to show. Existing rows migrate to NULL,
  which is exactly the "upgraded, never scanned" state.
- **Eligibility** (`SECRET_SCAN_ELIGIBLE_SQL` in `store.ts`, alongside `INTERPRETATION_ELIGIBLE_SQL`):
  the stamp is NULL or below the current version, **and** the session has retained text. Unlike the
  interpreter's version, this one *is* part of eligibility, since a bump is precisely how a rules
  refresh reaches already-indexed sessions.
- **The drain** (`src/indexing/secret-scan-drain.ts`, run from `runIndex` right after the structural
  index) reads each eligible session's text back via `readSessionInteractions`, rescans it, and
  replaces its findings wholesale with `writeSessionSecretFindings`. That write always stamps, even for
  an empty finding set, so a clean session de-queues. There's no rate limiter and no failure cooldown
  (nothing costs anything, nothing transient to retry), but the pass is bounded and yields every 25
  sessions so a large backlog can't make `argus run` stop responding.

Two consequences worth keeping in view:

- **Bump the version only when findings can actually change.** Dismissal is anchored to the finding-set
  digest, so a rescan that finds something different clears the dismissal by design. That's correct for
  a genuinely different finding set, but it means a gratuitous bump re-warns in bulk. The rule-refresh
  procedure in `secret-scan-rules.ts` carries this as its last step.
- **Text retention bounds what the drain can reach.** With `retainText` off (#120) a session's text only
  ever existed in memory during materialize, so there is nothing to rescan and eligibility excludes
  those sessions. Interpretation has the same limitation, so this is a known shape rather than a new
  one. The state is reported rather than silent: `secretScanProgress` counts them separately, and
  `argus status` says how many sessions can't be checked without re-reading their transcripts, which is
  what `argus index refresh` does.

`argus index refresh` remains the explicit "rescan everything now" path, and the only one that covers
sessions whose text wasn't kept. It is no longer the *only* way a rules improvement lands, though.
