#!/usr/bin/env bash
#
# watch-files-fsusage.sh — live-monitor filesystem access to a set of paths.
#
# fs_usage reports every filesystem-related syscall on the machine but can't
# filter by path itself, so this wraps it: it runs fs_usage system-wide and
# greps the live stream for the paths listed in a patterns file.
#
# The patterns file is one path (or path fragment) per line; matching is
# fixed-string (grep -F), so each line matches wherever it appears in the
# fs_usage output. Blank lines and lines starting with '#' are ignored.
#
# NOTE: this repo is public. The watch list is intentionally NOT stored in the
# repo, because it can contain personal absolute paths. Keep your patterns file
# outside the repo and point at it with -f or $ARGUS_WATCH_PATHS.
#
# Requires root (fs_usage does). Ctrl-C to stop.
#
# Usage:
#   sudo ./scripts/watch-files-fsusage.sh -f /path/to/watched-paths.txt
#   sudo ARGUS_WATCH_PATHS=/path/to/watched-paths.txt ./scripts/watch-files-fsusage.sh
#   sudo ./scripts/watch-files-fsusage.sh -f list.txt -p node   # scope to a process
#   sudo ./scripts/watch-files-fsusage.sh /path/a /path/b       # ad-hoc paths as args
#
set -euo pipefail

PATTERNS_FILE="${ARGUS_WATCH_PATHS:-}"
PROC=""            # optional: restrict fs_usage to this process name/pid
ARG_PATHS=()

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -f|--file)    PATTERNS_FILE="$2"; shift 2 ;;
    -p|--process) PROC="$2"; shift 2 ;;
    -h|--help)    sed -n '2,30p' "$0"; exit 0 ;;
    *)            ARG_PATHS+=("$1"); shift ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "fs_usage needs root. Re-run with: sudo $0 $*" >&2
  exit 1
fi

# Assemble grep -F patterns: from the patterns file and/or ad-hoc args.
TMP_PAT="$(mktemp)"
trap 'rm -f "$TMP_PAT"' EXIT

if [[ -n "$PATTERNS_FILE" ]]; then
  if [[ ! -r "$PATTERNS_FILE" ]]; then
    echo "Patterns file not readable: $PATTERNS_FILE" >&2
    exit 1
  fi
  grep -vE '^\s*(#|$)' "$PATTERNS_FILE" >> "$TMP_PAT"
fi
for p in "${ARG_PATHS[@]:-}"; do
  [[ -n "$p" ]] && printf '%s\n' "$p" >> "$TMP_PAT"
done

COUNT="$(wc -l < "$TMP_PAT" | tr -d ' ')"
if [[ "$COUNT" -eq 0 ]]; then
  echo "No paths to watch. Pass -f <file> (or \$ARGUS_WATCH_PATHS) and/or paths as args." >&2
  exit 1
fi

echo "Watching $COUNT pattern(s) via fs_usage${PROC:+ (process: $PROC)}. Ctrl-C to stop." >&2
echo "  patterns file: ${PATTERNS_FILE:-<none>}" >&2
echo >&2

# -w  wide output (keeps long absolute paths from being truncated)
# -f filesys  restrict to filesystem-related syscalls (open/read/write/stat/unlink/…)
# Trailing $PROC (if any) scopes fs_usage to one process; omit to watch everything.
# grep -F --line-buffered -f: fixed-string match against the assembled pattern list.
fs_usage -w -f filesys ${PROC:+"$PROC"} | grep --line-buffered -F -f "$TMP_PAT"
