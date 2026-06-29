#!/usr/bin/env node
"use strict";
// Local development bin for npm/npx when run from this checkout. The published package uses
// npm/launcher.cjs instead, which resolves the prebuilt platform package.
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const result = spawnSync(process.env.BUN || "bun", ["run", path.join(root, "src/cli.ts"), ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(`argus: failed to launch local source with Bun: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 0);
