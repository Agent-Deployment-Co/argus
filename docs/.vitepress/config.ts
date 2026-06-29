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
      src: '/favicon.svg',
      alt: 'The Agent Deployment Co. chevron'
    },
    siteTitle: 'Argus',
    outline: {
      label: 'On this page',
      level: [2, 3]
    },
    search: {
      provider: 'local'
    },
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Guide', link: '/architecture', activeMatch: '^/(architecture|configuration|session-model|task-interpretation|web-app|building)' },
      { text: 'Examples', link: '/api-examples', activeMatch: '^/(api-examples|markdown-examples)' },
      { text: 'GitHub', link: repoUrl }
    ],

    sidebar: [
      {
        text: 'Overview',
        items: [
          { text: 'Introduction', link: '/' },
          { text: 'Architecture', link: '/architecture' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Session model', link: '/session-model' },
          { text: 'Task interpretation', link: '/task-interpretation' },
          { text: 'Web app', link: '/web-app' },
          { text: 'Building', link: '/building' }
        ]
      },
      {
        text: 'Examples',
        items: [
          { text: 'API examples', link: '/api-examples' },
          { text: 'Markdown examples', link: '/markdown-examples' }
        ]
      }
    ],

    editLink: {
      pattern: `${repoUrl}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub'
    },
    lastUpdated: {
      text: 'Updated'
    },
    docFooter: {
      prev: 'Previous',
      next: 'Next'
    },
    footer: {
      message: 'Built for local-first agent usage auditing.',
      copyright: 'Copyright © The Agent Deployment Company'
    },

    socialLinks: [
      { icon: 'github', link: repoUrl }
    ]
  }
})
