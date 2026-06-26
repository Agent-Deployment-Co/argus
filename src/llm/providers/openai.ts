// Native OpenAI provider. Uses the shared OpenAI Chat Completions transport with OpenAI's own base
// URL and `max_completion_tokens` (the field gpt-5 / o-series require; `max_tokens` is rejected).
// `baseUrl` may point at an OpenAI-compatible proxy that speaks the same modern field. (OpenRouter and
// classic self-hosted servers, which use `max_tokens`, have their own provider entries.)
import { openaiCompatibleComplete } from "./openai-compatible.ts";
import type { ProviderCall, ProviderDescriptor } from "../types.ts";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-5";

export const openaiProvider: ProviderDescriptor = {
  name: "openai",
  apiKeyEnv: "OPENAI_API_KEY",
  defaultModel: DEFAULT_OPENAI_MODEL,
  requiresApiKey: true,
  configFields: ["model", "baseUrl", "apiKeyEnv", "maxTokens"],
  complete: (call: ProviderCall) =>
    openaiCompatibleComplete(call, {
      baseUrl: call.baseUrl || DEFAULT_OPENAI_BASE_URL,
      tokenParam: "max_completion_tokens",
    }),
};
