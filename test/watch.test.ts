// Must be first: point ARGUS_CONFIG_DIR at an empty temp dir before paths.ts captures it, so the
// developer's real hub.url/hub.key can't flip watchSync into hub mode (and resolveHubConfig stays
// short-circuited before any keychain access).
import "./helpers/isolated-config.ts";
import { describe, expect, test } from "bun:test";
import { sleep } from "../src/backoff.ts";
import { pushSnapshotForOpts, watchIndex, watchSync, type WatchSyncOptions } from "../src/watch.ts";
import type { PushResult } from "../src/push.ts";

const ok = (status = 200): PushResult => ({ ok: true, status, body: "ok" });

const syncOpts = (over: Partial<WatchSyncOptions>): WatchSyncOptions => ({
  source: "claude",
  intervalMin: 1,
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
  test("pushSnapshotForOpts skips an explicit local-only source before resolving hub config", async () => {
    const lines: string[] = [];
    const res = await pushSnapshotForOpts({ source: "claude-chat" }, (s) => lines.push(s));

    expect(res).toMatchObject({ ok: true, skipped: true, status: 0 });
    expect(res.body).toContain("local-only source");
    expect(lines).toEqual([]);
  });

  test("a skipped push (local-only source) is not reported as an upload", async () => {
    const ac = new AbortController();
    const lines: string[] = [];
    let pushed = 0;
    const p = watchSync(syncOpts({}), (s) => lines.push(s), ac.signal, {
      push: async () => {
        pushed++;
        return { ok: true, skipped: true, status: 0, body: "Nothing to upload: \"claude-chat\" is a local-only source, not synced to the team dashboard." };
      },
    });
    while (!lines.some((l) => l.includes("Nothing to upload"))) await sleep(10);
    ac.abort();
    await p;
    expect(pushed).toBeGreaterThanOrEqual(1);
    // The skipped result must NOT fall into the "Uploaded" arm.
    expect(lines.some((l) => l.includes("Uploaded"))).toBe(false);
  });

  test("a permanent setup failure is logged and does not retry", async () => {
    const ac = new AbortController();
    const lines: string[] = [];
    let pushed = 0;
    const p = watchSync(syncOpts({}), (s) => lines.push(s), ac.signal, {
      push: async () => {
        pushed++;
        return { ok: false, status: 0, body: "No Hub configured. Set ARGUS_HUB_URL and ARGUS_HUB_KEY to upload usage data." };
      },
    });
    while (!lines.some((l) => l.includes("No Hub configured"))) await sleep(10);
    await sleep(20);
    ac.abort();
    await p;
    expect(pushed).toBe(1);
    expect(lines.some((l) => l.includes("Retrying"))).toBe(false);
  });

  test("a transient upload failure backs off, then a success is reported", async () => {
    const ac = new AbortController();
    const lines: string[] = [];
    let n = 0;
    const p = watchSync(syncOpts({}), (s) => lines.push(s), ac.signal, {
      push: async () => (n++ === 0 ? { ok: false, status: 500, body: "" } : ok()),
    });
    while (!lines.some((l) => l.includes("Uploaded"))) await sleep(10);
    ac.abort();
    await p;
    expect(lines.some((l) => l.includes("Uploaded (200)"))).toBe(true);
    expect(n).toBeGreaterThanOrEqual(2);
  });
});
