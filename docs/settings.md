# Settings

Configure Argus from inside the app. The gear icon at the bottom of the left nav
opens Settings, grouped into a few categories.

## General

- **Appearance** sets the color theme: follow your system, or force light or
  dark.
- **Model provider** picks the model Argus uses for [task
  interpretation](#sessions) and stores the API key for it. Argus keeps your key
  in your operating system's secure store, never in its settings file, and never
  sends it anywhere except the provider you chose. A **Test connection** button
  confirms the key works.

## Sessions

- **Task interpretation** is an optional pass that groups each
  [session](/glossary#session) into the [tasks](/glossary#task) you worked on and
  judges how each one went. It's off by default, and turning it on reveals the
  model settings it uses. This is the one thing Argus does with an outside model,
  which is why it's opt-in and needs a provider set under General.
- **Text retention** controls whether Argus keeps the text of your prompts and
  responses on your computer. Either way the text stays local and is never
  uploaded.

## Debug

A read-only view of where Argus reads from and writes to: its settings, the
folders it's watching and how it resolved them. Useful when something isn't
showing up and you want to see what Argus sees.

## From the command line

Every setting has a command-line equivalent, and there are commands the app
doesn't surface. See the [CLI Reference](/cli-reference).
