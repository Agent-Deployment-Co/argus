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
import { SECRETS_FILE } from "./paths.ts";
import { PROVIDER_API_KEY_ENVS } from "./llm/index.ts";

/** The secret names Argus stores: the providers' standard API-key env vars, derived from the provider
 *  registry so a new provider's key is automatically storable. Keyed to the env-var names so the value
 *  resolves through `apiKeyEnv` and (on the desktop) needs no argus.json parsing on the native side. */
export const SECRET_NAMES: readonly string[] = PROVIDER_API_KEY_ENVS;

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

// --- macOS: login keychain via /usr/bin/security ---

/** Keychain service name; the account is the secret name. */
const KEYCHAIN_SERVICE = "argus";
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
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  }

  private writeBlobs(blobs: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(blobs, null, 2), { mode: 0o600 });
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
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  }

  private write(map: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(map, null, 2), { mode: 0o600 });
    chmodSync(this.path, 0o600);
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
