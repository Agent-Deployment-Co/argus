---
name: screenshot
description: Take Argus product screenshots for the docs using `bun run screenshot` and agent-browser. Use this skill whenever the user asks to capture a screenshot, take a screenshot of a URL or page, refresh the docs screenshots, run a batch of screenshots, or capture the Argus web app UI. Also trigger for ad hoc requests like "screenshot the sessions page" or "grab a shot of this URL" even if no batch file is mentioned.
allowed-tools: Bash(bun run screenshot*), Bash(agent-browser*), Bash(bun*), Read
---

# Screenshot

**Before doing anything, invoke the `agent-browser` skill.** It has the full command reference for navigation and interaction, which you need for any scripted screenshot.

Captures screenshots of the Argus web app for the docs using `bun run screenshot` (navigation, viewport, WebP conversion) and `agent-browser` (scripted interactions before capture). Every capture produces two WebP files, both at 2x display resolution:

- `docs/images/screenshots/{name}@1920x1280@2.webp` (tall)
- `docs/images/screenshots/{name}@1920x1080@2.webp` (standard)

## Before you start: the app must be running

Screenshots hit a running Argus web app. `argus serve` uses `http://localhost:4242`, which is the default base URL. If the user is running the app elsewhere (for example `bun run dev`, which picks a random port), **ask which URL to use**, then pass it as `--base-url`:

```bash
bun run screenshot /sessions --base-url http://localhost:5173
```

Relative URLs (`/sessions`) resolve against the base URL. Absolute URLs (`https://…`) are used as-is.

## Two ways to run it

### One page

```bash
bun run screenshot <url> [name]
```

`url` may be a path (`/tools`) or a full URL. `name` is optional; when omitted it's derived from the URL path (`/tools` becomes `tools`, `/` becomes `home`). Examples:

```bash
bun run screenshot /                      # -> home@...
bun run screenshot /sessions sessions     # -> sessions@...
bun run screenshot http://localhost:5173/tools tools --base-url http://localhost:5173
```

### A batch from YAML

```bash
bun run screenshot --batch docs/screenshots.yaml
```

The batch file lists named pages. `docs/screenshots.yaml` is the canonical set for the docs. Format:

```yaml
baseUrl: http://localhost:4242    # optional; --base-url overrides it
screenshots:
  - name: activity
    url: /
  - name: session-detail
    url: /sessions
    script: |
      1. Click the second session in the list on the left
```

## Processing loop

Read the batch file and process each screenshot **serially in a single browser tab, in the order it appears**, unless the user says otherwise (for example "just redo the tools shot"). Choose the path per entry based on whether it has a `script`:

**No `script`** → capture straight from the URL:

```bash
bun run screenshot <url> <name> --base-url <base>
```

**Has a `script`** → the `--batch` runner skips these, so run them by hand: navigate, execute the interactions with agent-browser, then capture the **current page** with `--name` and no URL (passing a URL would re-navigate and wipe out the state you just set up):

```bash
agent-browser open "<base>/sessions"
agent-browser wait --load networkidle    # proceed even if this times out

# ... execute the script steps (see below) ...

bun run screenshot --name session-detail
```

## Executing script steps

Scripts are natural-language numbered steps. Translate each into agent-browser commands with the snapshot then interact pattern: snapshot to get element refs, act on them, and re-snapshot after anything that changes the DOM (refs go stale).

```bash
agent-browser snapshot -i          # see the page; get refs like @e1, @e2
agent-browser click @e5            # click by ref
agent-browser fill @e3 "value"     # type into a field
agent-browser snapshot -i          # re-snapshot after DOM changes
```

If a step is ambiguous, snapshot first and use judgment about which element best matches. If nothing matches, note it and capture anyway; a partial interaction beats stopping.

**Removing focus rings before capture:** click a non-interactive element (a heading or static text) near the form. Avoid `Escape` (it may close a panel) and prefer a real click over `blur()`.

## Quality check after each screenshot

After each capture, read the tall-viewport file and inspect it:

```bash
Read docs/images/screenshots/{name}@1920x1280@2.webp
```

**A passing screenshot has** fully rendered content (no spinners, skeletons or blank areas), the right page and state (correct view, correct tab, any required panel open), and no stray dialogs or tooltips.

**Retry immediately** on: a loading spinner or skeleton, a blank content area, the wrong page or view, a required panel that isn't open. On a retry, wait 2 to 3 seconds and recapture the current page (omit the URL) unless the page itself needs reloading. Retry once; if it still fails, flag it and move on.

**Flag for review (don't auto-retry)** when content loaded but looks unexpectedly sparse or different from what the step intended.

Only check the tall file; if it's right, the standard one will be too.

## CLI reference

```
bun run screenshot <url> [name]      Capture one page (name defaults to a URL slug)
bun run screenshot --name <name>     Capture the page agent-browser is already on
bun run screenshot --batch <file>    Capture every script-less entry in a YAML batch

  --base-url <url>    Base for relative URLs (default http://localhost:4242, or $ARGUS_URL)
  --out-dir <dir>     Output directory (default docs/images/screenshots)
  --quality <0-100>   WebP quality (default 90)
  --wait <ms>         Extra settle time after the page loads (default 0)
```

The tool itself is `scripts/screenshot.ts`.
