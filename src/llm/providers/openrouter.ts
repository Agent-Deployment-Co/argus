// OpenRouter provider: a gateway that exposes an OpenAI-compatible Chat Completions API and routes to
// many upstream models behind namespaced ids (e.g. "anthropic/claude-haiku-4.5"). One OpenRouter key
// reaches them all. It builds on the shared OpenAI-compatible transport with its own base URL and the
// classic `max_tokens` field (what OpenRouter expects) — independent of the native `openai` provider.
//
// Privacy: requests go to OpenRouter and then on to the chosen upstream — a third party in the path.
import { openaiCompatibleComplete } from "./openai-compatible.ts";
import type { ProviderCall, ProviderDescriptor } from "../types.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const openrouterProvider: ProviderDescriptor = {
  name: "openrouter",
  apiKeyEnv: "OPENROUTER_API_KEY",
  requiresApiKey: true,
  configFields: ["model", "apiKeyEnv", "maxTokens"],
  // No default model — OpenRouter ids are namespaced and the catalog changes, so the user picks one.
  complete: (call: ProviderCall) =>
    openaiCompatibleComplete(call, { baseUrl: OPENROUTER_BASE_URL, tokenParam: "max_tokens" }),
};
