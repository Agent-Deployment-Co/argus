import type { ChartOptions } from "chart.js";
import { ChartCanvas } from "../components/charts/ChartCanvas";
import { type Column, DataTable } from "../components/DataTable";
import { Panel } from "../components/Panel";
import { Section } from "../components/Section";
import { SourceOverviewCard, type SourceMetrics } from "../components/SourceOverviewCard";
import { UsageHero } from "../components/UsageHero";
import { fmt } from "../lib/format";
import { SourceBadge, sourceColor, sourceLabel } from "../lib/sources";
import {
  useDashboardFilters,
  useSessionsBySourceQuery,
  useUsageBySourceDailyQuery,
  useUsageBySourceQuery,
  viewGate,
} from "../lib/views";
import type { NamedUsage } from "../types";

// The Home screen (#270) — the future root of the web UI. It leads with a few complementary lenses
// (recency, exceptions, repetition, a little metrics) rather than one big table, and routes the user
// into the detail views from there. Mounted at /home for now while it's designed alongside the
// existing Activity page; it takes over "/" once the design settles.
const rotated = { maxRotation: 90, minRotation: 45 };

// interactions/tasks ride NamedUsage.meta (a loose bag) alongside sessions; read them as numbers.
const metaNum = (r: NamedUsage, key: string): number => Number(r.meta?.[key] ?? 0);

// Per-source breakdown table: session count, tokens, interactions, tasks.
const sourceColumns: Column<NamedUsage>[] = [
  { id: "name", label: "Source", sortValue: (r) => r.name, cell: (r) => <SourceBadge id={r.name} /> },
  { id: "sessions", label: "Sessions", num: true, sortValue: (r) => metaNum(r, "sessions"), cell: (r) => fmt(metaNum(r, "sessions")) },
  { id: "total", label: "Tokens", num: true, sortValue: (r) => r.total, cell: (r) => fmt(r.total) },
  { id: "interactions", label: "Interactions", num: true, sortValue: (r) => metaNum(r, "interactions"), cell: (r) => fmt(metaNum(r, "interactions")) },
  { id: "tasks", label: "Tasks", num: true, sortValue: (r) => metaNum(r, "tasks"), cell: (r) => fmt(metaNum(r, "tasks")) },
];

export function Home() {
  const filters = useDashboardFilters();
  const sessionsQ = useSessionsBySourceQuery(filters);
  const bySourceQ = useUsageBySourceQuery(filters);
  const bySourceDailyQ = useUsageBySourceDailyQuery(filters);
  const gate = viewGate([sessionsQ, bySourceQ, bySourceDailyQ]);
  if (gate.pending) return <div className="center-state">Reading transcripts…</div>;
  if (gate.errorMessage) return <div className="center-state">Couldn't load data: {gate.errorMessage}</div>;

  const { sources, daily } = sessionsQ.data!;
  // Total sessions per source = the DISTINCT session count over the whole range (from by-source), not
  // the sum of the daily series — a session active on several days is counted once per day there, so
  // summing it would overcount. Keyed by source so the donut can follow the stacked chart's `sources`
  // order (and thus its colors), so the two charts read as one system.
  const sessionTotals = new Map(
    bySourceQ.data!.bySource.map((s) => [s.name, s.meta?.sessions ?? 0] as [string, number]),
  );

  // Per-source overview cards: key metrics from by-source, the day heatmap from the daily series.
  const metricsBySource = new Map<string, SourceMetrics>(
    bySourceQ.data!.bySource.map((s) => [
      s.name,
      { sessions: metaNum(s, "sessions"), tokens: s.total, interactions: metaNum(s, "interactions"), tasks: metaNum(s, "tasks") },
    ]),
  );
  // Heatmap span: the selected window when set, else the range the data actually covers.
  const rangeStart = filters.since ?? daily[0]?.date ?? "";
  const rangeEnd = filters.until ?? daily.at(-1)?.date ?? "";

  return (
    <>
      <Section>
        <UsageHero data={bySourceDailyQ.data!} sessions={sessionsQ.data!} />
      </Section>

      <Section eyebrow="Source overview">
        {sources.length ? (
          <div className="source-overview-stack">
            {sources.map((s) => (
              <SourceOverviewCard
                key={s}
                source={s}
                metrics={metricsBySource.get(s) ?? { sessions: 0, tokens: 0, interactions: 0, tasks: 0 }}
                dailyCounts={new Map(daily.map((d) => [d.date, d.bySource[s] ?? 0]))}
                rangeStart={rangeStart}
                rangeEnd={rangeEnd}
              />
            ))}
          </div>
        ) : (
          <p className="note">No sessions in this range.</p>
        )}
      </Section>

      <Section eyebrow="Home">
        <Panel title="Sessions by source">
          {daily.length ? (
            <ChartCanvas
              type="bar"
              height={260}
              data={{
                // Axis labels drop the year (MM-DD) to cut noise; the tooltip title restores the full date.
                labels: daily.map((d) => d.date.slice(5)),
                datasets: sources.map((s) => ({
                  label: sourceLabel(s),
                  data: daily.map((d) => d.bySource[s] ?? 0),
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
                      label: (c) => `${c.dataset.label}: ${fmt(Number(c.parsed.y))} sessions`,
                    },
                  },
                },
                scales: {
                  x: { stacked: true, ticks: rotated },
                  y: { stacked: true, ticks: { precision: 0 } },
                },
              } satisfies ChartOptions<"bar">}
            />
          ) : (
            <p className="note">No sessions in this range.</p>
          )}
        </Panel>
      </Section>

      <Section>
        <Panel title="Total sessions by source">
          {sources.length ? (
            <ChartCanvas
              type="doughnut"
              height={260}
              data={{
                labels: sources.map(sourceLabel),
                datasets: [
                  {
                    data: sources.map((s) => sessionTotals.get(s) ?? 0),
                    backgroundColor: sources.map((s) => sourceColor(s)),
                  },
                ],
              }}
              options={{
                plugins: {
                  legend: { position: "right" },
                  tooltip: { callbacks: { label: (c) => `${c.label}: ${fmt(Number(c.parsed))} sessions` } },
                },
              } satisfies ChartOptions<"doughnut">}
            />
          ) : (
            <p className="note">No sessions in this range.</p>
          )}
        </Panel>
      </Section>

      <Section eyebrow="By source">
        {bySourceQ.data!.bySource.length ? (
          <DataTable columns={sourceColumns} rows={bySourceQ.data!.bySource} initialSort="sessions" />
        ) : (
          <p className="note">No sessions in this range.</p>
        )}
      </Section>
    </>
  );
}
