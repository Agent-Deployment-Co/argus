// Client-fingerprint collection (#141 follow-up). Probes a handful of environment signals (starting
// with `git config user.name`) and records each as a key/value/timestamp tuple on the local store.
// The store writer suppresses repeat-of-same-value, so a steady environment doesn't churn the log —
// only changes accumulate. Later used to register a client with the dashboard backend.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReadModelStore } from "./store/store-contract.ts";

/** Read `git config user.name`. Returns undefined if git isn't on PATH, the call fails, or the
 *  config key is unset/empty — never throws, so a missing git install just yields no observation. */
export function readGitUserName(): string | undefined {
  try {
    const result = spawnSync("git", ["config", "user.name"], { encoding: "utf8" });
    if (result.status !== 0) return undefined;
    const value = result.stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Read `oauthAccount.emailAddress` from `$HOME/.claude.json` — the Claude Code CLI's per-user
 *  settings file, which holds the signed-in account when the user has logged in. Returns undefined
 *  if the file is missing, unreadable, malformed, or the field is unset/non-string. Lives in
 *  `$HOME` (not `$CLAUDE_CONFIG_DIR`) per Claude Code's layout. */
/** Decode a JWT payload (the middle `.`-segment) without verifying the signature. Returns the
 *  parsed object or undefined for any decode/parse failure — every caller here treats undefined
 *  as "skip this observation," so a malformed token is just absence, not an error. */
function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Read the signed-in email from Codex's `~/.codex/auth.json`. The file stores an OIDC `id_token`
 *  whose JWT payload carries `email`. Returns undefined on any failure (missing file, malformed
 *  JSON, malformed JWT, missing/blank email). Equivalent to:
 *    jq -r '.tokens.id_token | split(".")[1] | @base64d | fromjson | .email' ~/.codex/auth.json */
export function readCodexOauthEmail(
  path: string = join(
    process.env.CODEX_HOME || process.env.CODEX_CONFIG_DIR || join(homedir(), ".codex"),
    "auth.json",
  ),
): string | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { tokens?: { id_token?: unknown } };
    const idToken = parsed.tokens?.id_token;
    if (typeof idToken !== "string") return undefined;
    const claims = decodeJwtPayload(idToken);
    const email = claims?.email;
    if (typeof email !== "string") return undefined;
    const trimmed = email.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

export function readClaudeOauthEmail(path: string = join(homedir(), ".claude.json")): string | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: unknown } };
    const email = parsed.oauthAccount?.emailAddress;
    if (typeof email !== "string") return undefined;
    const trimmed = email.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

/** One named probe in the fingerprint set. `read` returns undefined to skip (no observation
 *  recorded for that key this run). */
export interface FingerprintProbe {
  key: string;
  read(): string | undefined;
}

/** Built-in probes. Adding a new fingerprint signal means appending an entry here. */
export const DEFAULT_PROBES: FingerprintProbe[] = [
  { key: "git.user.name", read: readGitUserName },
  { key: "claude.oauth.email", read: readClaudeOauthEmail },
  { key: "codex.oauth.email", read: readCodexOauthEmail },
];

/** Run every probe and write each observation to the store. Used by the indexing pipeline so a
 *  fingerprint refresh happens on the same cadence as `argus index`. */
export async function collectClientFingerprint(
  store: Pick<ReadModelStore, "recordClientFingerprint">,
  now: () => number = Date.now,
  probes: FingerprintProbe[] = DEFAULT_PROBES,
): Promise<void> {
  const tsMs = now();
  for (const probe of probes) {
    const value = probe.read();
    if (value === undefined) continue;
    await store.recordClientFingerprint(probe.key, value, tsMs);
  }
}
