// Worker entry point for the read-only public demo (#281 Part B.4). Static assets (the SPA built to
// dist/web) are served straight off the Assets binding by the platform, never through this file —
// wrangler.toml's `run_worker_first` list is the only reason this fetch handler ever runs at all,
// restricted to exactly the paths the DO actually answers. Everything this Worker does is forward the
// request to the one named DO instance; there is deliberately no routing logic here to keep in sync
// with createApp's own route table.
import { ArgusDemoStore, type DemoEnv } from "./argus-demo-store.ts";

export { ArgusDemoStore };

interface DurableObjectId {
  readonly name?: string;
}
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/** The `unsafe.bindings` Rate Limiting API shape (wrangler.toml's `API_RATE_LIMITER`). Not in
 *  `@cloudflare/workers-types` at this binding's current maturity, so declared structurally here
 *  like sql-driver.ts does for the DO SQL API. */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env extends DemoEnv {
  DEMO_STORE: DurableObjectNamespace;
  API_RATE_LIMITER?: RateLimiter;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Anonymous public demo: cap /api/* per client IP so one visitor (or a script) can't hammer the
    // shared DO instance. /healthz is unthrottled (cheap, used for uptime checks); /admin/seed has
    // its own bearer-token gate and is only ever called by the nightly Action, not a browser.
    if (url.pathname.startsWith("/api/") && env.API_RATE_LIMITER) {
      const key = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.API_RATE_LIMITER.limit({ key });
      if (!success) return new Response("Too many requests.", { status: 429 });
    }

    // One named instance (not one per client) — the whole point is a single shared, nightly-reseeded
    // corpus every visitor reads, not a store-per-session.
    const id = env.DEMO_STORE.idFromName("demo");
    const stub = env.DEMO_STORE.get(id);
    return stub.fetch(request);
  },
};
