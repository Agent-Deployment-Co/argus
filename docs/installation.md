# Installation

Argus ships as a native macOS app that lives in your menu bar. It bundles the
Argus CLI, keeps your local session data current, and opens the dashboard in
your browser — no separate setup required.

<DownloadMac />

The download is a universal build that runs natively on both Apple Silicon and
Intel Macs.

## Install the app

1. Open the downloaded `.dmg`.
2. Drag **Argus** into your **Applications** folder.
3. Eject the disk image, then launch Argus from Applications (or Spotlight).

Once it's running, look for the Argus icon in your menu bar. Open it to start
the dashboard and explore your usage.

::: tip If macOS blocks the app on first launch
If you see a warning that the app can't be opened, right-click (or
Control-click) **Argus** in Applications and choose **Open**, then confirm.
You only need to do this once. Alternatively, open **System Settings →
Privacy & Security** and click **Open Anyway**.
:::

## Updating

Argus checks for new versions and updates itself in the background, so you stay
on the latest release without re-downloading. You can always grab the most
recent build from this page or from the
[GitHub releases](https://github.com/Agent-Deployment-Co/argus/releases).

## Prefer the command line?

You don't need the app to use Argus. If you'd rather run it directly, the CLI
works through `npx` (Node.js 20.17 or newer):

```bash
npx @agentdeploymentco/argus serve --open
```

See the [Introduction](/) for the quick start and what the dashboard shows.
