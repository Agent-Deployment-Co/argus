// Shared types for the general LLM access layer (#132). Kept dependency-free so `index.ts`,
// `http.ts`, the providers, and `config.ts` can all import them without an import cycle.

/** The set of LLM providers Argus can route a completion through.
 *  - `off`        — no LLM available; the client returns `ok: false` with a clear reason.
 *  - `claude-cli` — the local `claude -p` CLI (no API key; uses the user's Claude login).
 *  - `command`    — an arbitrary local command: prompt on stdin, completion text on stdout.
 *  - `claude-api` — Anthropic's API (BYO key).
 *  - `openai`     — OpenAI / OpenAI-compatible (BYO key; `baseUrl` for self-hosted endpoints).
 *  - `gemini`     — Google Gemini API (BYO key).
 *  - `openrouter` — the OpenRouter gateway: one key, many upstream models (OpenAI-compatible).
 *  - `hub`        — reserved extension point for a future org-managed key proxy (not implemented). */
export type LlmProvider =
  | "off"
  | "claude-cli"
  | "command"
  | "claude-api"
  | "openai"
  | "gemini"
  | "openrouter"
  | "hub";

/** The `llm.*` config fields a provider can meaningfully use. Drives which fields the settings UI
 *  shows for a selected provider (e.g. an API provider needs a key env var; the local CLI doesn't). */
export type LlmConfigField = "model" | "baseUrl" | "apiKeyEnv" | "maxTokens" | "command" | "claudeCliPath";

/** A consumer-agnostic completion request. `system` carries instructions, `prompt` carries the data;
 *  the single-blob callers map everything to `prompt` with no `system`. */
export interface LlmRequest {
  system?: string;
  prompt: string;
  /** Overrides `config.model` for this call. */
  model?: string;
  /** Overrides `config.maxTokens` for this call. */
  maxTokens?: number;
  /** Aborts the in-flight request (and kills a local subprocess). */
  signal?: AbortSignal;
}

/** A completion result. `text` is the raw completion only — JSON parsing stays in the consumer.
 *  `off`/auth/network failures come back as `ok: false` with a diagnostic; the client never throws. */
export interface LlmResult {
  ok: boolean;
  text: string;
  error?: string;
  /** HTTP status (HTTP providers) or subprocess exit code (local providers); absent for transport errors. */
  status?: number | null;
}

/** The resolved LLM settings a consumer passes to `complete()`. Produced by `config.ts` from the
 *  `llm.*` block (with per-consumer overrides) plus a resolved `apiKey` for the HTTP providers. */
export interface ResolvedLlmConfig {
  provider: LlmProvider;
  /** Model id; falls back to each provider's built-in default when unset. */
  model?: string;
  /** OpenAI-compatible / self-hosted base URL (openai provider only). */
  baseUrl?: string;
  /** Per-request output cap for the HTTP providers. */
  maxTokens?: number;
  /** Command line for the `command` provider. */
  command?: string;
  /** Explicit path to the `claude` CLI (claude-cli provider); auto-resolved when unset. */
  claudeCliPath?: string;
  /** The resolved API key for an HTTP provider. The layer owns the transport, not the key store:
   *  consumers resolve this (env var → secret store) and pass it in. Absent → a "no key" diagnostic. */
  apiKey?: string;
  /** Name of the env var the key is expected under — used only to phrase the "no key" diagnostic. */
  apiKeyEnv?: string;
}

/** The fully-resolved per-call context the client hands to a provider's `complete`. The client has
 *  already resolved `model`/`maxTokens` (request → config → provider default) and, for providers that
 *  declare `requiresApiKey`, guaranteed `apiKey` is present. Optional fields a given provider ignores
 *  (e.g. `command` for HTTP providers, `apiKey`/`baseUrl` for local ones) are simply unused. */
export interface ProviderCall {
  system?: string;
  prompt: string;
  model: string;
  maxTokens: number;
  baseUrl?: string;
  apiKey?: string;
  command?: string;
  /** Explicit path to the `claude` CLI; the claude-cli provider auto-resolves when unset. */
  claudeCliPath?: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

/**
 * One provider, self-contained. Adding a provider is adding one descriptor (its key env var, default
 * model, and how to run a completion) and registering it — the client, the config's per-provider
 * apiKeyEnv default, and the secret allowlist all derive from the registry, with no per-provider
 * branching anywhere else.
 */
export interface ProviderDescriptor {
  name: LlmProvider;
  /** Standard env var (and secret-store key) for this provider's API key; absent → no key. */
  apiKeyEnv?: string;
  /** Built-in default model, used when neither the request nor the config sets one. */
  defaultModel?: string;
  /** When true, the client short-circuits with a clear "no key" diagnostic if `apiKey` is missing. */
  requiresApiKey?: boolean;
  /** Registered for forward-compatibility but not a real, user-selectable provider (e.g. `hub`, a
   *  reserved extension point that isn't implemented). Such providers still validate so an existing
   *  config value doesn't error, but they're excluded from user-facing choices like the settings UI. */
  reserved?: boolean;
  /** The `llm.*` config fields this provider actually uses — drives which fields the settings UI shows
   *  when this provider is selected. Omitted/empty → none (e.g. `off`). */
  configFields?: readonly LlmConfigField[];
  complete(call: ProviderCall): Promise<LlmResult>;
}

/** The resolved per-call context a local (subprocess) provider operates on. */
export interface LocalProviderContext {
  system?: string;
  prompt: string;
  /** Model passed to the `claude` CLI's `--model`. */
  model?: string;
  /** Command line for the `command` provider. */
  command?: string;
  /** Explicit path to the `claude` CLI; auto-resolved when unset. */
  claudeCliPath?: string;
  signal?: AbortSignal;
}
