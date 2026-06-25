// The general LLM access layer (#132). A small provider registry plus one client entry point,
// `complete(request, config)`, that any part of Argus can call to run a model. The layer owns
// transport, auth, model selection, and retry; consumers own prompt construction and output parsing.
//
// History: LLM access used to live only inside the Interpret stage's task extraction, via `claude -p`
// or an arbitrary `command`. This generalizes that seam — task extraction is now the first consumer.
import { runAnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./providers/anthropic.ts";
import { runOpenAiProvider, DEFAULT_OPENAI_MODEL } from "./providers/openai.ts";
import { runGeminiProvider, DEFAULT_GEMINI_MODEL } from "./providers/gemini.ts";
import { runClaudeProvider, runCommandProvider } from "./providers/local.ts";
import type { HttpProviderContext, LlmProvider, LlmRequest, LlmResult, ResolvedLlmConfig } from "./types.ts";

export type {
  HttpProviderContext,
  LlmProvider,
  LlmRequest,
  LlmResult,
  LocalProviderContext,
  ResolvedLlmConfig,
} from "./types.ts";

/** Default output cap for the HTTP providers when neither the request nor the config sets one. */
export const DEFAULT_MAX_TOKENS = 2048;

/** The providers that hit a third-party HTTP API and therefore need an API key. */
const HTTP_PROVIDERS = new Set<LlmProvider>(["anthropic", "openai", "gemini"]);

/** Every provider name the layer recognizes — used by `config.ts` to validate `llm.provider`. */
export const LLM_PROVIDERS: readonly LlmProvider[] = [
  "off",
  "claude",
  "command",
  "anthropic",
  "openai",
  "gemini",
  "hub",
];

export function isLlmProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

export function isHttpProvider(provider: LlmProvider): boolean {
  return HTTP_PROVIDERS.has(provider);
}

/** Built-in default model for an HTTP provider, used when neither the request nor the config sets one. */
function defaultModelFor(provider: LlmProvider): string {
  if (provider === "anthropic") return DEFAULT_ANTHROPIC_MODEL;
  if (provider === "openai") return DEFAULT_OPENAI_MODEL;
  return DEFAULT_GEMINI_MODEL;
}

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
 * Run a completion through the configured provider. Never throws: `off`, a missing key, an auth
 * failure, a network error, or a malformed response all come back as `ok: false` with a diagnostic.
 * `request` fields (model/maxTokens/system) override the corresponding `config` values.
 */
export async function complete(
  request: LlmRequest,
  config: ResolvedLlmConfig,
  deps: LlmClientDeps = {},
): Promise<LlmResult> {
  const provider = config.provider ?? "off";

  if (provider === "off") {
    return { ok: false, text: "", error: "No LLM provider is configured." };
  }
  if (provider === "hub") {
    return { ok: false, text: "", error: "The hub provider is not implemented yet." };
  }

  if (provider === "claude") {
    return runClaudeProvider({
      system: request.system,
      prompt: request.prompt,
      model: request.model ?? config.model,
      signal: request.signal,
    });
  }
  if (provider === "command") {
    return runCommandProvider({
      system: request.system,
      prompt: request.prompt,
      command: config.command,
      signal: request.signal,
    });
  }

  if (!isHttpProvider(provider)) {
    return { ok: false, text: "", error: `Unknown LLM provider "${provider}".` };
  }

  if (!config.apiKey) {
    return { ok: false, text: "", error: missingKeyMessage(config) };
  }

  const ctx: HttpProviderContext = {
    apiKey: config.apiKey,
    model: request.model ?? config.model ?? defaultModelFor(provider),
    maxTokens: request.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
    baseUrl: config.baseUrl,
    system: request.system,
    prompt: request.prompt,
    fetch: deps.fetch ?? fetch,
    signal: request.signal,
  };

  if (provider === "anthropic") return runAnthropicProvider(ctx);
  if (provider === "openai") return runOpenAiProvider(ctx);
  return runGeminiProvider(ctx);
}
