import type { ChartOptions, Plugin, Scale } from "chart.js";
import { useMemo, useState } from "react";
import { fmt, usd } from "../lib/format";
import { CostIcon, TokensIcon } from "../lib/icons";
import { sourceColor, sourceLabel } from "../lib/sources";
import { useTheme } from "../lib/theme";
import type { SessionsBySourceResponse, UsageBySourceDailyResponse } from "../types";
import { ChartCanvas } from "./charts/ChartCanvas";
import { Panel } from "./Panel";

// The Home usage hero (#270): a wide lead panel. Title (left) + a tokens/cost mode switch (right),
// with a stacked-column chart (one series per source, X = day) filling the width below. A smaller
// stacked-column "session volume" chart sits underneath sharing the same X axis — the price/volume
// pairing from a stock chart. The mode switch only drives the top chart (tokens vs. priced cost);
// the volume chart always shows daily session counts. The two modes read the same series off one
// payload, so the stack order and colors stay identical when toggling; legend labels carry each
// source's period sum.
type Mode = "tokens" | "cost";
const rotated = { maxRotation: 90, minRotation: 45 };

// Pin both charts' y-axis to the same width so their plot areas start at the same x and the day
// columns line up vertically (the shared-x illusion — Chart.js draws each chart independently).
const AXIS_WIDTH = 60;
const fixAxisWidth = (scale: Scale) => {
  scale.width = AXIS_WIDTH;
};

// Dim the volume chart so it reads as secondary to the main chart: its bar colors are dimmed (source
// hue at reduced opacity) so they stay tied to each source, and its plot area (only — not the axis
// gutters) gets a slightly-darkened surface tint.
const dimVolumeSource = (id: string) => `color-mix(in srgb, ${sourceColor(id)} 45%, transparent)`;

// Resolve the app's standard sub-surface wash (between --surface and --bg) to a concrete color for
// canvas painting: color-mix()/var() don't resolve in a canvas fillStyle, so mix it on a probe
// element and read back the computed rgb. Theme-aware (the tokens differ per theme).
function subSurfaceWash(): string {
  const probe = document.createElement("span");
  probe.style.cssText = "display:none;background:color-mix(in srgb, var(--surface) 50%, var(--bg))";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

export function UsageHero({
  data,
  sessions,
}: {
  data: UsageBySourceDailyResponse;
  sessions: SessionsBySourceResponse;
}) {
  const [mode, setMode] = useState<Mode>("tokens");
  const { theme } = useTheme();
  const { sources, daily, totalsBySource, totalTokens, totalCost } = data;

  // Paint the sub-surface wash over the volume chart's plot area only (leaving the axis gutters on
  // the panel surface). Re-resolved when the theme changes so it tracks the light/dark tokens.
  const volumeWash = useMemo<Plugin<"bar">>(() => {
    const fill = subSurfaceWash();
    return {
      id: "volumeWash",
      beforeDraw(chart) {
        const { ctx, chartArea } = chart;
        if (!chartArea) return;
        ctx.save();
        ctx.fillStyle = fill;
        ctx.fillRect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
        ctx.restore();
      },
    };
  }, [theme]);

  const title =
    mode === "tokens" ? `Total Tokens: ${fmt(totalTokens)}` : `Estimated Cost: ${usd(totalCost)}`;

  // Legend sum per source over the period, formatted for the active mode.
  const sumLabel = (s: string) => {
    const t = totalsBySource[s];
    return mode === "tokens" ? fmt(t?.tokens ?? 0) : usd(t?.cost ?? 0);
  };

  // One canonical day axis for both charts (the usage series' days). Session counts are keyed by day
  // and read off the same axis — both derive from the same in-range transcripts, so the day sets match.
  const days = daily.map((d) => d.date);
  const axisLabels = days.map((d) => d.slice(5)); // MM-DD; tooltip title restores the full date
  const sessionsByDate = new Map(sessions.daily.map((d) => [d.date, d.bySource]));

  const switcher = (
    <div className="mode-switch" role="group" aria-label="Show tokens or estimated cost">
      <button
        type="button"
        className={`mode-switch-btn${mode === "tokens" ? " is-active" : ""}`}
        aria-pressed={mode === "tokens"}
        onClick={() => setMode("tokens")}
      >
        <TokensIcon size={15} aria-hidden />
        Tokens
      </button>
      <button
        type="button"
        className={`mode-switch-btn${mode === "cost" ? " is-active" : ""}`}
        aria-pressed={mode === "cost"}
        onClick={() => setMode("cost")}
      >
        <CostIcon size={15} aria-hidden />
        Est. Cost
      </button>
    </div>
  );

  return (
    <Panel title={title} actions={switcher} className="usage-hero">
      {daily.length ? (
        <>
          <ChartCanvas
            type="bar"
            height={280}
            data={{
              labels: axisLabels,
              datasets: sources.map((s) => ({
                label: `${sourceLabel(s)} (${sumLabel(s)})`,
                data: daily.map((d) => (mode === "tokens" ? (d.tokens[s] ?? 0) : (d.cost[s] ?? 0))),
                backgroundColor: sourceColor(s),
                stack: "s",
              })),
            }}
            options={{
              // Hovering a day's column surfaces every source's value for that day, not just the
              // segment under the cursor.
              interaction: { mode: "index", intersect: false },
              plugins: {
                // Legend above the top chart — the space between the two charts is reserved for the
                // shared x axis, so it can't live at the bottom of the top chart anymore.
                legend: { position: "top" },
                tooltip: {
                  callbacks: {
                    title: (items) => days[items[0]!.dataIndex]!,
                    // Drop the period-sum suffix the legend carries; show just this day's value.
                    label: (c) => {
                      const s = sources[c.datasetIndex]!;
                      const v = Number(c.parsed.y);
                      return `${sourceLabel(s)}: ${mode === "tokens" ? `${fmt(v)} tokens` : usd(v)}`;
                    },
                  },
                },
              },
              scales: {
                // Hide the day labels on the top chart — the volume chart below owns the shared axis.
                x: { stacked: true, ticks: { display: false } },
                y: {
                  stacked: true,
                  afterFit: fixAxisWidth,
                  ticks: {
                    // Compact axis labels (16M, not 16,000,000; $5, not $5.00) — the precise 2-decimal
                    // dollar figure stays on the title/legend/tooltip.
                    callback: (v) => (mode === "tokens" ? fmt(Number(v)) : `$${fmt(Number(v))}`),
                  },
                },
              },
            } satisfies ChartOptions<"bar">}
          />
          <div className="usage-hero-volume">
            <ChartCanvas
              type="bar"
              height={96}
              plugins={[volumeWash]}
              data={{
                labels: axisLabels,
                datasets: sessions.sources.map((s) => ({
                  label: sourceLabel(s),
                  data: days.map((d) => sessionsByDate.get(d)?.[s] ?? 0),
                  backgroundColor: dimVolumeSource(s),
                  stack: "s",
                })),
              }}
              options={{
                interaction: { mode: "index", intersect: false },
                plugins: {
                  legend: { display: false },
                  tooltip: {
                    callbacks: {
                      title: (items) => days[items[0]!.dataIndex]!,
                      label: (c) => {
                        const s = sessions.sources[c.datasetIndex]!;
                        const v = Number(c.parsed.y);
                        return `${sourceLabel(s)}: ${fmt(v)} ${v === 1 ? "session" : "sessions"}`;
                      },
                    },
                  },
                },
                scales: {
                  x: { stacked: true, ticks: rotated },
                  y: { stacked: true, afterFit: fixAxisWidth, ticks: { precision: 0 } },
                },
              } satisfies ChartOptions<"bar">}
            />
          </div>
        </>
      ) : (
        <p className="note">No usage in this range.</p>
      )}
    </Panel>
  );
}
