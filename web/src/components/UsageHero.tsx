import type { ChartOptions } from "chart.js";
import { useState } from "react";
import { fmt, usd } from "../lib/format";
import { CostIcon, TokensIcon } from "../lib/icons";
import { sourceColor, sourceLabel } from "../lib/sources";
import type { UsageBySourceDailyResponse } from "../types";
import { ChartCanvas } from "./charts/ChartCanvas";
import { Panel } from "./Panel";

// The Home usage hero (#270): a wide panel leading the Home screen. Title (left) + a tokens/cost
// mode switch (right), with a stacked-column chart (one series per source, X = day) filling the
// width below. The two modes read the same series off one payload — tokens vs. priced cost — so the
// stack order and colors stay identical when toggling. Legend labels carry each source's period sum.
type Mode = "tokens" | "cost";
const rotated = { maxRotation: 90, minRotation: 45 };

export function UsageHero({ data }: { data: UsageBySourceDailyResponse }) {
  const [mode, setMode] = useState<Mode>("tokens");
  const { sources, daily, totalsBySource, totalTokens, totalCost } = data;

  const title =
    mode === "tokens" ? `Total Tokens: ${fmt(totalTokens)}` : `Estimated Cost: ${usd(totalCost)}`;

  // Legend sum per source over the period, formatted for the active mode.
  const sumLabel = (s: string) => {
    const t = totalsBySource[s];
    return mode === "tokens" ? fmt(t?.tokens ?? 0) : usd(t?.cost ?? 0);
  };

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
        <ChartCanvas
          type="bar"
          height={300}
          data={{
            // Axis labels drop the year (MM-DD) to cut noise; the tooltip title restores the full date.
            labels: daily.map((d) => d.date.slice(5)),
            datasets: sources.map((s) => ({
              label: `${sourceLabel(s)} (${sumLabel(s)})`,
              data: daily.map((d) => (mode === "tokens" ? (d.tokens[s] ?? 0) : (d.cost[s] ?? 0))),
              backgroundColor: sourceColor(s),
              stack: "s",
            })),
          }}
          options={{
            plugins: {
              legend: { position: "bottom" },
              tooltip: {
                callbacks: {
                  title: (items) => daily[items[0]!.dataIndex]!.date,
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
              x: { stacked: true, ticks: rotated },
              y: {
                stacked: true,
                ticks: {
                  // Compact axis labels (16M, not 16,000,000; $5, not $5.00) — the precise 2-decimal
                  // dollar figure stays on the title/legend/tooltip.
                  callback: (v) => (mode === "tokens" ? fmt(Number(v)) : `$${fmt(Number(v))}`),
                },
              },
            },
          } satisfies ChartOptions<"bar">}
        />
      ) : (
        <p className="note">No usage in this range.</p>
      )}
    </Panel>
  );
}
