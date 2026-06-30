import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Argus',
  description:
    'Local-first usage analytics for Claude Code, Codex, Gemini, and Claude Cowork.',
  cleanUrls: true,
  lastUpdated: true,
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
    ['meta', { property: 'og:title', content: 'Argus' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Local-first usage analytics for Claude Code, Codex, Gemini, and Claude Cowork.'
      }
    ]
  ],
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
      { text: 'Introduction', link: '/' },
      { text: 'Installation', link: '/installation' },
      { text: 'Configuration', link: '/configuration' },
      { text: 'Argus Hub', link: '/argus-hub' },
      { text: 'Glossary', link: '/glossary' }
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
