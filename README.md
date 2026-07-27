# Argus

Argus is a desktop app that helps you find and fix wasted agent work. It's built for people using
AI for business tasks. These tasks are usually more open-ended and need more external context than
coding, making for some frustrating agent interactions. Argus analyzes your AI sessions to identify
those costly, repetitive or unsuccessful tasks. It's free, open source and runs locally on Mac or
Windows. Argus works with Claude Cowork, Claude Chat, Claude Code, ChatGPT Work and Codex.

![The Argus Activity view: sessions, tokens and estimated cost up top, with recommendations and daily token and cost trends below.](docs/images/screenshots/activity@1920x1080@2.webp)

[**Try the live demo**](https://argus-demo.agentdeployment.co) ·
[**Download**](https://argus.agentdeployment.co/download) ·
[**Documentation**](https://argus.agentdeployment.co)

The demo is a read-only copy of Argus filled with sample data, so you can look around without
installing anything. Argus is from [The Agent Deployment Company](https://www.agentdeployment.co)
and is [MIT licensed](LICENSE).

## Features

- The tasks you set out to do, and whether each one finished, failed or is unclear
- Sessions you interrupted, tool actions you declined and conversations that had to be compacted
  (Claude sessions only, the other agents don't report this)
- The tools and MCP servers that push the most content into your agent's context
- Tokens and estimated cost over time, by project, agent and model
- The skills, tools, plugins and models you actually use

Argus indexes sessions from Claude Cowork, Claude Chat, Claude Code, ChatGPT Work, Codex and
Gemini CLI. See [Supported agents](https://argus.agentdeployment.co/supported-agents) for what it
can measure for each.

## Installation

Argus is a desktop app that lives in your menu bar on macOS or your system tray on Windows. It keeps
your sessions current, opens Argus in your browser and updates itself.

**[Download for macOS or Windows](https://argus.agentdeployment.co/download)**

### Command line

You don't need the app. Argus also ships as a command-line tool, which runs on Node.js 20.17 or
newer:

```bash
npx @agentdeploymentco/argus serve --open
```

That indexes the sessions on your machine and serves the web app at `http://localhost:4242`.

Four commands do the work. `index` finds and indexes new sessions into the local store, `serve` runs
the web app, `sync` uploads usage to an [Argus Hub](https://argus.agentdeployment.co/argus-hub) if
your company runs one, and `run` supervises all three in one process. `status`, `search`, `config`
and `secret` round it out. The
[CLI Reference](https://argus.agentdeployment.co/cli-reference) covers every command and flag.

## Data and accuracy

Argus reads the session files your agents already write to your disk (`~/.claude`, `~/.codex`,
`~/.gemini`) and keeps everything it builds in a local store. Set `ARGUS_HOME` to put that
somewhere else.

Nothing is uploaded unless you run `sync` against an
[Argus Hub](https://argus.agentdeployment.co/argus-hub) your company operates, and that's off until
you configure it. Even then your prompt and response text never leaves the machine, and neither do
your API keys.

Two things worth knowing about the numbers. Resumed sessions repeat earlier messages and subagents
write their own files, so Argus walks directories recursively and deduplicates by message id.
Cost is an estimate built from published API prices, so it won't match a subscription bill; override
the prices in `pricing.json` if you need to.

For the full picture, see [Privacy and Security](https://argus.agentdeployment.co/privacy).

## Contributing

Argus is developed with [Bun](https://bun.sh). See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the
architecture and how to run the tests. If you're writing anything a user will read, the guides in
[`docs/contributing/`](docs/contributing/) cover the audience, what we claim and how Argus sounds.

## License

MIT, see [LICENSE](LICENSE).
