# Settings

Configure Argus from inside the app. The gear icon at the bottom of the left nav
opens Settings, grouped into a few categories.

## General

- **Appearance** sets the color theme: follow your system, or force light or
  dark.
- **Updates** controls whether the desktop app installs new versions
  automatically. With it off, Argus tells you when an update is ready and you
  install it from the menu bar.
- **Argus Hub** holds the address of your team's [Argus Hub](/glossary#argus-hub)
  and the key used to [sync](/glossary#sync) to it. Leave these blank if you
  aren't using a Hub.

<div class="screenshot">

![General settings: appearance, updates and Argus Hub.](./images/screenshots/settings-general@1920x1080@2.webp)

</div>

## Sessions

- **Extract tasks** turns on task interpretation, the pass that groups each
  [session](/glossary#session) into the [tasks](/glossary#task) you worked on and
  judges how each one went. It's on by default. This is the one thing Argus does
  with an outside model, so turning it on reveals the model settings below.
- **Max sessions per hour** caps how many sessions Argus interprets
  automatically each hour. Refreshing a session by hand isn't limited.
- **Model provider**, **Model** and **Claude CLI path** choose which model
  backend does the interpretation. Argus stores any API key in your operating
  system's secure store, never in its settings file, and a **Test connection**
  button confirms it works.

<div class="screenshot">

![Sessions settings: task interpretation and the model provider it uses.](./images/screenshots/settings-sessions@1920x1080@2.webp)

</div>

## Debug

A read-only view of where Argus reads from and writes to: its settings, the
folders it's watching and how it resolved them. Useful when something isn't
showing up and you want to see what Argus sees.

## From the command line

The app surfaces the everyday settings. A few advanced ones are set from the
command line instead, including text retention, which controls whether Argus
keeps the text of your prompts and responses on your machine (it stays local
either way). See the [CLI Reference](/cli-reference).
