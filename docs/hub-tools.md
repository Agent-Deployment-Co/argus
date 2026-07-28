---
description: Which skills, tools, MCP servers and plugins the organization reaches for, aggregated across everyone syncing to a Hub.
---

# Tools

Hub's Tools view is the same four-part breakdown as the single-client
[Tools view](/metric-views#tools) — [skills](/terminology#skill),
[tools](/terminology#tool), [MCP servers](/terminology#mcp-server) and
[plugins](/terminology#plugin) — aggregated across everyone syncing to the
Hub, plus a few sections that only make sense at organization scale.

The same filter bar as [Activity](/hub-activity) applies here: date range,
source and group.

## Access layer overview

A stat row for the window: how many distinct tools, skills, MCP servers and
plugins were used at all, what share of tool calls the top three tools
account for, and how many MCP servers make up the long tail beyond the
heavily-used ones.

## Skills, tools, MCP servers

The same cuts as the single-client view — top skills by tokens, top tools
by call count and category, and top MCP servers by calls and the content
they return into context — but counted across the whole organization
rather than one person's sessions.

## What people aren't using

A ranked list of the least-reached tools, skills and MCP servers, by call
count or by how few distinct people ever use them. Unlike the
single-client Tools view, Hub only sees what's actually invoked — it has no
visibility into what's installed but never touched, so this section is
strictly about low or single-person usage, not an enabled-but-unused
comparison.

## Tool friction

A table of tools with an unusual rate of non-normal stop reasons — errors,
timeouts and the like — shown only once enough of the window's sessions
report a stop reason to make the rate meaningful.

## Shared vs. solo

Which tools, skills and MCP servers are used by three or more distinct
people versus used by only one. Like the per-user rankings elsewhere in
Hub, this stays hidden until the organization has enough people syncing
that singling one out wouldn't be identifying.

## Comparing sources

With more than one [source](/terminology#source) syncing, a comparison of
tool-category mix and top tools, skills and MCP servers side by side, so
you can see how usage differs between, say, Claude Code and Codex across
the organization.

## Plugins

Hub can only report a plugin as **used** or **not observed** in the window
— it runs server-side and has no local install to inspect, so it can't
tell you a plugin is enabled but unused the way the single-client view
does. That enabled/unused distinction is something only your own Argus app
can see; see [Tools](/metric-views#tools).
