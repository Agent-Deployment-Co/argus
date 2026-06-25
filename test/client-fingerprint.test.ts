import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectClientFingerprint,
  readClaudeOauthEmail,
  readCodexOauthEmail,
  type FingerprintProbe,
} from "../src/client-fingerprint.ts";
import type { ClientFingerprintEntry } from "../src/store/store-contract.ts";

class FakeStore {
  rows: ClientFingerprintEntry[] = [];
  async recordClientFingerprint(key: string, value: string, tsMs: number): Promise<void> {
    const latest = [...this.rows].reverse().find((row) => row.key === key);
    if (latest && latest.value === value) return;
    this.rows.push({ key, value, tsMs });
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeClaudeJson(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-fp-home-"));
  tempDirs.push(dir);
  const path = join(dir, ".claude.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("readClaudeOauthEmail", () => {
  test("extracts oauthAccount.emailAddress from the given .claude.json", () => {
    const path = fakeClaudeJson({ oauthAccount: { emailAddress: "user@example.com" } });
    expect(readClaudeOauthEmail(path)).toBe("user@example.com");
  });

  test("returns undefined when the file is missing, malformed, or the field is absent", () => {
    expect(readClaudeOauthEmail(join(tmpdir(), "argus-no-such-file-xyz"))).toBeUndefined();
    expect(readClaudeOauthEmail(fakeClaudeJson("{ not json"))).toBeUndefined();
    expect(readClaudeOauthEmail(fakeClaudeJson({ oauthAccount: {} }))).toBeUndefined();
    expect(
      readClaudeOauthEmail(fakeClaudeJson({ oauthAccount: { emailAddress: "  " } })),
    ).toBeUndefined();
  });
});

function fakeAuthJson(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-fp-codex-"));
  tempDirs.push(dir);
  const path = join(dir, "auth.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

function fakeJwt(payload: unknown): string {
  // Unsigned, but readCodexOauthEmail doesn't verify the signature — only decodes the payload.
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

describe("readCodexOauthEmail", () => {
  test("decodes tokens.id_token and returns the email claim", () => {
    const path = fakeAuthJson({ tokens: { id_token: fakeJwt({ email: "you@example.com", sub: "x" }) } });
    expect(readCodexOauthEmail(path)).toBe("you@example.com");
  });

  test("returns undefined when file/token/claim is missing or malformed", () => {
    expect(readCodexOauthEmail(join(tmpdir(), "argus-no-such-codex-auth-xyz"))).toBeUndefined();
    expect(readCodexOauthEmail(fakeAuthJson("{ not json"))).toBeUndefined();
    expect(readCodexOauthEmail(fakeAuthJson({ tokens: {} }))).toBeUndefined();
    expect(readCodexOauthEmail(fakeAuthJson({ tokens: { id_token: "not.a.jwt" } }))).toBeUndefined();
    expect(
      readCodexOauthEmail(fakeAuthJson({ tokens: { id_token: fakeJwt({ sub: "x" }) } })),
    ).toBeUndefined();
    expect(
      readCodexOauthEmail(fakeAuthJson({ tokens: { id_token: fakeJwt({ email: "  " }) } })),
    ).toBeUndefined();
  });
});

describe("collectClientFingerprint", () => {
  test("writes one observation per probe, stamping all with the same timestamp", async () => {
    const store = new FakeStore();
    const probes: FingerprintProbe[] = [
      { key: "git.user.name", read: () => "Alice" },
      { key: "env.shell", read: () => "zsh" },
    ];
    await collectClientFingerprint(store, () => 4242, probes);
    expect(store.rows).toEqual([
      { key: "git.user.name", value: "Alice", tsMs: 4242 },
      { key: "env.shell", value: "zsh", tsMs: 4242 },
    ]);
  });

  test("skips probes whose read returns undefined (e.g. git not installed)", async () => {
    const store = new FakeStore();
    const probes: FingerprintProbe[] = [
      { key: "git.user.name", read: () => undefined },
      { key: "env.shell", read: () => "bash" },
    ];
    await collectClientFingerprint(store, () => 1, probes);
    expect(store.rows).toEqual([{ key: "env.shell", value: "bash", tsMs: 1 }]);
  });
});
