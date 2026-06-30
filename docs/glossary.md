# Glossary

Plain definitions for the terms you'll meet in these docs and in the Argus
dashboard. If a word on another page links here, this is where it lands.

## Agent

An AI assistant you direct to get work done, like Claude Code, Codex, or Claude
Cowork. You give it a goal in plain language and it carries out the steps, using
tools to read files, run commands, or call other systems.

## Argus Hub

A self-hosted server that collects usage from many people's Argus and shows an
org-wide view. It's how a team or ops leader sees how agents are used across a
group, rather than just their own use.

## Cost

The estimated dollar cost of your agent use, worked out from how many tokens you
used and each model's price. It's an estimate for understanding trends, not a
bill.

## Dashboard

The visual view of your usage that Argus opens in your browser: tokens and cost
over time, which tools and skills you lean on, and a breakdown by project and
source.

## MCP server

A connector that gives an agent extra abilities, like access to a database, a
ticketing system, or a web service. MCP (Model Context Protocol) is the shared
standard agents use to talk to these connectors.

## Model

The specific AI behind an agent, such as Claude Opus, Claude Sonnet, or a GPT
model. Different models have different speed, capability, and price, so your usage
and cost depend on which ones you use.

## Plugin

A bundle that adds skills, tools, or connectors to an agent in one package. Argus
can show which plugins you have enabled and which ones you aren't actually using.

## Project

A body of work an agent associates with a folder on your computer, usually one
codebase or working directory. Argus groups your usage by project so you can see
where your agent time goes.

## Session

One continuous working conversation with an agent, from the first thing you ask to
when you stop. A session can include many back-and-forth turns and the tools the
agent used along the way.

## Skill

A reusable set of instructions an agent can pull in to do a particular kind of
task the same way each time, like drafting a release note or formatting a report.

## Source

Which agent a piece of usage came from. Argus reads from Claude (Claude Code,
Claude Cowork, and Claude Chat), Codex, and Gemini CLI. Claude Chat usage is
estimated rather than metered, and it stays on your machine: it isn't uploaded to
an Argus Hub.

## Sync

Uploading a snapshot of your usage to an Argus Hub so it can be combined with other
people's. Nothing is uploaded unless you choose to sync; reading and the local
dashboard stay on your machine.

## Token

The unit of text an agent reads and writes. Usage and cost are measured in tokens,
so a longer conversation or a bigger file means more tokens.

## Tool

A single action an agent can take, such as reading a file, running a command,
searching the web, or calling an API. Argus shows which tools your agents use most.

## Transcript

The local file an agent writes as it works, recording the session: what you asked,
what it did, and how many tokens it used. Argus reads these transcripts from your
machine to build the dashboard.
