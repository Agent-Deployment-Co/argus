# LLM providers and secret storage (`src/llm/`, `src/secrets.ts`)

Argus has one shared LLM access layer that any part of the app can call to run a model. It owns
transport, auth, model selection, and retry; consumers own prompt construction and output parsing.
Task interpretation (see [task-interpretation.md](./task-interpretation.md)) is the first consumer —
it builds the prompt and parses the JSON; the layer just runs the completion.

## The layer (`src/llm/`)

- **`registry.ts`** — the single source of truth: the list of `ProviderDescriptor`s. The client, the
  config's per-provider `apiKeyEnv` default, and the secret allowlist all derive from it.
- **`index.ts`** — the client. One entry point, dispatching through the registry with **no
  per-provider branching**:

  ```ts
  complete(request: LlmRequest, config: ResolvedLlmConfig): Promise<LlmResult>
  ```

  - `LlmRequest` = `{ system?, prompt, model?, maxTokens?, signal? }` — `system` is instructions,
    `prompt` is the data; single-blob callers put everything in `prompt`.
  - `LlmResult` = `{ ok, text, error?, status? }` — raw completion text only. **The client never
    throws**: `off`, a missing key, an auth failure, a network error, an oversized body, or a malformed
    response all come back as `ok: false` with a diagnostic.
- **`http.ts`** — shared transport for the HTTP providers: retry on `429`/`5xx` honoring `retry-after`
  (reuses `src/backoff.ts`), a 32 MB response-size cap, and uniform error→`LlmResult` mapping.
- **`providers/`**
  - `local.ts` — `claude-cli` (`claude -p --no-session-persistence --model haiku -`) and `command` (an
    arbitrary local command: prompt on stdin, completion on stdout). No API key.
  - `anthropic.ts` — the `claude-api` provider: `POST /v1/messages`, `x-api-key` + `anthropic-version`;
    default `claude-haiku-4-5`.
  - `openai-compatible.ts` — the shared OpenAI Chat Completions transport: base URL + which token
    field to send (`max_completion_tokens` vs `max_tokens`). Both providers below build on it, so
    neither needs to know about the other.
  - `openai.ts` — native OpenAI over that transport, using `max_completion_tokens` (gpt-5 / o-series
    require it). `baseUrl` can point at an OpenAI-compatible proxy that uses the same modern field.
  - `gemini.ts` — `POST .../models/{model}:generateContent`, `x-goog-api-key`.
  - `openrouter.ts` — the OpenRouter gateway over the shared transport: its base URL + classic
    `max_tokens`. Independent of the openai provider.

### Providers

| Provider | Transport | Key | Notes |
|---|---|---|---|
| `off` | — | — | Default. `ok: false` "no provider"; consumers treat it as "no LLM". |
| `claude-cli` | local `claude -p` | none | Uses your Claude login; the historical task-extraction default. |
| `command` | local subprocess | none | Prompt on stdin, JSON on stdout. |
| `claude-api` | HTTP | `ANTHROPIC_API_KEY` | Anthropic's API. Default model `claude-haiku-4-5`. |
| `openai` | HTTP | `OPENAI_API_KEY` | Native OpenAI (`max_completion_tokens`); `baseUrl` for OpenAI-compatible proxies using the modern field. |
| `gemini` | HTTP | `GEMINI_API_KEY` | |
| `openrouter` | HTTP | `OPENROUTER_API_KEY` | OpenRouter gateway → many upstream models (OpenAI-compatible). No default model (ids are namespaced). |
| `hub` | — | — | Reserved for a future org-managed-key proxy; returns "not implemented". |

The legacy provider value `claude` is accepted as an alias for `claude-cli` (existing configs keep working).

Config lives in the `llm` block — see [configuration.md](./configuration.md). The layer is pure of
secret access: the consumer resolves the API key (env var → secret store) and passes it on
`config.apiKey`, so `complete()` stays trivially testable against an injected `fetch`.

## Secret storage (`src/secrets.ts`)

BYO API keys are stored via a `SecretStore` with three platform backends, all reached only by the
local CLI / the desktop sidecar — never serialized onto the sync wire. Set them with `argus secret set`
or the `serve` API; resolve them with **`apiKeyEnv` env var → secret store → none**.

- **macOS** — the login keychain, via the system `/usr/bin/security` tool. Because both the write and
  the read go through `security` (not `bun`/`node`), there's no per-app keychain prompt churn, and the
  bare CLI and the signed desktop sidecar share one item. The value is written twice on stdin
  (password + retype) so it never appears in argv.
- **Windows** — a DPAPI-encrypted blob (CurrentUser scope) in `secrets.json`, via built-in PowerShell.
- **Linux / fallback** — a chmod-600 plaintext JSON file (the model `token.json` already uses).

Each backend sits behind an injectable command-runner seam so tests never touch the real keychain.

**Security boundary.** Keychain/DPAPI give *encryption at rest* and *user scoping*; they do **not**
withhold a key from the machine owner (any process running as the user can read it). That's intrinsic
to a local BYO key. The only way to truly withhold an org key from the user is to keep it server-side —
the future `hub` provider, where Argus would post the request to an org proxy that holds the key.

## Privacy

The default is `off`: no session text leaves the machine. `claude-cli`/`command` send the dialogue to
a local process. The `claude-api`/`openai`/`gemini`/`openrouter` providers send the reconstructed session
prompt/response text to that **third-party cloud API** — a meaningful change from Argus's
otherwise-local processing. The reconstructed dialogue is an in-memory intermediate (never written to
disk), but it does leave the machine when an API provider is selected. This is surfaced in
user-facing config docs and stays opt-in.

## Adding a provider

A provider is one `ProviderDescriptor` — `{ name, apiKeyEnv?, defaultModel?, requiresApiKey?, complete }`.
To add one (e.g. `mistral`):

1. Add `"mistral"` to the `LlmProvider` union in `types.ts`.
2. Add `src/llm/providers/mistral.ts` exporting a `ProviderDescriptor` (its `apiKeyEnv`, default model,
   and a `complete(call)` that shapes the request and extracts the text — reuse `httpComplete` for the
   transport).
3. Register it in the `PROVIDERS` array in `registry.ts`.

That's it. The client dispatches to it automatically; `config.ts` derives its `apiKeyEnv` default and
`secrets.ts` adds its key to the allowlist — both from the registry, with no per-provider branches to
touch. The client resolves `model`/`maxTokens` and (for `requiresApiKey` providers) guarantees
`call.apiKey` before invoking `complete`.

## Adding a consumer

A new consumer resolves a `ResolvedLlmConfig` (its own block, or the shared `llm.*`), fills
`config.apiKey` via `resolveApiKey(config.apiKeyEnv)` when the provider declares a key env var, then
calls `complete()`, builds its own prompt, and parses its own output. Nothing in `src/llm/` is
task-extraction-specific.
