import type { Chart, ChartType, TooltipModel } from "chart.js";

// Render Chart.js tooltips as an HTML element beside the canvas instead of painting them onto it.
// Chart.js's native tooltip is drawn on the canvas bitmap, so on a short canvas (e.g. the usage
// hero's volume band) it clips at the canvas edge. This handler builds a positioned <div> in the
// chart's container (.chart-box, position: relative) that overflows the canvas freely while staying
// inside the chart box (so it never rides up over the sticky filter bar).
//
// It anchors at the mouse cursor, not the datum: Chart.js anchors its tooltip to the datum (a bar's
// end, a doughnut arc's centroid), which reads oddly. We track the cursor from a canvas mousemove
// listener and reposition on every move — Chart.js only re-invokes `external` when the active
// element changes, so it alone can't follow the cursor within one bar/segment. Pair it with
// `tooltip: { enabled: false, external: htmlTooltip, callbacks: {...} }`.

const GAP = 15; // gap from the cursor to the tooltip (the caret protrudes ~6px into this space)
const PAD = 6; // keep the tooltip this far from the chart box's left/right edges

const cursors = new WeakMap<Chart, { x: number; y: number }>();
const tracked = new WeakSet<Chart>();

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The y below which a tooltip may sit without overlapping the sticky filter bar at the top of the
// viewport. Reads --filter-bar-h (falls back to a safe default) plus a little breathing room.
function filterBarBottom(): number {
  const h = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--filter-bar-h"), 10);
  return (Number.isFinite(h) ? h : 56) + 8;
}

function tooltipEl(chart: Chart): HTMLDivElement | null {
  const parent = chart.canvas.parentElement;
  if (!parent) return null;
  let el = parent.querySelector<HTMLDivElement>(":scope > .chart-tooltip");
  if (!el) {
    el = document.createElement("div");
    el.className = "chart-tooltip";
    parent.appendChild(el);
  }
  return el;
}

// Place the tooltip above the cursor (caret pointing down at it), flipping below only when going
// above would collide with the top of the viewport. Horizontally centered on the cursor, clamped
// within the chart box; the caret then offsets within the tooltip to keep pointing at the cursor.
function positionTooltip(chart: Chart, el: HTMLDivElement) {
  const cursor = cursors.get(chart);
  if (!cursor) return;
  const canvas = chart.canvas;
  const parent = canvas.parentElement;
  if (!parent) return;
  const w = el.offsetWidth;
  const h = el.offsetHeight;

  const pointLeft = canvas.offsetLeft + cursor.x;
  const pointTop = canvas.offsetTop + cursor.y;

  const left = Math.max(PAD, Math.min(pointLeft - w / 2, parent.clientWidth - w - PAD));
  const caretX = Math.max(11, Math.min(pointLeft - left, w - 11));

  const pointViewportTop = canvas.getBoundingClientRect().top + cursor.y;
  const below = pointViewportTop - h - GAP < filterBarBottom();

  el.classList.toggle("chart-tooltip--below", below);
  el.classList.toggle("chart-tooltip--above", !below);
  el.style.setProperty("--caret-x", `${caretX}px`);
  el.style.left = `${left}px`;
  el.style.top = `${below ? pointTop + GAP : pointTop - h - GAP}px`;
}

// Track the cursor and reposition the (visible) tooltip live, so it follows the pointer even while
// the hovered bar/segment doesn't change. Attached once per chart, on first tooltip render.
function trackCursor(chart: Chart) {
  if (tracked.has(chart)) return;
  tracked.add(chart);
  chart.canvas.addEventListener("mousemove", (e) => {
    cursors.set(chart, { x: e.offsetX, y: e.offsetY });
    const el = chart.canvas.parentElement?.querySelector<HTMLDivElement>(":scope > .chart-tooltip");
    if (el && el.style.opacity === "1") positionTooltip(chart, el);
  });
}

export function htmlTooltip(context: { chart: Chart; tooltip: TooltipModel<ChartType> }) {
  const { chart, tooltip } = context;
  const el = tooltipEl(chart);
  if (!el) return;
  trackCursor(chart);
  if (tooltip.opacity === 0) {
    el.style.opacity = "0";
    return;
  }
  // Until the first mousemove lands, fall back to the datum caret so the first frame isn't unplaced.
  if (!cursors.has(chart)) cursors.set(chart, { x: tooltip.caretX, y: tooltip.caretY });

  const title = tooltip.title?.[0] ?? "";
  const swatchRow = (bg: string, text: string) =>
    `<div class="chart-tooltip-row"><span class="chart-tooltip-swatch" style="background:${bg}"></span><span>${escapeHtml(text)}</span></div>`;
  const subRow = (text: string) => `<div class="chart-tooltip-row chart-tooltip-sub">${escapeHtml(text)}</div>`;
  const split = (s: string) => s.split("\n"); // afterLabel etc. can embed newlines

  const rows = tooltip.body
    .map((b, i) => {
      const bg = String(tooltip.labelColors[i]?.backgroundColor ?? "transparent");
      // before / after (e.g. an afterLabel list) render as muted sub-rows around the labeled line.
      const before = b.before.flatMap(split).map(subRow);
      const lines = b.lines.flatMap(split).map((line, j) => (j === 0 ? swatchRow(bg, line) : subRow(line)));
      const after = b.after.flatMap(split).map(subRow);
      return [...before, ...lines, ...after].join("");
    })
    .join("");
  // Some charts (doughnut/pie) have no tooltip title — omit the title row rather than leave a gap.
  const titleHtml = title ? `<div class="chart-tooltip-title">${escapeHtml(title)}</div>` : "";
  el.innerHTML = `${titleHtml}${rows}`;

  positionTooltip(chart, el);
  el.style.opacity = "1";
}
