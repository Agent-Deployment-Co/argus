import type { ChartOptions } from "chart.js";
import { ChartCanvas } from "../components/charts/ChartCanvas";
import { DataTable } from "../components/DataTable";
import { Recommendations } from "../components/Recommendations";
import { StatCards, type Stat } from "../components/StatCards";
import { namedUsageColumns } from "../components/tables";
import { fmt, modelFamilyColor, SERIES, usd } from "../lib/format";
import { SourceBadge, sourceColor, sourceLabel } from "../lib/sources";
import {
  useDashboardFilters,
  useRecommendationsQuery,
  useUsageByModelQuery,
  useUsageBySourceQuery,
  useUsageDailyQuery,
  viewGate,
} from "../lib/views";

const fmtTick = (v: number | string) => fmt(Number(v));
const dollarTick = (v: number | string) => "$" + v;
const rotated = { maxRotation: 90, minRotation: 45 };

export function Activity() {
  const filters = useDashboardFilters();
  const dailyQ = useUsageDailyQuery(filters);
  const modelQ = useUsageByModelQuery(filters);
  const sourceQ = useUsageBySourceQuery(filters);
  const recsQ = useRecommendationsQuery(filters);
  const gate = viewGate([dailyQ, modelQ, sourceQ, recsQ]);
  if (gate.pending) return <div className="center-state">Reading transcripts…</div>;
  if (gate.errorMessage) return <div className="center-state">Couldn't load data: {gate.errorMessage}</div>;

  const { totals, daily, unpriced } = dailyQ.data!;
  const { byModel, byModelDaily } = modelQ.data!;
  const { bySource } = sourceQ.data!;
  const recommendations = recsQ.data!.recommendations;
  const u = totals.usage;
  const days = daily.map((x) => x.date);

  const cards: Stat[] = [
    { label: "Sessions", value: String(totals.sessions) },
    { label: "Model responses", value: fmt(totals.messages) },
    { label: "Total tokens", value: fmt(totals.total) },
    { label: "Est. cost", value: usd(totals.cost) },
    {
      label: "Cache read",
      value: <>{Math.round((100 * u.cacheRead) / Math.max(1, totals.total))}% <small>{fmt(u.cacheRead)}</small></>,
    },
    { label: "Output tokens", value: fmt(u.output) },
  ];

  return (
    <>
      <section>
        <StatCards stats={cards} />
        {unpriced.length > 0 && (
          <p className="note">Unpriced models (cost excluded): {unpriced.join(", ")}.</p>
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
                  { label: "cache read", data: daily.map((x) => x.cacheRead), backgroundColor: SERIES.cacheRead, stack: "t" },
                  { label: "cache write", data: daily.map((x) => x.cacheWrite), backgroundColor: SERIES.cacheWrite, stack: "t" },
                  { label: "input", data: daily.map((x) => x.input), backgroundColor: SERIES.input, stack: "t" },
                  { label: "output", data: daily.map((x) => x.output), backgroundColor: SERIES.output, stack: "t" },
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
                  label: "USD", data: daily.map((x) => x.cost),
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
                labels: bySource.map((s) => sourceLabel(s.name)),
                // Each source keeps its stable identity color (see lib/sources), so a source is the
                // same color here, in the cost bars, and on the Home charts.
                datasets: [{ data: bySource.map((s) => s.total), backgroundColor: bySource.map((s) => sourceColor(s.name)) }],
              }}
              options={{
                plugins: {
                  legend: { position: "right" },
                  tooltip: { callbacks: { label: (c) => `${c.label}: ${fmt(Number(c.parsed))} tok · ${usd(bySource[c.dataIndex]!.cost)}` } },
                },
              } satisfies ChartOptions<"doughnut">}
            />
          </div>
          <div className="panel">
            <h3 className="t-subhead">Est. cost by source</h3>
            <ChartCanvas
              type="bar"
              height={220}
              data={{ labels: bySource.map((s) => sourceLabel(s.name)), datasets: [{ label: "USD", data: bySource.map((s) => s.cost), backgroundColor: bySource.map((s) => sourceColor(s.name)) }] }}
              options={{
                indexAxis: "y",
                plugins: { legend: { display: false } },
                scales: { x: { ticks: { callback: dollarTick } } },
              } satisfies ChartOptions<"bar">}
            />
          </div>
        </div>
        <div style={{ marginTop: 24 }}>
          <DataTable columns={namedUsageColumns("Source", (r) => <SourceBadge id={r.name} />)} rows={bySource} initialSort="total" />
        </div>
      </section>

      <section>
        <h2 className="t-eyebrow">Models</h2>
        <div className="panel">
          <h3 className="t-subhead">Tokens by model</h3>
          <ChartCanvas
            type="bar"
            height={260}
            data={{
              labels: byModelDaily.map((x) => x.date),
              datasets: byModel.map((m) => ({
                label: m.name,
                data: byModelDaily.map((x) => x.byModel[m.name] ?? 0),
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
