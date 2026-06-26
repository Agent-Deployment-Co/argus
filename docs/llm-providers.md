# LLM providers and secret storage (`src/llm/`, `src/secrets.ts`)

Argus has one shared LLM access layer that any part of the app can call to run a model. It owns
transport, auth, model selection, and retry; consumers own prompt construction and output parsing.
Task interpretation (see [task-interpretation.md](./task-interpretation.md)) is the first consumer —
it builds the prompt and parses the JSON; the layer just runs the completion.

## The layer (`src/llm/`)

- **`index.ts`** — the registry + client. One entry point:

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
  - `local.ts` — `claude` (`claude -p --no-session-persistence --model haiku -`) and `command` (an
    arbitrary local command: prompt on stdin, completion on stdout). No API key.
  - `anthropic.ts` — `POST /v1/messages`, `x-api-key` + `anthropic-version`; default `claude-haiku-4-5`.
  - `openai.ts` — `POST {baseUrl}/chat/completions`, Bearer key; `baseUrl` defaults to the OpenAI API
    but also covers OpenAI-compatible / local endpoints (Ollama, LM Studio, vLLM, OpenRouter).
  - `gemini.ts` — `POST .../models/{model}:generateContent`, `x-goog-api-key`.

### Providers

| Provider | Transport | Key | Notes |
|---|---|---|---|
| `off` | — | — | Default. `ok: false` "no provider"; consumers treat it as "no LLM". |
| `claude` | local `claude -p` | none | Uses your Claude login; the historical task-extraction default. |
| `command` | local subprocess | none | Prompt on stdin, JSON on stdout. |
| `anthropic` | HTTP | `ANTHROPIC_API_KEY` | Default model `claude-haiku-4-5`. |
| `openai` | HTTP | `OPENAI_API_KEY` | `baseUrl` for compatible/self-hosted endpoints. |
| `gemini` | HTTP | `GEMINI_API_KEY` | |
| `hub` | — | — | Reserved for a future org-managed-key proxy; returns "not implemented". |

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

The default is `off`: no session text leaves the machine. `claude`/`command` send the dialogue to a
local process. The `anthropic`/`openai`/`gemini` providers send the reconstructed session
prompt/response text to that **third-party cloud API** — a meaningful change from Argus's
otherwise-local processing. The reconstructed dialogue is an in-memory intermediate (never written to
disk), but it does leave the machine when an API provider is selected. This is surfaced in
user-facing config docs and stays opt-in.

## Adding a consumer

A new consumer resolves a `ResolvedLlmConfig` (its own block, or the shared `llm.*`), fills
`config.apiKey` via `resolveApiKey(config.apiKeyEnv)` for HTTP providers, then calls `complete()`,
builds its own prompt, and parses its own output. Nothing in `src/llm/` is task-extraction-specific.
