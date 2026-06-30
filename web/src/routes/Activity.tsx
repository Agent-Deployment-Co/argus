import type { ChartOptions } from "chart.js";
import { ChartCanvas } from "../components/charts/ChartCanvas";
import { DataTable } from "../components/DataTable";
import { Recommendations } from "../components/Recommendations";
import { StatCards, type Stat } from "../components/StatCards";
import { namedUsageColumns } from "../components/tables";
import { fmt, modelFamilyColor, SERIES, SKILL_PALETTE, usd } from "../lib/format";
import { useSnapshot } from "../lib/snapshot";

const fmtTick = (v: number | string) => fmt(Number(v));
const dollarTick = (v: number | string) => "$" + v;
const rotated = { maxRotation: 90, minRotation: 45 };

export function Activity() {
  const { dashboard: d, recommendations } = useSnapshot();
  const u = d.totals.usage;
  const days = d.daily.map((x) => x.date);

  const cards: Stat[] = [
    { label: "Sessions", value: String(d.totals.sessions) },
    { label: "Model responses", value: fmt(d.totals.messages) },
    { label: "Total tokens", value: fmt(d.totals.total) },
    { label: "Est. cost", value: usd(d.totals.cost) },
    {
      label: "Cache read",
      value: <>{Math.round((100 * u.cacheRead) / Math.max(1, d.totals.total))}% <small>{fmt(u.cacheRead)}</small></>,
    },
    { label: "Output tokens", value: fmt(u.output) },
  ];

  return (
    <>
      <section>
        <StatCards stats={cards} />
        {d.unpriced.length > 0 && (
          <p className="note">Unpriced models (cost excluded): {d.unpriced.join(", ")}.</p>
        )}
      </section>

      <Recommendations recs={recommendations} />

      <section>
        <h2 className="t-eyebrow">Trends</h2>
        <div className="grid2">
          <div className="panel">
            <h3 className="t-subhead">Tokens per day</h3>
            <ChartCanvas
              type="bar"
              height={220}
              data={{
                labels: days,
                datasets: [
                  { label: "cache read", data: d.daily.map((x) => x.cacheRead), backgroundColor: SERIES.cacheRead, stack: "t" },
                  { label: "cache write", data: d.daily.map((x) => x.cacheWrite), backgroundColor: SERIES.cacheWrite, stack: "t" },
                  { label: "input", data: d.daily.map((x) => x.input), backgroundColor: SERIES.input, stack: "t" },
                  { label: "output", data: d.daily.map((x) => x.output), backgroundColor: SERIES.output, stack: "t" },
                ],
              }}
              options={{
                plugins: { legend: { position: "bottom" } },
                scales: { x: { stacked: true, ticks: rotated }, y: { stacked: true, ticks: { callback: fmtTick } } },
              } satisfies ChartOptions<"bar">}
            />
          </div>
          <div className="panel">
            <h3 className="t-subhead">Cost per day (USD)</h3>
            <ChartCanvas
              type="line"
              height={220}
              data={{
                labels: days,
                datasets: [{
                  label: "USD", data: d.daily.map((x) => x.cost),
                  borderColor: SERIES.accent, backgroundColor: "rgba(239,137,32,.16)",
                  fill: true, tension: 0.25, pointRadius: 2,
                }],
              }}
              options={{
                plugins: { legend: { display: false } },
                scales: { x: { ticks: rotated }, y: { ticks: { callback: dollarTick } } },
              } satisfies ChartOptions<"line">}
            />
          </div>
        </div>
      </section>

      <section>
        <h2 className="t-eyebrow">Sources</h2>
        <div className="grid2">
          <div className="panel">
            <h3 className="t-subhead">Tokens by source</h3>
            <ChartCanvas
              type="doughnut"
              height={220}
              data={{
                labels: d.bySource.map((s) => s.name),
                // One color per source by position so the palette scales to however many sources exist
                // (a fixed 4-color array left the 5th+ slice uncolored once claude-chat was added).
                datasets: [{ data: d.bySource.map((s) => s.total), backgroundColor: d.bySource.map((_, i) => SKILL_PALETTE[i % SKILL_PALETTE.length]) }],
              }}
              options={{
                plugins: {
                  legend: { position: "right" },
                  tooltip: { callbacks: { label: (c) => `${c.label}: ${fmt(Number(c.parsed))} tok · ${usd(d.bySource[c.dataIndex]!.cost)}` } },
                },
              } satisfies ChartOptions<"doughnut">}
            />
          </div>
          <div className="panel">
            <h3 className="t-subhead">Est. cost by source</h3>
            <ChartCanvas
              type="bar"
              height={220}
              data={{ labels: d.bySource.map((s) => s.name), datasets: [{ label: "USD", data: d.bySource.map((s) => s.cost), backgroundColor: SERIES.accent }] }}
              options={{
                indexAxis: "y",
                plugins: { legend: { display: false } },
                scales: { x: { ticks: { callback: dollarTick } } },
              } satisfies ChartOptions<"bar">}
            />
          </div>
        </div>
        <div style={{ marginTop: 24 }}>
          <DataTable columns={namedUsageColumns("Source")} rows={d.bySource} initialSort="total" />
        </div>
      </section>

      {d.byUser && d.byUser.length > 0 && (
        <section>
          <h2 className="t-eyebrow">By user</h2>
          <div className="grid2">
            <div className="panel">
              <h3 className="t-subhead">Tokens by user</h3>
              <ChartCanvas
                type="bar"
                height={240}
                data={{ labels: d.byUser.map((x) => x.name), datasets: [{ label: "tokens", data: d.byUser.map((x) => x.total), backgroundColor: SERIES.input }] }}
                options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { ticks: { callback: fmtTick } } } } satisfies ChartOptions<"bar">}
              />
            </div>
            <div className="panel">
              <h3 className="t-subhead">Est. cost by user</h3>
              <ChartCanvas
                type="bar"
                height={240}
                data={{ labels: d.byUser.map((x) => x.name), datasets: [{ label: "USD", data: d.byUser.map((x) => x.cost), backgroundColor: SERIES.accent }] }}
                options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { ticks: { callback: dollarTick } } } } satisfies ChartOptions<"bar">}
              />
            </div>
          </div>
          <div style={{ marginTop: 24 }}>
            <DataTable columns={namedUsageColumns("User")} rows={d.byUser} initialSort="total" />
          </div>
        </section>
      )}

      <section>
        <h2 className="t-eyebrow">Models</h2>
        <div className="panel">
          <h3 className="t-subhead">Tokens by model</h3>
          <ChartCanvas
            type="bar"
            height={260}
            data={{
              labels: d.byModelDaily.map((x) => x.date),
              datasets: d.byModel.map((m) => ({
                label: m.name,
                data: d.byModelDaily.map((x) => x.byModel[m.name] ?? 0),
                backgroundColor: modelFamilyColor(m.name),
                stack: "m",
              })),
            }}
            options={{
              plugins: { legend: { position: "right" }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(Number(c.parsed.y))} tok` } } },
              scales: { x: { stacked: true, ticks: rotated }, y: { stacked: true, ticks: { callback: fmtTick } } },
            } satisfies ChartOptions<"bar">}
          />
        </div>
      </section>
    </>
  );
}
