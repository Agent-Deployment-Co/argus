# The web app (`argus serve`)

`argus serve [--port N]` runs a local web server that presents the dashboard as an interactive
app in the browser. It is the **preferred way to explore usage** and the foundation for richer,
interactive features (filtering, drill-downs, live updates) tracked under issue #57.

```
                 browser  ─────────────────────────────┐
                   │  GET /            (SPA shell)       │  React + Vite SPA
                   │  GET /assets/*    (JS / CSS)        │  (TanStack Router/Query/Table,
                   │  GET /api/snapshot (Dashboard JSON) │   Chart.js via react-chartjs-2)
                   ▼                                     │
            Hono server  (src/serve.ts)                  │
                   │                                     │
   buildDashboard() ── reads the warm store (incremental)┘
   (src/dashboard-builder.ts → SessionStore.read)
```

The server is the seam the future `argusd` daemon (#56) will run; today it builds the dashboard on
demand and caches it briefly.

---

## How it's wired

- **`src/dashboard-builder.ts`** — `buildDashboard()`, extracted from the CLI entry point so the
  `sync` command and the server share one code path. It reads the warm session store
  **incrementally** (only new/changed transcripts are parsed — see [architecture.md](./architecture.md)),
  not a cold re-parse from disk.
- **`src/serve.ts`** — `createApp()` (pure route wiring, unit-testable) and `startServer()` (owns the
  cache + listens via `@hono/node-server`). Routes:
  - `GET /api/snapshot` → `{ dashboard, recommendations, generatedAtMs }`. Reuses `buildDashboard`
    + `computeRecommendations`. The result is cached in memory for **30s**; `?refresh=1` forces a
    fresh read. A single in-flight build is shared across concurrent requests.
  - `GET *` → serves the built SPA from `dist/web`, falling back to `index.html` so client-side
    routes resolve on a hard refresh. If the app hasn't been built, a small placeholder is served
    and the API still works (the dev-server case).
- **`web/`** — the React app (Vite). Built to `dist/web/`, which the server serves as static files.

### Data flow per request

`/api/snapshot` → `buildDashboard` → `SessionStore.read()` reconciles the store against disk and
returns finished rows → `aggregate` is already baked into the stored read model path → JSON. On a
warm store with nothing new, almost no parsing happens. The 30s cache means repeated page loads
don't even re-run the incremental sync.

---

## Frontend structure (`web/src/`)

| Path | Responsibility |
|------|----------------|
| `main.tsx` | Mounts React; wires `QueryClientProvider`, `ThemeProvider`, `RouterProvider`. |
| `router.tsx` | Code-based TanStack Router tree: `/` (Activity), `/projects`, `/tools`, `/health`. |
| `components/Layout.tsx` | Header, brand mark, nav tabs (Health disabled when no friction data), theme switcher; fetches the snapshot and provides it to routes. |
| `routes/*.tsx` | One file per tab — the charts and tables for that screen. |
| `components/DataTable.tsx` | Sortable table (TanStack Table); replaces the old hand-rolled `makeTable`. |
| `components/charts/ChartCanvas.tsx` | react-chartjs-2 wrapper that merges the current theme's chrome into each chart's options. |
| `lib/charts.ts` | Chart.js registration + theme-aware chrome. |
| `lib/theme.tsx` | Theme context; mirrors/sets `documentElement.dataset.theme` + `localStorage`. |
| `lib/format.ts` | `fmt`/`usd`/`dur`/`dt`, brand palettes, `modelFamilyColor`. |
| `lib/snapshot.tsx` | `useSnapshotQuery` (React Query) + a context so routes read typed, non-null data. |
| `types.ts` | Re-exports the CLI `Dashboard` types (type-only) so the API payload and UI never drift. |

The visual design (CSS variables, the coffee-bean/antique-white themes, the brand fonts) lives in
`web/src` and defines the Argus brand look.

---

## Build & packaging

- `bun run build:web` runs Vite, output → `dist/web/{index.html, assets/*, fonts/*}`.
- `bun run build` runs `build:web` **first**, then bundles the Node CLI to `dist/index.js`. The
  package `files` field is `["dist"]`, so `dist/web` ships automatically with the npm package and
  `npx @agentdeploymentco/argus serve` works against the published bundle.
- **Frontend dependencies are `devDependencies`.** React, Vite, the TanStack packages, and Chart.js
  are bundled into `dist/web` at build time and are never resolved when a user installs the package.
  Only `hono` + `@hono/node-server` are added to runtime `dependencies` — the end-user install
  footprint barely changes.
- The server finds the web root relative to its own module, so it works both as the bundled CLI
  (`dist/index.js` → `dist/web`) and from source after a `build:web` (`src/serve.ts` → `../dist/web`).

---

## Design decisions

These are the choices made for issue #57 and why. The shape — **a Vite-built SPA served by an
embedded server, with a JSON API and (later) SSE for live updates** — is the consensus pattern for
local developer-tool web UIs. We use React + Hono.

**Server: Hono (+ `@hono/node-server`).** Tiny (~14 KB, zero-dep) and runs on **both** Bun (dev) and
Node (the published `dist/index.js`) with the same code. Its idle footprint is small, which matters
because the server is what a future `argusd` daemon (#56) keeps resident. Rejected: Elysia (Bun-only
— would break the Node dist), Fastify (~280 KB, Node-only), bare `node:http` (re-inventing routing).

**Frontend: React + Vite, client-rendered (CSR) SPA.** The deciding insight: the **footprint
constraint binds the server, not the frontend.** The frontend framework runs in the user's browser,
not in `argusd`, so React vs. a smaller framework makes no difference to daemon memory; and because
the app is served over `localhost`, bundle size has negligible latency cost. That freed the choice
to be driven by the component model and ecosystem for a complex, multi-screen analytics app — where
React's ecosystem (TanStack, Radix/shadcn, react-chartjs-2) is strongest. Svelte was the close
runner-up (it's the local-first-niche favorite), but React was chosen for the component model and
ecosystem.

**No SSR / meta-framework.** A local single-user tool reading local data gains nothing from SSR (no
SEO, no slow-network first paint, no edge), and SSR would only add runtime weight to the daemon. A
client router (TanStack Router) provides typed routes, nested layouts, and URL-based filter state
without an SSR server.

**TanStack Router + Query + Table.** Routing with URL-based filter/date state (shareable, back-button
works); cached data fetching with a clean path to SSE live updates later; headless tables that
replace the hand-rolled `makeTable` and scale to many screens.

**Charts: Chart.js via `react-chartjs-2`.** A mature charting library with a React binding. (Note:
react-chartjs-2 v5 requires registering the controllers — `BarController`/`LineController`/
`DoughnutController` — not just the elements; see `lib/charts.ts`.)

---

## Out of scope (future work)

- SSE / live updates — meaningful once `argusd` (#56) watches the transcript dirs and keeps a warm
  store; `GET /api/snapshot`'s `?refresh` is the seam it will plug into.
- New analytical screens beyond the four ported tabs, deeper drill-downs, and filtering UI.
- Authentication (local-only tool for now) and any Tauri/desktop wrapper.
