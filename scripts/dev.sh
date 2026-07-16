#!/usr/bin/env bash
#
# Local development: run the API server and the web dev server together, with
# changes reflected automatically.
#
#   - API server (`argus serve`) runs under `bun --watch`, so editing anything
#     under src/ restarts it with the new code.
#   - Web app runs on the Vite dev server with hot-module reload, so editing
#     anything under web/ updates the browser instantly.
#
# Open the app at the Vite URL it prints. Both the API and Vite ports are picked at random (free
# ports) by default, so you can run several dev servers at once without collisions. Vite proxies
# /api to the API server, so the two talk to each other.
#
# By default the store + config are localized to this worktree's ./tmp (via ARGUS_HOME), so each
# worktree has its own isolated data; set ARGUS_HOME (or ARGUS_DATA_DIR/ARGUS_CONFIG_DIR) to override.
#
# Usage:
#   bun run dev            # or: ./scripts/dev.sh   (random free ports, store under ./tmp)
#   bun run dev --port 5173       # pin the web (Vite) port so its URL stays stable
#   WEB_PORT=5173 bun run dev     # same, via env var
#   ARGUS_PORT=4300 bun run dev   # pin the API port instead of picking one at random
#   ARGUS_HOME=~/.argus bun run dev   # use a shared store/config instead of the worktree's ./tmp
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Optional --port <n> (or --port=<n>) pins the web (Vite) port — the URL you open. It wins over the
# WEB_PORT env var; without either, a random free port is chosen. Other args are ignored.
WEB_PORT_FLAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port) WEB_PORT_FLAG="${2:-}"; shift 2 ;;
    --port=*) WEB_PORT_FLAG="${1#*=}"; shift ;;
    --) shift ;;
    *) shift ;;
  esac
done

# Ask the OS for a free TCP port (bind to :0, read the assigned port, release it). There's a tiny
# window between releasing and re-binding, but with random ports collisions are vanishingly rare.
find_free_port() {
  bun -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'
}

# API port. Defaults to a random free port so multiple dev servers coexist; pin it with ARGUS_PORT.
# Vite reads ARGUS_PORT to know where to proxy /api, so keep them in sync.
PORT="${ARGUS_PORT:-$(find_free_port)}"
export ARGUS_PORT="$PORT"

# Localize Argus's store + settings to this worktree's ./tmp by default, so each worktree's dev
# server gets its own isolated data and config (and `rm -rf tmp` resets it). ARGUS_HOME puts the
# store under $ARGUS_HOME/data and config under $ARGUS_HOME/config. Override by setting ARGUS_HOME
# (or the granular ARGUS_DATA_DIR/ARGUS_CONFIG_DIR vars, which win over it) in your shell.
export ARGUS_HOME="${ARGUS_HOME:-$ROOT/tmp}"

# Surface the locations the server will actually use — these are inherited from your shell and are
# captured at launch (bun --watch restarts on file changes, not env changes), so if you change one,
# restart this script. Mismatches here (e.g. a store built under a different CLAUDE_CONFIG_DIR)
# are the usual cause of "the title/tasks are wrong".
echo "→ ARGUS_HOME:        $ARGUS_HOME  (store → \$ARGUS_HOME/data, config → \$ARGUS_HOME/config)"
echo "→ CLAUDE_CONFIG_DIR: ${CLAUDE_CONFIG_DIR:-(unset → ~/.claude)}"
echo "→ ARGUS_DATA_DIR:    ${ARGUS_DATA_DIR:-(unset → \$ARGUS_HOME/data)}"
echo "→ ARGUS_CONFIG_DIR:  ${ARGUS_CONFIG_DIR:-(unset → \$ARGUS_HOME/config)}"

# Refuse to start if the API port is already taken. Otherwise the API server can't bind, Vite still
# starts, and it proxies /api to whatever stale server already owns the port — so you'd debug a ghost
# with the wrong env/data (exactly the trap that hid a CLAUDE_CONFIG_DIR mismatch).
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✗ Port $PORT is already in use — stop the other server or set ARGUS_PORT=<n>." >&2
  echo "  In use by PID(s): $(lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN | tr '\n' ' ')" >&2
  exit 1
fi

echo "→ API server:  http://localhost:$PORT  (restarts on src/ changes)"
bun --watch run src/cli.ts serve --port "$PORT" &
API_PID=$!

_cleaned_up=""
cleanup() {
  # Guard against running twice: Ctrl-C fires the INT trap, which then exits and fires the EXIT trap.
  [ -n "$_cleaned_up" ] && return
  _cleaned_up=1
  echo
  echo "Shutting down dev servers…"
  # SIGKILL, not TERM: `bun --watch` ignores SIGTERM, so a polite kill leaves it (and the port) alive,
  # turning the next run into the ghost-server case above. Kill its children first, then the wrapper,
  # then anything still on our port (pre-flight ensured it was free, so it's ours).
  pkill -9 -P "$API_PID" 2>/dev/null || true
  kill -9 "$API_PID" 2>/dev/null || true
  lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
}
# EXIT does the cleanup (covers every exit path). INT/TERM exit cleanly so Ctrl-C ends with status 0
# instead of 130 — stopping the dev server is a normal exit, not an error.
trap cleanup EXIT
trap 'exit 0' INT TERM

# Wait until the API is actually listening before starting Vite, so the proxy never points at a dead
# or stale server. Bail clearly if the API exits before binding (e.g. a compile error).
for _ in $(seq 1 60); do
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "✗ API server exited before binding $PORT (see errors above)." >&2; exit 1; }
  sleep 0.25
done

# Web (Vite) port: --port flag wins, then WEB_PORT env, else a random free port so several web dev
# servers can run side by side.
WEB_PORT="${WEB_PORT_FLAG:-${WEB_PORT:-$(find_free_port)}}"
WEB_URL="http://localhost:$WEB_PORT"
echo "→ Web server:  $WEB_URL  (Vite, hot reload)"

# Open the app in the browser once Vite is actually listening. Backgrounded so it doesn't block the
# foreground Vite process; it polls the web port (which we picked free, so Vite binds it exactly) and
# gives up after ~15s if the server never comes up.
(
  for _ in $(seq 1 60); do
    lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1 && { open "$WEB_URL"; break; }
    sleep 0.25
  done
) &

# Foreground: Ctrl-C stops Vite, and the trap above stops the API server too.
bun run dev:web -- --port "$WEB_PORT"
