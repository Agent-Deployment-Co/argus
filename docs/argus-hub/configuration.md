---
description: Configure Argus Hub's port, data directory and secret key, keep it running with systemd, Docker or launchd, and keep a deployment private.
---

# Argus Hub: Configuration

Argus Hub starts with one command and a generated secret key. From there, this page covers setting
its port and data directory, keeping it running with a service manager, and keeping a deployment
private on your network.

## Quick Start

Argus Hub requires Node.js 20.17 or later, or Bun 1.0 or later.

Generate a secret key and start it with:

```bash
export HUB_SECRET_KEY="$(openssl rand -base64 32)"  # save this value
npx @agentdeploymentco/argus-hub serve --port 4343
```

The first startup creates `data/hub.db`, generates an API key and generates an admin password.
Both values are printed once, so copy them to a secure location before closing the terminal.

The **API key** authenticates uploads from Argus clients. The **admin password** protects the
dashboard at `http://localhost:4343/login` and Argus Hub's read-only MCP endpoint. Set
`ADMIN_PASSWORD` before starting Argus Hub to keep the same dashboard password across restarts. If you
do not set it, Argus Hub generates a new password each time it starts.

`HUB_SECRET_KEY` is optional, but without it Argus Hub starts with a warning and disables API-key-based
task LLM providers in **Settings**, since it has nothing to encrypt those keys with in `hub.db`.
Set it once, keep it stable across restarts, and back it up separately from `hub.db`: losing it
makes any provider keys already stored there unreadable.

::: warning Keep the credentials private
The API key allows clients to upload data. The admin password allows access to the organization's
pooled usage data. Do not put either value in source control or share them in a public channel.
:::

## Configure Argus Hub

Argus Hub reads `hub.json` from the current directory, then environment variables, then command-line
flags. A later source takes precedence over an earlier one.

| CLI flag | Environment variable | `hub.json` key | Default | What it controls |
|---|---|---|---|---|
| `--port` | `HUB_PORT` | `port` | `4343` | Port Argus Hub listens on |
| `--data-dir` | `HUB_DATA_DIR` | `dataDir` | `./data` | Folder containing `hub.db` |
| None | `HUB_SECRET_KEY` | None | None | Base64 encoding of 32 random bytes; encrypts task LLM provider keys stored in `hub.db`. Without it, those providers stay disabled |
| None | `ADMIN_PASSWORD` | None | Random | Dashboard and MCP password |
| None | `HUB_INSECURE_COOKIE_HOSTS` | None | None | Hostnames allowed to use a non-`Secure` cookie for private plain-HTTP deployments |

For example:

```json
{
  "port": 4343,
  "dataDir": "/var/lib/argus-hub"
}
```

There is no `HUB_KEY` setting. Argus Hub stores API keys in `hub.db`. If the database has no API keys
when Argus Hub starts, it generates a key for the Default organization and prints it to the terminal.

Only use `HUB_INSECURE_COOKIE_HOSTS` for hostnames reachable through a private network. Never list
a hostname that is reachable from the public internet.

To rotate a key, delete the old key's row from the Argus Hub database, then restart Argus Hub. Argus Hub only
generates a new key when the `api_keys` table is empty, so disabling a key with `is_enabled = 0`
does not trigger this: rotation requires removing the row outright, not just disabling it. A
disabled key is rejected before Argus Hub reads the upload body.

## Run Argus Hub continuously

Argus Hub runs in the foreground, so a service manager can restart it and collect its logs. The Argus
Hub repository contains the Dockerfile and the complete service examples. The common deployment
shapes are below.

### Linux with systemd

Save this as `/etc/systemd/system/argus-hub.service`:

```ini
[Unit]
Description=Argus Hub
After=network.target

[Service]
Type=simple
ExecStart=npx @agentdeploymentco/argus-hub serve --port 4343
WorkingDirectory=/srv/argus-hub
Environment=HUB_DATA_DIR=/srv/argus-hub/data
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and follow it with:

```bash
sudo systemctl enable --now argus-hub
sudo journalctl -fu argus-hub
```

Set `ADMIN_PASSWORD` in the service environment so a restart does not change the dashboard
password.

### Docker

Pull the published image and persist `/data`, which contains `hub.db`:

```bash
docker pull ghcr.io/agent-deployment-co/argus-hub:latest
docker run -d \
  --name argus-hub \
  -p 4343:4343 \
  -v argus-hub-data:/data \
  --env-file hub.env \
  ghcr.io/agent-deployment-co/argus-hub:latest
```

The package is public, so no `docker login` is needed to pull it. Prefer pinning to a specific
`<version>` or `sha-<commit>` tag over `latest` outside local testing. Building the image
yourself (`docker build -t argus-hub .`) works the same way if you'd rather not pull a
prebuilt image.

`hub.env` should hold at least `HUB_SECRET_KEY` (see [Quick Start](#quick-start)) and,
if you want it pinned, `ADMIN_PASSWORD`. The image exposes `GET /healthz`, which returns `200 ok`
without authentication for container health checks and Kubernetes liveness probes.

For Docker Compose, persist the same data volume:

```yaml
services:
  argus-hub:
    image: ghcr.io/agent-deployment-co/argus-hub:latest
    restart: unless-stopped
    ports:
      - "4343:4343"
    env_file:
      - hub.env
    volumes:
      - argus-hub-data:/data

volumes:
  argus-hub-data:
```

### macOS with launchd

Create a LaunchAgent at `~/Library/LaunchAgents/co.agentdeployment.argus-hub.plist`, set its
working directory and `HUB_DATA_DIR`, then load it:

```bash
launchctl load ~/Library/LaunchAgents/co.agentdeployment.argus-hub.plist
```

Use the service definition in the [Argus Hub repository](https://github.com/Agent-Deployment-Co/argus-hub)
for the complete plist, including log paths and restart behavior.

## Keep an Argus Hub private

Place Argus Hub behind a VPN or a reverse proxy with TLS. Do not expose it directly to the internet.
The Argus Hub database contains the session data of every syncing user, so restrict filesystem access
and include it in backups. Argus Hub sets new database files to mode `0600`.

The client sends resolved usage rows, session summaries, tasks, interaction metadata, tool and MCP
invocations and labels. It does not send retained prompt and response text or BYO API keys. The
client's local `argus.db` file never leaves the machine as a file.
