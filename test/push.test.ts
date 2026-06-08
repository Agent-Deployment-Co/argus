import { describe, expect, test, mock, beforeAll, afterAll } from "bun:test";
import { detectOrg, pushSnapshot } from "../src/push.ts";
import type { PushPayload } from "../src/push.ts";

describe("detectOrg", () => {
  test("explicit override wins", () => {
    expect(detectOrg("acme.test", "mando@gradient.works")).toBe("acme.test");
    expect(detectOrg("  spaced  ", "x")).toBe("spaced");
  });

  test("derives org from the email domain when no override", () => {
    expect(detectOrg(undefined, "mando@gradient.works")).toBe("gradient.works");
  });

  test("returns undefined for a bare user (org then comes from the token server-side)", () => {
    expect(detectOrg(undefined, "bob")).toBeUndefined();
    expect(detectOrg(undefined, "trailing@")).toBeUndefined();
  });
});

describe("pushSnapshot", () => {
  const dummyPayload = {
    schemaVersion: 1,
    org: "acme.test",
    user: "user@acme.test",
    generatedAtMs: 123456789,
    dashboard: {} as any,
  };

  test("sends JWT header when credentials have jwt", async () => {
    const originalFetch = globalThis.fetch;
    let sentHeaders: Record<string, string> = {};

    globalThis.fetch = async (url, options) => {
      sentHeaders = (options?.headers as Record<string, string>) || {};
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => "success",
      } as Response;
    };

    try {
      const res = await pushSnapshot(
        "https://api.test",
        { jwt: "dummy-jwt" },
        dummyPayload,
      );

      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(res.body).toBe("success");
      expect(res.isAccessChallenge).toBe(false);
      expect(sentHeaders["cf-access-token"]).toBe("dummy-jwt");
      expect(sentHeaders["cf-access-client-id"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends client ID and secret when credentials have service tokens", async () => {
    const originalFetch = globalThis.fetch;
    let sentHeaders: Record<string, string> = {};

    globalThis.fetch = async (url, options) => {
      sentHeaders = (options?.headers as Record<string, string>) || {};
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => "success",
      } as Response;
    };

    try {
      const res = await pushSnapshot(
        "https://api.test",
        { clientId: "my-id", clientSecret: "my-secret" },
        dummyPayload,
      );

      expect(res.ok).toBe(true);
      expect(sentHeaders["cf-access-client-id"]).toBe("my-id");
      expect(sentHeaders["cf-access-client-secret"]).toBe("my-secret");
      expect(sentHeaders["cf-access-token"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("detects Access login challenge (HTML response)", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, options) => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        text: async () => "<!DOCTYPE html><html><body>Access Denied</body></html>",
      } as Response;
    };

    try {
      const res = await pushSnapshot(
        "https://api.test",
        { jwt: "expired-jwt" },
        dummyPayload,
      );

      expect(res.ok).toBe(false); // Should be false because it is an Access challenge
      expect(res.isAccessChallenge).toBe(true);
      expect(res.body).toContain("Access Denied");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
