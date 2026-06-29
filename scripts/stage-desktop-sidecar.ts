#!/usr/bin/env bun
// Stage the compiled `argus` CLI and the built web app where the Tauri desktop shell expects them:
//   - desktop/src-tauri/binaries/argus-<target-triple>   (Tauri `externalBin` sidecar)
//   - desktop/src-tauri/web/                              (Tauri bundled `resources`)
//
// Flags (may be combined):
//   --build      Compile the CLI binary/binaries before staging.
//   --universal  Cross-compile for both macOS arches, stage each as its own arch-specific binary,
//                and lipo them into argus-universal-apple-darwin. All three are required for
//                `tauri build --target universal-apple-darwin`. macOS-only; implies --build.
//
// Without --universal the host triple is used (local dev default). Cross-platform (no bash needed),
// so it runs natively on Windows too.
//
// Usage: bun run scripts/stage-desktop-sidecar.ts [--build] [--universal]
import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";

const args = process.argv.slice(2);
const universal = args.includes("--universal");
const build = universal || args.includes("--build");

const BINARIES = "desktop/src-tauri/binaries";
mkdirSync(BINARIES, { recursive: true });

async function stageWeb() {
  rmSync("desktop/src-tauri/web", { recursive: true, force: true });
  cpSync("dist/web", "desktop/src-tauri/web", { recursive: true });
  console.log("Staged web app -> desktop/src-tauri/web/");
}

if (universal) {
  if (process.platform !== "darwin") {
    console.error("--universal builds a macOS universal binary and only works on macOS.");
    process.exit(1);
  }
  await $`bun run build:web`;
  const arm = `${BINARIES}/argus-aarch64-apple-darwin`;
  const x64 = `${BINARIES}/argus-x86_64-apple-darwin`;
  const uni = `${BINARIES}/argus-universal-apple-darwin`;
  console.log("Cross-compiling for aarch64-apple-darwin…");
  await $`bun build --compile --target=bun-darwin-arm64 src/cli.ts --outfile ${arm}`;
  console.log("Cross-compiling for x86_64-apple-darwin…");
  await $`bun build --compile --target=bun-darwin-x64 src/cli.ts --outfile ${x64}`;
  console.log("Creating universal binary with lipo…");
  await $`lipo -create -output ${uni} ${arm} ${x64}`;
  console.log(`Staged sidecars -> ${BINARIES}/argus-{aarch64,x86_64,universal}-apple-darwin`);
  await stageWeb();
  process.exit(0);
}

if (build) {
  await $`bun run build:compile`;
}

// build:compile writes dist/argus (dist/argus.exe on Windows, where bun appends .exe).
const binsrc = existsSync("dist/argus.exe") ? "dist/argus.exe" : "dist/argus";
if (!existsSync(binsrc)) {
  console.error(`${binsrc} not found — run 'bun run build:compile' first (or pass --build).`);
  process.exit(1);
}

// rustc is required for any Tauri build, so it's always available here.
const rustcOut = await $`rustc -vV`.text();
const triple = rustcOut.match(/^host:\s*(.+)$/m)?.[1]?.trim();
if (!triple) {
  console.error("could not determine the Rust host target triple (is rustc installed?).");
  process.exit(1);
}

const ext = process.platform === "win32" ? ".exe" : "";
const dest = `${BINARIES}/argus-${triple}${ext}`;
cpSync(binsrc, dest);
console.log(`Staged sidecar -> ${dest}`);

await stageWeb();
