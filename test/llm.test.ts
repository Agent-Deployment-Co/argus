import { describe, expect, test } from "bun:test";
import {
  complete,
  getProvider,
  isLlmProvider,
  LLM_PROVIDERS,
  PROVIDER_API_KEY_ENVS,
  type LlmProvider,
} from "../src/llm/index.ts";
import type { ResolvedLlmConfig } from "../src/llm/types.ts";

/** A recording fake fetch that returns scripted responses in order. */
function fakeFetch(responses: Array<Response | (() => Response)>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const cfg = (over: Partial<ResolvedLlmConfig> & { provider: LlmProvider }): ResolvedLlmConfig => ({
  apiKey: "test-key",
  ...over,
});

describe("provider registry (single source of truth)", () => {
  test("every provider name resolves to its descriptor; unknown → undefined", () => {
    for (const name of LLM_PROVIDERS) expect(getProvider(name)?.name).toBe(name);
    expect(getProvider("nope")).toBeUndefined();
    expect(isLlmProvider("claude-api")).toBe(true);
    expect(isLlmProvider("nope")).toBe(false);
  });

  test("the secret allowlist + key requirement derive from descriptors", () => {
    expect([...PROVIDER_API_KEY_ENVS].sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
    expect(getProvider("claude-api")?.requiresApiKey).toBe(true);
    expect(getProvider("claude-cli")?.requiresApiKey).toBeUndefined();
  });

  test("an unknown provider → ok:false, never throws", async () => {
    const res = await complete({ prompt: "x" }, { provider: "bogus" as LlmProvider });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Unknown");
  });
});

describe("llm client routing", () => {
  test("off → ok:false with a clear reason, no fetch", async () => {
    const { fetch, calls } = fakeFetch([json({})]);
    const res = await complete({ prompt: "hi" }, cfg({ provider: "off" }), { fetch });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("No LLM provider");
    expect(calls).toHaveLength(0);
  });

  test("hub → not implemented", async () => {
    const res = await complete({ prompt: "hi" }, cfg({ provider: "hub" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("hub");
  });

  test("http provider with no key → diagnostic naming the env var", async () => {
    const res = await complete(
      { prompt: "hi" },
      { provider: "claude-api", apiKeyEnv: "ANTHROPIC_API_KEY" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ANTHROPIC_API_KEY");
  });
});

describe("anthropic provider", () => {
  test("shapes the request and extracts text", async () => {
    const { fetch, calls } = fakeFetch([json({ content: [{ type: "text", text: "hello world" }] })]);
    const res = await complete(
      { prompt: "the data", system: "be brief", maxTokens: 99 },
      cfg({ provider: "claude-api", model: "claude-haiku-4-5" }),
      { fetch },
    );
    expect(res.ok).toBe(true);
    expect(res.text).toBe("hello world");
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({
      model: "claude-haiku-4-5",
      max_tokens: 99,
      system: "be brief",
      messages: [{ role: "user", content: "the data" }],
    });
  });

  test("uses the default model when unset", async () => {
    const { fetch, calls } = fakeFetch([json({ content: [{ type: "text", text: "x" }] })]);
    await complete({ prompt: "p" }, cfg({ provider: "claude-api" }), { fetch });
    expect(JSON.parse(calls[0]!.init.body as string).model).toBe("claude-haiku-4-5");
  });
});

describe("openai provider", () => {
  test("default base url, bearer auth, choices extraction", async () => {
    const { fetch, calls } = fakeFetch([
      json({ choices: [{ message: { content: "answer" } }] }),
    ]);
    const res = await complete({ prompt: "p" }, cfg({ provider: "openai", model: "gpt-5" }), { fetch });
    expect(res.text).toBe("answer");
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    // Native OpenAI: newer models require max_completion_tokens, not the (rejected) max_tokens.
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.max_completion_tokens).toBeDefined();
    expect(body.max_tokens).toBeUndefined();
  });

  test("honors a custom baseUrl (trailing slash trimmed) and uses classic max_tokens", async () => {
    const { fetch, calls } = fakeFetch([json({ choices: [{ message: { content: "ok" } }] })]);
    await complete(
      { prompt: "p" },
      cfg({ provider: "openai", baseUrl: "http://localhost:1234/v1/" }),
      { fetch },
    );
    expect(calls[0]!.url).toBe("http://localhost:1234/v1/chat/completions");
    // A self-hosted / compatible endpoint speaks classic OpenAI → max_tokens.
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.max_tokens).toBeDefined();
    expect(body.max_completion_tokens).toBeUndefined();
  });
});

describe("openrouter provider", () => {
  test("reuses the OpenAI transport against OpenRouter's base url (classic max_tokens)", async () => {
    const { fetch, calls } = fakeFetch([json({ choices: [{ message: { content: "via openrouter" } }] })]);
    const res = await complete(
      { prompt: "p" },
      cfg({ provider: "openrouter", model: "anthropic/claude-haiku-4.5" }),
      { fetch },
    );
    expect(res.text).toBe("via openrouter");
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("anthropic/claude-haiku-4.5");
    // OpenRouter is OpenAI-compatible (not api.openai.com) → classic max_tokens.
    expect(body.max_tokens).toBeDefined();
    expect(body.max_completion_tokens).toBeUndefined();
  });
});

describe("gemini provider", () => {
  test("model in the path, x-goog-api-key, parts extraction", async () => {
    const { fetch, calls } = fakeFetch([
      json({ candidates: [{ content: { parts: [{ text: "g1" }, { text: "g2" }] } }] }),
    ]);
    const res = await complete({ prompt: "p" }, cfg({ provider: "gemini", model: "gemini-2.5-flash" }), { fetch });
    expect(res.text).toBe("g1g2");
    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
  });
});

describe("error and retry paths", () => {
  test("retries on 429 then succeeds", async () => {
    const { fetch, calls } = fakeFetch([
      () => new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }),
      () => json({ content: [{ type: "text", text: "after retry" }] }),
    ]);
    const res = await complete({ prompt: "p" }, cfg({ provider: "claude-api" }), { fetch });
    expect(res.ok).toBe(true);
    expect(res.text).toBe("after retry");
    expect(calls).toHaveLength(2);
  });

  test("gives up after repeated 5xx", async () => {
    const { fetch, calls } = fakeFetch([
      () => new Response("boom", { status: 503, headers: { "retry-after": "0" } }),
    ]);
    const res = await complete({ prompt: "p" }, cfg({ provider: "claude-api" }), { fetch });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(calls.length).toBe(3); // maxAttempts
  });

  test("does not retry a 401", async () => {
    const { fetch, calls } = fakeFetch([() => new Response("nope", { status: 401 })]);
    const res = await complete({ prompt: "p" }, cfg({ provider: "claude-api" }), { fetch });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  test("malformed JSON body → ok:false", async () => {
    const { fetch } = fakeFetch([
      () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    const res = await complete({ prompt: "p" }, cfg({ provider: "claude-api" }), { fetch });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("invalid JSON");
  });

  test("oversized response (declared content-length) → ok:false", async () => {
    const { fetch } = fakeFetch([
      () =>
        json(
          { content: [{ type: "text", text: "x" }] },
          { headers: { "content-type": "application/json", "content-length": String(40 * 1024 * 1024) } },
        ),
    ]);
    const res = await complete({ prompt: "p" }, cfg({ provider: "claude-api" }), { fetch });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("size limit");
  });
});
