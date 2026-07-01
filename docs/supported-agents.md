# Supported Agents

Argus finds and indexes the [sessions](/terminology#session) from your AI
[agents](/terminology#agent) on your computer. It supports five
[sources](/terminology#source) across three agents, and includes all of them by
default.

| Agent | Description |
|---|---|
| [Claude Code](https://claude.com/product/claude-code) | Claude's coding agent for the terminal, IDE and desktop app |
| [Claude Cowork](https://claude.com/product/cowork) | Claude's agent for knowledge work in the Claude desktop app |
| [Claude Chat](https://claude.ai) | Chat conversations on claude.ai (via desktop, see below) |
| [Codex](https://openai.com/codex/) | OpenAI's coding and knowledge work agent |
| [Gemini CLI](https://geminicli.com/) | Google's coding agent that runs in your terminal |

## How Argus finds your sessions

Argus automatically indexes sessions from every agent it finds on your computer without any additional configuration. By default, Argus uses these locations to find your existing agent sessions:

| Agent | macOS | Windows |
|---|---|---|
| Claude Code | `~/.claude/projects` | `%USERPROFILE%\.claude\projects` |
| Claude Cowork | `~/Library/Application Support/Claude/local-agent-mode-sessions` | macOS only |
| Claude Chat | `~/Library/Application Support/Claude/Cache/Cache_Data` | `%APPDATA%\Claude\Cache\Cache_Data` |
| Codex | `~/.codex/sessions` | `%USERPROFILE%\.codex\sessions` |
| Gemini CLI | `~/.gemini` | `%USERPROFILE%\.gemini` |

If you've moved an agent's data with its own setting (for example
`CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `GEMINI_CLI_HOME`), Argus follows that same
setting. For where Argus keeps its own data, see the
[CLI Reference](/cli-reference#where-argus-stores-its-data).

## Claude Chat sessions require the desktop app

Argus finds Claude Chat in the [Claude desktop app](https://claude.com/download),
which keeps a local copy of your conversations. It can't include chats that only
happened on claude.ai and were never synced to the desktop app, so two limits apply:

- You need the desktop app installed and signed in, and only conversations that
  have synced to it are included.
- Claude Chat usage is estimated, not exact, because Claude Chat doesn't report
  [token](/terminology#token) counts the way the command-line agents do.
