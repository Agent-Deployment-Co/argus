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
import type { Theme } from "./theme";

ChartJS.register(
  BarController, LineController, DoughnutController,
  ArcElement, BarElement, LineElement, PointElement,
  CategoryScale, LinearScale, Filler, Legend, Tooltip,
);

ChartJS.defaults.font.family = "Aleo, Georgia, serif";
ChartJS.defaults.plugins.tooltip.borderColor = "#286992";
ChartJS.defaults.plugins.tooltip.borderWidth = 1;

const CHART_THEMES: Record<Theme, { grid: string; muted: string; panel: string; fg: string }> = {
  dark: { grid: "rgba(243,215,186,.18)", muted: "#f3d7ba", panel: "#341f09", fg: "#fefaf5" },
  light: { grid: "rgba(52,31,9,.13)", muted: "#6f5331", panel: "#fefaf5", fg: "#1c1105" },
};

export const fmtNum = (n: number): string =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + "B"
  : n >= 1e6 ? (n / 1e6).toFixed(2) + "M"
  : n >= 1e3 ? (n / 1e3).toFixed(1) + "k"
  : String(n);

/** Theme-dependent chrome merged into every chart's options for the current theme. */
export function chartChrome(theme: Theme): ChartOptions {
  const c = CHART_THEMES[theme];
  return {
    responsive: true,
    maintainAspectRatio: false,
    color: c.muted,
    borderColor: c.grid,
    plugins: {
      legend: { labels: { color: c.muted } },
      tooltip: { backgroundColor: c.panel, titleColor: c.fg, bodyColor: c.fg, borderColor: "#286992", borderWidth: 1 },
    },
    scales: {
      x: { ticks: { color: c.muted }, grid: { color: c.grid } },
      y: { ticks: { color: c.muted }, grid: { color: c.grid } },
    },
  };
}

export { CHART_THEMES };
