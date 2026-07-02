import { afterEach, describe, expect, it } from "bun:test";
import { fetchOrOffline, jsonOrThrow, OFFLINE_MESSAGE } from "./http";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlResponse(status: number): Response {
  return new Response("<html>holding page</html>", {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

describe("fetchOrOffline", () => {
  it("throws the offline message on a network error", async () => {
    global.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await expect(fetchOrOffline("/api/sessions")).rejects.toThrow(OFFLINE_MESSAGE);
  });

  it.each([502, 503, 504])("throws the offline message on a %d gateway status", async (status) => {
    global.fetch = (async () => htmlResponse(status)) as typeof fetch;

    await expect(fetchOrOffline("/api/sessions")).rejects.toThrow(OFFLINE_MESSAGE);
  });

  it("returns the response as-is for other statuses", async () => {
    global.fetch = (async () => jsonResponse(200, { ok: true })) as typeof fetch;

    const res = await fetchOrOffline("/api/sessions");
    expect(res.status).toBe(200);
  });
});

describe("jsonOrThrow", () => {
  it("returns the parsed body on success", async () => {
    const body = await jsonOrThrow<{ ok: boolean }>(jsonResponse(200, { ok: true }), "failed");
    expect(body).toEqual({ ok: true });
  });

  it("throws the offline message when an ok response doesn't parse as JSON", async () => {
    await expect(jsonOrThrow(htmlResponse(200), "failed")).rejects.toThrow(OFFLINE_MESSAGE);
  });

  it("throws the server's error message on a non-ok JSON response", async () => {
    await expect(jsonOrThrow(jsonResponse(400, { error: "bad request" }), "failed")).rejects.toThrow(
      "bad request",
    );
  });

  it("throws the fallback message on a non-ok response with an unparseable body", async () => {
    await expect(jsonOrThrow(htmlResponse(500), "Failed to load")).rejects.toThrow("Failed to load (500)");
  });
});
