# The web app design system

How a data view is put together visually: the tokens, the type scale, and the layout primitives
every screen composes from. The goal is that a new view looks like the rest of the app without
anyone re-deciding padding, radius, or heading style. If you're adding or changing a screen, build
from the pieces here rather than hand-rolling markup or inventing a one-off.

The tokens live in `web/src/styles.css`; the primitives live in `web/src/components/`.

## Tokens

**Color.** Everything reads from CSS variables so the coffee-bean (dark) and antique-white (light)
themes stay in sync. Never hard-code a hex value in a component; use the variable for its role:

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

**Radius.** One scale, no exceptions:

- **12px** — panels and stat cards (the framed surfaces).
- **8px** — grouped list containers and code blocks.
- **6px** — small controls (icon buttons, copy buttons).

Do not introduce a 10px card. (SessionDetail predates this doc and has some 10px surfaces; see
[Known divergence](#known-divergence).)

**Spacing.** A top-level `section` carries the page's vertical rhythm (`margin: 0 0 42px`). Inside a
section, a panel title row leaves `10px` below it; the `.grid2` gutter is `24px`; the stat-card grid
gutter is `14px`. Reach for these via the primitives below rather than inline `margin`/`padding`.

## Type scale

Four classes, defined once in `styles.css`, are the single source of truth for heading typography.
Apply one in the markup; never set font-size/weight on a heading inline.

| Class | Use |
|-------|-----|
| `.t-title` | Page / surface title (22px). |
| `.t-eyebrow` | Section overline: accent, uppercase, wide tracking. Labels a `<Section>`. |
| `.t-subhead` | Panel heading (15px bold). The title inside a `<Panel>`. |
| `.t-overline` | Small muted label / table header (11px uppercase). |

Body text is the Aleo serif (set on `body`); labels and headings use `--font-ui` (Poppins).

## Iconography

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
way to pair two panels. (It is viewport-based on purpose; SessionDetail uses container queries instead
because its pane is resizable.) There is no `.grid3`/`.grid4` yet — add one deliberately if a view
needs it rather than reaching for inline grid styles.

## Composition rules

- **Charts and mixed content go in a `<Panel>`.** A chart always sits in a titled panel.
- **Tables do _not_ get a panel.** `DataTable` owns its own chrome (row borders, a sticky header on
  `--surface`), so it sits bare inside a `<Section>`. Wrapping it in a panel double-borders it.
- **Headline numbers use `<StatCards>`** (the `.cards` grid of orange-top-border `.card`s), not
  hand-built panels.
- **Two panels side by side → wrap them in `.grid2`.**

A typical view, then, is a sequence of `<Section>`s: a `<StatCards>` row, some `.grid2` pairs of
`<Panel>`ed charts, and a bare `<DataTable>` or two.

## Known divergence

`routes/SessionDetail.tsx` predates this system and does not use `<Panel>`/`<Section>`. It has its
own card token (`.overview-card`, radius 10, tighter padding), its own heading-above-card layout, a
`.section-title-row` header pattern, and its own container-query grids (`.overview-split`,
`.details-row`). Some of that is justified (tabs, a resizable pane); the card token, radius, and
heading placement are not. **Don't copy those patterns into new views** — use the primitives here.
Bringing SessionDetail onto `<Panel>` is a pending follow-up.
