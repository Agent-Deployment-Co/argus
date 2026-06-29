#!/usr/bin/env bun
// Cross-platform desktop build orchestrator: stage the CLI sidecar + web app, then drive the local
// Tauri CLI with the right bundle target for the host OS. Replaces the old non-portable
// `cd desktop && ../node_modules/.bin/tauri …` shell snippets (which the default Windows shell can't
// run) and the macOS-only `--bundles app` hardcoding.
//
// Usage: bun run scripts/build-desktop.ts <dev|build|dmg> [-- extra tauri args]
//   dev    -> tauri dev
//   build  -> tauri build, bundling the host OS's app installer (macOS: app, Windows: nsis)
//   dmg    -> tauri build --bundles dmg   (macOS only)
//
// The TAURI_UPDATER_ARGS env var (e.g. "--config src-tauri/tauri.updater.conf.json") is forwarded to
// `tauri build` when set, mirroring the release CI.
import { $ } from "bun";

const argv = process.argv.slice(2);
const mode = argv.find((a) => !a.startsWith("-")) ?? "build";
const passthrough = argv.slice(argv.indexOf(mode) + 1);

if (!["dev", "build", "dmg"].includes(mode)) {
  console.error(`Unknown mode "${mode}". Usage: build-desktop.ts <dev|build|dmg>`);
  process.exit(1);
}
if (mode === "dmg" && process.platform !== "darwin") {
  console.error("dmg builds are macOS-only.");
  process.exit(1);
}

// Stage the host-arch sidecar + web app (compiles the CLI first).
await $`bun run scripts/stage-desktop-sidecar.ts --build`;

// Pick the bundle target for `tauri build`. dev needs none.
function bundleArgs(): string[] {
  if (mode === "dev") return [];
  if (mode === "dmg") return ["--bundles", "dmg"];
  // build:
  if (process.platform === "darwin") return ["--bundles", "app"];
  if (process.platform === "win32") return ["--bundles", "nsis"];
  return []; // Linux: let tauri.conf.json `targets` decide.
}

const updaterArgs = (process.env.TAURI_UPDATER_ARGS ?? "").split(" ").filter(Boolean);
const tauriCmd = mode === "dev" ? "dev" : "build";
const args = [tauriCmd, ...bundleArgs(), ...updaterArgs, ...passthrough];

// Run the local Tauri CLI from the desktop dir (where it finds src-tauri/). bunx resolves the
// repo's @tauri-apps/cli devDependency cross-platform — no extensionless .bin shim to exec.
await $`bunx tauri ${args}`.cwd("desktop");
