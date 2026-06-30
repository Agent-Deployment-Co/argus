# Supported agents

Argus indexes [sessions](/glossary#session) from your AI [agents](/glossary#agent)
by reading their [transcripts](/glossary#transcript). It supports five
[sources](/glossary#source) across three agents, and includes all of them by
default.

| Agent | Description |
|---|---|
| [Claude Code](https://claude.com/product/claude-code) | Claude's coding agent for the terminal, IDE, and desktop app |
| [Claude Cowork](https://claude.com/product/cowork) | Claude's agent for knowledge work in the Claude desktop app |
| [Claude Chat](https://claude.ai) | Chat conversations on claude.ai (via desktop, see below) |
| [Codex](https://openai.com/codex/) | OpenAI's coding and knowledge work agent |
| [Gemini CLI](https://geminicli.com/) | Google's coding agent that runs in your terminal |

## No configuration required

Argus automatically indexes sessions from every agent it finds without any additional configuration. When it
reads your machine, it picks up whatever each agent has left behind and folds it
all into one [dashboard](/glossary#dashboard).

## Where Argus looks for sessions

Argus reads each agent's sessions from wherever that agent already stores them on
your computer. You don't point Argus at anything; it checks these locations:

| Agent | Default location |
|---|---|
| Claude Code | `~/.claude/projects` |
| Claude Cowork | `~/Library/Application Support/Claude/local-agent-mode-sessions` (macOS) |
| Claude Chat | The Claude desktop app's local cache (see below) |
| Codex | `~/.codex/sessions` |
| Gemini CLI | `~/.gemini` |

If you've moved an agent's data with its own setting (for example
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `GEMINI_CLI_HOME`), Argus follows that same
setting. For where Argus keeps its own data, see
[Configuration](/configuration#filesystem-locations).

## Claude Chat needs the desktop app

Argus reads Claude Chat from the [Claude desktop app](https://claude.com/download),
which keeps a local copy of your conversations. It can't read chats that only
happened on claude.ai and were never synced to the desktop app, so two limits apply:

- You need the desktop app installed and signed in, and only conversations that
  have synced to it are included.
- Claude Chat usage is estimated, not exact, because Claude Chat doesn't report
  [token](/glossary#token) counts the way the command-line agents do.
