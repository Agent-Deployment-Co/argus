import { describe, expect, test, mock, beforeAll, afterAll } from "bun:test";
import { detectOrg, pushSnapshot, SCHEMA_VERSION } from "../src/push.ts";
import type { PushPayload } from "../src/push.ts";

describe("detectOrg", () => {
  test("returns a trimmed explicit override", () => {
    expect(detectOrg("acme.test")).toBe("acme.test");
    expect(detectOrg("  spaced  ")).toBe("spaced");
  });

  test("omits org by default so the server uses the authenticated Access org", () => {
    expect(detectOrg()).toBeUndefined();
    expect(detectOrg("  ")).toBeUndefined();
  });
});

describe("pushSnapshot", () => {
  const dummyPayload = {
    schemaVersion: SCHEMA_VERSION as any,
    org: "acme.test",
    user: "user@acme.test",
    generatedAtMs: 123456789,
    dashboard: {} as any,
  };

  test("sends JWT header when credentials have jwt", async () => {
    const originalFetch = globalThis.fetch;
    let sentHeaders: Record<string, string> = {};

    globalThis.fetch = (async (url: any, options: any) => {
      sentHeaders = (options?.headers as Record<string, string>) || {};
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => "success",
      } as Response;
    }) as any;

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

  test("sends OAuth access tokens as bearer authorization", async () => {
    const originalFetch = globalThis.fetch;
    let sentHeaders: Record<string, string> = {};

    globalThis.fetch = (async (url: any, options: any) => {
      sentHeaders = (options?.headers as Record<string, string>) || {};
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => "success",
      } as Response;
    }) as any;

    try {
      const res = await pushSnapshot(
        "https://api.test",
        { bearerToken: "oauth-token" },
        dummyPayload,
      );

      expect(res.ok).toBe(true);
      expect(sentHeaders.authorization).toBe("Bearer oauth-token");
      expect(sentHeaders["cf-access-token"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends client ID and secret when credentials have service tokens", async () => {
    const originalFetch = globalThis.fetch;
    let sentHeaders: Record<string, string> = {};

    globalThis.fetch = (async (url: any, options: any) => {
      sentHeaders = (options?.headers as Record<string, string>) || {};
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => "success",
      } as Response;
    }) as any;

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

    globalThis.fetch = (async (url: any, options: any) => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        text: async () => "<!DOCTYPE html><html><body>Access Denied</body></html>",
      } as Response;
    }) as any;

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

  test("detects a Managed OAuth Access challenge", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 401,
        headers: new Headers({
          "content-type": "application/json",
          "www-authenticate":
            'Bearer realm="OAuth", resource_metadata="https://api.test/.well-known/cloudflare-access-protected-resource/"',
        }),
        text: async () => JSON.stringify({ error: "invalid_token" }),
      } as Response;
    }) as any;

    try {
      const res = await pushSnapshot(
        "https://api.test",
        { bearerToken: "expired-oauth-token" },
        dummyPayload,
      );

      expect(res.ok).toBe(false);
      expect(res.isAccessChallenge).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
