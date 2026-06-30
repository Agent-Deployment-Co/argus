import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  FileSecretStore,
  isSecretName,
  migrateHubKeyToSecretStore,
  resolveHubConfig,
  type SecretStore,
} from "../src/secrets.ts";

function tmpSecrets(): FileSecretStore {
  return new FileSecretStore(join(mkdtempSync(join(tmpdir(), "argus-hubkey-secrets-")), "secrets.json"));
}
function tmpConfig(contents = "{}"): string {
  const path = join(mkdtempSync(join(tmpdir(), "argus-hubkey-")), "argus.json");
  writeFileSync(path, contents, "utf8");
  return path;
}

// These resolvers read process.env; keep the suite hermetic.
const TOUCHED = ["ARGUS_HUB_URL", "ARGUS_HUB_KEY"];
afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
});

describe("hub key secret storage", () => {
  test("ARGUS_HUB_KEY is an allowed secret name", () => {
    expect(isSecretName("ARGUS_HUB_KEY")).toBe(true);
  });

  test("migrates a legacy plaintext hub.key into the store and strips it from argus.json", async () => {
    const configPath = tmpConfig('{"hub":{"url":"http://hub.example:4242","key":"hub-secret-1234"}}');
    const secrets = tmpSecrets();

    expect(await migrateHubKeyToSecretStore({ store: secrets, configPath })).toBe(true);
    expect(await secrets.get("ARGUS_HUB_KEY")).toBe("hub-secret-1234"); // moved into the store
    const cfg = loadConfig(configPath);
    expect(cfg.hub?.key).toBeUndefined(); // stripped from the file
    expect(cfg.hub?.url).toBe("http://hub.example:4242"); // url untouched

    // Idempotent — nothing left to move.
    expect(await migrateHubKeyToSecretStore({ store: secrets, configPath })).toBe(false);
  });

  test("migration does not clobber a key already in the store, but still strips the plaintext", async () => {
    const configPath = tmpConfig('{"hub":{"key":"from-json"}}');
    const secrets = tmpSecrets();
    await secrets.set("ARGUS_HUB_KEY", "from-store");

    await migrateHubKeyToSecretStore({ store: secrets, configPath });
    expect(await secrets.get("ARGUS_HUB_KEY")).toBe("from-store");
    expect(loadConfig(configPath).hub?.key).toBeUndefined();
  });

  test("no-op (no store access) when argus.json has no hub.key", async () => {
    const exploding = explodingStore();
    expect(await migrateHubKeyToSecretStore({ store: exploding, configPath: tmpConfig("{}") })).toBe(false);
  });

  test("never throws when the keychain write fails: leaves the plaintext key in place and returns false", async () => {
    // A locked/denied keychain (the macOS case) must not crash serve startup (#154 review).
    const configPath = tmpConfig('{"hub":{"url":"http://hub.example:4242","key":"hub-secret-1234"}}');
    const logs: string[] = [];
    const failingSet: SecretStore = {
      get: async () => undefined,
      set: async () => {
        throw new Error("keychain is locked");
      },
      delete: async () => false,
      describe: async () => ({ configured: false }),
    };
    expect(await migrateHubKeyToSecretStore({ store: failingSet, configPath, log: (m) => logs.push(m) })).toBe(false);
    expect(loadConfig(configPath).hub?.key).toBe("hub-secret-1234"); // left untouched — hub mode still works
    expect(logs.some((l) => /secure storage/.test(l))).toBe(true);
  });

  test("resolveHubConfig returns url + stored key, migrating en route", async () => {
    const configPath = tmpConfig('{"hub":{"url":"http://hub.example:4242","key":"hub-secret-1234"}}');
    const secrets = tmpSecrets();
    expect(await resolveHubConfig({ store: secrets, configPath })).toEqual({
      url: "http://hub.example:4242",
      key: "hub-secret-1234",
    });
    expect(loadConfig(configPath).hub?.key).toBeUndefined();
  });

  test("resolveHubConfig short-circuits (no keychain read) when no Hub URL is set", async () => {
    // The store throws on any access — proving we never touch it without a URL.
    expect(await resolveHubConfig({ store: explodingStore(), configPath: tmpConfig("{}") })).toBeUndefined();
  });

  test("env ARGUS_HUB_KEY wins over the stored value", async () => {
    const configPath = tmpConfig('{"hub":{"url":"http://hub.example:4242"}}');
    const secrets = tmpSecrets();
    await secrets.set("ARGUS_HUB_KEY", "from-store");
    process.env.ARGUS_HUB_KEY = "from-env";
    expect((await resolveHubConfig({ store: secrets, configPath }))?.key).toBe("from-env");
  });
});

/** A store that fails on every access, to assert a code path never reads it. */
function explodingStore(): SecretStore {
  const boom = () => {
    throw new Error("secret store should not be accessed");
  };
  return {
    get: async () => boom(),
    set: async () => boom(),
    delete: async () => boom(),
    describe: async () => boom(),
  };
}
