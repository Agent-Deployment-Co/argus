# Plan: stable front-door port for the desktop app

## Problem

The desktop tray app currently exposes the sidecar's dynamically-chosen port
directly to the browser: `pick_free_port()` runs once per app process
(`desktop/src-tauri/src/lib.rs:952`), the sidecar is launched with
`argus run --port <that-port>`, and `open_dashboard()` /
`about_info()` hand that same port straight to the browser / About window.

That port is stable for the life of one desktop-app process (crash-restarts
via the tray's Start action reuse it), but a full quit + relaunch of the app
always calls `pick_free_port()` again and gets a different port. Any browser
tab left open against the old port breaks with no recovery path — there's no
health-check, reconnect, or redirect logic anywhere in `web/src`, and no
channel for the Rust side to reach into an already-open tab (no deep-link
plugin, no shared state file).

## Goal

Make the URL the user bookmarks/leaves open **never change**, so a port
change on the backend is invisible to any open tab (aside from a brief
connection hiccup during the actual restart window).

## Approach: TCP-level reverse proxy at a fixed front-door port

Split "the port the browser talks to" from "the port the `argus run` sidecar
actually binds":

```
Browser tab ──► fixed front port (e.g. 4242) ──► [Rust TCP proxy] ──► current backend port ──► argus run sidecar
                (never changes)                    (Tauri process)     (may change per spawn)
```

The proxy is a dumb byte-splicer (`tokio::io::copy_bidirectional`), not an
HTTP-aware proxy — it doesn't need to parse requests, so it transparently
handles whatever the Hono server does (chunked responses, keep-alive, and any
future SSE/WebSocket upgrade) for free.

### Why this over frontend polling+redirect

A `web/src` heartbeat-and-redirect approach needs its own fixed-port
discovery endpoint to tell a stale tab where the new port is — which means
building a stable listener anyway. The proxy gets the same result with less
code and zero frontend changes: the tab's URL is simply always correct.

## Changes

### 1. `desktop/src-tauri/src/proxy.rs` (new)

- `start_proxy(front_port: u16, backend_port: Arc<AtomicU16>) -> tokio::task::JoinHandle<()>`
- Binds `TcpListener` on `127.0.0.1:{front_port}` once, for the life of the
  app (independent of sidecar start/stop/crash).
- Per accepted connection: read `backend_port.load()`, `TcpStream::connect`
  to `127.0.0.1:{backend_port}`, then `copy_bidirectional`.
- If the backend connect fails (sidecar down/restarting), write a minimal
  static HTTP/1.1 response with a short `<meta http-equiv=refresh>` /
  `setTimeout(location.reload, 1000)` page instead of just resetting the
  socket — turns "connection refused" into a self-healing "reconnecting…"
  flash instead of a browser error page. (Nice-to-have; can ship v1 without
  it and just let the browser show its native retry.)

### 2. `AppState` (`lib.rs`)

- Add `front_port: u16` (resolved once at setup, see below).
- Change `port: u16` → `backend_port: Arc<AtomicU16>` so the proxy and
  `spawn_sidecar` share a mutable cell instead of a fixed value.

### 3. `spawn_sidecar()` (`lib.rs:216-260`)

- Re-pick the backend port on **every** spawn (`pick_free_port()`), not just
  once — store it into `AppState.backend_port` before launching
  `argus run --port <new-backend-port>`. This is strictly safer (no reliance
  on the previous port still being free) and is exactly the case the proxy
  exists to absorb, so there's no longer a downside to doing it on every
  restart, not just app-launch.

### 4. Setup (`lib.rs` `.setup(...)`)

- Resolve `front_port`: try the CLI's own default (`4242`) first via a
  `pick_preferred_or_free_port(4242)` helper (same bind-to-probe trick as
  `pick_free_port`, but attempts the preferred port before falling back to
  `0`). Keeps `http://localhost:4242` working out of the box, matching
  `argus serve`/`argus run` run standalone.
- Start the proxy immediately in setup (`start_proxy(front_port, backend_port.clone())`),
  independent of whether the sidecar is running yet — so it's always up to
  show the "reconnecting" page even before first sidecar start.

### 5. `open_dashboard()` / `about_info()` (`lib.rs:328-334`, `601-619`)

- Change both to use `AppState.front_port` instead of the backend port.
  This is the only consumer-facing change — from here on nothing outside
  Rust ever sees the backend port.

### 6. No changes needed

- `src/cli.ts`, `src/api/serve.ts`, `web/src/*`: unaffected. The CLI keeps
  its existing `--port`/default-4242 behavior; the desktop app just happens
  to pass it a different port each spawn now.
- `tauri.conf.json`: no new config; both ports are resolved in Rust at
  runtime as today.

## Edge cases

- **Preferred front port (4242) already taken** (e.g. user is also running
  `argus serve` standalone): fall back to an OS-assigned free port, same as
  today's `pick_free_port()` fallback. Surface the actual URL via the About
  window/notification so the user isn't left guessing why `:4242` doesn't
  work.
- **In-flight request during a backend restart**: the open TCP connection to
  the old backend drops; the proxy's *next* accepted connection picks up the
  new backend port. A request that was in-flight at the exact moment of
  restart fails once — normal fetch/browser retry or the next user
  interaction recovers. No attempt to buffer/replay in-flight requests.
- **Sidecar takes a moment to come up after a crash-restart**: covered by
  the optional "reconnecting" holding page in the proxy (item 1); without it,
  the browser just shows its native connection-refused/retry UI until the
  new backend accepts.
- **Multiple desktop-app instances / already-running `argus serve` on 4242**:
  out of scope for this change — behavior is unchanged from today (whichever
  one binds 4242 first gets it, others fall back to a random port).

## Testing

- Manual: start the app, open the dashboard, use the tray's Stop then Start
  — confirm the same browser tab keeps working (after the brief reconnect
  window) with no new tab/URL needed.
- Manual: quit and relaunch the whole app — confirm the previously-open tab
  (pointed at the fixed front port) still works without a URL change.
- Rust integration test for `proxy.rs`: spin up two local TCP echo/HTTP
  listeners on different ports, point the proxy's `backend_port` at the
  first, verify traffic flows, then flip the atomic to the second port and
  verify new connections route there.

## Out of scope / follow-ups

- Any frontend-side reconnect/health-check UI (e.g. a banner while the proxy
  is serving its holding page) — the holding page's own auto-reload covers
  the common case; a nicer in-app banner could be a later `web/src` change.
- Single-instance enforcement / handling two desktop app processes racing
  for the same front port.
