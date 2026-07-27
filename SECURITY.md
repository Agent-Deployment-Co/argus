# Security

## Reporting a vulnerability

Use GitHub's private reporting:
[Report a vulnerability](https://github.com/Agent-Deployment-Co/argus/security/advisories/new).
It's private between you and the maintainers. Please don't open a public issue
for something exploitable.

Tell us what you found, how to reproduce it and what an attacker could do with
it. We'll acknowledge within three business days and keep you updated while we
work on it. If you'd like credit in the release notes, say so and we'll include
you.

## What's in scope

This repository: the Argus command-line tool, the local web app it serves, and
the desktop app that wraps them. The Argus Hub server is a separate project with
its own repository.

Things we care about most, given what Argus touches:

- Anything that exposes your session data, or the text inside it, to another
  program or over the network.
- Anything that leaks a stored API key out of the OS keychain, the encrypted
  store on Windows, or the config directory.
- Anything reachable by another process or another machine through the local web
  server or the desktop app's front-door port.
- Anything that lets a crafted session file run code, escape its directory or
  corrupt the local store during indexing.

## What Argus already does

Useful context when judging whether something is a real finding:

- Indexing is read-only against your agents' session files. Everything Argus
  derives is written to a local database.
- Nothing is uploaded unless you configure an
  [Argus Hub](https://argus.agentdeployment.co/argus-hub) and run `sync`, and a
  Hub is a server your own organization operates.
- Prompt and response text stays on the machine even when sync is on.
- API keys you supply live in the macOS keychain, a DPAPI-encrypted file on
  Windows, or a `chmod 600` file on Linux. They are never uploaded.
- The desktop app checks GitHub for new releases on a schedule. That's the only
  network call Argus makes on its own.
- Release artifacts are signed: Developer ID and notarization on macOS, Azure
  Artifact Signing on Windows, and the updater verifies its own signature.

[Privacy and Security](https://argus.agentdeployment.co/privacy) covers the same
ground for people who aren't reading the source.

## Supported versions

Fixes go into the next release from `main`. Argus updates itself by default, so
the practical advice is to stay current rather than pin a version.
