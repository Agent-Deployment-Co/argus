import { afterEach, describe, expect, it } from "bun:test";
import { fetchSnapshot } from "./snapshot";
import { OFFLINE_MESSAGE } from "./http";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("fetchSnapshot", () => {
  it("surfaces the offline message on a network error", async () => {
    global.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await expect(fetchSnapshot({})).rejects.toThrow(OFFLINE_MESSAGE);
  });

  it("surfaces the offline message on a 502/503/504 from the proxy's holding page", async () => {
    global.fetch = (async () => new Response("<html></html>", { status: 502 })) as typeof fetch;

    await expect(fetchSnapshot({})).rejects.toThrow(OFFLINE_MESSAGE);
  });
});
