// Google Gemini (Generative Language API) provider. POST .../models/{model}:generateContent with an
// x-goog-api-key header; the completion is the concatenation of candidates[0].content.parts[].text.
import { httpComplete } from "../http.ts";
import type { HttpProviderContext, LlmResult } from "../types.ts";

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

function extractText(body: unknown): string {
  const candidates = (body as { candidates?: unknown } | null)?.candidates;
  const first = Array.isArray(candidates) ? candidates[0] : undefined;
  const parts = (first as { content?: { parts?: unknown } } | undefined)?.content?.parts;
  if (!Array.isArray(parts)) throw new Error("Gemini response had no content parts");
  return parts
    .filter((p): p is { text: string } => !!p && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("");
}

export function runGeminiProvider(ctx: HttpProviderContext): Promise<LlmResult> {
  return httpComplete(
    () => ({
      url: `${GEMINI_API_BASE}/models/${encodeURIComponent(ctx.model)}:generateContent`,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": ctx.apiKey,
        },
        body: JSON.stringify({
          ...(ctx.system ? { systemInstruction: { parts: [{ text: ctx.system }] } } : {}),
          contents: [{ parts: [{ text: ctx.prompt }] }],
          generationConfig: { maxOutputTokens: ctx.maxTokens },
        }),
      },
    }),
    extractText,
    { fetch: ctx.fetch, signal: ctx.signal },
  );
}
