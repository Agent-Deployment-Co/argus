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

echo "→ API server:  http://localhost:$PORT  (restarts on src/ changes)"
bun --watch run src/cli.ts serve --port "$PORT" &
API_PID=$!

cleanup() {
  echo
  echo "Shutting down dev servers…"
  kill "$API_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "→ Web server:  starting Vite (hot reload)…"
# Foreground: Ctrl-C stops Vite, and the trap above stops the API server too.
bun run dev:web
