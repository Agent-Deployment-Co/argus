// Client-fingerprint collection (#141 follow-up). Probes a handful of environment signals (starting
// with the user's git identity) and records each as a key/value/timestamp tuple on the local store.
// The store writer suppresses repeat-of-same-value, so a steady environment doesn't churn the log —
// only changes accumulate. Later used to register a client with the dashboard backend.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReadModelStore } from "./store/store-contract.ts";

/** Parse the `user.name` value out of a git config file's contents (INI-like: `[section]` headers,
 *  `key = value` lines, `;`/`#` comments). Only looks at top-level `[user]` sections — subsections
 *  like `[user "foo"]` aren't git identity and are skipped. Returns undefined if no such key is
 *  found or its value is blank. Not a full git-config parser (no `include`/`includeIf`, no
 *  quoting/escape handling) — sufficient for the common case of a flat `[user]` block. */
export function parseGitConfigUserName(contents: string): string | undefined {
  let inUserSection = false;
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([^\]"]+)(\s+"[^"]*")?\]$/);
    if (sectionMatch) {
      inUserSection = sectionMatch[1]?.trim().toLowerCase() === "user" && !sectionMatch[2];
      continue;
    }
    if (!inUserSection) continue;
    const keyMatch = line.match(/^name\s*=\s*(.*)$/i);
    if (keyMatch) {
      const value = (keyMatch[1] ?? "").trim();
      if (value) return value;
    }
  }
  return undefined;
}

/** Read the user's git identity from their global gitconfig — `$GIT_CONFIG_GLOBAL` if set, else
 *  `$HOME/.gitconfig` (git's own default resolution for the global config file) — without shelling
 *  out to the `git` binary. Deliberately avoids invoking `git` (or any other PATH binary) here: on
 *  macOS, running `git` when Xcode Command Line Tools aren't installed pops up a system dialog
 *  prompting the user to install them, which this unattended background probe must not trigger.
 *  Returns undefined if the file is missing, unreadable, or has no `user.name`. */
export function readGitUserName(
  path: string = process.env.GIT_CONFIG_GLOBAL || join(homedir(), ".gitconfig"),
): string | undefined {
  try {
    const contents = readFileSync(path, "utf8");
    return parseGitConfigUserName(contents);
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
