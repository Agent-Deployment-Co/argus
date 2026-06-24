---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "Argus"
  text: "Local agent usage, made legible"
  tagline: Audit Claude Code, Codex, Gemini, and Claude Cowork sessions from your own machine, then explore usage, cost, tools, skills, and session health in one local view.
  image:
    src: /favicon.svg
    alt: The Agent Deployment Co. chevron
  actions:
    - theme: brand
      text: Configure Argus
      link: /configuration
    - theme: alt
      text: Read the architecture
      link: /architecture

features:
  - title: Local by default
    details: Serve and index read your transcripts on your machine. Uploads happen only through sync.
    link: /architecture
    linkText: Follow the data flow
  - title: Source-aware parsing
    details: Native producers normalize Claude Code, Codex, Gemini, and Claude Cowork transcripts without flattening away source-specific behavior.
    link: /session-model
    linkText: See the session model
  - title: Interactive dashboard
    details: The web app brings activity, projects, tools, health, and session detail into a browser UI served by the CLI.
    link: /web-app
    linkText: Explore the web app
  - title: Configured explicitly
    details: Settings resolve through flags, environment variables, argus.json, and defaults, with tolerant loading for everyday CLI use.
    link: /configuration
    linkText: Review configuration
---
