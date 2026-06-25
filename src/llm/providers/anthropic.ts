// Anthropic Messages API provider. POST /v1/messages with x-api-key + anthropic-version; the request
// is a single user turn (optionally with a system prompt), and the completion is the concatenation of
// the response's text blocks.
import { httpComplete } from "../http.ts";
import type { HttpProviderContext, LlmResult } from "../types.ts";

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

export function runAnthropicProvider(ctx: HttpProviderContext): Promise<LlmResult> {
  return httpComplete(
    () => ({
      url: ANTHROPIC_API_URL,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ctx.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: ctx.model,
          max_tokens: ctx.maxTokens,
          ...(ctx.system ? { system: ctx.system } : {}),
          messages: [{ role: "user", content: ctx.prompt }],
        }),
      },
    }),
    extractText,
    { fetch: ctx.fetch, signal: ctx.signal },
  );
}
