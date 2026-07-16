// MDM managed settings (#257) — the layer above every user-controlled config source.
//
// Organizations that manage machines with an MDM (Jamf, Kandji, Mosyle, …) can force Argus settings
// by delivering a settings file to a managed location (`managedConfigCandidates` in paths.ts). The
// file carries the same camelCase shape as `argus.json`, as either JSON or a plist (XML or binary —
// what an MDM custom-settings payload writes). When one is found, its values win over CLI flags,
// env vars, and `argus.json` — the MDM convention that managed settings can't be overridden locally.
//
// This module owns discovery, parsing, and the per-process cache; the resolvers in `config.ts`
// consult it as their first layer. Loading is tolerant like `loadConfig`: a malformed or unreadable
// candidate warns and falls through to the next one, and never crashes a command. The file is read
// once per process (settings churn by MDM push is rare; a restart picks changes up).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { managedConfigCandidates } from "./paths.ts";
import { logDebug, logger, logWarn } from "./logger.ts";
import type { ArgusConfig, ConfigWarn } from "./config.ts";

/** Convert a plist file (XML or binary) to a JSON string. Throws on failure. Injectable so tests
 *  don't need the macOS `plutil` binary. */
export type PlistToJson = (path: string) => string;

/** The system plist converter — same posture as the keychain access in `secrets.ts`: shell out to
 *  the OS tool rather than carry a parser dependency. `plutil` ships with macOS, the only platform
 *  with standard managed locations today. */
export const defaultPlistToJson: PlistToJson = (path) =>
  execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", path], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

function defaultWarn(message: string): void {
  logWarn(logger, message);
}

/** A found managed settings file: its parsed contents and where it came from (surfaced in the
 *  settings UI so users can see what's managing a value). */
export interface ManagedConfigSource {
  config: ArgusConfig;
  path: string;
}

/**
 * Find and parse the managed settings file: the first candidate that exists and parses wins. A
 * candidate that exists but can't be read or parsed warns and falls through to the next one, so a
 * broken push never crashes a command — at worst everything resolves as unmanaged.
 */
export function loadManagedConfig(
  candidates: string[] = managedConfigCandidates(),
  warn: ConfigWarn = defaultWarn,
  plistToJson: PlistToJson = defaultPlistToJson,
): ManagedConfigSource | undefined {
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = path.endsWith(".plist") ? plistToJson(path) : readFileSync(path, "utf8");
    } catch (error) {
      warn(
        `Ignoring managed settings file ${path}: ${error instanceof Error ? error.message : String(error)}.`,
      );
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { config: parsed as ArgusConfig, path };
      }
      warn(`Ignoring managed settings file ${path}: expected a set of settings, not a list or a single value.`);
    } catch (error) {
      warn(
        `Ignoring managed settings file ${path}: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }
  return undefined;
}

// The per-process cache. `undefined` doubles as "not loaded yet" via the `loaded` flag, since a
// successful load can also legitimately be `undefined` (no managed file — the common case).
let cached: ManagedConfigSource | undefined;
let loaded = false;

/** The managed settings source for this process, loaded once and cached. */
export function managedConfigSource(): ManagedConfigSource | undefined {
  if (!loaded) {
    cached = loadManagedConfig();
    loaded = true;
    if (cached) logDebug(logger, `Using managed settings from ${cached.path}.`);
  }
  return cached;
}

/** The managed settings themselves — `{}` when the machine has none, so lookups are uniform. */
export function managedConfig(): ArgusConfig {
  return managedConfigSource()?.config ?? {};
}

/** Drop the cache so the next lookup re-reads the candidates. For tests (which repoint
 *  `ARGUS_MANAGED_CONFIG_FILE` between cases); production code reads once per process. */
export function resetManagedConfigCache(): void {
  cached = undefined;
  loaded = false;
}
