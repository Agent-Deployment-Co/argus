#!/usr/bin/env bash
# Stage the compiled `argus` CLI and the built web app where the Tauri desktop shell expects them:
#   - desktop/src-tauri/binaries/argus-<target-triple>   (Tauri `externalBin` sidecar)
#   - desktop/src-tauri/web/                              (Tauri bundled `resources`)
#
# Flags (may be combined):
#   --build      Compile the CLI binary/binaries before staging.
#   --universal  Cross-compile for both macOS arches, stage each as its own
#                arch-specific binary, and lipo them into argus-universal-apple-darwin.
#                All three are required for `tauri build --target universal-apple-darwin`.
#                Implies --build.
#   --target <triple>  Compile and stage a sidecar for the given Rust target.
#                      Supports x86_64-pc-windows-msvc and aarch64-pc-windows-msvc.
#
# Without --universal the host triple is used (local dev default).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

build=false
universal=false
target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --build)     build=true; shift ;;
    --universal) universal=true; build=true; shift ;;
    --target)
      target="${2:-}"
      build=true
      shift 2
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [ -n "$target" ] && [ "$target" != "x86_64-pc-windows-msvc" ] && [ "$target" != "aarch64-pc-windows-msvc" ]; then
  echo "unsupported desktop sidecar target: $target" >&2
  exit 1
fi

if $universal && [ -n "$target" ]; then
  echo "--universal and --target cannot be used together" >&2
  exit 1
fi

mkdir -p desktop/src-tauri/binaries

if $universal; then
  bun run build:web
  arm="desktop/src-tauri/binaries/argus-aarch64-apple-darwin"
  x64="desktop/src-tauri/binaries/argus-x86_64-apple-darwin"
  uni="desktop/src-tauri/binaries/argus-universal-apple-darwin"
  echo "Cross-compiling for aarch64-apple-darwin…"
  bun build --compile --target=bun-darwin-arm64 src/cli.ts --outfile "$arm"
  echo "Cross-compiling for x86_64-apple-darwin…"
  bun build --compile --target=bun-darwin-x64  src/cli.ts --outfile "$x64"
  echo "Creating universal binary with lipo…"
  lipo -create -output "$uni" "$arm" "$x64"
  echo "Staged sidecars -> desktop/src-tauri/binaries/argus-{aarch64,x86_64,universal}-apple-darwin"
else
  if $build; then
    if [ -n "$target" ]; then
      bun run build:web
    else
      bun run build:compile
    fi
  fi

  binsrc="dist/argus"
  if [ -n "$target" ]; then
    case "$target" in
      x86_64-pc-windows-msvc)
        bun_target="bun-windows-x64"
        binsrc="desktop/src-tauri/binaries/argus-${target}.exe"
        ;;
      aarch64-pc-windows-msvc)
        bun_target="bun-windows-arm64"
        binsrc="desktop/src-tauri/binaries/argus-${target}.exe"
        ;;
    esac
    echo "Cross-compiling sidecar for ${target}…"
    bun build --compile --target="$bun_target" src/cli.ts --outfile "$binsrc"
  fi

  if [ -z "$target" ] && [ -f "dist/argus.exe" ]; then
    binsrc="dist/argus.exe"
  fi
  if [ ! -f "$binsrc" ]; then
    echo "$binsrc not found — run 'bun run build:compile' first (or pass --build)." >&2
    exit 1
  fi

  if [ -z "$target" ]; then
    triple="$(rustc -vV | sed -n 's/host: //p')"
    if [ -z "$triple" ]; then
      echo "could not determine the Rust host target triple (is rustc installed?)." >&2
      exit 1
    fi

    ext=""
    case "$triple" in *windows*) ext=".exe" ;; esac

    cp "$binsrc" "desktop/src-tauri/binaries/argus-${triple}${ext}"
    echo "Staged sidecar -> desktop/src-tauri/binaries/argus-${triple}${ext}"
  else
    echo "Staged sidecar -> $binsrc"
  fi
fi

rm -rf desktop/src-tauri/web
cp -R dist/web desktop/src-tauri/web
echo "Staged web app -> desktop/src-tauri/web/"
