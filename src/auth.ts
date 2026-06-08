import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname } from "node:path";

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
}

interface AuthorizationServerMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface ClientRegistration {
  client_id?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export interface ManagedOAuthTokenCache {
  version: 1;
  endpoint: string;
  resource: string;
  clientId: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

export interface LegacyAccessTokenCache {
  token: string;
}

export type AccessTokenCache = ManagedOAuthTokenCache | LegacyAccessTokenCache;

export interface LoginOptions {
  fetch?: typeof fetch;
  log?: (message: string) => void;
  now?: () => number;
  openBrowser?: (url: string) => boolean | Promise<boolean>;
  timeoutMs?: number;
}

const CALLBACK_PATH = "/callback";
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_EXPIRY_SKEW_MS = 30 * 1000;

function normalizeEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported endpoint protocol: ${url.protocol}`);
  }
  return url.href.replace(/\/+$/, "");
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  description: string,
): Promise<T> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const detail =
      body && typeof body === "object"
        ? String(
            (body as Record<string, unknown>).error_description ||
              (body as Record<string, unknown>).error ||
              "",
          )
        : "";
    throw new Error(`${description} failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (!body || typeof body !== "object") {
    throw new Error(`${description} returned an invalid JSON response`);
  }
  return body as T;
}

function requiredString(value: string | undefined, description: string): string {
  if (!value) throw new Error(`Cloudflare OAuth metadata is missing ${description}`);
  return value;
}

function generatePkce(): { verifier: string; challenge: string } {
  while (true) {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (/^[A-Za-z0-9]/.test(challenge)) return { verifier, challenge };
  }
}

function openBrowser(url: string): boolean {
  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "rundll32";
    args = ["url.dll,FileProtocolHandler", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
}

interface CallbackListener {
  redirectUri: string;
  waitForCode: Promise<string>;
  close: () => Promise<void>;
}

async function createLoopbackServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 49152 + (randomBytes(2).readUInt16BE(0) % (65535 - 49152 + 1));
    const server = createServer(handler);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      });
      return { server, port };
    } catch (err) {
      server.close();
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error("Could not find an available local port for OAuth login");
}

async function startCallbackListener(expectedState: string, timeoutMs: number): Promise<CallbackListener> {
  let server: Server;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  void waitForCode.catch(() => {});

  const finish = (error?: Error, code?: string) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (error) rejectCode(error);
    else resolveCode(code!);
  };

  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const error = url.searchParams.get("error");
    const description = url.searchParams.get("error_description");
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");

    if (error) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<h1>Argus login failed</h1><p>Return to the terminal for details.</p>");
      finish(new Error(`${error}${description ? `: ${description}` : ""}`));
    } else if (state !== expectedState) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Invalid OAuth state");
      finish(new Error("OAuth callback state did not match"));
    } else if (!code) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing authorization code");
      finish(new Error("OAuth callback did not include an authorization code"));
    } else {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<h1>Argus login complete</h1><p>You can close this tab.</p>");
      finish(undefined, code);
    }
  };

  const listener = await createLoopbackServer(handler);
  server = listener.server;
  if (!settled) {
    timer = setTimeout(() => {
      finish(new Error("Timed out waiting for browser authentication"));
      server.close();
    }, timeoutMs);
    timer.unref();
  }

  return {
    redirectUri: `http://127.0.0.1:${listener.port}${CALLBACK_PATH}`,
    waitForCode,
    close: () =>
      new Promise<void>((resolve) => {
        if (!settled) {
          settled = true;
          if (timer) clearTimeout(timer);
        }
        if (!server.listening) resolve();
        else server.close(() => resolve());
      }),
  };
}

function validateAuthorizationServer(metadata: AuthorizationServerMetadata): void {
  if (!metadata.grant_types_supported?.includes("authorization_code")) {
    throw new Error("Cloudflare OAuth server does not support authorization_code");
  }
  if (!metadata.grant_types_supported.includes("refresh_token")) {
    throw new Error("Cloudflare OAuth server does not support refresh_token");
  }
  if (!metadata.token_endpoint_auth_methods_supported?.includes("none")) {
    throw new Error("Cloudflare OAuth server does not support public clients");
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("Cloudflare OAuth server does not support PKCE S256");
  }
}

function tokenCacheFromResponse(
  token: TokenResponse,
  context: Omit<ManagedOAuthTokenCache, "accessToken" | "refreshToken" | "expiresAtMs">,
  now: number,
  previousRefreshToken?: string,
): ManagedOAuthTokenCache {
  const accessToken = requiredString(token.access_token, "access_token");
  const refreshToken = token.refresh_token || previousRefreshToken;
  if (!refreshToken) throw new Error("Cloudflare OAuth response is missing refresh_token");
  if (!Number.isFinite(token.expires_in) || token.expires_in! <= 0) {
    throw new Error("Cloudflare OAuth response has an invalid expires_in");
  }
  return {
    ...context,
    accessToken,
    refreshToken,
    expiresAtMs: now + token.expires_in! * 1000,
  };
}

export function isManagedOAuthTokenCache(value: unknown): value is ManagedOAuthTokenCache {
  if (!value || typeof value !== "object") return false;
  const cache = value as Record<string, unknown>;
  return (
    cache.version === 1 &&
    typeof cache.endpoint === "string" &&
    typeof cache.resource === "string" &&
    typeof cache.clientId === "string" &&
    typeof cache.tokenEndpoint === "string" &&
    typeof cache.accessToken === "string" &&
    typeof cache.refreshToken === "string" &&
    typeof cache.expiresAtMs === "number"
  );
}

export function isLegacyAccessTokenCache(value: unknown): value is LegacyAccessTokenCache {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).token === "string"
  );
}

export function loadAccessTokenCache(path: string): AccessTokenCache | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isManagedOAuthTokenCache(value) || isLegacyAccessTokenCache(value)) return value;
  } catch {
    // Missing, unreadable, and malformed caches are all treated as unauthenticated.
  }
  return undefined;
}

export function saveAccessTokenCache(path: string, cache: ManagedOAuthTokenCache): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function oauthCacheMatchesEndpoint(cache: ManagedOAuthTokenCache, endpoint: string): boolean {
  return cache.endpoint === normalizeEndpoint(endpoint);
}

export function oauthTokenIsFresh(cache: ManagedOAuthTokenCache, now = Date.now()): boolean {
  return cache.expiresAtMs - TOKEN_EXPIRY_SKEW_MS > now;
}

export async function loginWithManagedOAuth(
  endpoint: string,
  options: LoginOptions = {},
): Promise<ManagedOAuthTokenCache> {
  const endpointUrl = normalizeEndpoint(endpoint);
  const fetchImpl = options.fetch || fetch;
  const log = options.log || (() => {});
  const now = options.now || Date.now;
  const launchBrowser = options.openBrowser || openBrowser;
  const timeoutMs = options.timeoutMs || DEFAULT_LOGIN_TIMEOUT_MS;

  const resourceMetadataUrl = new URL(
    "/.well-known/cloudflare-access-protected-resource/",
    endpointUrl,
  ).href;
  const resourceMetadata = await requestJson<ProtectedResourceMetadata>(
    fetchImpl,
    resourceMetadataUrl,
    undefined,
    "Cloudflare protected-resource discovery",
  );
  const authorizationServer = requiredString(
    resourceMetadata.authorization_servers?.[0],
    "authorization_servers",
  );
  const resource = requiredString(resourceMetadata.resource, "resource");
  const serverMetadataUrl = new URL(
    "/.well-known/oauth-authorization-server",
    authorizationServer,
  ).href;
  const serverMetadata = await requestJson<AuthorizationServerMetadata>(
    fetchImpl,
    serverMetadataUrl,
    undefined,
    "Cloudflare authorization-server discovery",
  );
  validateAuthorizationServer(serverMetadata);

  const registrationEndpoint = requiredString(
    serverMetadata.registration_endpoint,
    "registration_endpoint",
  );
  const authorizationEndpoint = requiredString(
    serverMetadata.authorization_endpoint,
    "authorization_endpoint",
  );
  const tokenEndpoint = requiredString(serverMetadata.token_endpoint, "token_endpoint");
  const state = randomBytes(24).toString("base64url");
  const listener = await startCallbackListener(state, timeoutMs);

  try {
    const registration = await requestJson<ClientRegistration>(
      fetchImpl,
      registrationEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [listener.redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
          resource,
        }),
      },
      "Cloudflare OAuth client registration",
    );
    const clientId = requiredString(registration.client_id, "client_id");
    const { verifier, challenge } = generatePkce();
    const authorizationUrl = new URL(authorizationEndpoint);
    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("redirect_uri", listener.redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("resource", resource);
    authorizationUrl.searchParams.set("state", state);

    log("Open this URL to authenticate:");
    log(`  ${authorizationUrl.href}`);
    const opened = await launchBrowser(authorizationUrl.href);
    if (!opened) log("Could not open a browser automatically; open the URL above manually.");

    const code = await listener.waitForCode;
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: listener.redirectUri,
      code_verifier: verifier,
    });
    const token = await requestJson<TokenResponse>(
      fetchImpl,
      tokenEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
      },
      "Cloudflare OAuth token exchange",
    );

    return tokenCacheFromResponse(
      token,
      {
        version: 1,
        endpoint: endpointUrl,
        resource,
        clientId,
        tokenEndpoint,
      },
      now(),
    );
  } finally {
    await listener.close();
  }
}

export async function refreshManagedOAuthToken(
  cache: ManagedOAuthTokenCache,
  options: Pick<LoginOptions, "fetch" | "now"> = {},
): Promise<ManagedOAuthTokenCache> {
  const fetchImpl = options.fetch || fetch;
  const now = options.now || Date.now;
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cache.refreshToken,
    client_id: cache.clientId,
  });
  const token = await requestJson<TokenResponse>(
    fetchImpl,
    cache.tokenEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    },
    "Cloudflare OAuth token refresh",
  );
  return tokenCacheFromResponse(
    token,
    {
      version: 1,
      endpoint: cache.endpoint,
      resource: cache.resource,
      clientId: cache.clientId,
      tokenEndpoint: cache.tokenEndpoint,
    },
    now(),
    cache.refreshToken,
  );
}
