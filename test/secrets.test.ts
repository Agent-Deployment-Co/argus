import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DpapiSecretStore,
  FileSecretStore,
  KeychainSecretStore,
  isSecretName,
  maskSecret,
  resolveApiKey,
  type CommandResult,
  type CommandRunner,
  type SecretStore,
} from "../src/secrets.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmpFile(name = "secrets.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-secrets-"));
  tmpDirs.push(dir);
  return join(dir, name);
}

/** A mock command runner that records calls and returns scripted results. */
function mockRunner(handler: (file: string, args: string[], opts: { stdin?: string; env?: Record<string, string> }) => CommandResult): {
  runner: CommandRunner;
  calls: Array<{ file: string; args: string[]; stdin?: string; env?: Record<string, string> }>;
} {
  const calls: Array<{ file: string; args: string[]; stdin?: string; env?: Record<string, string> }> = [];
  const runner: CommandRunner = {
    async run(file, args, opts = {}) {
      calls.push({ file, args, stdin: opts.stdin, env: opts.env });
      return handler(file, args, opts);
    },
  };
  return { runner, calls };
}
const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

describe("allowlist + masking", () => {
  test("isSecretName accepts the provider keys and rejects others", () => {
    expect(isSecretName("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSecretName("OPENAI_API_KEY")).toBe(true);
    expect(isSecretName("HOME")).toBe(false);
  });
  test("maskSecret never reveals the raw value", () => {
    expect(maskSecret("sk-abcdefghWXYZ")).toBe("…WXYZ");
    expect(maskSecret("ab")).toBe("…");
  });
});

describe("FileSecretStore (real round-trip)", () => {
  test("set/get/describe/delete with 0600 perms", async () => {
    const path = tmpFile();
    const store = new FileSecretStore(path);
    expect(await store.get("ANTHROPIC_API_KEY")).toBeUndefined();
    expect(await store.describe("ANTHROPIC_API_KEY")).toEqual({ configured: false });

    await store.set("ANTHROPIC_API_KEY", "sk-secret-1234");
    expect(await store.get("ANTHROPIC_API_KEY")).toBe("sk-secret-1234");
    expect(await store.describe("ANTHROPIC_API_KEY")).toEqual({ configured: true, hint: "…1234" });
    // file is chmod 600
    expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(await store.delete("ANTHROPIC_API_KEY")).toBe(true);
    expect(await store.delete("ANTHROPIC_API_KEY")).toBe(false);
    expect(await store.get("ANTHROPIC_API_KEY")).toBeUndefined();
  });
});

describe("KeychainSecretStore (mock /usr/bin/security)", () => {
  test("set passes the value inline to security (no interactive prompt)", async () => {
    const { runner, calls } = mockRunner(() => ok());
    await new KeychainSecretStore(runner).set("ANTHROPIC_API_KEY", "sk-xyz");
    const call = calls[0]!;
    expect(call.file).toBe("/usr/bin/security");
    // Inline `-w <value>` (not stdin) so `security` doesn't emit its own password prompts.
    expect(call.args).toEqual([
      "add-generic-password", "-s", "argus", "-a", "ANTHROPIC_API_KEY", "-U", "-w", "sk-xyz",
    ]);
    expect(call.stdin).toBeUndefined();
  });

  test("get strips the trailing newline", async () => {
    const { runner } = mockRunner(() => ok("sk-from-keychain\n"));
    expect(await new KeychainSecretStore(runner).get("OPENAI_API_KEY")).toBe("sk-from-keychain");
  });

  test("get returns undefined when the item is not found (exit 44)", async () => {
    const { runner } = mockRunner(() => ({ code: 44, stdout: "", stderr: "not found" }));
    const store = new KeychainSecretStore(runner);
    expect(await store.get("OPENAI_API_KEY")).toBeUndefined();
    expect(await store.describe("OPENAI_API_KEY")).toEqual({ configured: false });
  });

  test("delete reports found vs not-found", async () => {
    const found = mockRunner(() => ok());
    expect(await new KeychainSecretStore(found.runner).delete("GEMINI_API_KEY")).toBe(true);
    const missing = mockRunner(() => ({ code: 44, stdout: "", stderr: "" }));
    expect(await new KeychainSecretStore(missing.runner).delete("GEMINI_API_KEY")).toBe(false);
  });
});

describe("DpapiSecretStore (mock PowerShell)", () => {
  test("set encrypts via env var and stores the blob in the file; get decrypts", async () => {
    const path = tmpFile();
    const { runner, calls } = mockRunner((_file, args, opts) => {
      const command = args[args.length - 1] ?? "";
      if (command.includes("ConvertFrom-SecureString")) return ok("DPAPI-BLOB-HEX\n");
      // decrypt: echo back based on the blob we were given
      return opts.env?.ARGUS_SECRET_BLOB === "DPAPI-BLOB-HEX" ? ok("plaintext-key\n") : ok("");
    });
    const store = new DpapiSecretStore(runner, path);

    await store.set("ANTHROPIC_API_KEY", "plaintext-key");
    // value went via env, not argv
    expect(calls[0]!.env?.ARGUS_SECRET_VALUE).toBe("plaintext-key");
    expect(calls[0]!.args).not.toContain("plaintext-key");

    expect(await store.get("ANTHROPIC_API_KEY")).toBe("plaintext-key");
    expect(await store.describe("ANTHROPIC_API_KEY")).toEqual({ configured: true, hint: "…-key" });
    expect(await store.delete("ANTHROPIC_API_KEY")).toBe(true);
    expect(await store.get("ANTHROPIC_API_KEY")).toBeUndefined();
  });
});

describe("resolveApiKey", () => {
  const ENV = "ARGUS_TEST_RESOLVE_KEY";
  afterEach(() => {
    delete process.env[ENV];
  });

  test("env var wins over the store", async () => {
    process.env[ENV] = "from-env";
    const store: SecretStore = new FileSecretStore(tmpFile());
    await store.set(ENV, "from-store");
    expect(await resolveApiKey(ENV, store)).toBe("from-env");
  });

  test("falls back to the store when the env var is unset", async () => {
    const store: SecretStore = new FileSecretStore(tmpFile());
    await store.set(ENV, "from-store");
    expect(await resolveApiKey(ENV, store)).toBe("from-store");
  });

  test("undefined when neither is set", async () => {
    expect(await resolveApiKey(ENV, new FileSecretStore(tmpFile()))).toBeUndefined();
    expect(await resolveApiKey(undefined)).toBeUndefined();
  });
});
