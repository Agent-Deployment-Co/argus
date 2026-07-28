import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
// Canonical wording lives in docs/contributing/positioning.md. `SITE_DESCRIPTION`
// is the one-liner from there; change it in that file first, then here.
const SITE_URL = 'https://argus.agentdeployment.co'
const SITE_DESCRIPTION =
  'Argus is a desktop app that helps find and fix wasted agent work. Local, free and open source. Focuses on business tasks, not code. Works with Claude Cowork / Chat / Code, ChatGPT Work and Codex.'

export default defineConfig({
  title: 'Argus',
  description: SITE_DESCRIPTION,
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: SITE_URL },
  vite: {
    // Expose PUBLIC_*-prefixed env vars to the client build (in addition to
    // Vite's default VITE_*), so the PostHog config in theme/posthog.ts can read
    // PUBLIC_POSTHOG_PROJECT_TOKEN / PUBLIC_POSTHOG_HOST. Same var names as the
    // adc.co site, so the same GitHub Actions repo variable feeds both builds.
    envPrefix: ['VITE_', 'PUBLIC_']
  },
  // Contributor/agent material kept in the repo but excluded from the published
  // site: authoring guides (docs/contributing/) and the internal/architecture
  // reference (docs/internals/).
  srcExclude: ['contributing/**', 'internals/**'],
  markdown: {
    // VitePress has no built-in Mermaid support. Turn ```mermaid fences into a
    // placeholder div carrying the (base64-encoded) source; the theme renders
    // them client-side with mermaid. base64 keeps the source out of reach of
    // the Vue template compiler, so braces/pipes in the diagram stay intact.
    config(md) {
      const defaultFence = md.renderer.rules.fence
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        if (token.info.trim() === 'mermaid') {
          const encoded = Buffer.from(token.content, 'utf-8').toString('base64')
          return `<div class="mermaid-diagram" data-mermaid="${encoded}"></div>\n`
        }
        return defaultFence
          ? defaultFence(tokens, idx, options, env, self)
          : self.renderToken(tokens, idx, options)
      }
    }
  },
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico', sizes: '48x48' }],
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }],
    [
      'meta',
      {
        name: 'theme-color',
        content: '#F9EBDC',
        media: '(prefers-color-scheme: light)'
      }
    ],
    [
      'meta',
      {
        name: 'theme-color',
        content: '#1C1105',
        media: '(prefers-color-scheme: dark)'
      }
    ],
    // Defaults. transformPageData below overrides og:title / og:description /
    // og:url per page, so a shared link previews the page it points at.
    ['meta', { property: 'og:site_name', content: 'Argus' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Argus' }],
    ['meta', { property: 'og:description', content: SITE_DESCRIPTION }],
    ['meta', { property: 'og:url', content: SITE_URL }],
    // Regenerate with `bun run og-image` after changing the wordmark or the
    // Activity screenshot. Absolute URL: most platforms won't resolve a relative one.
    ['meta', { property: 'og:image', content: `${SITE_URL}/og-image.png` }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:image:alt', content: 'The Argus dashboard, showing sessions, tokens and estimated cost.' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: `${SITE_URL}/og-image.png` }]
  ],
  // Per-page social metadata. VitePress merges these into the page's head, and
  // duplicate og:* keys would both render, so replace the defaults in place.
  transformPageData(pageData) {
    const isHome = pageData.relativePath === 'index.md'
    // The promise carries the home card; inner pages say what they're about.
    const title = isHome ? 'Find and fix wasted agent work' : `${pageData.title} | Argus`
    const description = pageData.description || pageData.frontmatter.description || SITE_DESCRIPTION
    const path = pageData.relativePath.replace(/(?:index)?\.md$/, '')
    const url = `${SITE_URL}/${path}`

    pageData.frontmatter.head ??= []
    pageData.frontmatter.head.push(
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:url', content: url }],
      ['link', { rel: 'canonical', href: url }]
    )
  },
  themeConfig: {
    logo: {
      light: '/wordmark-on-light.svg',
      dark: '/wordmark-on-dark.svg',
      alt: 'Argus'
    },
    siteTitle: false,
    outline: {
      label: 'On this page',
      level: [2, 3]
    },
    search: {
      provider: 'local'
    },
    // One flat list of pages down the left side — no top nav menu; the
    // logo, search, and GitHub icon live in the header.
    nav: [],

    sidebar: [
      {
        text: 'Get Started',
        items: [
          { text: 'Quick Start', link: '/' },
          { text: 'Download', link: '/download' },
          { text: 'How It Works', link: '/how-it-works' },
          { text: 'Supported Agents', link: '/supported-agents' }
        ]
      },
      {
        text: 'Using Argus',
        items: [
          { text: 'Overview', link: '/overview' },
          { text: 'Sessions', link: '/sessions' },
          { text: 'Tasks', link: '/tasks' },
          { text: 'Metric Views', link: '/metric-views' },
          { text: 'Settings', link: '/settings' },
          { text: 'Model Gateway', link: '/model-gateway' }
        ]
      },
      {
        text: 'Using Argus Hub',
        items: [
          { text: 'Overview', link: '/argus-hub' },
          { text: 'Configuration', link: '/argus-hub/configuration' },
          { text: 'Activity', link: '/argus-hub/activity' },
          { text: 'Tasks', link: '/argus-hub/tasks' },
          { text: 'Tools', link: '/argus-hub/tools' },
          { text: 'Team', link: '/argus-hub/team' },
          { text: 'MCP', link: '/argus-hub/mcp' },
          { text: 'Export', link: '/argus-hub/export' }
        ]
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI Reference', link: '/cli-reference' },
          { text: 'Settings Reference', link: '/settings-reference' },
          { text: 'Changelog', link: '/changelog' },
          { text: 'Terminology', link: '/terminology' },
          { text: 'Privacy and Security', link: '/privacy' },
          { text: 'About', link: '/about' }
        ]
      }
    ],

    lastUpdated: {
      text: 'Updated'
    },
    docFooter: {
      prev: 'Previous',
      next: 'Next'
    },
    footer: {
      copyright: 'Copyright © The Agent Deployment Company'
    }
  }
})
