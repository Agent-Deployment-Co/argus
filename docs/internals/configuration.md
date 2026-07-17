# Configuration: `argus.json` and the settings resolver

Argus has one app-owned settings file, **`argus.json`**, under `$ARGUS_CONFIG_DIR`
(macOS: `~/Library/Application Support/argus/argus.json`). It's the config peer of the data store
(`argus.db`) — the durable, structured home for user settings. It is **settings only**:
`pricing.json` (price overrides) stays as its own file, with different sensitivity and backup
characteristics.

`src/config.ts` owns the file: a typed `ArgusConfig`, a tolerant loader, and the settings resolver.

## Tolerant loading

- Missing file → defaults (no error).
- Malformed JSON, or any single bad value → a clear warning, then fall back to the default. **Reading
  config never crashes a command.** (For example, a typo'd `taskExtraction.provider` warns and falls
  back to the default rather than exiting.)

## The resolution chain

Every setting resolves through one uniform chain:

```
managed (MDM)  >  CLI flag  >  env var  >  argus.json  >  built-in default
```

Each layer is consulted in order; the first one that's *present* wins. An exported-but-empty value
(e.g. `ARGUS_TASK_PROVIDER=""`) counts as **absent** and falls through to the next layer. The managed
layer is the settings file an organization delivers through device management (see
[Managed settings](#managed-settings-mdm) below); on unmanaged machines it is simply absent.

The three layers don't share a spelling — flags are kebab-case, env vars `SCREAMING_SNAKE`, and
`argus.json` keys camelCase — and the names aren't mechanical transforms of each other (the enable
toggle is `--extract-tasks` on the CLI but `taskExtraction.enabled` in the file). So each setting binds
its three names explicitly in a single descriptor (the **settings registry** in `src/config.ts`), and
the resolver walks them. Precedence, coercion, and naming live in exactly one place.

## Settings today

### Logging

Logs go to stderr. Every log line includes an ISO timestamp and a level, so output from `run`,
`index --watch`, or `sync --watch` can be saved to a file and searched by severity.

| Setting | `argus.json` (camelCase) | env (SNAKE) | CLI flag (kebab) |
|---|---|---|---|
| log level | `log.level` | `ARGUS_LOG_LEVEL` | `--log-level` |

Levels are `error`, `warn`, `info`, `debug`, and `trace`. The default is `info`. Most commands also
accept `--quiet` as a shortcut for warnings and errors only, and `--verbose` as a shortcut for debug
logs. The task-extraction `--debug` flag now writes debug logs through the same stderr logger.

The level is also editable from the web Settings surface (General → Logging). Saving it writes
`log.level` to `argus.json` and applies to the running `serve` logger immediately, without a restart.
`ARGUS_LOG_LEVEL` still wins over the file, so when it's set the surface shows the usual env-override
note and the running level stays at the env value.

```json
{
  "log": { "level": "debug" }
}
```

### Desktop app

The desktop tray app starts automatically when you sign in. Set `desktop.startAtLogin` to `false`
to turn that off.

The desktop tray app also checks for signed updates on an interval. Automatic installs are enabled
by default; set `autoUpdate.enabled` to `false` to leave available updates waiting behind the tray
menu's `Install Update` item.

| Setting | `argus.json` (camelCase) | env (SNAKE) | CLI flag (kebab) |
|---|---|---|---|
| start at login | `desktop.startAtLogin` | `ARGUS_DESKTOP_START_AT_LOGIN` | — |
| automatic desktop updates | `autoUpdate.enabled` | `ARGUS_AUTO_UPDATE_ENABLED` | — |
| update check interval, minutes | `autoUpdate.checkIntervalMinutes` | `ARGUS_AUTO_UPDATE_CHECK_INTERVAL_MINUTES` | — |

```json
{
  "desktop": {
    "startAtLogin": false
  },
  "autoUpdate": {
    "enabled": false,
    "checkIntervalMinutes": 60
  }
}
```

The desktop tray app can also run in silent mode: the tray icon is hidden, no notifications are
shown, and no browser tab opens on a fresh install. Everything else keeps working in the
background, including indexing, the local dashboard, and update installs. Silent mode is set only
through the config file or `argus config set desktop.silent true`; it never appears in the web
Settings surface. Changing it takes effect immediately, so the tray icon hides or returns without
a restart.

| Setting | `argus.json` (camelCase) | env (SNAKE) | CLI flag (kebab) |
|---|---|---|---|
| silent mode (run the desktop app invisibly) | `desktop.silent` | `ARGUS_DESKTOP_SILENT` | — |

```json
{
  "desktop": { "silent": true }
}
```

### Session text retention

Argus keeps the prompt and response text of your sessions in the local store (`argus.db`) so that
interpretation can read it without re-reading transcripts from disk, and so it survives after a
transcript ages off disk. This is **on by default**. Set `retainText` to `false` to keep session
text out of `argus.db` entirely.

| Setting | `argus.json` (camelCase) | env (SNAKE) | CLI flag (kebab) |
|---|---|---|---|
| keep session text locally | `retainText` | `ARGUS_RETAIN_TEXT` | `--retain-text` |

`--retain-text` is a three-state flag — `true` / `false` / unset — on `index` / `index rebuild` /
`index refresh`, mirroring `--extract-tasks`. Unset defers to `argus.json`/env; `true`/`false`
overrides it for that run. Turning it off and re-indexing removes any text already stored.

What is kept is bounded: the opening prompt of each task (truncated) and the final response text of
each interaction — not full transcripts, tool output, or attached files.

> **Privacy.** Retained text is **local-only — it is never uploaded by `sync`.** The upload path
> reads only the text-free interaction records, so stored text cannot reach the server in any mode.
> It is stored as plaintext in `argus.db`; protect it the way you protect the rest of your data
> directory (e.g. full-disk encryption). To store nothing, set `retainText: false`.

```json
{
  "retainText": false
}
```

### Task interpretation

The first consumer is task interpretation, the optional model-driven pass that segments and judges
your sessions:

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
interpretation). It resolves through the same managed > flag > env > file > default chain.

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
var (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY`). The legacy
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
back-compat. Prefer the `llm` block. On unmanaged machines, resolution is **consumer override >
shared `llm.*` > default**. Managed shared `llm.*` values still win over user-controlled
per-consumer overrides.

## Managed settings (MDM)

Organizations that manage machines with an MDM (Jamf, Kandji, Mosyle, and similar) can force Argus
settings for their users. A managed settings file is the **highest-precedence** source: its values win
over CLI flags, environment variables, and `argus.json`, matching the platform convention that
managed preferences can't be overridden locally.

Argus looks for the file in the standard macOS managed-preference locations, in this order, and the
first one that exists and parses wins:

1. `/Library/Managed Preferences/<user>/co.agentdeployment.argus.plist`
2. `/Library/Managed Preferences/<user>/co.agentdeployment.argus.json`
3. `/Library/Managed Preferences/co.agentdeployment.argus.plist`
4. `/Library/Managed Preferences/co.agentdeployment.argus.json`

Per-user managed preferences beat machine-wide ones, and the plist (what an MDM custom-settings
payload actually writes) is checked before a JSON sibling (for orgs that push a file by script).
The domain is the desktop app's bundle identifier, `co.agentdeployment.argus`. macOS is the only
platform with standard locations today. `ARGUS_MANAGED_CONFIG_FILE` points Argus at an additional
managed file: it is checked after the standard macOS locations, and is the whole list on platforms
without a standard managed location.

The file carries the same camelCase shape as `argus.json`, as JSON or as a plist (XML or binary,
converted with the system `plutil`). For example, this payload forces interpretation off and caps
logging:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>sessionInterpretation</key>
  <dict><key>enabled</key><false/></dict>
  <key>log</key>
  <dict><key>level</key><string>warn</string></dict>
</dict>
</plist>
```

Managed loading is tolerant, like the rest of config reading: a candidate that exists but can't be
read or parsed logs a warning and the next candidate is tried, and a single invalid managed value
warns and falls through to the user-controlled layers. A broken push never crashes a command. The
file is read once per process; a restart picks up changes.

A managed value is visible where you'd look for it: the web Settings surface labels the field
"Managed by your organization" and names the file, and `argus config set` on a managed key saves the
value but notes that the managed one takes precedence. The implementation lives in
`src/managed-config.ts` (discovery, parsing, cache) and `src/paths.ts` (the candidate locations);
the resolvers in `src/config.ts` consult it as their first layer.

## Secrets (BYO API keys)

API keys are **not** stored in `argus.json` (it's settings only). They live in a secret store, set via
the web API or the CLI, and are resolved at call time as **`apiKeyEnv` env var → secret store → none**.

```bash
argus secret set ANTHROPIC_API_KEY    # reads the value from stdin or a hidden prompt
argus secret status                   # masked: which keys are stored
argus secret rm ANTHROPIC_API_KEY
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
- **config** — credentials and hand-authored settings (`pricing.json`, `argus.json`).
  Tiny, not regenerable, and worth backing up.

**`ARGUS_HOME` is the single primary knob.** Set it and the data lands in `$ARGUS_HOME/data` and the
config in `$ARGUS_HOME/config`, keeping the split underneath. So `rm -rf $ARGUS_HOME/data` clears
derived state without touching your settings or price overrides, and a dotfiles/backup tool can include
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
