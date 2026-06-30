// BYO API-key storage (#132). A small SecretStore interface with three platform backends, all of
// which keep the secret encrypted at rest where the OS allows it and never expose a per-app boundary
// weaker than the existing token.json:
//
//   - macOS   → the login keychain, via the stable system `/usr/bin/security` tool. Because both the
//               write and the read go through `security` (not bun/node), there is no per-app keychain
//               prompt churn, and the same item is shared by the bare CLI and the desktop sidecar.
//   - Windows → a DPAPI-encrypted blob (CurrentUser scope) in a file, via built-in PowerShell.
//   - Linux   → a chmod-600 plaintext JSON file (the model auth.ts already uses for token.json).
//
// None of these protects the secret from the machine owner (that's intrinsic to a local BYO key); the
// win over a plaintext file is encryption at rest on macOS/Windows. The store is reached only by the
// local CLI / the sidecar — never serialized onto the sync wire.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG_FILE, SECRETS_FILE } from "./paths.ts";
import { PROVIDER_API_KEY_ENVS } from "./llm/index.ts";
import { getPath, HUB_SETTINGS, loadConfig, resolveSetting, setPath, writeConfigAtomic, type ArgusConfig } from "./config.ts";

/** The env-var name the Argus Hub key is stored under (and resolved from). */
const HUB_KEY_ENV = HUB_SETTINGS.key.env!;

/** The secret names Argus stores: the providers' standard API-key env vars (derived from the provider
 *  registry so a new provider's key is automatically storable) plus the Argus Hub key. Keyed to the
 *  env-var names so the value resolves through `apiKeyEnv`/`ARGUS_HUB_KEY` and (on the desktop) needs no
 *  argus.json parsing on the native side. */
export const SECRET_NAMES: readonly string[] = [...PROVIDER_API_KEY_ENVS, HUB_KEY_ENV];

export function isSecretName(name: string): boolean {
  return SECRET_NAMES.includes(name);
}

/** A masked, never-raw description of a stored secret. */
export interface SecretStatus {
  configured: boolean;
  /** A masked hint (e.g. "…WXYZ"), present only when configured. Never the raw value. */
  hint?: string;
}

export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  /** Returns true if an entry was removed, false if there was nothing to remove. */
  delete(name: string): Promise<boolean>;
  describe(name: string): Promise<SecretStatus>;
}

/** Mask a secret to a short, non-reversible hint. */
export function maskSecret(value: string): string {
  return value.length <= 4 ? "…" : `…${value.slice(-4)}`;
}

// --- command-runner seam (so tests never touch the real keychain / PowerShell) ---

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(
    file: string,
    args: string[],
    opts?: { stdin?: string; env?: Record<string, string> },
  ): Promise<CommandResult>;
}

export const defaultCommandRunner: CommandRunner = {
  run(file, args, opts = {}) {
    return new Promise<CommandResult>((resolve) => {
      const child = spawn(file, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      child.on("error", (err) => resolve({ code: null, stdout, stderr: stderr || err.message }));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(opts.stdin ?? "", "utf8");
    });
  },
};

function describeFrom(value: string | undefined): SecretStatus {
  return value ? { configured: true, hint: maskSecret(value) } : { configured: false };
}

// --- shared on-disk secrets.json map (DPAPI blobs on Windows, plaintext elsewhere) ---
// Both file-backed stores persist a flat `{ name: value }` JSON object at `secrets.json`; the only
// difference is whether the value is a DPAPI blob or the raw secret. Keeping the load/store, the
// object guard, and the file mode here means the on-disk shape can't drift between them.

function readSecretMap(path: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeSecretMap(path: string, map: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(map, null, 2), { mode: 0o600 });
  // `mode` only applies when the file is created, so re-tighten an already-existing file to 0600.
  chmodSync(path, 0o600);
}

// --- macOS: login keychain via /usr/bin/security ---

/** Keychain service (the `(service, account)` pair is the item's identity). A reverse-DNS name —
 *  matching the desktop app's bundle id — so it can't collide with another tool's generic-password
 *  items. The account is the secret name. */
const KEYCHAIN_SERVICE = "co.agentdeployment.argus";
/** Display name (kSecAttrLabel) shown in Keychain Access; the service stays the unique reverse-DNS id. */
const KEYCHAIN_LABEL = "Argus";
/** `security` exit code when an item isn't found. */
const SECURITY_NOT_FOUND = 44;

export class KeychainSecretStore implements SecretStore {
  constructor(private readonly runner: CommandRunner = defaultCommandRunner) {}

  async get(name: string): Promise<string | undefined> {
    const res = await this.runner.run("/usr/bin/security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      name,
      "-w",
    ]);
    if (res.code !== 0) return undefined; // not found (44) or any error → treat as unset
    return res.stdout.replace(/\r?\n$/, "");
  }

  async set(name: string, value: string): Promise<void> {
    // `-U` updates an existing item. The value is passed inline with `-w`: the stdin form makes
    // `security` emit interactive "password data for new item:" / "retype password" prompts, which is
    // exactly the confirmation noise we don't want. The trade-off is a brief, local argv exposure of
    // the value (visible to a same-user `ps` only for this short-lived process) — the same approach
    // gw-cli takes, and the machine owner can already read the keychain.
    const res = await this.runner.run("/usr/bin/security", [
      "add-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      name,
      "-l",
      KEYCHAIN_LABEL,
      "-U",
      "-w",
      value,
    ]);
    if (res.code !== 0) {
      throw new Error(`Couldn't save ${name} to the keychain: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
  }

  async delete(name: string): Promise<boolean> {
    const res = await this.runner.run("/usr/bin/security", [
      "delete-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      name,
    ]);
    if (res.code === 0) return true;
    if (res.code === SECURITY_NOT_FOUND) return false;
    throw new Error(`Couldn't remove ${name} from the keychain: ${res.stderr.trim() || `exit ${res.code}`}`);
  }

  async describe(name: string): Promise<SecretStatus> {
    return describeFrom(await this.get(name));
  }
}

// --- Windows: DPAPI-encrypted blobs (CurrentUser) in a file, via built-in PowerShell ---

const ENCRYPT_PS =
  "ConvertTo-SecureString -String $env:ARGUS_SECRET_VALUE -AsPlainText -Force | ConvertFrom-SecureString";
const DECRYPT_PS =
  "$s = ConvertTo-SecureString -String $env:ARGUS_SECRET_BLOB; " +
  "[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))";

export class DpapiSecretStore implements SecretStore {
  constructor(
    private readonly runner: CommandRunner = defaultCommandRunner,
    private readonly path: string = SECRETS_FILE,
  ) {}

  private readBlobs(): Record<string, string> {
    return readSecretMap(this.path);
  }

  private writeBlobs(blobs: Record<string, string>): void {
    writeSecretMap(this.path, blobs);
  }

  private ps(command: string, env: Record<string, string>): Promise<CommandResult> {
    return this.runner.run("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { env });
  }

  async get(name: string): Promise<string | undefined> {
    const blob = this.readBlobs()[name];
    if (!blob) return undefined;
    const res = await this.ps(DECRYPT_PS, { ARGUS_SECRET_BLOB: blob });
    if (res.code !== 0) return undefined;
    return res.stdout.replace(/\r?\n$/, "");
  }

  async set(name: string, value: string): Promise<void> {
    const res = await this.ps(ENCRYPT_PS, { ARGUS_SECRET_VALUE: value });
    if (res.code !== 0 || !res.stdout.trim()) {
      throw new Error(`Couldn't encrypt ${name}: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
    const blobs = this.readBlobs();
    blobs[name] = res.stdout.replace(/\r?\n$/, "");
    this.writeBlobs(blobs);
  }

  async delete(name: string): Promise<boolean> {
    const blobs = this.readBlobs();
    if (!(name in blobs)) return false;
    delete blobs[name];
    this.writeBlobs(blobs);
    return true;
  }

  async describe(name: string): Promise<SecretStatus> {
    return describeFrom(await this.get(name));
  }
}

// --- Linux / fallback: chmod-600 plaintext JSON ---

export class FileSecretStore implements SecretStore {
  constructor(private readonly path: string = SECRETS_FILE) {}

  private read(): Record<string, string> {
    return readSecretMap(this.path);
  }

  private write(map: Record<string, string>): void {
    writeSecretMap(this.path, map);
  }

  async get(name: string): Promise<string | undefined> {
    return this.read()[name] || undefined;
  }

  async set(name: string, value: string): Promise<void> {
    const map = this.read();
    map[name] = value;
    this.write(map);
  }

  async delete(name: string): Promise<boolean> {
    const map = this.read();
    if (!(name in map)) return false;
    delete map[name];
    this.write(map);
    return true;
  }

  async describe(name: string): Promise<SecretStatus> {
    return describeFrom(await this.get(name));
  }
}

/** The platform-appropriate secret store: keychain on macOS, DPAPI on Windows, a 0600 file elsewhere. */
export function selectSecretStore(): SecretStore {
  if (process.platform === "darwin") return new KeychainSecretStore();
  if (process.platform === "win32") return new DpapiSecretStore();
  return new FileSecretStore();
}

let cached: SecretStore | undefined;
export function defaultSecretStore(): SecretStore {
  return (cached ??= selectSecretStore());
}

/**
 * Resolve the API key for a provider: the named env var wins (CI / power-user escape hatch), then the
 * platform secret store, then undefined. Non-fatal — an undefined result becomes a "no key" diagnostic
 * downstream in the LLM client.
 */
export async function resolveApiKey(
  apiKeyEnv: string | undefined,
  store: SecretStore = defaultSecretStore(),
): Promise<string | undefined> {
  if (!apiKeyEnv) return undefined;
  const fromEnv = process.env[apiKeyEnv];
  if (fromEnv) return fromEnv;
  return store.get(apiKeyEnv);
}

// --- Argus Hub connection (url from settings, key from the secret store) ---

export interface ResolvedHubConfig {
  url: string;
  key: string;
}

/** Resolve the Hub key: the `ARGUS_HUB_KEY` env var wins, then the secret store, then undefined. */
export async function resolveHubKey(store: SecretStore = defaultSecretStore()): Promise<string | undefined> {
  const fromEnv = process.env[HUB_KEY_ENV];
  if (fromEnv) return fromEnv;
  return store.get(HUB_KEY_ENV);
}

/**
 * One-time, idempotent migration: if a legacy plaintext `hub.key` is still sitting in `argus.json`,
 * move it into the secret store (the keychain) and strip it from the file — so the key stops living in
 * plaintext. A no-op (no store access, no write) when the file has no `hub.key`, so it's cheap to call
 * on every resolve. Doesn't clobber a value already in the store. Returns true if it migrated.
 */
export async function migrateHubKeyToSecretStore(
  opts: { store?: SecretStore; configPath?: string; log?: (msg: string) => void } = {},
): Promise<boolean> {
  const configPath = opts.configPath ?? CONFIG_FILE;
  const file = loadConfig(configPath) as ArgusConfig & Record<string, unknown>;
  const plaintext = getPath(file, "hub.key");
  if (typeof plaintext !== "string" || plaintext === "") return false;

  const store = opts.store ?? defaultSecretStore();
  // Never let migration failure crash startup: the keychain can be locked/denied (macOS), unwritable
  // (headless Linux), or unavailable (Windows DPAPI). On failure we leave the plaintext key in place
  // (hub mode keeps working) and log — a no-op for everyone without a legacy plaintext key. Callers
  // (serve startup, resolveHubConfig) therefore don't need their own try/catch.
  try {
    // Keep an existing stored value (e.g. set later via `argus secret`) authoritative.
    if (!(await store.describe(HUB_KEY_ENV)).configured) await store.set(HUB_KEY_ENV, plaintext);
    setPath(file, "hub.key", undefined); // JSON.stringify omits undefined → the key is dropped from the file
    writeConfigAtomic(file, configPath);
  } catch (err) {
    opts.log?.(`Couldn't move the Argus Hub key into secure storage; leaving it in argus.json. (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
  opts.log?.("Moved the Argus Hub key into secure storage and removed it from argus.json.");
  return true;
}

/**
 * Resolve the Hub connection: `hub.url` from settings (env > argus.json) and the key from the secret
 * store (env > keychain). Returns the config only when both are present; undefined otherwise. First
 * migrates any legacy plaintext `hub.key` out of argus.json into the store. Short-circuits before any
 * keychain access when no Hub URL is configured (the common case), so it never prompts needlessly.
 */
export async function resolveHubConfig(
  opts: { flags?: Record<string, unknown>; store?: SecretStore; configPath?: string; log?: (msg: string) => void } = {},
): Promise<ResolvedHubConfig | undefined> {
  const store = opts.store ?? defaultSecretStore();
  await migrateHubKeyToSecretStore({ store, configPath: opts.configPath, log: opts.log });
  const file = loadConfig(opts.configPath ?? CONFIG_FILE);
  const url = resolveSetting(HUB_SETTINGS.url, opts.flags ?? {}, file);
  if (!url) return undefined;
  const key = await resolveHubKey(store);
  return key ? { url, key } : undefined;
}
