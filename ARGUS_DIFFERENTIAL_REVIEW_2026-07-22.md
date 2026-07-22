# Argus PR #300 Differential Review

## Executive Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 0 |
| LOW | 0 actionable findings |

**Overall risk:** Low

**Recommendation:** Approve

PR #300 keeps the desktop sync leg running when Hub settings are incomplete and makes the upload loop re-check those settings. The changed control flow preserves the existing behavior for missing configuration, transient failures, schema mismatches, local-only sources, and shutdown. No actionable correctness or security findings were identified.

## What Changed

**Base:** `c5aacbfc0eb828c36ad48402ac5ed9ce81aa19e8`

**Head:** `807b16286c9c2fe7e39c417b1e65f9ab1667f572`

| File | Change | Risk |
|------|--------|------|
| `desktop/src-tauri/src/lib.rs` | Always starts `argus run` without native Hub preflight | Medium |
| `src/watch.ts` | Adds an explicit not-configured result and 5-second config polling | Medium |
| `src/push.ts` | Extends `PushResult` with `notConfigured` | Low |
| `src/run.ts` | Updates startup status text | Low |
| `test/watch.test.ts` | Adds missing-config and late-config coverage | Low |
| `test/helpers/isolated-config.ts` | Updates test isolation rationale | Low |

Total: 43 additions and 91 deletions across 6 files.

## Findings

No actionable findings.

The new `notConfigured` branch is evaluated before the existing generic status-0 branch, resets backoff, uses a bounded cancellable sleep, and therefore retries configuration without treating the state as an upload failure. Once settings become valid, the next pass reaches the existing successful-upload path. Removing the Rust-side preflight also removes duplicated config/keychain resolution and lets the CLI remain the single source of truth.

## Test Coverage Analysis

Verified locally at the PR head:

- `bun test test/watch.test.ts`: 7 passing
- `bun test`: 689 passing
- `bun run typecheck`: passed
- `cargo check --manifest-path desktop/src-tauri/Cargo.toml`: passed
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml`: passed

The TypeScript watch behavior has direct coverage for local-only skips, missing Hub settings, late configuration, transient failures, and abort. The native sidecar change has compile/test validation but no targeted test asserting the exact spawned argument list; this is a coverage gap, not an observed defect.

## Blast Radius and Historical Context

The modified runtime functions are reached by the desktop sidecar and the CLI `run`/`sync --watch` paths. The change is limited to sync-loop startup and retry classification; it does not alter upload payload construction, authentication, storage writes, or Hub response handling.

The removed native preflight was introduced by the earlier desktop sync lifecycle work to avoid starting uploads on fresh installs. The current implementation retains that operational property in `src/watch.ts`: missing settings produce no upload, emit a collapsed informational message, and wait for configuration. The earlier native check also duplicated the CLI's Hub URL/key resolution and could not observe settings added while the sidecar stayed alive, which this PR addresses.

## Non-blocking Observation

`src/run.ts:98` says the process checks for Hub uploads at the normal sync interval, while the not-configured state checks settings every 5 seconds. This is not a functional issue, but the startup message could be made more precise if desired.

## Analysis Methodology

Focused differential review of all six changed files, including base/head comparison, one-hop call tracing through `watchSync`, `pushSnapshotForOpts`, `resolveHubConfig`, `runRun`, and the Tauri sidecar launcher; historical review of the removed native preflight; adversarial checks for retry classification, config transitions, keychain access, local-only sources, and abort behavior; and the verification commands listed above.

**Confidence:** High for the changed paths. External Hub behavior was not independently exercised because the PR does not change the wire payload or HTTP implementation.
