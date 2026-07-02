// Shared fetch helpers for the JSON API. Keeps the same-origin CSRF marker and the error-extraction
// idiom in one place so the mutating calls (settings, secrets, reindex) can't drift apart.

/** Same-origin marker the mutating endpoints require (matches serve.ts `rejectCrossSite`). A
 *  cross-origin page can't set a custom header without a CORS preflight the server never grants, so
 *  this blocks CSRF against those endpoints. Spread into a request's `headers`. */
export const APP_HEADER = { "X-Argus-App": "1" } as const;

/** Shown whenever the local server can't be reached at all, or answers with something that isn't
 *  the JSON we expect (e.g. a proxy's HTML error page) — both usually mean Argus isn't running. */
export const OFFLINE_MESSAGE = "Couldn't reach Argus. Make sure Argus is running.";

/** `fetch` that treats a network failure or a 502/503/504 as "Argus isn't reachable" rather than
 *  a generic error — a gateway status means a proxy in front of Argus (e.g. the desktop app's
 *  front-door proxy, or a dev reverse proxy) is up but Argus itself isn't answering. Everything
 *  else (including other non-ok statuses) is returned as-is for the caller to handle. */
export async function fetchOrOffline(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch {
    throw new Error(OFFLINE_MESSAGE);
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new Error(OFFLINE_MESSAGE);
  return res;
}

/** Sentinel distinguishing "the body parsed to `null`" from "the body didn't parse as JSON at
 *  all" (e.g. an HTML holding page returned where JSON was expected). */
const PARSE_FAILED = Symbol("jsonOrThrow.parseFailed");

/** Parse a JSON response, throwing on a non-ok status with the server's `{ error }` message when it
 *  has one, else `"<fallback> (<status>)"`. Returns the parsed body on success. Centralizes the
 *  error-extraction block that the mutating API calls all share.
 *
 *  A response that claims success (`res.ok`) but doesn't actually parse as JSON is treated as
 *  offline rather than silently returning `null` — that combination only happens when something
 *  other than Argus answered the request. */
export async function jsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  const body = await res.json().catch(() => PARSE_FAILED);
  if (body === PARSE_FAILED) {
    if (res.ok) throw new Error(OFFLINE_MESSAGE);
    throw new Error(`${fallback} (${res.status})`);
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `${fallback} (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}
