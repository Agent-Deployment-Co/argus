#!/usr/bin/env bash
#
# trace-claude-p.sh — run `claude` under fs_usage and report every file it touches.
#
# `claude` is a short-lived process in headless (`-p`) mode, so we can't attach
# after it starts. This starts fs_usage, runs your `claude` command, then stops
# the tracer and prints the deduped set of files that were accessed.
#
# Modes:
#   (default)         Watch only the `claude` process itself. Lean; no firehose.
#   --with-children   Also capture the tools Claude spawns (Bash → sh/rg/git/…).
#                     Runs fs_usage system-wide and filters afterward to the set
#                     of process names Claude's process subtree actually used
#                     (discovered live via `ps -o ucomm`, the same accounting
#                     name fs_usage prints).
#
# fs_usage needs root; `claude` must run as you (so it finds your config/creds).
# The script runs as your user and uses sudo only for the tracer. You'll be
# prompted for your sudo password once.
#
# Usage:
#   ./scripts/trace-claude-p.sh -p "summarize the git log"
#   ./scripts/trace-claude-p.sh --with-children -- -p "list files"
#   ./scripts/trace-claude-p.sh --name python3 --with-children -- -p "..."
#   TRACE_OUT=/tmp/mytrace ./scripts/trace-claude-p.sh -p "hi"
#
#   # Trace the `claude` that Argus spawns during task extraction. --run launches
#   # a different program (argus) while still watching the `claude` process by
#   # name, so you get only the spawned claude's file access, not argus's:
#   ./scripts/trace-claude-p.sh --run argus -- index refresh <session-id> --extract-tasks true
#   ./scripts/trace-claude-p.sh --run bun  -- run src/cli.ts index refresh <session-id> --extract-tasks true
#
# Everything after a literal `--` (or all args once flags begin) is passed
# straight to the run target (`claude` by default, or `--run <prog>`).
#
set -euo pipefail

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
RUN_BIN=""            # program to execute (default: claude itself)
WITH_CHILDREN=0
EXTRA_NAMES=()

# Parse our own leading flags; stop at `--` or the first arg we don't own.
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --with-children) WITH_CHILDREN=1; shift ;;
    --name)          EXTRA_NAMES+=("$2"); shift 2 ;;
    --run)           RUN_BIN="$2"; shift 2 ;;
    -h|--help)       sed -n '2,44p' "$0"; exit 0 ;;
    --)              shift; break ;;
    *)               break ;;
  esac
done
: "${RUN_BIN:=$CLAUDE_BIN}"
CLAUDE_ARGS=("$@")
if [[ "${#CLAUDE_ARGS[@]}" -eq 0 ]]; then
  echo "No command arguments given. Example: $0 -p \"hello\"" >&2
  exit 1
fi

command -v "$CLAUDE_BIN" >/dev/null || { echo "claude not found on PATH ($CLAUDE_BIN)" >&2; exit 1; }
command -v "$RUN_BIN"    >/dev/null || { echo "program not found on PATH ($RUN_BIN)" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_BASE="${TRACE_OUT:-/tmp/claude-fsusage-$STAMP}"
RAW="$OUT_BASE.raw"
LIST="$OUT_BASE.files.txt"
NAMES_FILE="$OUT_BASE.names.txt"
: > "$NAMES_FILE"

# Candidate accounting names for the claude binary itself. `claude` is a symlink
# to a versioned binary, so the kernel comm may be either the symlink name or the
# resolved basename — cover both.
BASE_NAMES=("claude")
RESOLVED="$(readlink -f "$(command -v "$CLAUDE_BIN")" 2>/dev/null || true)"
[[ -n "$RESOLVED" ]] && BASE_NAMES+=("$(basename "$RESOLVED")")
printf '%s\n' "${BASE_NAMES[@]}" "${EXTRA_NAMES[@]:-}" | grep -v '^$' >> "$NAMES_FILE"

echo "Priming sudo (needed for fs_usage)…" >&2
sudo -v

cleanup() {
  local pid
  pid="$(pgrep -x fs_usage || true)"
  [[ -n "$pid" ]] && sudo kill "$pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

#   -w         wide output (don't truncate long paths)
#   -f filesys filesystem-related syscalls only (open/read/write/stat/unlink/…)
if [[ "$WITH_CHILDREN" -eq 1 ]]; then
  echo "Starting fs_usage system-wide → $RAW (will filter to Claude's subtree)" >&2
  sudo fs_usage -w -f filesys >"$RAW" 2>/dev/null &
else
  echo "Starting fs_usage for: ${BASE_NAMES[*]} → $RAW" >&2
  sudo fs_usage -w -f filesys "${BASE_NAMES[@]}" >"$RAW" 2>/dev/null &
fi

# Let fs_usage attach before launching claude, so we don't miss early opens.
sleep 0.7

echo "Running: $RUN_BIN ${CLAUDE_ARGS[*]}" >&2
echo "----------------------------------------" >&2

if [[ "$WITH_CHILDREN" -eq 1 ]]; then
  # Run claude in the background so we can poll its process subtree. It keeps the
  # terminal's stdio (job control is off in scripts), so a prompt passed as an
  # argument works normally.
  "$RUN_BIN" "${CLAUDE_ARGS[@]}" &
  CLAUDE_PID=$!

  # Recursively print the accounting name (ucomm) of a pid and all descendants.
  collect_ucomm() {
    local root=$1 d
    ps -o ucomm= -p "$root" 2>/dev/null | sed 's/^ *//;s/ *$//'
    for d in $(pgrep -P "$root" 2>/dev/null); do collect_ucomm "$d"; done
  }

  # Poll the subtree while claude runs, accumulating every process name seen.
  while kill -0 "$CLAUDE_PID" 2>/dev/null; do
    collect_ucomm "$CLAUDE_PID" >> "$NAMES_FILE" 2>/dev/null || true
    sleep 0.15
  done
  collect_ucomm "$CLAUDE_PID" >> "$NAMES_FILE" 2>/dev/null || true
  set +e
  wait "$CLAUDE_PID"
  CLAUDE_RC=$?
  set -e
else
  set +e
  "$RUN_BIN" "${CLAUDE_ARGS[@]}"
  CLAUDE_RC=$?
  set -e
fi

echo "----------------------------------------" >&2

# Let the tracer flush trailing events, then stop it.
sleep 0.5
cleanup
trap - EXIT INT TERM

# Reduce the accumulated names to a unique set.
sort -u -o "$NAMES_FILE" "$NAMES_FILE"

# fs_usage prints each event's process as a trailing  NAME.THREADID  token.
# Keep lines whose NAME is in our set, then pull the '/'-prefixed path field.
awk -v nf="$NAMES_FILE" '
  BEGIN { while ((getline n < nf) > 0) if (n != "") keep[n] = 1 }
  {
    proc = $NF
    sub(/\.[0-9]+$/, "", proc)   # strip the trailing .threadid
    if (proc in keep) print
  }
' "$RAW" 2>/dev/null \
  | grep -oE '/[^ ]+' \
  | grep -vE '\.[0-9]+$' \
  | sort -u > "$LIST" || true

COUNT="$(wc -l < "$LIST" | tr -d ' ')"
echo >&2
echo "claude exited with code ${CLAUDE_RC:-?}" >&2
if [[ "$WITH_CHILDREN" -eq 1 ]]; then
  echo "process names captured: $(paste -sd' ' "$NAMES_FILE")" >&2
fi
echo "$COUNT unique paths accessed → $LIST" >&2
echo "raw fs_usage trace           → $RAW" >&2
echo >&2
cat "$LIST"

exit "${CLAUDE_RC:-0}"
