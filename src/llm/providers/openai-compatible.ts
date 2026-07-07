// Shared OpenAI Chat Completions transport. The native `openai` provider and the `openrouter`
// provider (and any future OpenAI-compatible endpoint) build on this — each supplies its own base URL
// and the token-limit parameter that endpoint expects, so neither provider needs to know about the
// other. The completion is choices[0].message.content.
import { httpComplete } from "../http.ts";
import type { LlmResult, ProviderCall } from "../types.ts";

/** The token-limit field name. Native OpenAI (gpt-5 / o-series) requires `max_completion_tokens`;
 *  classic OpenAI-compatible servers (OpenRouter, Ollama, vLLM, LM Studio) use `max_tokens`. */
export type TokenParam = "max_tokens" | "max_completion_tokens";

function extractText(body: unknown): string {
  const choices = (body as { choices?: unknown } | null)?.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const content = (first as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content !== "string") throw new Error("OpenAI response had no message content");
  return content;
}

export function openaiCompatibleComplete(
  call: ProviderCall,
  opts: { baseUrl: string; tokenParam: TokenParam },
): Promise<LlmResult> {
  const base = opts.baseUrl.replace(/\/+$/, "");
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
          [opts.tokenParam]: call.maxTokens,
          // Structured output via `response_format` (json_schema); reasoning effort via
          // `reasoning_effort` (a string the reasoning models accept). Both omitted when unset so
          // non-reasoning models and endpoints that don't support schemas are unaffected.
          ...(call.schema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: { name: "output", schema: call.schema, strict: true },
                },
              }
            : {}),
          ...(call.effort ? { reasoning_effort: call.effort } : {}),
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
}
