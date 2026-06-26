# Configuration: `argus.json` and the settings resolver

Argus has one app-owned settings file, **`argus.json`**, under `$ARGUS_CONFIG_DIR`
(macOS: `~/Library/Application Support/argus/argus.json`). It's the config peer of the data store
(`argus.db`) — the durable, structured home for user settings. It is **settings only**:
`token.json` (the login credential) and `pricing.json` (price overrides) stay as their own files,
with different sensitivity and backup characteristics.

`src/config.ts` owns the file: a typed `ArgusConfig`, a tolerant loader, and the settings resolver.

## Tolerant loading

- Missing file → defaults (no error).
- Malformed JSON, or any single bad value → a clear warning, then fall back to the default. **Reading
  config never crashes a command.** (For example, a typo'd `taskExtraction.provider` warns and falls
  back to the default rather than exiting.)

## The resolution chain

Every setting resolves through one uniform chain:

```
CLI flag  >  env var  >  argus.json  >  built-in default
```

Each layer is consulted in order; the first one that's *present* wins. An exported-but-empty value
(e.g. `ARGUS_TASK_PROVIDER=""`) counts as **absent** and falls through to the next layer.

The three layers don't share a spelling — flags are kebab-case, env vars `SCREAMING_SNAKE`, and
`argus.json` keys camelCase — and the names aren't mechanical transforms of each other (the enable
toggle is `--extract-tasks` on the CLI but `taskExtraction.enabled` in the file). So each setting binds
its three names explicitly in a single descriptor (the **settings registry** in `src/config.ts`), and
the resolver walks them. Precedence, coercion, and naming live in exactly one place.

## Settings today

The first consumer is task interpretation (see [task-interpretation.md](./task-interpretation.md)):

| Setting | `argus.json` (camelCase) | env (SNAKE) | CLI flag (kebab) |
|---|---|---|---|
| enable index-time extraction | `taskExtraction.enabled` | `ARGUS_TASK_ENABLED` | `--extract-tasks` |
| provider | `taskExtraction.provider` | `ARGUS_TASK_PROVIDER` | `--task-provider` |
| model | `taskExtraction.model` | `ARGUS_TASK_MODEL` | `--task-model` |
| inline prompt | `taskExtraction.prompt` | `ARGUS_TASK_PROMPT` | `--task-prompt` |
| prompt file | `taskExtraction.promptFile` | `ARGUS_TASK_PROMPT_FILE` | `--task-prompt-file` |
| command | `taskExtraction.command` | `ARGUS_TASK_COMMAND` | `--task-command` |

`--extract-tasks` is a three-state flag — `true` / `false` / unset. Unset defers to `argus.json`;
`true`/`false` override it for that run (so `--extract-tasks false` forces extraction off even when the
file enables it). The `--task-*` flags are exposed on `serve`/`run`; `--extract-tasks` is on
`index` / `index rebuild` / `index refresh`. (Which command exposes which flag is independent of the
name binding above.)

Example `argus.json`:

```json
{
  "taskExtraction": { "enabled": true, "provider": "claude-cli" }
}
```

## The `llm` block (shared LLM access)

LLM access is a top-level `llm` block, shared by any model-driven feature (today: task
interpretation). It resolves through the same flag > env > file > default chain. Full design in
[llm-providers.md](./llm-providers.md).

| Setting | `argus.json` | env | CLI flag |
|---|---|---|---|
| provider | `llm.provider` | `ARGUS_LLM_PROVIDER` | `--llm-provider` |
| model | `llm.model` | `ARGUS_LLM_MODEL` | `--llm-model` |
| base URL (openai-compatible) | `llm.baseUrl` | `ARGUS_LLM_BASE_URL` | `--llm-base-url` |
| API-key env var | `llm.apiKeyEnv` | `ARGUS_LLM_API_KEY_ENV` | `--llm-api-key-env` |
| max output tokens | `llm.maxTokens` | `ARGUS_LLM_MAX_TOKENS` | `--llm-max-tokens` |
| command (command provider) | `llm.command` | `ARGUS_LLM_COMMAND` | `--llm-command` |

Providers: `off` (default — no LLM), `claude-cli` (local `claude -p`), `command` (local command),
`claude-api` / `openai` / `gemini` (direct HTTP, BYO key), `openrouter` (the OpenRouter gateway — one
key, many upstream models), and `hub` (reserved). `apiKeyEnv` defaults to the provider's standard env
var (`CLAUDE_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY`). The legacy
value `claude` is still accepted as an alias for `claude-cli`.

```jsonc
{
  "llm": { "provider": "claude-api", "model": "claude-haiku-4-5" },
  "taskExtraction": { "enabled": true }
}
```

OpenRouter example (one key reaches many backends; model ids are namespaced):

```jsonc
{ "llm": { "provider": "openrouter", "model": "anthropic/claude-haiku-4.5" } }
```

**Per-consumer overrides (deprecated).** `taskExtraction.provider` / `taskExtraction.model` /
`taskExtraction.command` still work as a per-consumer override of the shared `llm.*` values, for
back-compat — prefer the `llm` block. Resolution is **consumer override > shared `llm.*` > default**.

## Secrets (BYO API keys)

API keys are **not** stored in `argus.json` (it's settings only). They live in a secret store, set via
the web API or the CLI, and are resolved at call time as **`apiKeyEnv` env var → secret store → none**.

```bash
argus secret set CLAUDE_API_KEY    # reads the value from stdin or a hidden prompt
argus secret status                   # masked: which keys are stored
argus secret rm CLAUDE_API_KEY
```

The backend is chosen by platform — same posture everywhere (encrypted at rest where the OS allows,
scoped to your user, no per-app prompt, no extra dependencies):

| OS | Store | Encrypted at rest |
|---|---|---|
| macOS | login keychain (via the system `security` tool) | yes |
| Windows | DPAPI-encrypted file (via built-in PowerShell) | yes |
| Linux | chmod-600 file in `$ARGUS_CONFIG_DIR/secrets.json` | no (plaintext) |

None of these protects a key from the machine owner — that's intrinsic to a local BYO key. The win
over a plaintext file is at-rest encryption on macOS/Windows. Secrets are **never** uploaded by `sync`.

> **Privacy.** The default provider is `off` — nothing is sent off-machine. Selecting an API provider
> (`claude-api`/`openai`/`gemini`/`openrouter`) transmits the reconstructed session prompt/response text to that
> third party. The reconstructed dialogue stays an in-memory intermediate (never stored on disk), but
> it does leave your machine when an API provider is used.

## Filesystem locations

Argus keeps two kinds of files on disk, and deliberately separates them:

- **data** — the store (`argus.db`) and regenerable derived state. Fully rebuildable by re-indexing,
  large, and churns; not worth backing up.
- **config** — credentials and hand-authored settings (`token.json`, `pricing.json`, `argus.json`).
  Tiny, not regenerable, and worth backing up. `token.json` is a secret.

**`ARGUS_HOME` is the single primary knob.** Set it and the data lands in `$ARGUS_HOME/data` and the
config in `$ARGUS_HOME/config`, keeping the split underneath. So `rm -rf $ARGUS_HOME/data` clears
derived state without touching your login or price overrides, and a dotfiles/backup tool can include
`config/` while excluding the churning `data/`.

Resolution order for each directory (first present value wins; empty values count as absent):

1. The explicit per-directory override — `ARGUS_DATA_DIR` / `ARGUS_CONFIG_DIR` (advanced; e.g. to
   put the large store on a separate volume).
2. `ARGUS_HOME` → `$ARGUS_HOME/data` and `$ARGUS_HOME/config`.
3. The per-platform default (macOS: `~/Library/Application Support/argus`; Linux: `$XDG_DATA_HOME` /
   `$XDG_CONFIG_HOME`, else `~/.local/share/argus` and `~/.config/argus`; Windows: `%LOCALAPPDATA%` /
   `%APPDATA%`).

With none of these set, the defaults are unchanged from earlier versions — `ARGUS_HOME` is opt-in and
existing installs keep their current locations. The resolution lives in `src/paths.ts`.
