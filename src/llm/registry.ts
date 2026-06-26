// The provider registry — the single source of truth for which LLM providers exist and how they
// behave. Everything else derives from this list: the client dispatches through it, config derives a
// provider's default API-key env var from it, and the secret allowlist is built from it. Adding a
// provider is adding one descriptor file and one entry here; no other file needs a per-provider branch.
import { claudeApiProvider } from "./providers/anthropic.ts";
import { openaiProvider } from "./providers/openai.ts";
import { geminiProvider } from "./providers/gemini.ts";
import { openrouterProvider } from "./providers/openrouter.ts";
import { claudeCliProvider, commandProvider } from "./providers/local.ts";
import type { LlmProvider, ProviderDescriptor } from "./types.ts";

/** `off`: the default "no LLM" state. The client returns this descriptor's clear, non-fatal reason. */
const offProvider: ProviderDescriptor = {
  name: "off",
  complete: async () => ({ ok: false, text: "", error: "No LLM provider is configured." }),
};

/** `hub`: reserved extension point for a future org-managed-key proxy (not implemented here). */
const hubProvider: ProviderDescriptor = {
  name: "hub",
  complete: async () => ({ ok: false, text: "", error: "The hub provider is not implemented yet." }),
};

/** Every provider Argus knows about. Order is the documentation order (off first as the default). */
export const PROVIDERS: readonly ProviderDescriptor[] = [
  offProvider,
  claudeCliProvider,
  commandProvider,
  claudeApiProvider,
  openaiProvider,
  geminiProvider,
  openrouterProvider,
  hubProvider,
];

const BY_NAME = new Map<string, ProviderDescriptor>(PROVIDERS.map((p) => [p.name, p]));

export function getProvider(name: string): ProviderDescriptor | undefined {
  return BY_NAME.get(name);
}

/** Every provider name the layer recognizes — used by `config.ts` to validate `llm.provider`. */
export const LLM_PROVIDERS: readonly LlmProvider[] = PROVIDERS.map((p) => p.name);

export function isLlmProvider(value: string): value is LlmProvider {
  return BY_NAME.has(value);
}

/** The standard API-key env vars across all providers — the basis for the secret allowlist. */
export const PROVIDER_API_KEY_ENVS: readonly string[] = PROVIDERS.flatMap((p) =>
  p.apiKeyEnv ? [p.apiKeyEnv] : [],
);
