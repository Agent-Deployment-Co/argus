#!/usr/bin/env bun
// Print the current version. `package.json` is the canonical source — the desktop
// `tauri.conf.json` and `Cargo.toml` are kept in sync with it by bump-version.ts.
//
// Usage: bun run scripts/get-version.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version?: string;
};

if (!pkg.version) {
  console.error("no version field in package.json");
  process.exit(1);
}

console.log(pkg.version);
