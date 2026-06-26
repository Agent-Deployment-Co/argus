// The general LLM access layer (#132). A small provider registry plus one client entry point,
// `complete(request, config)`, that any part of Argus can call to run a model. The layer owns
// transport, auth, model selection, and retry; consumers own prompt construction and output parsing.
//
// History: LLM access used to live only inside the Interpret stage's task extraction, via `claude -p`
// or an arbitrary `command`. This generalizes that seam — task extraction is now the first consumer.
//
// Dispatch is registry-driven (see registry.ts): the client looks the provider up and calls its
// `complete`, with no per-provider branching here. Adding a provider doesn't touch this file.
import { getProvider } from "./registry.ts";
import type { LlmProvider, LlmRequest, LlmResult, ResolvedLlmConfig } from "./types.ts";

export {
  getProvider,
  isLlmProvider,
  LLM_PROVIDERS,
  PROVIDER_API_KEY_ENVS,
  PROVIDERS,
} from "./registry.ts";
export type {
  LlmProvider,
  LlmRequest,
  LlmResult,
  LocalProviderContext,
  ProviderCall,
  ProviderDescriptor,
  ResolvedLlmConfig,
} from "./types.ts";

/** Default output cap for the HTTP providers when neither the request nor the config sets one. */
export const DEFAULT_MAX_TOKENS = 2048;

function missingKeyMessage(config: ResolvedLlmConfig): string {
  const where = config.apiKeyEnv
    ? `Set the ${config.apiKeyEnv} environment variable or store it with \`argus secret set ${config.apiKeyEnv}\`.`
    : "No API key is configured for this provider.";
  return `No API key available for the ${config.provider} provider. ${where}`;
}

export interface LlmClientDeps {
  /** Injectable for tests — defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Run a completion through the configured provider. Never throws: an unknown provider, a missing key,
 * an auth failure, a network error, or a malformed response all come back as `ok: false` with a
 * diagnostic. `request` fields (model/maxTokens/system) override the corresponding `config` values.
 */
export async function complete(
  request: LlmRequest,
  config: ResolvedLlmConfig,
  deps: LlmClientDeps = {},
): Promise<LlmResult> {
  const name: LlmProvider = config.provider ?? "off";
  const provider = getProvider(name);
  if (!provider) {
    return { ok: false, text: "", error: `Unknown LLM provider "${name}".` };
  }
  if (provider.requiresApiKey && !config.apiKey) {
    return { ok: false, text: "", error: missingKeyMessage(config) };
  }
  // Clamp to the default when no positive cap is set: a configured `0` is not a meaningful output
  // cap (providers reject it or return an empty completion), so treat it as absent — unlike `??`,
  // which would forward the `0` verbatim.
  const maxTokens = request.maxTokens || config.maxTokens || DEFAULT_MAX_TOKENS;
  return provider.complete({
    system: request.system,
    prompt: request.prompt,
    model: request.model ?? config.model ?? provider.defaultModel ?? "",
    maxTokens,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    command: config.command,
    fetch: deps.fetch ?? fetch,
    signal: request.signal,
  });
}
