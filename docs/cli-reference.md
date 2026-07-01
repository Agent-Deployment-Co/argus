# CLI Reference

Argus is desktop-first, but everything it does is also a command-line tool, for
people who prefer the terminal or want to script it.

## Running Argus

If you installed the desktop app, the same command-line tool is bundled with it.
You can also run it directly with `npx` (needs Node.js 20.17 or newer):

```bash
npx @agentdeploymentco/argus <command>
```

## Commands

| Command | What it does |
|---|---|
| `serve` | Start Argus in your browser. |
| `index` | Find and index your [sessions](/glossary#session) into the local store. |
| `index rebuild` | Rebuild the store from your sessions, dropping ones no longer on disk. |
| `index refresh` | Re-index everything, or the session ids you name. |
| `index delete` | Remove the session ids you name from the store. |
| `sync` | Upload a usage snapshot to an [Argus Hub](/glossary#argus-hub). |
| `run` | Do it all: keep the index current, serve Argus and sync on a schedule. |
| `status` | Show where the local store lives and per-source counts. |
| `config` | Read or write settings (`config get`, `config set`). |
| `secret` | Store API keys for the model providers Argus can use. |

Run `argus <command> --help` for the flags on any command.

## Where Argus stores its data

Argus keeps its [index](/glossary#index) and settings on your own computer:

| | macOS | Windows |
|---|---|---|
| Data (the index) | `~/Library/Application Support/argus` | `%LOCALAPPDATA%\Argus\Data` |
| Settings | `~/Library/Application Support/argus` | `%APPDATA%\Argus` |

Set `ARGUS_HOME` to put both somewhere else (data under `ARGUS_HOME/data`, settings
under `ARGUS_HOME/config`).
