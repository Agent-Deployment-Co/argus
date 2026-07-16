# Internal docs

Reference for people and agents working on the Argus code. These pages document
how Argus is built: the indexing pipeline, the session model, the local store
schema, the shared LLM layer, task interpretation, and the web app's internals.

They go deeper than the published docs and use internal vocabulary (producer,
reconcile, fragment, fact row, table names) on purpose. The published, user-facing
docs live one level up in `docs/`.

These pages are kept out of the published site (`srcExclude` in the VitePress
config). They stay in the repo as a maintainer and agent reference, not as product
documentation.

- **[Architecture](./architecture.md)** — the one-way pipeline, from transcripts to dashboard.
- **[Session model](./session-model.md)** — how raw transcripts become normalized sessions.
- **[Database schema](./database-schema.md)** — the local store's tables and relationships.
- **[LLM providers](./llm-providers.md)** — the shared LLM access layer and secret storage.
- **[Task interpretation](./task-interpretation.md)** — the optional, model-driven task pass.
- **[Web app](./web-app.md)** — how `argus serve` and the `web/` SPA are wired.
- **[Configuration](./configuration.md)** — the `argus.json` settings file and the settings resolver.
- **[Analytics](./analytics.md)** — PostHog on the published docs site (config, events, deploy).
