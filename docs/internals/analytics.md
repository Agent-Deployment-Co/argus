# Analytics (PostHog)

The published docs site sends product analytics to PostHog. It mirrors the setup
on the marketing site (`agentdeployment.co`, the `adc.co` project in the `mono`
repo): configured from `PUBLIC_*` build-time env vars with no token hardcoded,
and CTA click tracking centralized in one delegated handler so pages and
components carry no tracking code of their own.

The docs site is VitePress (a Vite-built Vue SPA), not Astro, so two things
differ from `adc.co` — see [Differences from adc.co](#differences-from-adc-co).

## How it fits together

```
docs/.env / GitHub Actions   PUBLIC_POSTHOG_PROJECT_TOKEN, PUBLIC_POSTHOG_HOST   ← inlined at build time
config.ts (vite.envPrefix)   exposes PUBLIC_* to the client bundle
theme/posthog.ts             posthog.init() (guarded) + delegated click handler
theme/index.ts setup()       initPostHog() on mount                             ← once, client-only
CTAs                         data-ph-event="…" data-ph-location="…"             ← opt-in, no per-component JS
env.d.ts                     import.meta.env.PUBLIC_* typing
```

## The module (`docs/.vitepress/theme/posthog.ts`)

`initPostHog()` has three responsibilities and runs once, on mount, in the
browser:

1. **Load** — imports `posthog-js` from the bundle (see the difference below).
2. **Init, guarded** — `posthog.init()` runs **only when a token is present**.
   With the token absent (local dev, any unconfigured build) PostHog stays a
   no-op: nothing is sent, nothing errors. The host defaults to
   `https://us.i.posthog.com` when `PUBLIC_POSTHOG_HOST` is unset.
3. **Track clicks, delegated** — one document-level `click` listener. Any element
   with a `data-ph-event` attribute fires that event; an optional
   `data-ph-location` is passed as the `location` property. One listener for the
   whole site means no double-binding and no per-section scripts.

`theme/index.ts`'s `setup()` calls `initPostHog()` inside `onMounted`, so it runs
once per app on the client and never during SSR.

Pageviews (the first load and every client-side navigation) are captured
automatically by PostHog's `defaults: '2026-01-30'` bundle, which tracks History
API changes — VitePress routes via the History API, so there is no SPA router to
wire up by hand.

## Configuration (env vars)

| Var | Purpose |
|-----|---------|
| `PUBLIC_POSTHOG_PROJECT_TOKEN` | Project API key. Public by design; gates whether `init()` runs. |
| `PUBLIC_POSTHOG_HOST` | Ingestion host. Optional — defaults to `https://us.i.posthog.com`. |

Both are `PUBLIC_`, so Vite **inlines their values into the static output at
build time** — they are *not* read at serve time. `config.ts` sets
`vite.envPrefix: ['VITE_', 'PUBLIC_']` so Vite exposes the `PUBLIC_`-prefixed
names (its default is `VITE_` only). The value has to exist **wherever
`bun run docs:build` runs**, not where the site is served.

### Where the build runs

The docs deploy (`.github/workflows/docs.yml`) runs `bun run docs:build` on the
GitHub Actions runner and publishes the finished `docs/.vitepress/dist` to GitHub
Pages. So the token lives as a **GitHub Actions repo variable**, passed into the
build step:

```yaml
# .github/workflows/docs.yml
- run: bun run docs:build
  env:
    PUBLIC_POSTHOG_PROJECT_TOKEN: ${{ vars.PUBLIC_POSTHOG_PROJECT_TOKEN }}
```

It's a repo **variable** (Settings → Secrets and variables → Actions →
*Variables* tab), not a secret, because the token is public — it ships to every
browser regardless. It shares the name `PUBLIC_POSTHOG_PROJECT_TOKEN` with the
`adc.co` site, so one org value can feed both. `PUBLIC_POSTHOG_HOST` isn't wired
in; the code default covers it.

### Local development

Copy [`docs/.env.example`](../.env.example) to `docs/.env` (gitignored) and add a
token to test locally. Analytics is off without one, which is usually what you
want. VitePress reads `.env` only at startup — **restart `bun run docs:dev`**
after editing it.

### Verifying a deploy picked up the token

View-source the live site and look for the inlined token:

```bash
curl -s https://<docs-site>/ | grep -o 'phc_[A-Za-z0-9]*'
```

A `phc_…` match means the token was inlined. Empty means the build didn't see it.
(PostHog also has an ingestion delay, so a correct source is a faster signal than
waiting on the Live events view.)

## Events

| Event | When | Properties |
|-------|------|------------|
| `$pageview` | Any page load or client-side navigation | captured automatically by `defaults` |
| `download_clicked` | A macOS or Windows download button is clicked | `location`: `quick_start`, `download_page` |

`download_clicked` is emitted by the delegated handler via the data attributes on
the download buttons in `DownloadButtons.vue`. The `location` prop on the
component identifies the placement, so we can tell which page drives downloads.

## Adding instrumentation

**A new CTA / link (the common case)** — add the data attributes, nothing else.
The delegated handler picks it up automatically:

```html
<a href="…" data-ph-event="cli_docs_clicked" data-ph-location="download_page">…</a>
```

`data-ph-event` is required; `data-ph-location` is optional and becomes the
`location` property. No script, no import.

**Inside a Vue component** — either set the data attributes on the clickable
element (as `DownloadButtons.vue` does) and let the delegated handler fire it, or
`import posthog from 'posthog-js'` and call `posthog.capture(...)` directly. The
delegated route is preferred; it keeps components free of tracking logic.

## Differences from adc.co

Two adaptations for VitePress vs. the reference Astro site. The **configuration**
(env var names, host default, `defaults`, the delegated `data-ph-*` click
pattern) is identical; only the **delivery** differs:

1. **Bundled import, not the CDN snippet.** `adc.co` is a static Astro build and
   loads PostHog from the CDN via an inline array-stub snippet (keeping
   `posthog-js` a devDependency for types only). The docs site already runs a
   Vite build, so it imports `posthog-js` and bundles it — the idiomatic fit.
2. **No manual pageview wiring.** `adc.co` is a multi-page app, so full document
   loads cover pageviews. VitePress is a single-page app, but the `defaults`
   bundle's History-API pageview capture handles client-side navigations, so
   there's still nothing to wire up per page.
