#!/usr/bin/env bun
// Bump the version across all three places that track it:
//   - package.json                               (npm packages)
//   - desktop/src-tauri/tauri.conf.json          (Tauri app)
//   - desktop/src-tauri/Cargo.toml               (Rust crate)
//
// Usage: bun run scripts/bump-version.ts <new-version>
//   e.g. bun run scripts/bump-version.ts 0.2.0
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: bun run scripts/bump-version.ts <major.minor.patch>");
  process.exit(1);
}

const root = new URL("..", import.meta.url).pathname;

function updateJson(relPath: string, update: (obj: Record<string, unknown>) => void) {
  const abs = join(root, relPath);
  const obj = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
  update(obj);
  writeFileSync(abs, JSON.stringify(obj, null, 2) + "\n");
  console.log(`  ${relPath}  →  ${version}`);
}

function updateToml(relPath: string) {
  const abs = join(root, relPath);
  const original = readFileSync(abs, "utf8");
  // Only replace the [package] version line, not dependency version constraints.
  const updated = original.replace(
    /^(version\s*=\s*)"[^"]*"/m,
    `$1"${version}"`,
  );
  if (updated === original) {
    console.error(`  ${relPath}  — no version line found, skipping`);
    return;
  }
  writeFileSync(abs, updated);
  console.log(`  ${relPath}  →  ${version}`);
}

console.log(`Bumping to ${version}:`);
updateJson("package.json", (p) => { p.version = version; });
updateJson("desktop/src-tauri/tauri.conf.json", (p) => { p.version = version; });
updateToml("desktop/src-tauri/Cargo.toml");
