#!/usr/bin/env bash
# Stage the compiled `argus` CLI and the built web app where the Tauri desktop shell expects them:
#   - desktop/src-tauri/binaries/argus-<target-triple>   (Tauri `externalBin` sidecar)
#   - desktop/src-tauri/web/                              (Tauri bundled `resources`)
#
# Flags (may be combined):
#   --build      Compile the CLI binary/binaries before staging.
#   --universal  Cross-compile for both macOS arches, lipo them into a universal
#                binary, and stage it as argus-universal-apple-darwin (required for
#                `tauri build --target universal-apple-darwin`). Implies --build.
#
# Without --universal the host triple is used (local dev default).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

build=false
universal=false
for arg in "$@"; do
  case "$arg" in
    --build)     build=true ;;
    --universal) universal=true; build=true ;;
  esac
done

mkdir -p desktop/src-tauri/binaries

if $universal; then
  bun run build:web
  echo "Cross-compiling for aarch64-apple-darwin…"
  bun build --compile --target=bun-darwin-arm64 src/cli.ts \
    --outfile /tmp/argus-aarch64-apple-darwin
  echo "Cross-compiling for x86_64-apple-darwin…"
  bun build --compile --target=bun-darwin-x64 src/cli.ts \
    --outfile /tmp/argus-x86_64-apple-darwin
  echo "Creating universal binary with lipo…"
  lipo -create -output desktop/src-tauri/binaries/argus-universal-apple-darwin \
    /tmp/argus-aarch64-apple-darwin /tmp/argus-x86_64-apple-darwin
  rm /tmp/argus-aarch64-apple-darwin /tmp/argus-x86_64-apple-darwin
  echo "Staged sidecar -> desktop/src-tauri/binaries/argus-universal-apple-darwin"
else
  if $build; then
    bun run build:compile
  fi

  binsrc="dist/argus"
  [ -f "dist/argus.exe" ] && binsrc="dist/argus.exe"
  if [ ! -f "$binsrc" ]; then
    echo "$binsrc not found — run 'bun run build:compile' first (or pass --build)." >&2
    exit 1
  fi

  triple="$(rustc -vV | sed -n 's/host: //p')"
  if [ -z "$triple" ]; then
    echo "could not determine the Rust host target triple (is rustc installed?)." >&2
    exit 1
  fi

  ext=""
  case "$triple" in *windows*) ext=".exe" ;; esac

  cp "$binsrc" "desktop/src-tauri/binaries/argus-${triple}${ext}"
  echo "Staged sidecar -> desktop/src-tauri/binaries/argus-${triple}${ext}"
fi

rm -rf desktop/src-tauri/web
cp -R dist/web desktop/src-tauri/web
echo "Staged web app -> desktop/src-tauri/web/"
