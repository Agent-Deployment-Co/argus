---
description: The agents Argus indexes, where it finds each one on your computer and what it can measure for each.
---

# Supported Agents

Argus finds and indexes the [sessions](/terminology#session) from your AI
[agents](/terminology#agent) on your computer, and includes every one of them by
default.

| Agent | Description |
|---|---|
| [Claude Cowork](https://claude.com/product/cowork) | Claude's agent for knowledge work in the Claude desktop app |
| [Claude Chat](https://claude.ai) | Chat conversations on claude.ai (via desktop, see below) |
| [Claude Code](https://claude.com/product/claude-code) | Claude's coding agent for the terminal, IDE and desktop app |
| [ChatGPT Work](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex) | OpenAI's agent for longer, multi-step knowledge work |
| [Codex](https://openai.com/codex/) | OpenAI's agent for software development and technical work |
| [Gemini CLI](https://geminicli.com/) | Google's coding agent that runs in your terminal |

ChatGPT Work and Codex are two experiences inside ChatGPT rather than two names
for the same thing. They write their sessions to the same place, so Argus reads
both together.

## Locations

Argus automatically indexes sessions from every agent it finds on your computer without any additional configuration. By default, Argus uses these locations to find your existing agent sessions:

| Agent | macOS | Windows |
|---|---|---|
| Claude Cowork | `~/Library/Application Support/Claude/local-agent-mode-sessions` | not yet supported |
| Claude Chat | `~/Library/Application Support/Claude/Cache/Cache_Data` | `%APPDATA%\Claude\Cache\Cache_Data` |
| Claude Code | `~/.claude/projects` | `%USERPROFILE%\.claude\projects` |
| ChatGPT Work and Codex | `~/.codex/sessions` | `%USERPROFILE%\.codex\sessions` |
| Gemini CLI | `~/.gemini` | `%USERPROFILE%\.gemini` |

If you've moved an agent's data with its own setting (for example
`CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `GEMINI_CLI_HOME`), Argus follows that same
setting. For where Argus keeps its own data, see the
[CLI Reference](/cli-reference#data-locations).

## Claude Chat sessions require the desktop app

Argus finds Claude Chat in the [Claude desktop app](https://claude.com/download),
which keeps a local copy of your conversations. It can't include chats that only
happened on claude.ai and were never synced to the desktop app, so two limits apply:

- You need the desktop app installed and signed in, and only conversations that
  have synced to it are included.
- Claude Chat usage is estimated, not exact, because Claude Chat doesn't report
  [token](/terminology#token) counts the way the command-line agents do.
