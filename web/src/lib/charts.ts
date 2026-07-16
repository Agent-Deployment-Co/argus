// Chart.js registration + theme-aware chrome. Data-series hues stay constant across themes; only
// the chrome (tick/label text, gridlines, tooltip surface) follows the selected theme — same split
// as src/report.ts. Charts re-render when the theme changes because their options are derived from
// it, so we don't mutate live instances by hand.
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  DoughnutController,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import type { ChartOptions } from "chart.js";
import { htmlTooltip } from "./chart-tooltip";
import type { Theme } from "./theme";

ChartJS.register(
  BarController, LineController, DoughnutController,
  ArcElement, BarElement, LineElement, PointElement,
  CategoryScale, LinearScale, Filler, Legend, Tooltip,
);

ChartJS.defaults.font.family = "Aleo, Georgia, serif";

const CHART_THEMES: Record<Theme, { grid: string; muted: string }> = {
  dark: { grid: "rgba(243,215,186,.18)", muted: "#f3d7ba" },
  light: { grid: "rgba(52,31,9,.13)", muted: "#6f5331" },
};

/** Theme-dependent chrome merged into every chart's options for the current theme. Tooltips render
 *  as HTML beside the canvas (lib/chart-tooltip) — the native canvas tooltip is disabled app-wide so
 *  they aren't clipped by short canvases and match the app chrome; charts add their own `callbacks`. */
export function chartChrome(theme: Theme): ChartOptions {
  const c = CHART_THEMES[theme];
  return {
    responsive: true,
    maintainAspectRatio: false,
    color: c.muted,
    borderColor: c.grid,
    plugins: {
      legend: { labels: { color: c.muted } },
      tooltip: { enabled: false, external: htmlTooltip },
    },
    scales: {
      x: { ticks: { color: c.muted }, grid: { color: c.grid } },
      y: { ticks: { color: c.muted }, grid: { color: c.grid } },
    },
  };
}

export { CHART_THEMES };
