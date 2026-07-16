# Settings Reference

Argus settings can come from the app, `argus.json`, environment variables,
command flags, stored secrets or managed settings from your organization. Use
this page when you need the exact setting name or precedence order.

For the everyday Settings screen, see [Settings](/settings).

## How settings are applied

Most settings resolve in this order:

```text
managed settings > command flag > environment variable > argus.json > built-in default
```

The first value that is present wins. Blank values count as absent and Argus
continues to the next source.

| Source | How to set it | Notes |
|---|---|---|
| App Settings | Open **Settings** in the app. | Writes `argus.json` for plain settings and the secret store for keys. |
| Config command | `npx @agentdeploymentco/argus config set <key> <value>` | Writes `argus.json`. For provider-specific LLM fields, it writes the flat fallback key noted below. |
| Config file | Edit `argus.json` in the Argus config folder. | Uses the dotted keys shown below, nested as JSON. |
| Environment variable | Set the variable before starting Argus. | Overrides `argus.json` for that process. |
| Command flag | Pass the flag to a command that accepts it. | Overrides environment variables for that command only. |
| Secret store | `npx @agentdeploymentco/argus secret set <name>` | Stores API keys and the Hub key outside `argus.json`. |
| Managed settings | Your organization deploys a JSON or plist settings file. | Wins over every user-controlled source. |

`argus.json` lives in the Argus config folder. On macOS, the default path is
`~/Library/Application Support/argus/argus.json`. Set `ARGUS_CONFIG_DIR` or
`ARGUS_HOME` to move it.

## Examples

Write a setting to `argus.json`:

```bash
npx @agentdeploymentco/argus config set log.level debug
```

Set a value for one process:

```bash
ARGUS_LOG_LEVEL=debug npx @agentdeploymentco/argus serve --open
```

Override a setting for one indexing run:

```bash
npx @agentdeploymentco/argus index --interpret false
```

Store an API key without putting it in `argus.json`:

```bash
npx @agentdeploymentco/argus secret set ANTHROPIC_API_KEY
```

## Common values

Boolean settings accept `true` or `false` in `argus.json` and with
`argus config set`. Environment variables also accept `1`, `yes` and `on` for
true. Use `true` or `false` for command flags that take booleans.

Valid log levels are `error`, `warn`, `info`, `debug` and `trace`.

Valid LLM providers are `off`, `claude-cli`, `command`, `claude-api`, `openai`,
`gemini`, `openrouter` and `hub`. `hub` is reserved for future use. The legacy
provider value `claude` is still accepted as an alias for `claude-cli`.

## App and general settings

| Setting | What it controls | `argus.json` key | Environment variable | Command flag | Default |
|---|---|---|---|---|---|
| Automatic updates | Whether the desktop app installs updates automatically. | `autoUpdate.enabled` | `ARGUS_AUTO_UPDATE_ENABLED` | None | `true` |
| Update check interval | Minutes between desktop update checks. | `autoUpdate.checkIntervalMinutes` | `ARGUS_AUTO_UPDATE_CHECK_INTERVAL_MINUTES` | None | `60` |
| Start at login | Whether the desktop app opens when you sign in. | `desktop.startAtLogin` | `ARGUS_DESKTOP_START_AT_LOGIN` | None | `false` |
| Silent desktop mode | Whether the desktop app runs without a tray icon, notifications or opening the browser on first run. | `desktop.silent` | `ARGUS_DESKTOP_SILENT` | None | `false` |
| Read-only mode | Whether `serve` runs read-only: labels, hiding sessions, refresh and Settings are hidden and their routes aren't mounted. | `readOnly` | `ARGUS_READ_ONLY` | `serve`: `--read-only` | `false` |
| Hub URL | Argus Hub server URL for [sync](/terminology#sync). | `hub.url` | `ARGUS_HUB_URL` | None | unset |
| Hub key | Key used to authenticate to Argus Hub. | `hub.key` | `ARGUS_HUB_KEY` | None | unset |
| Log level | How much detail Argus prints to the terminal. | `log.level` | `ARGUS_LOG_LEVEL` | `--log-level` | `info` |
| Retain session text | Whether Argus keeps prompt and response text in the local [index](/terminology#index) for interpretation. | `retainText` | `ARGUS_RETAIN_TEXT` | `index`, `index rebuild` and `index refresh`: `--retain-text true\|false` | `true` |
| Welcome completed | Whether the first-run welcome screen has been dismissed. | `state.onboardingCompleted` | `ARGUS_STATE_ONBOARDING_COMPLETED` | None | `false` |

`desktop.startAtLogin` is currently kept as restore plumbing. The desktop app
does not use it while start-at-login is disabled.

`desktop.silent` is for managed or scripted desktop deployments. Set it with
`argus config set desktop.silent true` or `ARGUS_DESKTOP_SILENT=true`; it is not
shown in the app Settings screen.

`readOnly` is a deployment switch for running a shared, read-only Argus instance, not something to
flip from the app Settings screen. Set it with `argus config set readOnly true`, `ARGUS_READ_ONLY=true`,
or `serve --read-only`.

Use the secret store or `ARGUS_HUB_KEY` for the Hub key. A legacy plaintext
`hub.key` in `argus.json` is still read and migrated by `serve`, but new
configuration should not put keys in `argus.json`.

`--quiet` and `--verbose` are command shortcuts for logging. They do not write
`log.level`.

## Session interpretation

Session interpretation uses a [model](/terminology#model) to title and summarize each
[session](/terminology#session), split it into tasks and judge outcomes. These
settings control whether it runs and how much it does.

| Setting | What it controls | `argus.json` key | Environment variable | Command flag | Default |
|---|---|---|---|---|---|
| Interpret sessions | Whether indexing interprets sessions. | `sessionInterpretation.enabled` | `ARGUS_INTERPRET_ENABLED` | `index`, `index rebuild` and `index refresh`: `--interpret true\|false` | `true` |
| Max sessions per hour | Maximum sessions interpreted automatically each hour. | `sessionInterpretation.maxSessionsPerHour` | `ARGUS_INTERPRET_MAX_PER_HOUR` | None | `30` |
| Custom prompt | Instructions to use instead of the built-in interpretation prompt. | `sessionInterpretation.prompt` | `ARGUS_INTERPRET_PROMPT` | `run`: `--interpret-prompt` | unset |
| Prompt file | File containing custom interpretation instructions. | `sessionInterpretation.promptFile` | `ARGUS_INTERPRET_PROMPT_FILE` | `run`: `--interpret-prompt-file` | unset |
| Title length | Maximum generated title length in characters. | `sessionInterpretation.titleMaxChars` | `ARGUS_INTERPRET_TITLE_MAX_CHARS` | None | `100` |
| Summary length | Maximum generated summary length in characters. | `sessionInterpretation.summaryMaxChars` | `ARGUS_INTERPRET_SUMMARY_MAX_CHARS` | None | `500` |

These compatibility settings still work, but prefer the shared `llm.*` settings
below for new configuration.

| Compatibility setting | What it overrides | `argus.json` key | Environment variable | Command flag |
|---|---|---|---|---|
| Interpretation provider | Shared `llm.provider`. | `sessionInterpretation.provider` | `ARGUS_INTERPRET_PROVIDER` | `run`: `--interpret-provider` |
| Interpretation model | Shared `llm.model`. | `sessionInterpretation.model` | `ARGUS_INTERPRET_MODEL` | `run`: `--interpret-model` |
| Interpretation command | Shared `llm.command`. | `sessionInterpretation.command` | `ARGUS_INTERPRET_COMMAND` | `run`: `--interpret-command` |

The older `taskExtraction.*` keys and `ARGUS_TASK_*` variables are still read as
legacy names. The CLI also keeps these deprecated aliases: `--extract-tasks`,
`--task-provider`, `--task-model`, `--task-prompt`, `--task-prompt-file` and
`--task-command`. Prefer `sessionInterpretation.*`, `ARGUS_INTERPRET_*` and
`--interpret-*`.

## LLM provider settings

The `llm` settings choose the model backend used by model-driven features.
Session interpretation is the feature that uses them today.

The provider itself is stored at `llm.provider`. Provider-specific fields are
stored under `llm.providerConfigs.<provider>`, so switching providers keeps each
provider's model, command and API-key variable separate.

```json
{
  "llm": {
    "provider": "openai",
    "providerConfigs": {
      "openai": {
        "model": "gpt-5.4-nano"
      },
      "claude-api": {
        "model": "claude-haiku-4-5"
      }
    }
  }
}
```

| Setting | What it controls | `argus.json` key | Environment variable | Command flag | Default |
|---|---|---|---|---|---|
| Provider | Which backend Argus uses for model calls. | `llm.provider` | `ARGUS_LLM_PROVIDER` | None | `claude-cli` |
| Model | Model name to request for the selected provider. | `llm.providerConfigs.<provider>.model` or flat fallback `llm.model` | `ARGUS_LLM_MODEL` | None | provider default |
| Base URL | OpenAI-compatible endpoint for the `openai` provider. | `llm.providerConfigs.<provider>.baseUrl` or flat fallback `llm.baseUrl` | `ARGUS_LLM_BASE_URL` | None | `https://api.openai.com/v1` for `openai` |
| API key variable | Environment variable or secret name used for a provider's API key. | `llm.providerConfigs.<provider>.apiKeyEnv` or flat fallback `llm.apiKeyEnv` | `ARGUS_LLM_API_KEY_ENV` | None | provider standard |
| Max output tokens | Output token cap for model requests. | `llm.providerConfigs.<provider>.maxTokens` or flat fallback `llm.maxTokens` | `ARGUS_LLM_MAX_TOKENS` | None | unset, with HTTP calls capped at `2048` when no request cap is set |
| Reasoning effort | Provider-native reasoning effort value. | `llm.providerConfigs.<provider>.effort` or flat fallback `llm.effort` | `ARGUS_LLM_EFFORT` | None | unset |
| Command | Command to run for the `command` provider. | `llm.providerConfigs.<provider>.command` or flat fallback `llm.command` | `ARGUS_LLM_COMMAND` | None | unset |
| Claude CLI path | Full path to the `claude` binary for the `claude-cli` provider. | `llm.providerConfigs.<provider>.claudeCliPath` or flat fallback `llm.claudeCliPath` | `ARGUS_CLAUDE_CLI_PATH` | None | auto-detect |

Older flat keys such as `llm.model`, `llm.command` and `llm.apiKeyEnv` are still
read as a fallback. The app moves flat values into `providerConfigs` when it can.
`argus config set` accepts the flat fallback keys, not
`llm.providerConfigs.<provider>.*` paths.

Provider defaults:

| Provider | Default model | Standard API key name | Provider-specific settings |
|---|---|---|---|
| `claude-cli` | `haiku` | None | `model`, `claudeCliPath`, `effort` |
| `command` | None | None | `command` |
| `claude-api` | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` | `model`, `apiKeyEnv`, `maxTokens`, `effort` |
| `openai` | `gpt-5.4-nano` | `OPENAI_API_KEY` | `model`, `baseUrl`, `apiKeyEnv`, `maxTokens`, `effort` |
| `gemini` | `gemini-3.1-flash-lite` | `GEMINI_API_KEY` | `model`, `apiKeyEnv`, `maxTokens`, `effort` |
| `openrouter` | None | `OPENROUTER_API_KEY` | `model`, `apiKeyEnv`, `maxTokens`, `effort` |
| `off` | None | None | None |
| `hub` | None | None | None, reserved for future use |

## Secrets

API keys are not stored in `argus.json` when you use the app Settings screen or
`argus secret`. They resolve from the named environment variable first, then the
secret store.

| Secret name | Used for | Also read from environment |
|---|---|---|
| `ANTHROPIC_API_KEY` | `claude-api` provider | yes |
| `OPENAI_API_KEY` | `openai` provider | yes |
| `GEMINI_API_KEY` | `gemini` provider | yes |
| `OPENROUTER_API_KEY` | `openrouter` provider | yes |
| `ARGUS_HUB_KEY` | Argus Hub sync | yes |

Manage secrets from the command line:

```bash
npx @agentdeploymentco/argus secret set OPENAI_API_KEY
npx @agentdeploymentco/argus secret status
npx @agentdeploymentco/argus secret rm OPENAI_API_KEY
```

## Location variables

These environment variables are not `argus.json` settings. They tell Argus where
to find agent data or where to put its own files.

| Environment variable | What it changes | Default |
|---|---|---|
| `ARGUS_HOME` | Base folder for Argus data and config. Data goes under `ARGUS_HOME/data`; config goes under `ARGUS_HOME/config`. | unset |
| `ARGUS_DATA_DIR` | Folder for the local store, including `argus.db`. | platform default |
| `ARGUS_CONFIG_DIR` | Folder for `argus.json`, `pricing.json` and secrets. | platform default |
| `CLAUDE_CONFIG_DIR` | Folder for Claude Code projects and settings. | `~/.claude` |
| `CODEX_HOME` | Folder for Codex sessions. | `~/.codex` |
| `CODEX_CONFIG_DIR` | Fallback folder for Codex sessions when `CODEX_HOME` is unset. | `~/.codex` |
| `GEMINI_CLI_HOME` | Base folder for Gemini CLI data. Argus reads `.gemini` under it. | home folder |
| `CLAUDE_DESKTOP_CACHE_DIR` | Claude desktop app cache folder for Claude Chat indexing. | platform Claude cache path |
| `ARGUS_MANAGED_CONFIG_FILE` | Extra managed settings file. On macOS, Argus checks standard managed-preference locations first. | unset |
| `ARGUS_PORT` | Default port for `serve` and `run` when no `--port` is passed. | `4242` |

`ARGUS_DATA_DIR` and `ARGUS_CONFIG_DIR` win over `ARGUS_HOME`. Empty values count
as absent.

## Price overrides

Argus estimates [cost](/terminology#cost) from model usage and a local price
table. Override prices in `pricing.json` under the Argus config folder. This is
not an `argus.json` setting and has no environment variable or command flag.

Each price is USD per million [tokens](/terminology#token):

```json
{
  "gpt-5.5": {
    "input": 5,
    "output": 30,
    "cacheRead": 0.5,
    "cacheWrite5m": 0,
    "cacheWrite1h": 0
  }
}
```

Built-in price family keys are:

| Key | Used when the model name contains |
|---|---|
| `opus` | `opus` |
| `sonnet` | `sonnet` |
| `haiku` | `haiku` |
| `gpt-5.5` | `gpt-5.5` |
| `gpt-5.4` | `gpt-5.4` |
| `gpt-5.4-mini` | `gpt-5.4-mini` or `gpt-5.4 mini` |
| `gpt-5.3` | `gpt-5.3` or `gpt-5.2` |
| `gpt-5` | `gpt-5-codex` or `gpt-5` |
| `codex-mini` | `codex-mini` |
| `gemini-2.5-pro` | `gemini-2.5-pro` with prompts up to 200,000 tokens |
| `gemini-2.5-pro-long` | `gemini-2.5-pro` with prompts over 200,000 tokens |
| `gemini-2.5-flash` | `gemini-2.5-flash` |
| `gemini-2.5-flash-lite` | `gemini-2.5-flash-lite` |
| `gemini-3-flash` | model names containing both `gemini-3` and `flash` |

## Managed settings

Managed settings use the same JSON shape as `argus.json`, but they are delivered
by your organization and have the highest precedence.

On macOS, Argus checks these paths in order and uses the first file that exists
and parses:

| Order | Path |
|---|---|
| 1 | `/Library/Managed Preferences/<user>/co.agentdeployment.argus.plist` |
| 2 | `/Library/Managed Preferences/<user>/co.agentdeployment.argus.json` |
| 3 | `/Library/Managed Preferences/co.agentdeployment.argus.plist` |
| 4 | `/Library/Managed Preferences/co.agentdeployment.argus.json` |

Set `ARGUS_MANAGED_CONFIG_FILE` to add a specific managed settings file on any
platform. On macOS, Argus checks the standard managed-preference locations first,
then this file. The file can be JSON or a macOS plist.

Example managed JSON:

```json
{
  "sessionInterpretation": {
    "enabled": false
  },
  "log": {
    "level": "warn"
  }
}
```

When a setting is managed, the app labels it **Managed by your organization**.
Changing the same setting in the app, through `argus config set` or with an
environment variable does not override the managed value.
