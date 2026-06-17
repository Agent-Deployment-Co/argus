#!/usr/bin/env bash
# Stage the compiled `argus` CLI and the built web app where the Tauri desktop shell expects them:
#   - desktop/src-tauri/binaries/argus-<target-triple>   (Tauri `externalBin` sidecar)
#   - desktop/src-tauri/web/                              (Tauri bundled `resources`)
#
# Run `bun run build:compile` first (or pass --build) so dist/argus and dist/web exist. The sidecar
# is named with the Rust host target triple because Tauri resolves externalBin per target.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [ "${1:-}" = "--build" ]; then
  bun run build:compile
fi

if [ ! -x dist/argus ]; then
  echo "dist/argus not found — run 'bun run build:compile' first (or pass --build)." >&2
  exit 1
fi

triple="$(rustc -vV | sed -n 's/host: //p')"
if [ -z "$triple" ]; then
  echo "could not determine the Rust host target triple (is rustc installed?)." >&2
  exit 1
fi

ext=""
case "$triple" in *windows*) ext=".exe" ;; esac

mkdir -p desktop/src-tauri/binaries
cp dist/argus "desktop/src-tauri/binaries/argus-${triple}${ext}"

rm -rf desktop/src-tauri/web
cp -R dist/web desktop/src-tauri/web

echo "Staged sidecar -> desktop/src-tauri/binaries/argus-${triple}${ext}"
echo "Staged web app -> desktop/src-tauri/web/"
