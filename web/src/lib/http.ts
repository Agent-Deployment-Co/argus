// Shared fetch helpers for the JSON API. Keeps the same-origin CSRF marker and the error-extraction
// idiom in one place so the mutating calls (settings, secrets, reindex) can't drift apart.

/** Same-origin marker the mutating endpoints require (matches serve.ts `rejectCrossSite`). A
 *  cross-origin page can't set a custom header without a CORS preflight the server never grants, so
 *  this blocks CSRF against those endpoints. Spread into a request's `headers`. */
export const APP_HEADER = { "X-Argus-App": "1" } as const;

/** Parse a JSON response, throwing on a non-ok status with the server's `{ error }` message when it
 *  has one, else `"<fallback> (<status>)"`. Returns the parsed body on success. Centralizes the
 *  error-extraction block that the mutating API calls all share. */
export async function jsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `${fallback} (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}
