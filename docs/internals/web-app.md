# The web app (`argus serve`)

`argus serve [--port N]` runs a local web server that presents the dashboard as an interactive
app in the browser. It is the **preferred way to explore usage** and the foundation for richer,
interactive features (filtering, drill-downs) tracked under issue #57.

```
                 browser  ───────────────────────────────────────┐
                   │  GET /                  (SPA shell)           │  React + Vite SPA
                   │  GET /assets/*          (JS / CSS)            │  (TanStack Router/Query/Table,
                   │  GET /api/usage/daily   (one endpoint / view) │   Chart.js via react-chartjs-2)
                   │  GET /api/tools/by-tool  …                    │
                   ▼                                               │
            Hono server  (src/api/serve.ts)                       │
                   │                                               │
   per-view store method + builder ── reads argus.db on demand ───┘
   (SqliteStore.readUsageByDateModel / readToolStats / … → api/{usage,tools,plugins,health}.ts)
```

`argus run` already runs `serve` alongside `index --watch` (the sole writer of `argus.db`), so
serve's reads are read-only and always current. Each dashboard view is answered by its own small
endpoint that reads only what it needs, on demand — there is **no monolithic snapshot and no
server-side cache** (#217). (An earlier design imagined a resident `argusd` daemon caching a
pre-aggregated dashboard; that never shipped — `argus run` is the long-running process.)

---

## How it's wired

- **`src/store/store.ts`** — one promoted read method per view (`readUsageByDateModel`,
  `readUsageBySourceModel`, `readToolStats`, `readToolCategoryStats`, `readMcpServers`/
  `readMcpServerTools`, `readToolResultStats`, `readSkillTokensByDate`, `readSessionsBy*`,
  `readHealthRollups`, …). Each is a SQL `GROUP BY` over the materialized read model — no per-message
  JS walk, and a view only runs the queries it needs.
- **`src/api/{usage,tools,plugins,health}.ts`** — small pure builders that turn those store rows into
  a view's response, pricing per `(dimension, model)` in JS (`cost()`), folding skills/MCP servers
  into plugins (`foldPlugins`), etc. Unit-tested directly in `test/dashboard-views.test.ts`.
- **`src/api/serve.ts`** — `createApp()` (pure route wiring, unit-testable) and `startServer()`
  (opens a store per request, listens via `@hono/node-server`). Routes:
  - The per-view endpoints — `GET /api/usage/daily`, `/api/usage/by-model`, `/api/usage/by-source`,
    `/api/usage/by-project`, `/api/skills`, `/api/tools/by-tool`, `/api/tools/by-category`,
    `/api/tools/by-mcp-server`, `/api/tools/heaviest-results`, `/api/plugins`, `/api/health`,
    `/api/recommendations`. All share the same `since`/`until`/`project`/`source` filter contract
    (unknown source → 400) and 503 when the reader isn't wired in this process.
  - `GET /api/sessions` / `GET /api/session/:id` — the paginated list and on-demand detail
    (`api/session-list.ts`), plus `POST /api/sessions/:id/reindex`, `GET /api/sessions/:id/task-metrics`,
    `GET /api/debug`.
  - `GET *` → serves the built SPA from `dist/web`, falling back to `index.html` so client-side
    routes resolve on a hard refresh. If the app hasn't been built, a small placeholder is served
    and the API still works (the dev-server case).
- **`web/`** — the React app (Vite). Built to `dist/web/`, which the server serves as static files.

### Data flow per request

A view endpoint (e.g. `/api/usage/daily`) opens the store, runs its one or two `GROUP BY` reads
against the request's filters, folds + prices them in the builder, and returns JSON. The store is a
warm read model (the `index` leg keeps it current), so a request does no transcript parsing. Nothing
is cached server-side; the client's React Query `staleTime` (30s) absorbs rapid reloads and keeps the
previous view on screen while a filter change refetches.

---

## Frontend structure (`web/src/`)

| Path | Responsibility |
|------|----------------|
| `main.tsx` | Mounts React; wires `QueryClientProvider`, `ThemeProvider`, `RouterProvider`. |
| `router.tsx` | Code-based TanStack Router tree: `/` (Activity), `/projects`, `/tools`, `/health`. |
| `components/Layout.tsx` | Header, brand mark, nav tabs, theme switcher. No global data fetch — each route fetches its own views; the FilterBar's refreshing indicator reads React Query's `useIsFetching()`. |
| `routes/*.tsx` | One file per tab — the charts and tables for that screen. Each calls only the view hooks its widgets need and handles its own loading/error via `viewGate`. |
| `components/DataTable.tsx` | Sortable table (TanStack Table). |
| `components/charts/ChartCanvas.tsx` | react-chartjs-2 wrapper that merges the current theme's chrome into each chart's options. |
| `lib/charts.ts` | Chart.js registration + theme-aware chrome. |
| `lib/theme.tsx` | Theme context; mirrors/sets `documentElement.dataset.theme` + `localStorage`. |
| `lib/format.ts` | `fmt`/`usd`/`dur`/`dt`, brand palettes, `modelFamilyColor`. |
| `lib/filters.ts` | The shared `SnapshotFilters` (date range + source) + query-param helpers. |
| `lib/views.ts` | One small React Query hook per view endpoint (`useUsageDailyQuery`, `useToolsByToolQuery`, …) via a shared factory, plus `useDashboardFilters` and `viewGate`. |
| `lib/sessions.ts` | The `/api/sessions` list + `/api/session/:id` detail hooks, reindex, and per-task metrics. |
| `types.ts` | Re-exports the CLI's per-view response types + `Dashboard` sub-types (type-only) so the API payload and UI never drift. |

The visual design (CSS variables, the coffee-bean/antique-white themes, the brand fonts) lives in
`web/src` and defines the Argus brand look.

---

## Build & packaging

- `bun run build:web` runs Vite, output → `dist/web/{index.html, assets/*, fonts/*}`.
- `bun run build:compile` compiles the self-contained CLI binary; `dist/web` ships beside it so
  `serve` works against the published artifact.
- **Frontend dependencies are `devDependencies`.** React, Vite, the TanStack packages, and Chart.js
  are bundled into `dist/web` at build time and are never resolved when a user installs the package.
  Only `hono` + `@hono/node-server` are added to runtime `dependencies` — the end-user install
  footprint barely changes.
- The server finds the web root relative to its own module, so it works both as the compiled binary
  and from source after a `build:web` (`src/api/serve.ts` → `../../dist/web`).

---

## Design decisions

These are the choices made for issue #57 and why. The shape — **a Vite-built SPA served by an
embedded server with a JSON API** — is the consensus pattern for local developer-tool web UIs. We use
React + Hono.

**Server: Hono (+ `@hono/node-server`).** Tiny (~14 KB, zero-dep) and runs on **both** Bun (dev) and
Node with the same code, with a small idle footprint — a good fit for the long-running `serve` leg of
`argus run`. Rejected: Elysia (Bun-only), Fastify (~280 KB, Node-only), bare `node:http`
(re-inventing routing).

**Frontend: React + Vite, client-rendered (CSR) SPA.** The frontend runs in the user's browser and is
served over `localhost`, so bundle size has negligible latency cost and doesn't affect the server's
footprint. That freed the choice to be driven by the component model and ecosystem for a complex,
multi-screen analytics app — where React's ecosystem (TanStack, Radix/shadcn, react-chartjs-2) is
strongest. Svelte was the close runner-up, but React was chosen for the component model and ecosystem.

**No SSR / meta-framework.** A local single-user tool reading local data gains nothing from SSR (no
SEO, no slow-network first paint, no edge). A client router (TanStack Router) provides typed routes,
nested layouts, and URL-based filter state without an SSR server.

**TanStack Router + Query + Table.** Routing with URL-based filter/date state (shareable, back-button
works); cached data fetching keyed per view, so a filter change refetches only the affected slices;
headless tables that scale to many screens.

**Charts: Chart.js via `react-chartjs-2`.** A mature charting library with a React binding. (Note:
react-chartjs-2 v5 requires registering the controllers — `BarController`/`LineController`/
`DoughnutController` — not just the elements; see `lib/charts.ts`.)

---

## Out of scope (future work)

- New analytical screens beyond the four ported tabs, deeper drill-downs, and richer filtering UI.
- Authentication (local-only tool for now) and any Tauri/desktop wrapper.
