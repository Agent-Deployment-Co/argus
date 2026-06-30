# Supported agents

Argus reads the [transcripts](/glossary#transcript) that your AI
[agents](/glossary#agent) leave on your computer. It supports five
[sources](/glossary#source) across three agents, and includes all of them by
default.

## The agents Argus reads

| Agent | What Argus reads |
|---|---|
| [Claude Code](https://claude.com/product/claude-code) | Claude's coding agent for the terminal, IDE, and desktop app |
| [Claude Cowork](https://claude.com/product/cowork) | Claude's agent for knowledge work in the Claude desktop app |
| [Claude Chat](https://claude.ai) | Your everyday conversations on claude.ai |
| [Codex](https://github.com/openai/codex) | OpenAI's coding agent that runs in your terminal |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Google's open-source agent that runs in your terminal |

## Everything is included by default

Argus reads every agent it finds, with nothing to switch on per agent. When it
reads your machine, it picks up whatever each agent has left behind and folds it
all into one [dashboard](/glossary#dashboard).

To focus on a single agent, filter by source in the dashboard, or pass `--source`
on the command line (for example, `--source codex`). The default is all of them.

## Claude Chat needs the desktop app

Argus reads Claude Chat from the [Claude desktop app](https://claude.com/download),
which keeps a local copy of your conversations. Two things follow from that:

- You need the desktop app installed and signed in, and only conversations that
  have synced to it are included.
- Claude Chat usage is estimated, not exact, because Claude Chat doesn't report
  [token](/glossary#token) counts the way the command-line agents do.
- Claude Chat stays on your machine. It's the one source Argus never uploads to an
  [Argus Hub](/glossary#argus-hub).
