# Download

Argus is a native desktop app that lives in your menu bar. It keeps your local
[session](/terminology#session) data current and opens Argus in your browser, with
no separate setup. The macOS build is available now, and Windows is coming soon.

<DownloadButtons location="download_page" />

## Install on macOS

1. Open the downloaded `.dmg`.
2. Drag **Argus** into your **Applications** folder.
3. Eject the disk image, then launch Argus from Applications (or Spotlight).

Once it's running, look for the Argus icon in your menu bar. Open it to see your
usage.

![The Argus menu bar icon and its menu: Open Argus, Start, Stop, Check for updates and more.](./images/screenshots/mac-menu.png)

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

You don't need the app to use Argus. If you'd rather run it directly, the
command-line tool works through `npx` (Node.js 20.17 or newer):

```bash
npx @agentdeploymentco/argus serve --open
```

See [Quick Start](/) for what Argus shows you.
