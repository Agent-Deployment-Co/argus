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
  "taskExtraction": { "enabled": true, "provider": "claude" }
}
```
