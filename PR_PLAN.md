# Plan: address PR #202 code review findings

Tracks the 7 findings posted on [PR #202](https://github.com/Agent-Deployment-Co/argus/pull/202)
(desktop front-door port + reconnect UX). Grouped by area; ordered within each group by severity.

## Frontend: offline-detection consistency (`web/src/lib`)

The core problem across four findings: `sessions.ts` grew its own offline-detection idiom
(network-error catch, 502/503/504 check, bad-JSON catch) instead of extending the shared
`http.ts` helper, so it's already inconsistent within itself and untouched everywhere else.
Fix once, at the root, instead of patching each call site.

### 1. Centralize offline detection in `web/src/lib/http.ts`

- Add `OFFLINE_MESSAGE` and a `fetchOrOffline(url, init?)` helper to `http.ts` that:
  - Wraps `fetch()`, catching network errors → throws `OFFLINE_MESSAGE`.
  - Treats `502`/`503`/`504` as offline → throws `OFFLINE_MESSAGE` (this is what the proxy's
    holding page returns while the sidecar is restarting — see `desktop/src-tauri/src/proxy.rs`).
  - Returns the `Response` for the caller to `.json()`/pass to `jsonOrThrow` as before.
- Extend `jsonOrThrow` (or add a `jsonOrThrow`-compatible variant) to catch a `res.json()` parse
  failure and rethrow as `OFFLINE_MESSAGE` — this is what happens when the holding page's HTML
  lands where JSON was expected.
- This directly fixes finding **"Duplicated fetch-error idiom instead of extending the existing
  helper"** (`web/src/lib/sessions.ts:37`) by giving both `sessions.ts` functions (and everyone
  else) one implementation instead of two hand-rolled, already-diverged copies.

### 2. Route `sessions.ts` through the shared helper

- Rewrite `fetchSessions` and `fetchSessionDetail` to call `fetchOrOffline` + the extended
  `jsonOrThrow`, dropping the local `OFFLINE_MESSAGE` constant and both hand-rolled try/catch
  blocks.
- This fixes **"Missing offline handling in `fetchSessionDetail`"** (`sessions.ts:76`) by
  construction — both functions get the 502/503/504 check from the shared helper, so they can't
  drift again.

### 3. Route `snapshot.tsx` (and `settings.ts`) through the same helper

- Update `fetchSnapshot` (`snapshot.tsx:43`), `fetchSessionTaskMetrics`, `fetchDebugInfo`, and
  `reindexSession` to use `fetchOrOffline`, and `settings.ts`'s fetch functions likewise.
- Fixes **"Main dashboard fetch has none of the new offline handling"** — the dashboard landing
  page (the highest-traffic surface for a restart-window reload) gets the same friendly message
  as the Sessions screen.
- Touches a file outside the original diff (`snapshot.tsx`), which is why that finding was left
  as a general PR comment rather than inline — call this out in the PR description.

### 4. Tests

- Add/extend `web` tests (wherever `sessions.ts`/`http.ts` are currently tested, or add one) for
  `fetchOrOffline`: network-error, 502/503/504, and malformed-JSON cases all resolve to
  `OFFLINE_MESSAGE`, for both `fetchSessions`/`fetchSessionDetail` and at least one `snapshot.tsx`
  call site.

## Rust: front-door / backend port picking (`desktop/src-tauri/src/lib.rs`)

### 5. Fix the backend-port fallback colliding with the front port

- `pick_free_port()`'s `.unwrap_or(PREFERRED_FRONT_PORT)` (`lib.rs:84`) is a leftover from when
  this function picked the browser-facing port; it's now only used for the *backend* sidecar port
  (`spawn_sidecar`, `lib.rs:243`), where falling back to 4242 can collide with the front-door
  proxy already bound there.
- Fix: give `pick_free_port` its own fallback that can't collide with `PREFERRED_FRONT_PORT` —
  either drop the fallback and propagate the bind error out of `spawn_sidecar` (surfacing a
  notification instead of silently picking a doomed port), or retry `bind("127.0.0.1:0")` a
  bounded number of times before giving up. Prefer propagating the error: a silent wrong-port
  fallback is worse than a visible failed-restart notification.

### 6. Retry / surface failure when the front-door proxy fails to bind

- `pick_preferred_or_free_port` (`lib.rs:89`) probes port 4242 with a synchronous bind-then-drop,
  but the real bind happens later, asynchronously, in `proxy::start_proxy` (`proxy.rs:64`). If
  something steals the port in between, `start_proxy` just logs and returns — `front_port` in
  `AppState` is already fixed, so `open_dashboard`/`about_info` point at a dead port forever with
  no retry and no user-visible diagnostic.
- Fix: have `start_proxy`'s bind failure path retry once against `pick_free_port()` (an
  OS-assigned port) instead of giving up, and notify the user (via the existing `notify()` helper)
  with the actual URL if it had to fall back — mirroring the "Preferred front port already taken"
  edge case `PLAN.md` already describes as in-scope, just not yet wired to a failure path.
- Smaller alternative if a full retry is out of scope for this PR: at minimum, `notify()` the user
  and log at `error!` with enough detail to explain why "Open Argus" is broken, rather than only a
  log line no one will see.

## Rust: proxy holding-page correctness (`desktop/src-tauri/src/proxy.rs`)

### 7. Fix the holding-page drain to match its own doc comment

- `serve_holding_page` (`proxy.rs:111`) claims to "drain whatever the client already sent" before
  closing, but only does one bounded 1024-byte read with a 200ms timeout — a larger request body
  (e.g. a POST to `/api/sessions/:id/reindex` mid-restart) or a slow client leaves bytes unread,
  triggering the RST the comment says this code prevents.
- Fix: loop the drain read (bounded by a total deadline, e.g. `tokio::time::timeout` around the
  whole loop rather than a single read) until either the read returns `0`/`WouldBlock`-after-idle
  or the deadline elapses, so most real requests are fully drained before `shutdown()`.
- If a full generalized HTTP-body drain feels like scope creep for a "dumb TCP proxy," the cheaper
  fix is to relax the doc comment to state the actual guarantee ("best-effort for small
  single-packet requests; a bare RST is still possible for larger/slower ones") — but prefer the
  loop-until-idle fix since it's a small change and closes the gap for the documented case.

### 8. Cache the static holding-page response

- `reconnecting_response()` (`proxy.rs:50`) reformats and reallocates the same constant bytes on
  every failed connection. Replace with a `std::sync::LazyLock<Vec<u8>>` (or `OnceLock`) computed
  once at first use, and have `serve_holding_page` write the cached bytes directly.
- Low severity (cleanup/efficiency only) — bundle with #7 since both touch the same function.

## Suggested PR/commit order

1. `http.ts` shared offline helper + `sessions.ts` migration + tests (#1, #2, #4) — fixes the two
   highest-severity/most-corroborated findings in one self-contained change.
2. `snapshot.tsx`/`settings.ts` migration to the same helper (#3) — depends on #1, extends the fix
   to the dashboard landing page.
3. `pick_free_port` fallback fix (#5) — small, standalone.
4. Front-door bind-failure retry/notify (#6) — standalone, slightly larger (touches `proxy.rs` and
   `lib.rs` setup wiring).
5. Holding-page drain loop + response caching (#7, #8) — standalone, `proxy.rs`-only.

Each can land as its own commit (or PR, if #202 is already large) without blocking the others —
none of the fixes depend on one another except #2 depending on #1's helper existing.
