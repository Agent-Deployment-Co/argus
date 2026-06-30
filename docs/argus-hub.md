# Argus Hub

Argus Hub is a self-hosted server that collects usage data from multiple Argus clients and
presents an org-wide dashboard.

Each user can point their client at an Argus Hub instance. Argus Hub receives session data from each client, merges it into one central database tagged by user, and serves an org-wide dashboard view.

## Sending data to Argus Hub

`argus run` includes a built-in sync that uploads automatically on an interval (every 5 minutes by default). Pass `--sync-interval N` to change the frequency, or `--no-sync` to skip uploads entirely.

Run `argus sync` to manually upload sessions.

## More information

See the [Argus Hub repository](https://github.com/Agent-Deployment-Co/argus-hub) for installation instructions and release downloads.
