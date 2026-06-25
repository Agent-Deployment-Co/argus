// OpenAI / OpenAI-compatible provider. POST {baseUrl}/chat/completions with a Bearer key; the
// optional baseUrl makes this cover Ollama, LM Studio, vLLM, OpenRouter, and other compatible
// endpoints. The completion is choices[0].message.content.
import { httpComplete } from "../http.ts";
import type { HttpProviderContext, LlmResult } from "../types.ts";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-5";

function extractText(body: unknown): string {
  const choices = (body as { choices?: unknown } | null)?.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const content = (first as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content !== "string") throw new Error("OpenAI response had no message content");
  return content;
}

export function runOpenAiProvider(ctx: HttpProviderContext): Promise<LlmResult> {
  const base = (ctx.baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  return httpComplete(
    () => ({
      url: `${base}/chat/completions`,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ctx.apiKey}`,
        },
        body: JSON.stringify({
          model: ctx.model,
          max_tokens: ctx.maxTokens,
          messages: [
            ...(ctx.system ? [{ role: "system", content: ctx.system }] : []),
            { role: "user", content: ctx.prompt },
          ],
        }),
      },
    }),
    extractText,
    { fetch: ctx.fetch, signal: ctx.signal },
  );
}
