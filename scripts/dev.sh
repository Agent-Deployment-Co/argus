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
# Open the app at the Vite URL it prints (default http://localhost:5173). Vite
# proxies /api to the API server, so the two talk to each other.
#
# Usage:
#   bun run dev            # or: ./scripts/dev.sh
#   ARGUS_PORT=4300 bun run dev   # use a different API port
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# API port. Vite reads ARGUS_PORT to know where to proxy /api, so keep them in sync.
PORT="${ARGUS_PORT:-4242}"
export ARGUS_PORT="$PORT"

# Dev convenience: if a local store exists at tmp/data (chapter-attributed test data for the
# task panel), use it unless the caller already pointed ARGUS_DATA_DIR somewhere. Override with
# ARGUS_DATA_DIR=... bun run dev, or delete tmp/data to fall back to the real ~/.../argus.db.
if [ -z "${ARGUS_DATA_DIR:-}" ] && [ -f "$ROOT/tmp/data/argus.db" ]; then
  export ARGUS_DATA_DIR="$ROOT/tmp/data"
  echo "→ Data store:  $ARGUS_DATA_DIR  (worktree test data)"
fi

# Surface the config dirs the server will actually use — these are inherited from your shell and are
# captured at launch (bun --watch restarts on file changes, not env changes), so if you change one,
# restart this script. Mismatches here (e.g. a tmp/data store built under a different CLAUDE_CONFIG_DIR)
# are the usual cause of "the title/tasks are wrong".
echo "→ CLAUDE_CONFIG_DIR: ${CLAUDE_CONFIG_DIR:-(unset → ~/.claude)}"
echo "→ ARGUS_DATA_DIR:    ${ARGUS_DATA_DIR:-(unset → default)}"

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

cleanup() {
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
trap cleanup EXIT INT TERM

# Wait until the API is actually listening before starting Vite, so the proxy never points at a dead
# or stale server. Bail clearly if the API exits before binding (e.g. a compile error).
for _ in $(seq 1 60); do
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "✗ API server exited before binding $PORT (see errors above)." >&2; exit 1; }
  sleep 0.25
done

echo "→ Web server:  starting Vite (hot reload)…"
# Foreground: Ctrl-C stops Vite, and the trap above stops the API server too.
bun run dev:web
