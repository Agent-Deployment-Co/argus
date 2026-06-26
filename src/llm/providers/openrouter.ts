// OpenRouter provider: a gateway that exposes an OpenAI-compatible API and routes to many upstream
// models behind namespaced ids (e.g. "anthropic/claude-haiku-4.5", "google/gemini-2.5-flash"). One
// OpenRouter key reaches them all. It speaks the OpenAI wire format, so this is a thin preset over the
// OpenAI transport with OpenRouter's base URL baked in.
//
// Privacy: requests go to OpenRouter and then on to the chosen upstream — a third party in the path.
import { openaiProvider } from "./openai.ts";
import type { ProviderCall, ProviderDescriptor } from "../types.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const openrouterProvider: ProviderDescriptor = {
  name: "openrouter",
  apiKeyEnv: "OPENROUTER_API_KEY",
  requiresApiKey: true,
  // No default model — OpenRouter ids are namespaced and the catalog changes, so the user picks one.
  complete: (call: ProviderCall) =>
    openaiProvider.complete({ ...call, baseUrl: OPENROUTER_BASE_URL }),
};
