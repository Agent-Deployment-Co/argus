import { afterEach, describe, expect, it } from "bun:test";
import { fetchSessionDetail, fetchSessions, type SessionListFilters } from "./sessions";
import { OFFLINE_MESSAGE } from "./http";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

const FILTERS: SessionListFilters = { sort: "recent" as SessionListFilters["sort"] };

describe("fetchSessions", () => {
  it("surfaces the offline message on a network error", async () => {
    global.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await expect(fetchSessions(FILTERS, 0)).rejects.toThrow(OFFLINE_MESSAGE);
  });

  it("surfaces the offline message on a 503 from the proxy's holding page", async () => {
    global.fetch = (async () => new Response("<html></html>", { status: 503 })) as typeof fetch;

    await expect(fetchSessions(FILTERS, 0)).rejects.toThrow(OFFLINE_MESSAGE);
  });
});

describe("fetchSessionDetail", () => {
  it("surfaces the offline message on a network error", async () => {
    global.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await expect(fetchSessionDetail("abc")).rejects.toThrow(OFFLINE_MESSAGE);
  });

  it("surfaces the offline message on a malformed body", async () => {
    global.fetch = (async () => new Response("<html></html>", { status: 200 })) as typeof fetch;

    await expect(fetchSessionDetail("abc")).rejects.toThrow(OFFLINE_MESSAGE);
  });
});
