import type { ChartOptions } from "chart.js";
import { ChartCanvas } from "../components/charts/ChartCanvas";
import { Panel } from "../components/Panel";
import { Section } from "../components/Section";
import { fmt, SKILL_PALETTE } from "../lib/format";
import { useDashboardFilters, useSessionsBySourceQuery, viewGate } from "../lib/views";

// The Home screen (#270) — the future root of the web UI. It leads with a few complementary lenses
// (recency, exceptions, repetition, a little metrics) rather than one big table, and routes the user
// into the detail views from there. Mounted at /home for now while it's designed alongside the
// existing Activity page; it takes over "/" once the design settles.
const rotated = { maxRotation: 90, minRotation: 45 };

export function Home() {
  const filters = useDashboardFilters();
  const sessionsQ = useSessionsBySourceQuery(filters);
  const gate = viewGate([sessionsQ]);
  if (gate.pending) return <div className="center-state">Reading transcripts…</div>;
  if (gate.errorMessage) return <div className="center-state">Couldn't load data: {gate.errorMessage}</div>;

  const { sources, daily } = sessionsQ.data!;

  return (
    <Section eyebrow="Home">
      <Panel title="Sessions by source">
        {daily.length ? (
          <ChartCanvas
            type="bar"
            height={260}
            data={{
              labels: daily.map((d) => d.date),
              datasets: sources.map((s, i) => ({
                label: s,
                data: daily.map((d) => d.bySource[s] ?? 0),
                backgroundColor: SKILL_PALETTE[i % SKILL_PALETTE.length],
                stack: "s",
              })),
            }}
            options={{
              plugins: {
                legend: { position: "bottom" },
                tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(Number(c.parsed.y))} sessions` } },
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
  );
}
