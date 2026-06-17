#!/usr/bin/env bun
// Build the publishable npm package set into dist/npm/:
//   - @agentdeploymentco/argus               — the launcher (bin) + optionalDependencies
//   - @agentdeploymentco/argus-<os>-<cpu>     — a self-contained compiled binary + the web app
//
// `npm i -g @agentdeploymentco/argus` then installs only the platform package matching the user's
// os/cpu (npm honors the `os`/`cpu` fields), and the launcher execs its binary. The binary bundles
// its own runtime, so end users need no Bun/Node/node-gyp; node is only used to run the tiny shim.
//
// Usage: bun run scripts/build-npm-packages.ts [--host-only]
import { $ } from "bun";
import { chmodSync, cpSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

const SCOPE = "@agentdeploymentco";
const OUT = "dist/npm";
const VERSION = pkg.version;

interface Target {
  os: string; // npm `os` value (process.platform)
  cpu: string; // npm `cpu` value (process.arch)
  bunTarget: string; // bun --compile --target
  exe: string;
}

const ALL_TARGETS: Target[] = [
  { os: "darwin", cpu: "arm64", bunTarget: "bun-darwin-arm64", exe: "argus" },
  { os: "darwin", cpu: "x64", bunTarget: "bun-darwin-x64", exe: "argus" },
  { os: "win32", cpu: "x64", bunTarget: "bun-windows-x64", exe: "argus.exe" },
];

const hostOnly = process.argv.includes("--host-only");
const targets = hostOnly
  ? ALL_TARGETS.filter((t) => t.os === process.platform && t.cpu === process.arch)
  : ALL_TARGETS;

if (targets.length === 0) {
  console.error(`No matching target for host ${process.platform}-${process.arch}.`);
  process.exit(1);
}

// The SPA is identical across platforms — build it once and copy into each package.
await $`bun run build:web`;

rmSync(OUT, { recursive: true, force: true });

for (const t of targets) {
  const name = `argus-${t.os}-${t.cpu}`;
  const dir = join(OUT, name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  console.log(`Compiling ${name}…`);
  await $`bun build --compile --target=${t.bunTarget} src/cli.ts --outfile ${join(dir, "bin", t.exe)}`;
  cpSync("dist/web", join(dir, "web"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: `${SCOPE}/${name}`,
        version: VERSION,
        description: `Argus CLI — prebuilt binary for ${t.os}/${t.cpu}.`,
        os: [t.os],
        cpu: [t.cpu],
        files: ["bin", "web"],
      },
      null,
      2,
    ) + "\n",
  );
}

// The main package: just the launcher, with the platform packages as optional dependencies so npm
// installs exactly the one that matches.
const mainDir = join(OUT, "argus");
mkdirSync(join(mainDir, "bin"), { recursive: true });
copyFileSync("npm/launcher.cjs", join(mainDir, "bin", "argus"));
chmodSync(join(mainDir, "bin", "argus"), 0o755);

const optionalDependencies = Object.fromEntries(
  ALL_TARGETS.map((t) => [`${SCOPE}/argus-${t.os}-${t.cpu}`, VERSION]),
);
writeFileSync(
  join(mainDir, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: VERSION,
      description: pkg.description,
      type: "commonjs",
      bin: { argus: "bin/argus" },
      files: ["bin"],
      optionalDependencies,
    },
    null,
    2,
  ) + "\n",
);

console.log(`\nBuilt ${targets.length + 1} package(s) in ${OUT}/`);
console.log(`Publish with: for d in ${OUT}/*/; do (cd "$d" && npm publish --access public); done`);
