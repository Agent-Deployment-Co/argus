import type { Chart, TooltipModel } from "chart.js";

// Render Chart.js tooltips as an HTML element beside the canvas instead of painting them onto it.
// Chart.js's native tooltip is drawn on the canvas bitmap, so on a short canvas (e.g. the usage
// hero's volume chart) it clips at the canvas edge. This handler builds a positioned <div> in the
// chart's container (.chart-box, position: relative) that can overflow the canvas freely while
// staying inside the chart box (so it never rides up over the sticky filter bar). It reads the same
// title/label callbacks and per-dataset colors the native tooltip would, so content is unchanged —
// pair it with `tooltip: { enabled: false, external: htmlTooltip, callbacks: {...} }`.

const GAP = 9; // space between the caret tip and the hovered bar
const PAD = 6; // keep the tooltip this far from the chart box's left/right edges

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The y below which a tooltip may sit without overlapping the sticky filter bar at the top of the
// viewport. Reads --filter-bar-h (falls back to a safe default) plus a little breathing room.
function filterBarBottom(): number {
  const h = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--filter-bar-h"), 10);
  return (Number.isFinite(h) ? h : 56) + 8;
}

export function htmlTooltip(context: { chart: Chart; tooltip: TooltipModel<"bar"> }) {
  const { chart, tooltip } = context;
  const parent = chart.canvas.parentElement;
  if (!parent) return;
  let el = parent.querySelector<HTMLDivElement>(":scope > .chart-tooltip");
  if (!el) {
    el = document.createElement("div");
    el.className = "chart-tooltip";
    parent.appendChild(el);
  }
  if (tooltip.opacity === 0) {
    el.style.opacity = "0";
    return;
  }

  const title = tooltip.title?.[0] ?? "";
  const rows = tooltip.body
    .map((b, i) => {
      const bg = String(tooltip.labelColors[i]?.backgroundColor ?? "transparent");
      return `<div class="chart-tooltip-row"><span class="chart-tooltip-swatch" style="background:${bg}"></span><span>${escapeHtml(b.lines.join(" "))}</span></div>`;
    })
    .join("");
  el.innerHTML = `<div class="chart-tooltip-title">${escapeHtml(title)}</div>${rows}`;

  const canvas = chart.canvas;
  const w = el.offsetWidth;
  const h = el.offsetHeight;

  // Caret position relative to the chart box (the offset parent).
  const caretLeft = canvas.offsetLeft + tooltip.caretX;
  const caretTop = canvas.offsetTop + tooltip.caretY;

  // Horizontal: center on the caret, clamped within the chart box. The caret then offsets within the
  // tooltip so it keeps pointing at the true column even when the tooltip is clamped near an edge.
  const containerW = parent.clientWidth;
  const left = Math.max(PAD, Math.min(caretLeft - w / 2, containerW - w - PAD));
  const caretX = Math.max(11, Math.min(caretLeft - left, w - 11));

  // Vertical: prefer above the caret (it may float up past a short canvas — e.g. the volume band —
  // into the space above it). Flip below only when going above would collide with the top of the
  // viewport, measured against the sticky filter bar so it never rides over it.
  const caretViewportTop = canvas.getBoundingClientRect().top + tooltip.caretY;
  const below = caretViewportTop - h - GAP < filterBarBottom();
  const aboveTop = caretTop - h - GAP;

  el.classList.toggle("chart-tooltip--below", below);
  el.classList.toggle("chart-tooltip--above", !below);
  el.style.setProperty("--caret-x", `${caretX}px`);
  el.style.left = `${left}px`;
  el.style.top = `${below ? caretTop + GAP : aboveTop}px`;
  el.style.opacity = "1";
}
