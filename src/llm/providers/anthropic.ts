// Anthropic Messages API provider. POST /v1/messages with x-api-key + anthropic-version; the request
// is a single user turn (optionally with a system prompt), and the completion is the concatenation of
// the response's text blocks.
import { httpComplete } from "../http.ts";
import type { ProviderCall, ProviderDescriptor } from "../types.ts";

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
/** Deliberately cheap — these are high-volume per-session/per-task calls (mirrors `claude --model haiku`). */
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";

function extractText(body: unknown): string {
  const blocks = (body as { content?: unknown } | null)?.content;
  if (!Array.isArray(blocks)) throw new Error("Anthropic response had no content array");
  return blocks
    .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text")
    .map((b) => b.text)
    .join("");
}

export const claudeApiProvider: ProviderDescriptor = {
  name: "claude-api",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  defaultModel: DEFAULT_ANTHROPIC_MODEL,
  requiresApiKey: true,
  configFields: ["model", "apiKeyEnv", "maxTokens", "effort"],
  complete(call: ProviderCall) {
    return httpComplete(
      () => ({
        url: ANTHROPIC_API_URL,
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": call.apiKey!,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: call.model,
            max_tokens: call.maxTokens,
            ...(call.system ? { system: call.system } : {}),
            // Structured output + reasoning effort both live under `output_config` (GA, no beta
            // header). `format` constrains the response to the JSON schema; `effort` is passed
            // through untranslated. Omitted entirely when unset — the default haiku model rejects an
            // effort parameter, and an absent schema keeps the plain-text path.
            ...(call.schema || call.effort
              ? {
                  output_config: {
                    ...(call.schema ? { format: { type: "json_schema", schema: call.schema } } : {}),
                    ...(call.effort ? { effort: call.effort } : {}),
                  },
                }
              : {}),
            messages: [{ role: "user", content: call.prompt }],
          }),
        },
      }),
      extractText,
      { fetch: call.fetch, signal: call.signal },
    );
  },
};
