import { defineConfig } from 'vitepress'

const repoUrl = 'https://github.com/Agent-Deployment-Co/argus'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Argus',
  description:
    'Local-first usage analytics for Claude Code, Codex, Gemini, and Claude Cowork.',
  cleanUrls: true,
  lastUpdated: true,
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
      { text: 'Architecture', link: '/architecture' },
      { text: 'Session model', link: '/session-model' },
      { text: 'Task interpretation', link: '/task-interpretation' },
      { text: 'Web app', link: '/web-app' },
      { text: 'Configuration', link: '/configuration' },
      { text: 'Database schema', link: '/database-schema' },
      { text: 'LLM providers', link: '/llm-providers' }
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
    },

    socialLinks: [
      { icon: 'github', link: repoUrl }
    ]
  }
})
