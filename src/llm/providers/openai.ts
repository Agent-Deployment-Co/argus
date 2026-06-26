// OpenAI / OpenAI-compatible provider. POST {baseUrl}/chat/completions with a Bearer key; the
// optional baseUrl makes this cover self-hosted compatible endpoints (Ollama, LM Studio, vLLM).
// (OpenRouter has its own provider, which reuses this transport.) The completion is
// choices[0].message.content.
import { httpComplete } from "../http.ts";
import type { ProviderCall, ProviderDescriptor } from "../types.ts";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-5";

function extractText(body: unknown): string {
  const choices = (body as { choices?: unknown } | null)?.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const content = (first as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content !== "string") throw new Error("OpenAI response had no message content");
  return content;
}

export const openaiProvider: ProviderDescriptor = {
  name: "openai",
  apiKeyEnv: "OPENAI_API_KEY",
  defaultModel: DEFAULT_OPENAI_MODEL,
  requiresApiKey: true,
  complete(call: ProviderCall) {
    const base = (call.baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
    // Native OpenAI's newer models (gpt-5 / o-series) reject `max_tokens` and require
    // `max_completion_tokens`. OpenAI-*compatible* endpoints still speak classic OpenAI and want
    // `max_tokens` — this includes self-hosted servers (Ollama/vLLM/LM Studio) and the OpenRouter
    // provider, which reuses this transport with openrouter.ai as the base. Choose by host:
    // api.openai.com → the new field; anything else → the classic field.
    let nativeOpenAi = false;
    try {
      nativeOpenAi = new URL(base).hostname === "api.openai.com";
    } catch {
      // Unparseable base URL — treat as a compatible endpoint (classic field).
    }
    const tokenField = nativeOpenAi ? "max_completion_tokens" : "max_tokens";
    return httpComplete(
      () => ({
        url: `${base}/chat/completions`,
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${call.apiKey!}`,
          },
          body: JSON.stringify({
            model: call.model,
            [tokenField]: call.maxTokens,
            messages: [
              ...(call.system ? [{ role: "system", content: call.system }] : []),
              { role: "user", content: call.prompt },
            ],
          }),
        },
      }),
      extractText,
      { fetch: call.fetch, signal: call.signal },
    );
  },
};
