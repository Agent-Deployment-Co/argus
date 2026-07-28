---
description: Run an Argus Hub so a team can pool its usage into one org-wide dashboard. Setup, connecting people and what each person sends.
---

# Argus Hub: Overview

[Argus Hub](https://github.com/Agent-Deployment-Co/argus-hub) is a self-hosted server that pools session, task, and usage data
from a team's [Argus](https://github.com/Agent-Deployment-Co/argus) clients into one org-wide dashboard. Argus Hub runs
entirely on your own network.

Each person points their Argus client at an Argus Hub instance and uses the normal [sync](/terminology#sync) command. Argus Hub
receives the usage snapshot at `POST /api/sync`, combines it in one database and tags it by user.
Nothing is forwarded anywhere else. The raw prompt and response text stays on each person's
machine, as do their BYO model API keys.

Setting an Argus Hub up, including generating its secret key, API key and admin password, is covered in
[Configuration](/argus-hub/configuration#quick-start).

## Connect Argus clients

In the desktop app, open **Settings** and enter the Argus Hub URL and API key. The app uploads on a
schedule after the connection is configured.

The app stores the key securely and shows a masked value after you save it.

<div class="screenshot">

![Argus Hub settings with an Argus Hub URL and masked Argus Hub key.](../images/screenshots/argus-hub-settings@1920x1080@2.webp)

</div>

For command-line use, save the URL in Argus and store the key in the local secret store:

```bash
npx @agentdeploymentco/argus config set hub.url https://hub.internal:4343
npx @agentdeploymentco/argus secret set ARGUS_HUB_KEY
```

The second command prompts for the key without putting it in `argus.json`. You can also configure
one process with environment variables:

```bash
export ARGUS_HUB_URL=https://hub.internal:4343
export ARGUS_HUB_KEY=hub-example-key
```

With an Argus Hub configured, `argus sync` uploads to that Argus Hub instead of the hosted service. No
`argus login` or OAuth flow is needed. Argus Hub identifies a person from the client's latest identity
signal, using the Claude or Codex OAuth email when available and falling back to the local Git
name. Repeat clients from the same person are grouped together.

The desktop app syncs automatically. If you run Argus from the command line, `argus run` includes
the same upload job every five minutes by default:

```bash
npx @agentdeploymentco/argus run
```

Use `--sync-interval N` with `run` to change the interval in minutes. Use `--no-sync` when you
want to keep indexing and serving locally without uploading.

To upload one snapshot immediately:

```bash
npx @agentdeploymentco/argus sync
```

Argus Hub's port, data directory, secret key and admin password, plus how to keep it running and
private, are covered in [Configuration](/argus-hub/configuration).

## Use the dashboard

Open the Argus Hub URL in a browser. The dashboard groups organization-wide usage into five views,
each covered in depth under **Using Argus Hub** in the nav:

<div class="screenshot">

![The Argus Hub Activity view: headline totals, the daily activity chart and cost by model.](../images/screenshots/argus-hub-activity@1920x1080@2.webp)

</div>

| View | What you can see |
|---|---|
| [Activity](/argus-hub/activity) | Usage and cost for the whole organization, trended against the prior window |
| [Tasks](/argus-hub/tasks) | Extracted tasks, outcomes, frustration and friction, top failure signals |
| [Tools](/argus-hub/tools) | Tool, skill and MCP server usage across the organization |
| [Team](/argus-hub/team) | Per-user sessions, tokens, estimated cost, last-sync time and groups |
| Labels | Argus Hub-wide task labels: create, apply and remove them (see [Argus Hub labels](/argus-hub/tasks#argus-hub-labels)) |
| [Export](/argus-hub/export) | Download the full dataset, or load it into Snowflake |

The group picker appears after at least one client syncs and someone has been put in a group.
Leave it on **All** for an organization-wide view, or choose a group to scope Activity, Tasks and
Tools. The Team table lists everyone by group, and clicking a row opens that person's own
activity view.

**Settings** holds the task LLM provider Argus Hub will use for organization-level task labeling.
Nothing in Argus Hub calls this provider yet beyond a **Test connection** check on the Settings page
itself; it's reserved for a future feature. Any API key you save there is encrypted in `hub.db`
with `HUB_SECRET_KEY`.

## MCP

Argus Hub also provides a read-only-by-default [MCP](https://modelcontextprotocol.io) endpoint at
`POST /mcp`, so an agent can query activity, tasks and tool usage directly. See
[MCP](/argus-hub/mcp) for the full tool list, filters, authentication and a worked
example.

## Export Argus Hub data

`argus-hub export snowflake` creates a consistent Snowflake-ready snapshot of the live Argus Hub
database, from the dashboard or the command line. See [Export](/argus-hub/export) for both paths and
the Snowflake load flow.

## Data flow

```text
Argus clients --POST /api/sync--> Argus Hub ingest --> hub.db
                                      |
                                      +--> dashboard and MCP queries
```

Argus Hub supports multiple organizations. Each API key belongs to one organization. Run separate Argus Hub
instances when unrelated tenants need strict isolation.

## License

Argus Hub is licensed under the [Functional Source License 1.1](https://github.com/Agent-Deployment-Co/argus-hub/blob/main/LICENSE),
which converts to MIT two years after each release. You can use, modify, distribute and build on
Argus Hub for personal, internal or commercial purposes. For the first two years, you cannot run a paid
hosted service whose primary offering is Argus Hub as a service. The restriction does not cover a
larger product where agent-usage reporting is a small feature.

See the [Argus Hub repository](https://github.com/Agent-Deployment-Co/argus-hub) for releases,
the full deployment examples and support information.
