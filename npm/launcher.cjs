#!/usr/bin/env node
"use strict";
// Published as the `bin` of @agentdeploymentco/argus. The real CLI is a self-contained compiled
// binary that ships in a per-platform package (an optional dependency); this launcher resolves the
// one matching the current OS/arch and execs it, pointing it at that package's bundled web assets.
// node is only needed to run this shim — the binary itself bundles its own runtime.
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const pkg = `@agentdeploymentco/argus-${process.platform}-${process.arch}`;

let pkgDir;
try {
  pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
} catch {
  console.error(
    `argus: no prebuilt binary for ${process.platform}-${process.arch}.\n` +
      `Expected the optional dependency ${pkg} to be installed alongside @agentdeploymentco/argus.`,
  );
  process.exit(1);
}

const binName = process.platform === "win32" ? "argus.exe" : "argus";
const bin = path.join(pkgDir, "bin", binName);

const result = spawnSync(bin, process.argv.slice(2), {
  stdio: "inherit",
  // The compiled binary serves the dashboard's SPA from this directory (see findWebRoot in serve.ts).
  env: { ...process.env, ARGUS_WEB_ROOT: path.join(pkgDir, "web") },
});

if (result.error) {
  console.error(`argus: failed to launch ${bin}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 0);
