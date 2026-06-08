import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAccessTokenCache,
  loginWithManagedOAuth,
  oauthCacheMatchesEndpoint,
  oauthTokenIsFresh,
  refreshManagedOAuthToken,
  saveAccessTokenCache,
  type ManagedOAuthTokenCache,
} from "../src/auth.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Managed OAuth login", () => {
  test("discovers, registers, completes PKCE, and exchanges the callback code", async () => {
    let registeredRedirect = "";
    let authorizationChallenge = "";
    let openedUrl = "";
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.test/.well-known/cloudflare-access-protected-resource/") {
        return jsonResponse({
          resource: "https://api.test",
          authorization_servers: ["https://team.cloudflareaccess.com"],
        });
      }
      if (url === "https://team.cloudflareaccess.com/.well-known/oauth-authorization-server") {
        return jsonResponse({
          authorization_endpoint:
            "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/authorization",
          token_endpoint: "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/token",
          registration_endpoint:
            "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/registration",
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url === "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/registration") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        registeredRedirect = (body.redirect_uris as string[])[0]!;
        expect(body).toEqual({
          redirect_uris: [registeredRedirect],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
          resource: "https://api.test",
        });
        expect(registeredRedirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        return jsonResponse({ client_id: "client-123" }, 201);
      }
      if (url === "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/token") {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code")).toBe("auth-code");
        expect(form.get("client_id")).toBe("client-123");
        expect(form.get("redirect_uri")).toBe(registeredRedirect);
        const verifier = form.get("code_verifier")!;
        expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
          authorizationChallenge,
        );
        return jsonResponse({
          access_token: "oauth:access",
          refresh_token: "oauth:refresh",
          token_type: "bearer",
          expires_in: 900,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    const cache = await loginWithManagedOAuth("https://api.test/", {
      fetch: fetchImpl,
      now: () => 1_000_000,
      openBrowser: async (url) => {
        openedUrl = url;
        const authorizationUrl = new URL(url);
        expect(authorizationUrl.searchParams.get("client_id")).toBe("client-123");
        expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(registeredRedirect);
        expect(authorizationUrl.searchParams.get("resource")).toBe("https://api.test");
        expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
        authorizationChallenge = authorizationUrl.searchParams.get("code_challenge")!;
        expect(authorizationChallenge).toMatch(/^[A-Za-z0-9]/);
        const callback = new URL(registeredRedirect);
        callback.searchParams.set("code", "auth-code");
        callback.searchParams.set("state", authorizationUrl.searchParams.get("state")!);
        const response = await fetch(callback);
        expect(response.status).toBe(200);
        await response.text();
        return true;
      },
    });

    expect(openedUrl).toStartWith(
      "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/authorization?",
    );
    expect(cache).toEqual({
      version: 1,
      endpoint: "https://api.test",
      resource: "https://api.test",
      clientId: "client-123",
      tokenEndpoint: "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/token",
      accessToken: "oauth:access",
      refreshToken: "oauth:refresh",
      expiresAtMs: 1_900_000,
    });
  });

  test("rejects a callback with the wrong state", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("cloudflare-access-protected-resource")) {
        return jsonResponse({
          resource: "https://api.test",
          authorization_servers: ["https://team.cloudflareaccess.com"],
        });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse({
          authorization_endpoint: "https://team.cloudflareaccess.com/authorize",
          token_endpoint: "https://team.cloudflareaccess.com/token",
          registration_endpoint: "https://team.cloudflareaccess.com/register",
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.endsWith("/register")) return jsonResponse({ client_id: "client-123" }, 201);
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await expect(
      loginWithManagedOAuth("https://api.test", {
        fetch: fetchImpl,
        openBrowser: (url) => {
          const authorizationUrl = new URL(url);
          const callback = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
          callback.searchParams.set("code", "auth-code");
          callback.searchParams.set("state", "wrong-state");
          setTimeout(() => {
            void fetch(callback);
          }, 0);
          return true;
        },
      }),
    ).rejects.toThrow("OAuth callback state did not match");
  });
});

describe("Managed OAuth cache", () => {
  const cache: ManagedOAuthTokenCache = {
    version: 1,
    endpoint: "https://api.test",
    resource: "https://api.test",
    clientId: "client-123",
    tokenEndpoint: "https://team.cloudflareaccess.com/token",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAtMs: 200_000,
  };

  test("refreshes an expired token and accepts refresh-token rotation", async () => {
    const refreshed = await refreshManagedOAuthToken(cache, {
      now: () => 300_000,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(cache.tokenEndpoint);
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("refresh_token")).toBe("old-refresh");
        expect(form.get("client_id")).toBe("client-123");
        return jsonResponse({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 600,
        });
      }) as typeof fetch,
    });

    expect(refreshed.accessToken).toBe("new-access");
    expect(refreshed.refreshToken).toBe("new-refresh");
    expect(refreshed.expiresAtMs).toBe(900_000);
  });

  test("preserves the refresh token when the refresh response omits it", async () => {
    const refreshed = await refreshManagedOAuthToken(cache, {
      fetch: (async () =>
        jsonResponse({
          access_token: "new-access",
          expires_in: 600,
        })) as unknown as typeof fetch,
    });
    expect(refreshed.refreshToken).toBe("old-refresh");
  });

  test("matches normalized endpoints and uses an expiry safety window", () => {
    expect(oauthCacheMatchesEndpoint(cache, "https://api.test/")).toBe(true);
    expect(oauthCacheMatchesEndpoint(cache, "https://other.test")).toBe(false);
    expect(oauthTokenIsFresh(cache, 169_999)).toBe(true);
    expect(oauthTokenIsFresh(cache, 170_000)).toBe(false);
  });

  test("writes and reloads a mode-0600 cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-auth-"));
    tempDirs.push(dir);
    const path = join(dir, "nested", "token.json");

    saveAccessTokenCache(path, cache);

    expect(loadAccessTokenCache(path)).toEqual(cache);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).accessToken).toBe("old-access");
  });
});
