// Google Gemini (Generative Language API) provider. POST .../models/{model}:generateContent with an
// x-goog-api-key header; the completion is the concatenation of candidates[0].content.parts[].text.
import { httpComplete } from "../http.ts";
import type { ProviderCall, ProviderDescriptor } from "../types.ts";

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

export const geminiProvider: ProviderDescriptor = {
  name: "gemini",
  apiKeyEnv: "GEMINI_API_KEY",
  defaultModel: DEFAULT_GEMINI_MODEL,
  requiresApiKey: true,
  complete(call: ProviderCall) {
    return httpComplete(
      () => ({
        url: `${GEMINI_API_BASE}/models/${encodeURIComponent(call.model)}:generateContent`,
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": call.apiKey!,
          },
          body: JSON.stringify({
            ...(call.system ? { systemInstruction: { parts: [{ text: call.system }] } } : {}),
            contents: [{ parts: [{ text: call.prompt }] }],
            generationConfig: { maxOutputTokens: call.maxTokens },
          }),
        },
      }),
      extractText,
      { fetch: call.fetch, signal: call.signal },
    );
  },
};
