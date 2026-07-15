import { describe, expect, test } from "bun:test";
import worker from "../src/worker/index.ts";

// Fakes for the Worker's structural DO/rate-limiter bindings (#281 Part 7) — no real Cloudflare
// account is available in this environment (same limitation as the rest of #281's de-risking), so
// this exercises only the Worker's own fetch-handler logic: does it forward to the DO, and does it
// actually consult/enforce the rate limiter before doing so.
function fakeEnv(opts: { limiterSuccess?: boolean; hasLimiter?: boolean } = {}) {
  let forwarded = 0;
  const stub = {
    fetch: async () => {
      forwarded++;
      return new Response("from-do", { status: 200 });
    },
  };
  const env = {
    DEMO_STORE: {
      idFromName: (name: string) => ({ name }),
      get: () => stub,
    },
    ...(opts.hasLimiter === false
      ? {}
      : {
          API_RATE_LIMITER: {
            limit: async (_o: { key: string }) => ({ success: opts.limiterSuccess ?? true }),
          },
        }),
  };
  return { env, forwardedCount: () => forwarded };
}

describe("Worker fetch handler (#281 Part 7)", () => {
  test("forwards /api/* to the DO when the rate limiter allows it", async () => {
    const { env, forwardedCount } = fakeEnv({ limiterSuccess: true });
    const res = await worker.fetch(new Request("https://argus-demo.example/api/usage/daily"), env as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from-do");
    expect(forwardedCount()).toBe(1);
  });

  test("returns 429 instead of forwarding when the rate limiter rejects the request", async () => {
    const { env, forwardedCount } = fakeEnv({ limiterSuccess: false });
    const res = await worker.fetch(new Request("https://argus-demo.example/api/sessions"), env as never);
    expect(res.status).toBe(429);
    expect(forwardedCount()).toBe(0);
  });

  test("does not consult the rate limiter for /healthz", async () => {
    const { env, forwardedCount } = fakeEnv({ limiterSuccess: false });
    const res = await worker.fetch(new Request("https://argus-demo.example/healthz"), env as never);
    expect(res.status).toBe(200);
    expect(forwardedCount()).toBe(1);
  });

  test("forwards /api/* unthrottled when no limiter binding is configured", async () => {
    const { env, forwardedCount } = fakeEnv({ hasLimiter: false });
    const res = await worker.fetch(new Request("https://argus-demo.example/api/health"), env as never);
    expect(res.status).toBe(200);
    expect(forwardedCount()).toBe(1);
  });
});
