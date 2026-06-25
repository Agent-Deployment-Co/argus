// Shared HTTP transport for the API-backed LLM providers (anthropic/openai/gemini). Owns retry on
// 429/5xx (honoring `retry-after`), a response-size cap, and uniform error→LlmResult mapping, so each
// provider only has to shape its request and pluck the completion text out of the parsed body.
import { Backoff, sleep } from "../backoff.ts";
import type { LlmResult } from "./types.ts";

/** Cap on a single response body, mirroring the local providers' 32 MB subprocess buffer cap. */
export const MAX_LLM_RESPONSE_BYTES = 32 * 1024 * 1024;

const DEFAULT_MAX_ATTEMPTS = 3;

export interface HttpAttempt {
  url: string;
  init: RequestInit;
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Pull a human-readable reason out of an error response body, falling back to the status. */
function describeHttpError(status: number, bodyText: string): string {
  const trimmed = bodyText.trim();
  if (trimmed) {
    try {
      const body = JSON.parse(trimmed) as Record<string, unknown>;
      const err = body.error;
      if (err && typeof err === "object") {
        const message = (err as Record<string, unknown>).message;
        if (typeof message === "string" && message) return `HTTP ${status}: ${message}`;
      }
      if (typeof body.message === "string" && body.message) return `HTTP ${status}: ${body.message}`;
    } catch {
      // Non-JSON error body — fall through to a truncated raw snippet.
    }
    return `HTTP ${status}: ${trimmed.slice(0, 300)}`;
  }
  return `HTTP ${status}`;
}

/**
 * Run an HTTP completion with retry. `build` is called per attempt to produce the request; `extract`
 * turns the parsed JSON body into the completion text (throwing if the shape is wrong). Returns a
 * `LlmResult` and never throws: network errors, auth failures, oversized bodies, and bad shapes all
 * come back as `ok: false` with a diagnostic.
 */
export async function httpComplete(
  build: () => HttpAttempt,
  extract: (body: unknown) => string,
  opts: { fetch: typeof fetch; signal?: AbortSignal; maxAttempts?: number },
): Promise<LlmResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoff = new Backoff({ baseMs: 500, capMs: 8_000 });
  let lastError = "request failed";
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) return { ok: false, text: "", error: "request aborted" };
    const { url, init } = build();

    let res: Response;
    try {
      res = await opts.fetch(url, { ...init, signal: opts.signal });
    } catch (err) {
      // Transport error (network down, DNS, abort) — retryable.
      lastError = err instanceof Error ? err.message : String(err);
      lastStatus = null;
      if (opts.signal?.aborted) return { ok: false, text: "", error: "request aborted" };
      if (attempt < maxAttempts) {
        await sleep(backoff.next(), opts.signal);
        continue;
      }
      break;
    }

    lastStatus = res.status;

    if (res.ok) {
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_LLM_RESPONSE_BYTES) {
        return { ok: false, text: "", error: "provider response exceeded size limit", status: res.status };
      }
      const text = await res.text();
      if (Buffer.byteLength(text, "utf8") > MAX_LLM_RESPONSE_BYTES) {
        return { ok: false, text: "", error: "provider response exceeded size limit", status: res.status };
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, text: "", error: "provider returned an invalid JSON response", status: res.status };
      }
      try {
        const completion = extract(body);
        if (!completion.trim()) {
          return { ok: false, text: "", error: "provider returned an empty completion", status: res.status };
        }
        return { ok: true, text: completion, status: res.status };
      } catch (err) {
        return {
          ok: false,
          text: "",
          error: err instanceof Error ? err.message : String(err),
          status: res.status,
        };
      }
    }

    // Non-2xx. 429 and 5xx are retryable; everything else (401/403/400/404) is terminal.
    const errText = await res.text().catch(() => "");
    lastError = describeHttpError(res.status, errText);
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxAttempts) {
      const wait = retryAfterMs(res.headers.get("retry-after")) ?? backoff.next();
      await sleep(wait, opts.signal);
      continue;
    }
    return { ok: false, text: "", error: lastError, status: res.status };
  }

  return { ok: false, text: "", error: lastError, status: lastStatus };
}
