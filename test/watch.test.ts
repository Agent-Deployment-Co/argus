import { describe, expect, test } from "bun:test";
import { sleep } from "../src/backoff.ts";
import { watchIndex, watchSync, type WatchSyncOptions } from "../src/watch.ts";
import type { PushCredentials, PushResult } from "../src/push.ts";

const ok = (status = 200): PushResult => ({ ok: true, status, body: "ok" });

const syncOpts = (over: Partial<WatchSyncOptions>): WatchSyncOptions => ({
  source: "claude",
  endpoint: "http://test.local",
  intervalMin: 1,
  onUnauthenticated: "dormant",
  ...over,
});

describe("watchIndex", () => {
  test("indexes once immediately, then exits promptly on abort", async () => {
    const ac = new AbortController();
    let calls = 0;
    const p = watchIndex({ source: "claude", intervalMin: 1 }, () => {}, ac.signal, {
      index: async () => {
        calls++;
      },
    });
    while (calls === 0) await sleep(5);
    ac.abort();
    await p;
    expect(calls).toBe(1);
  });

  test("a failing index pass restarts instead of hanging, and still exits on abort", async () => {
    const ac = new AbortController();
    let calls = 0;
    const p = watchIndex({ source: "claude", intervalMin: 1 }, () => {}, ac.signal, {
      index: async () => {
        calls++;
        throw new Error("disk error");
      },
    });
    while (calls < 2) await sleep(5);
    ac.abort();
    await p;
    expect(calls).toBeGreaterThan(1);
  });
});

describe("watchSync", () => {
  test("started unauthenticated, fail mode rejects immediately", async () => {
    await expect(
      watchSync(syncOpts({ onUnauthenticated: "fail" }), () => {}, new AbortController().signal, {
        resolveCredentials: async () => null,
        push: async () => ok(),
      }),
    ).rejects.toThrow(/logged in/i);
  });

  test("dormant mode waits while logged out, logs once, and recovers when a token appears", async () => {
    const ac = new AbortController();
    const lines: string[] = [];
    // preflight: null; loop pass 1: null (dormant); loop pass 2: a credential appears.
    const creds: Array<PushCredentials | null> = [null, null, { bearerToken: "tok" }];
    let i = 0;
    let pushed = 0;
    const p = watchSync(syncOpts({ onUnauthenticated: "dormant" }), (s) => lines.push(s), ac.signal, {
      resolveCredentials: async () => creds[Math.min(i++, creds.length - 1)] ?? null,
      push: async () => {
        pushed++;
        return ok();
      },
    });
    while (pushed === 0) await sleep(10);
    ac.abort();
    await p;
    expect(pushed).toBe(1);
    expect(lines.filter((l) => l.includes("Not logged in")).length).toBe(1);
  });

  test("a transient upload failure backs off, then a success is reported", async () => {
    const ac = new AbortController();
    const lines: string[] = [];
    let n = 0;
    const p = watchSync(syncOpts({ onUnauthenticated: "fail" }), (s) => lines.push(s), ac.signal, {
      resolveCredentials: async () => ({ bearerToken: "tok" }),
      push: async () => (n++ === 0 ? { ok: false, status: 500, body: "" } : ok()),
    });
    while (!lines.some((l) => l.includes("Uploaded"))) await sleep(10);
    ac.abort();
    await p;
    expect(lines.some((l) => l.includes("Uploaded (200)"))).toBe(true);
    expect(n).toBeGreaterThanOrEqual(2);
  });
});
