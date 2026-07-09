import posthog from 'posthog-js'

// PostHog analytics for the docs site. Mirrors the setup on agentdeployment.co
// (the `adc.co` site): configured from PUBLIC_* build-time env vars, with no
// token hardcoded. init() only runs when a token is present, so local dev and
// any unconfigured build stay silent (PostHog is a no-op) rather than erroring.
//
// Two adaptations for VitePress vs. the reference Astro site:
//   - It's imported from the npm package and bundled, rather than loaded from
//     the CDN via the inline array-stub snippet. VitePress already runs a Vite
//     build, so a bundled import is the idiomatic fit.
//   - VitePress is a single-page app. The `defaults` bundle captures pageviews
//     on History API navigations (which VitePress uses to route), so both the
//     first load and every client-side page change are tracked automatically;
//     there's no per-page script to wire up.
//
// Click tracking is centralized here via event delegation: any element with a
// `data-ph-event` attribute fires that event on click, with an optional
// `data-ph-location` passed as the `location` property. Pages and components
// opt in with those attributes and carry no tracking code of their own.

let started = false

export function initPostHog(): void {
  // enhanceApp/setup also run during SSR; only initialize in the browser.
  if (started || typeof window === 'undefined') return

  const apiKey = import.meta.env.PUBLIC_POSTHOG_PROJECT_TOKEN
  // No token (local dev, any unconfigured build): stay a silent no-op.
  if (!apiKey) return
  started = true

  posthog.init(apiKey, {
    api_host: import.meta.env.PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
    defaults: '2026-01-30'
  })

  // One delegated handler for every CTA. Elements opt in with data-ph-event.
  document.addEventListener('click', (e) => {
    const el =
      e.target instanceof Element
        ? e.target.closest<HTMLElement>('[data-ph-event]')
        : null
    if (!el || !el.dataset.phEvent) return
    const props: Record<string, string> = {}
    if (el.dataset.phLocation) props.location = el.dataset.phLocation
    posthog.capture(el.dataset.phEvent, props)
  })
}
