# Building

Argus ships two distributables, both built locally with [Bun](https://bun.sh):

- the **CLI** — per-OS npm packages, each wrapping a self-contained compiled binary; and
- the **desktop tray app** — a [Tauri](https://tauri.app) shell (under `desktop/`) that bundles the
  CLI as a sidecar.

## CLI npm packages

```bash
bun run build:npm          # all platforms (macOS arm64/x64, Windows x64)
bun run build:npm --host-only   # just the current OS/arch
```

This compiles `src/cli.ts` with `bun build --compile` for each target and writes the publishable
package set to `dist/npm/`:

- `@agentdeploymentco/argus` — a tiny Node launcher (`bin`) that lists the per-platform packages as
  optional dependencies, so `npm i -g` pulls only the one matching the user's OS/arch.
- `@agentdeploymentco/argus-<os>-<cpu>` — the compiled binary plus the built web app.

The compiled binary bundles its own runtime, so end users need no Bun or Node. The Windows package
(`argus-win32-x64`, `bin/argus.exe`) **cross-compiles from any host** via Bun's `bun-windows-x64`
target — you do not need a Windows machine to produce it.

## Desktop app

Build the tray app for the **host OS** (Tauri cannot cross-compile the installer):

```bash
bun run desktop:build      # app installer for this OS
bun run desktop:dev        # run the app in dev mode
bun run desktop:dmg        # macOS .dmg (macOS only)
```

`desktop:build` stages the compiled CLI + web app as the Tauri sidecar, then runs `tauri build`
with the right bundle target for the host:

| OS      | Bundle | Output |
| ------- | ------ | ------ |
| macOS   | `app`  | `desktop/src-tauri/target/release/bundle/macos/Argus.app` |
| Windows | `nsis` | `desktop/src-tauri/target/release/bundle/nsis/Argus_<version>_x64-setup.exe` |

### Building on Windows

The build chain is pure Bun/TypeScript (`scripts/stage-desktop-sidecar.ts`,
`scripts/build-desktop.ts`) — no bash, no Git Bash required. You need:

- **Bun** — `bun install` to fetch dependencies.
- **Rust** with the **MSVC** toolchain (`x86_64-pc-windows-msvc`) — install via
  [rustup](https://rustup.rs) plus the Visual Studio "Desktop development with C++" workload, which
  Tauri requires.

Then:

```powershell
bun install
bun run typecheck
bun run desktop:build
```

Tauri downloads NSIS itself, so no extra installer toolchain is needed. The resulting
`*-setup.exe` is **unsigned** locally; Authenticode signing happens only in release CI when the
signing secrets are configured.

## Releases

The `Release` workflow (`.github/workflows/release.yml`) runs on a `v*` tag (or manual dispatch)
with a `build-macos` and a `build-windows` job. Both stage the sidecar, build the desktop app via
`tauri-apps/tauri-action`, and upload to the **same** draft GitHub Release, so the updater's
`latest.json` ends up with both a macOS and a Windows entry. All code signing (Apple notarization,
Windows Authenticode, Tauri updater) is gated on repository secrets: the workflow runs end-to-end
producing **unsigned** artifacts until those secrets are added, then starts signing automatically.

## Versioning

Bump the version everywhere it's tracked (`package.json`, `desktop/src-tauri/tauri.conf.json`,
`desktop/src-tauri/Cargo.toml`) in one step:

```bash
bun run bump-version 0.2.0   # or: make bump VERSION=0.2.0
```
