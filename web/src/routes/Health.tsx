import { Link } from "@tanstack/react-router";
import type { ChartOptions } from "chart.js";
import { ChartCanvas } from "../components/charts/ChartCanvas";
import { DataTable, type Column } from "../components/DataTable";
import { Dash, OutcomeCell, TokGrowthCell } from "../components/pills";
import { StatCards, type Stat } from "../components/StatCards";
import { compactProject, dt, dur, fmt, usd } from "../lib/format";
import { useSnapshot } from "../lib/snapshot";
import type { SessionRow } from "../types";

const numOrDash = (v: number | null) => (v != null ? v : <Dash />);

const healthColumns: Column<SessionRow>[] = [
  {
    id: "start", label: "Started", className: "nowrap", sortValue: (r) => r.start,
    cell: (r) => (
      <Link to="/sessions/$sessionId" params={{ sessionId: r.sessionId }} className="table-link" title="View session">
        {dt(r.start)}
      </Link>
    ),
  },
  {
    id: "project", label: "Project", className: "session-project", sortValue: (r) => r.project,
    cell: (r) => <span className="truncate" title={r.project}>{compactProject(r.project)}</span>,
  },
  { id: "outcome", label: "Outcome", sortValue: (r) => r.health.outcome ?? "", cell: (r) => <OutcomeCell outcome={r.health.outcome} /> },
  { id: "interrupts", label: "Interrupts", num: true, sortValue: (r) => r.health.interruptions ?? -1, cell: (r) => numOrDash(r.health.interruptions) },
  { id: "rejections", label: "Rejections", num: true, sortValue: (r) => r.health.rejections ?? -1, cell: (r) => numOrDash(r.health.rejections) },
  { id: "compactions", label: "Compactions", num: true, sortValue: (r) => r.health.compactions ?? -1, cell: (r) => numOrDash(r.health.compactions) },
  { id: "turns", label: "Turns", num: true, sortValue: (r) => r.health.turns ?? -1, cell: (r) => numOrDash(r.health.turns) },
  { id: "median", label: "Median turn", num: true, sortValue: (r) => r.health.medianTurnMs ?? -1, cell: (r) => (r.health.medianTurnMs != null ? dur(r.health.medianTurnMs) : <Dash />) },
  { id: "growth", label: "Tok×", num: true, sortValue: (r) => r.health.tokenGrowth ?? 0, cell: (r) => <TokGrowthCell growth={r.health.tokenGrowth} /> },
  { id: "msgs", label: "Msgs", num: true, sortValue: (r) => r.messages, cell: (r) => r.messages },
  { id: "cost", label: "Cost", num: true, sortValue: (r) => r.cost, cell: (r) => usd(r.cost) },
];

export function Health() {
  const { dashboard: d } = useSnapshot();
  const ft = d.frictionTotals;
  const n = ft.observableSessions;

  if (n <= 0) {
    return <div className="center-state">No Claude sessions yet — friction signals require native Claude transcripts.</div>;
  }

  const cards: Stat[] = [
    { label: "Interruptions", value: <>{ft.interruptions} <small>{(ft.interruptions / n).toFixed(1)}/session</small></> },
    { label: "Rejections", value: <>{ft.rejections} <small>{(ft.rejections / n).toFixed(1)}/session</small></> },
    { label: "Compactions", value: String(ft.compactions) },
    { label: "Turns", value: <>{fmt(ft.turns)} <small>{(ft.turns / n).toFixed(0)}/session</small></> },
  ];

  const counts = { clean: 0, interrupted: 0, unknown: 0 };
  for (const s of d.sessions) {
    const o = s.health.outcome ?? "unknown";
    counts[o] = (counts[o] ?? 0) + 1;
  }
  const totalSessions = d.sessions.length || 1;

  return (
    <>
      <section>
        <StatCards stats={cards} />
        <p className="note">{n} observable sessions — native Claude transcripts with friction data.</p>
      </section>

      <section>
        <h2>Outcomes</h2>
        <div className="panel">
          <ChartCanvas
            type="doughnut"
            height={220}
            data={{
              labels: ["Clean", "Interrupted", "Unknown"],
              datasets: [{ data: [counts.clean, counts.interrupted, counts.unknown], backgroundColor: ["#5dbcdf", "#e2302c", "rgba(243,215,186,.35)"] }],
            }}
            options={{
              plugins: {
                legend: { position: "right" },
                tooltip: { callbacks: { label: (c) => `${c.label}: ${c.parsed} (${Math.round((100 * Number(c.parsed)) / totalSessions)}%)` } },
              },
            } satisfies ChartOptions<"doughnut">}
          />
        </div>
      </section>

      <section>
        <h2>Sessions</h2>
        <DataTable columns={healthColumns} rows={d.sessions} initialSort="start" />
      </section>
    </>
  );
}
