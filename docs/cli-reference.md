---
description: Every Argus command and flag, covering index, serve, sync, run, status, search, config and secret.
---

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
| `index` | Find and index your [sessions](/terminology#session) into the local store. |
| `index rebuild` | Rebuild the store from your sessions, dropping ones no longer on disk. |
| `index refresh` | Re-index everything, or the session ids you name. |
| `index delete` | Remove the session ids you name from the store. |
| `sync` | Upload a usage snapshot to an [Argus Hub](/terminology#argus-hub). |
| `run` | Do it all: keep the index current, serve Argus and sync on a schedule. |
| `status` | Show where the local store lives, per-source counts and how far the [credential check](/sessions#credential-warnings) has got. |
| `config` | Read or write settings (`config get`, `config set`). |
| `secret` | Store API keys for the model providers Argus can use. |

Run `argus <command> --help` for the flags on any command.

## Opening Argus to your network

By default `serve` and `run` answer only on the computer they run on, at
`http://localhost:4242`. Pass `--host` to listen on another address, so you can
open Argus from a different computer:

```bash
# Reachable from anywhere on your network
npx @agentdeploymentco/argus serve --host 0.0.0.0 --read-only

# Or one interface, if the machine has several
npx @agentdeploymentco/argus serve --host 192.168.1.5 --read-only
```

This is for running Argus on a machine you don't sit at: a home server, a box in
the corner, a container or VM whose ports you reach from the host. The desktop app
never does it, and neither does the default.

Argus has no sign-in, so anyone who can reach the port can open the dashboard and
read what's in your [index](/terminology#index):
[session](/terminology#session) titles, model-written summaries,
[tasks](/terminology#task) and how each one went, and the prompt and response text
Argus keeps when **Retain session text** is on. Only open it on a network you
trust, and pair it with `--read-only` so a visitor can look but not change
anything.

Two things stay on the computer running Argus whatever you pass:

- **Settings and API keys.** Changing a setting, testing a model connection or
  saving a provider key works only in a browser on that computer. Requests from
  anywhere else are refused. Set those up locally first, then start serving.
- **The [MCP](/terminology#mcp-server) endpoint.** Agents can query Argus over
  `/mcp` only from the same computer. See [Connect Your Agent](/connect-your-agent).

`--host` also has a setting (`host`) and an environment variable (`ARGUS_HOST`);
see the [Settings Reference](/settings-reference). Nothing about this changes what
Argus sends anywhere: exposing the port lets people read your Argus, it doesn't
make Argus upload anything. See [Privacy and Security](/privacy).

## Data locations

Argus keeps its [index](/terminology#index) and settings on your own computer:

| | macOS | Windows |
|---|---|---|
| Data (the index) | `~/Library/Application Support/argus` | `%LOCALAPPDATA%\Argus\Data` |
| Settings | `~/Library/Application Support/argus` | `%APPDATA%\Argus` |

Set `ARGUS_HOME` to put both somewhere else (data under `ARGUS_HOME/data`, settings
under `ARGUS_HOME/config`).
