# The web app design system

How a view is put together visually: the tokens, the type scale, the layout primitives, and the
reusable components every screen composes from. The goal is that a new view looks like the rest of
the app without anyone re-deciding padding, radius, color, or heading style. If you're adding or
changing a screen, build from the pieces here rather than hand-rolling markup or inventing a one-off.

Tokens and element styling live in `web/src/styles.css`; the primitives and components live in
`web/src/components/`; palettes and formatters live in `web/src/lib/`.

Some conventions below are **standardized by repetition but not yet tokenized** (spacing, elevation,
motion, z-index). They are documented so a new view stays consistent with the existing ones; turning
them into real `--*` variables is tracked under [Known divergences and debt](#known-divergences-and-debt).

## Foundations

### Color

Everything reads from CSS variables so the coffee-bean (dark) and antique-white (light) themes stay
in sync. Never hard-code a hex value in a component; use the variable for its role:

| Variable | Role |
|----------|------|
| `--bg` | Page background (behind everything). |
| `--surface` | Card / panel background (one step up from `--bg`). |
| `--line` | Hairline borders and dividers. |
| `--hover` | Row / control hover wash. |
| `--heading` | Headings and headline numbers. |
| `--text` | Body text. |
| `--muted` | Secondary / label text. |
| `--accent` | The one accent (tiger orange): section eyebrows, the card top-border, focus rings. |
| `--link` / `--link-hover` | Links and interactive text. |

The brand hues (`--tiger-orange`, `--racing-red`, `--sky-surge`, `--cornflower-ocean`, …) are defined
once at `:root`; use them through the role variable above, or through the pill/chart palettes in
`lib/format.ts`, not directly.

- **Style both themes.** Dark is the default `:root`; light is provided via `:root[data-theme="light"]`
  (manual toggle) and `@media (prefers-color-scheme: light)` (system-follow). New tokens must be set in
  all three so the theme toggle works in both directions.
- **State layers use `color-mix`.** Active/selected/hover tints are `color-mix(in srgb, var(--accent)
  8–15%, …)` rather than new hard-coded colors — keep to that pattern.

### Typography

Four classes, defined once in `styles.css`, are the single source of truth for heading typography.
Apply one in the markup; never set font-size/weight on a heading inline.

| Class | Use |
|-------|-----|
| `.t-title` | Page / surface title (22px). |
| `.t-eyebrow` | Section overline: accent, uppercase, wide tracking. Labels a `<Section>`. |
| `.t-subhead` | Panel heading (15px bold). The title inside a `<Panel>`. |
| `.t-overline` | Small muted label / table header (11px uppercase). |

Body text is the **Aleo** serif (set on `body`, 15px/1.55); labels, headings, buttons, and pills use
`--font-ui` (**Poppins**).

### Spacing

There is no `--space-*` scale yet; spacing is raw px literals that cluster on an even-ish ramp. Reach
for a value already on the ramp rather than a new number:

`2 · 4 · 6 · 8 · 10 · 12 · 14 · 18 · 22 · 24 · 28 · 32 · 42`

Anchors worth knowing: a top-level `section` leaves **42px** below it; the `.grid2` gutter is **24px**;
`.panel` padding is **18px**; the stat-card grid gutter is **14px**; a panel title row leaves **10px**;
the page content gutter is **32px** (dropping to 18px under 640px). Prefer the primitives (which own
this spacing) over inline `margin`/`padding`.

### Radius

One ramp:

- **12px** — panels and stat cards (the framed surfaces).
- **8px** — grouped list containers and most controls (inputs, buttons).
- **6px** — small icon buttons (copy, rail icon buttons).
- **4px** — inline `code`.
- **999px / 50%** — pills and circular controls.

Do not introduce a 10px card. (SessionDetail predates this doc and uses 10px on some cards; see
[Known divergences and debt](#known-divergences-and-debt).)

### Elevation

The app is **flat and border-driven** — surfaces are separated by `1px solid var(--line)`, not
shadows. `box-shadow` appears **only on floating layers** (dropdowns, popovers, modals), in three
rough tiers: dropdown/popover (`~0 12px 32px`), modal card (`~0 24px 64px`), lifted image
(`~0 8px 24px`). Don't put a shadow on an inline card or panel. (These shadows aren't tokenized or
theme-aware yet — see debt.)

### Motion

Motion is minimal and should stay so. Existing durations: **0.15s** (toggle), **0.22s** (the task-card
blind), and **0.8s** linear-infinite for the `spin` loading indicator. Use `ease` and keep new
transitions short.

**Always guard non-essential motion behind `@media (prefers-reduced-motion: reduce)`.** (Only the
task-card does this today; new motion must too.)

### Z-index

There's no named scale; keep new stacking within the established bands so layers don't collide:

| Band | Used by |
|------|---------|
| `1–5` | sticky table headers, sticky filter/toolbar bars |
| `20–30` | popovers and dropdown panels |
| `50` | full-screen surfaces and modal backdrops |
| `60` | a modal opened on top of another surface |

### Focus and accessibility

The focus ring is uniform: **`outline: 2px solid var(--accent)`** with an `outline-offset` that
depends on the element:

- **`1px`** — bordered text inputs and selects (ring just outside the border).
- **`2px`** — standalone buttons and links.
- **`-2px`** (inset) — full-bleed rows where an outer ring would clip (e.g. a clickable table row).

Every interactive element gets this ring. Icons are **decorative** (`aria-hidden`); the accessible
name / tooltip goes on the wrapping control via `title` + `aria-label` (see `IconStat`). `color-scheme`
is set per theme so native controls (scrollbars, form widgets) match.

### Breakpoints

Two mechanisms, used deliberately:

- **Viewport `@media (max-width: …)`** for page-level layout. The set in use: **960px** (toolbar wrap),
  **880px** (`.grid2` collapses to one column), **640px** (nav rail → icon-only; settings/welcome stack).
- **Container queries** (`container-type: inline-size` + `@container`) for components whose width
  varies independently of the viewport — the resizable SessionDetail panes use 440/560/620px. Use a
  container query when a component can be narrow while the window is wide.

### Iconography

Icons come from **[lucide-react](https://lucide.dev)** — the one icon set. Render at
`strokeWidth={1.75}` (the app-wide weight); size `18` for nav / controls and `12`–`13` for inline
stats.

**Semantic metric icons have a single source of truth: `web/src/lib/icons.ts`.** A concept that
recurs across views gets a named export there so it looks identical everywhere it appears:

| Export | Icon | Concept |
|--------|------|---------|
| `TokensIcon` | `Coins` | tokens |
| `InteractionsIcon` | `MessagesSquare` | interactions |
| `TasksIcon` | `ClipboardList` | tasks |

Reference these exports rather than reaching for a lucide icon directly for one of these concepts,
and add a new export here when a new metric earns a recurring icon — don't inline a one-off. (This is
the convention SessionDetail and the session list standardized on; a rare case where it, not the
primitives, is the thing to copy.)

**Render a value + its icon with `<IconStat>` (`components/pills.tsx`).** It places the icon after the
value by default (`iconFirst` flips it), treats the icon as decorative (`aria-hidden`), and carries
the accessible name / tooltip on the wrapper via `title` + `aria-label`. `<InteractionCount>` is the
ready-made count-of-interactions variant.

```tsx
<IconStat value={fmt(total)} title={`${fmt(total)} tokens`} icon={TokensIcon} size={12} iconFirst />
```

## Value formatting

Render numbers, money, durations, and dates through the shared formatters in `web/src/lib/format.ts`,
never ad hoc — they own the compact-number and currency conventions the whole app reads by:

| Formatter | Output |
|-----------|--------|
| `fmt(n)` | Compact number: `1.2B` / `3.4M` / `5.6k` / raw. Tokens, calls, messages. |
| `usd(n)` | Currency: `$` + 3 decimals under `$1`, else 2. |
| `pluralize(n, word)` | Singular/plural word for a count. |
| `fmtBytes(n)` | Base-1024 size (`2.0 KB`); `—` when null. |
| `dur(ms)` | Duration `Xm` / `XhYm`. |
| `dt(ms)` / `dtAmPm(ms)` / `dayStamp(ms)` | Timestamp variants (ISO, 12-hour, today-relative). |
| `compactProject(p)` | Truncates hashed project ids. |

## Layout primitives

Two components express the composition rules so they can't drift. Import them from
`web/src/components/`.

### `<Section eyebrow?>`

A top-level block on a view. Renders a `<section>` (so it carries the 42px rhythm) with an optional
`.t-eyebrow` heading above its content.

```tsx
<Section eyebrow="Trends">
  {/* panels and/or tables */}
</Section>
```

### `<Panel title? actions?>`

The canonical surface card: `--surface` background, 1px `--line` border, radius 12, 18px padding.
An optional `title` renders as a `.t-subhead`; optional `actions` sit right-aligned in the title row.

```tsx
<Panel title="Tokens per day">
  <ChartCanvas … />
</Panel>
```

### `.grid2`

Two equal columns with a 24px gutter, collapsing to one column at ≤880px viewport width. The standard
way to pair two panels. (Viewport-based on purpose; SessionDetail uses container queries because its
pane is resizable.) There is no `.grid3`/`.grid4` yet — add one deliberately if a view needs it rather
than reaching for inline grid styles.

## Data visualization

Charts are Chart.js via `react-chartjs-2`, always through **`<ChartCanvas>`** (`components/charts/`),
never a raw `<Chart>`. Color and theming are centralized so charts read as one system.

### Palettes and semantic color (`lib/format.ts`)

- **`SERIES`** — the semantic token-type colors, consistent across every chart: `input` = light blue,
  `output` = orange, `cacheRead` = deep blue, `cacheWrite` = red. Cost/USD series use `SERIES.accent`
  (orange). Pull the key that matches the series' meaning.
- **`modelFamilyColor(name)`** — maps a model to a fixed family hue (Claude = oranges, Gemini = blues,
  GPT = green, Codex = teal), so a given model keeps its color across charts.
- **`SKILL_PALETTE`** (12) / **`CATEGORY_PALETTE`** (9) — categorical arrays for per-skill / per-source /
  per-category series, indexed positionally (`palette[i % palette.length]`).

### Theming

`lib/charts.ts` defines `CHART_THEMES` (grid, tick, tooltip, legend colors per theme) and
`chartChrome(theme)`; `<ChartCanvas>` reads `useTheme()` and deep-merges `chartChrome` under each
chart's own options, re-rendering on theme change. **Data-series hues stay theme-constant; only the
chrome (grid/ticks/tooltip/legend) follows the theme.**

### Conventions

Bar / line / doughnut only. Horizontal bars (`indexAxis: "y"`) for top-N rankings; stacked bars share
a `stack` id + `scales.*.stacked`; legend `bottom` for stacked token bars, `right` for doughnuts,
hidden for single-series bars. Format axis ticks and tooltips through `fmt`/`usd`.

## Component catalog

Reuse these; don't rebuild them. (Star = has a real React component; others are CSS patterns.)

| Component / pattern | Where | For |
|---------------------|-------|-----|
| `Section`, `Panel`, `StatCards` ★ | `components/` | layout primitives + headline-number row |
| `DataTable` ★ + `tables.tsx` helpers | `components/` | sortable table; column descriptors |
| `Kv` / `KvRow` ★ | `components/kv.tsx` | key/value detail grid |
| `Select` ★ (default / pill) | `components/Select.tsx` | the one native-select wrapper |
| `FilterDropdown` ★ | `components/FilterDropdown.tsx` | checkable popover filter (FilterBar + inbox) |
| `CopyButton` ★ | `components/CopyButton.tsx` | copy-to-clipboard (Copy→Check flip) |
| `ClampText` ★ | `components/ClampText.tsx` | truncate with a "read more" toggle |
| `pills.tsx` helpers ★ | `components/pills.tsx` | `IconStat`, `InteractionCount`, `SkillPill`/`Skills`, `TokGrowthCell`, `Dash` |
| `.pill` family | `styles.css` | status badges with semantic color (see below) |
| `Recommendations` ★ | `components/Recommendations.tsx` | the `.rec` recommendation cards |
| `lib/icons.ts`, `lib/format.ts` | `lib/` | semantic icons; value formatters |

**Pill semantics** (`.pill` + modifier): `.on` = active/used, `.warn` = warning, `.clean` =
no-friction, `.interrupted` = interrupted, `.skill` = a skill name; `.task-success/.task-failure/
.task-unclear` and `.frust-none/.frust-moderate/.frust-high` carry outcome / frustration color coding.

## States: loading, error, empty

Every data view gates on its queries with **`viewGate`** (`lib/views.ts`) and renders the shared
`.center-state` shell — match this so loading/error look identical everywhere:

```tsx
const gate = viewGate([q1, q2, …]);
if (gate.pending)      return <div className="center-state">Reading transcripts…</div>;
if (gate.errorMessage) return <div className="center-state">Couldn't load data: {gate.errorMessage}</div>;
```

- **`.center-state`** — the centered muted block for a whole-view loading / error / empty message
  (also used for "No … yet" first-run states).
- **`.note`** — a small muted caption for an inline empty or explanatory note inside a section.

(The gate *logic* is shared but the markup is copy-pasted per route; a `<ViewGate>` wrapper is a
tracked follow-up — see debt.)

## Composition rules

- **Charts and mixed content go in a `<Panel>`.** A chart always sits in a titled panel.
- **Tables do _not_ get a panel.** `DataTable` owns its own chrome (row borders, a sticky header on
  `--surface`), so it sits bare inside a `<Section>`. Wrapping it in a panel double-borders it.
- **Headline numbers use `<StatCards>`**, not hand-built panels.
- **Two panels side by side → wrap them in `.grid2`.**
- **Render every value through `lib/format.ts` and every recurring metric icon through `lib/icons.ts`.**

A typical view is a sequence of `<Section>`s: a `<StatCards>` row, some `.grid2` pairs of `<Panel>`ed
charts, and a bare `<DataTable>` or two.

## Known divergences and debt

Captured so a future contributor neither copies these patterns nor rediscovers the cleanup. None
block building a new view from the primitives above.

**SessionDetail predates this system.** `routes/SessionDetail.tsx` doesn't use `<Panel>`/`<Section>`:
it has its own card token (`.overview-card`, radius 10, tighter padding), a heading-above-card layout,
a `.section-title-row` header pattern, and its own container-query grids. Some of that is justified
(tabs, a resizable pane); the card token, radius, and heading placement are not. **Don't copy those
into new views.** Bringing it onto `<Panel>` is a pending follow-up.

**Missing shared components (consolidation candidates):**
- **No `Button` / `IconButton`.** ~10 near-duplicate neutral-bordered button classes and 4
  differently-sized icon-button classes. Highest-value consolidation.
- **No `Input`.** The bordered-box input formula is copy-pasted across ~5 classes.
- **No `<ViewGate>`.** The gate markup (above) is duplicated in every route though the logic is shared.
- **No `Modal`.** The two centered backdrop dialogs (welcome, label-delete) duplicate the
  backdrop + card formula.
- **Two chip systems** (`.chip` vs `.label-chip`) — mild redundancy.

**Color / token gaps:**
- **No `--success` / `--danger` tokens.** Task-success green is a hard-coded `#6cc08b`/`#3f8f5e`, and a
  hard-coded `#d9534f` competes with the themed `--racing-red` as a second "danger" red.
- **`SERIES.accent === SERIES.output`** (both orange), so orange means both "cost" and "output
  tokens" depending on the chart. Single-series bars also borrow semantic `SERIES` colors as generic
  accents, giving color a false meaning; a dedicated neutral single-series color would fix both.
- **No `--space-*`, `--shadow-*`, `--z-*`, or motion tokens** — the spacing/elevation/z-index/motion
  conventions above are repetition, not variables. Shadows and modal backdrops are also fixed black
  (not theme-aware).
- `fmtTick` / `dollarTick` / `rotated` chart-axis helpers are re-declared in three routes; hoist into
  `lib/charts.ts`.
