import type { ChartOptions } from "chart.js";
import { ChartCanvas } from "../components/charts/ChartCanvas";
import { DataTable, type Column } from "../components/DataTable";
import { OutcomeCell, Skills, TokGrowthCell, Dash } from "../components/pills";
import { metaSessions, namedUsageColumns } from "../components/tables";
import { compactProject, dt, dur, fmt, SERIES, usd } from "../lib/format";
import { useSnapshot } from "../lib/snapshot";
import type { SessionRow } from "../types";

const fmtTick = (v: number | string) => fmt(Number(v));
const dollarTick = (v: number | string) => "$" + v;

function sessionColumns(rows: SessionRow[]): Column<SessionRow>[] {
  const cols: Column<SessionRow>[] = [
    { id: "start", label: "Started", className: "nowrap", sortValue: (r) => r.start, cell: (r) => dt(r.start) },
    { id: "source", label: "Source", sortValue: (r) => r.source ?? "", cell: (r) => r.source ?? "" },
    {
      id: "project", label: "Project", className: "session-project", sortValue: (r) => r.project,
      cell: (r) => <span className="truncate" title={r.project}>{compactProject(r.project)}</span>,
    },
    { id: "dur", label: "Dur", num: true, sortValue: (r) => r.durationMs, cell: (r) => dur(r.durationMs) },
    { id: "msgs", label: "Msgs", num: true, sortValue: (r) => r.messages, cell: (r) => r.messages },
    { id: "outcome", label: "Outcome", sortValue: (r) => r.health.outcome ?? "", cell: (r) => <OutcomeCell outcome={r.health.outcome} /> },
    {
      id: "interrupts", label: "Interrupts", num: true,
      sortValue: (r) => r.health.interruptions ?? -1,
      cell: (r) => (r.health.interruptions != null ? r.health.interruptions : <Dash />),
    },
    { id: "growth", label: "Tok×", num: true, sortValue: (r) => r.health.tokenGrowth ?? 0, cell: (r) => <TokGrowthCell growth={r.health.tokenGrowth} /> },
    { id: "skills", label: "Skills", sortValue: (r) => r.topSkills.join(), cell: (r) => <Skills skills={r.topSkills} /> },
    { id: "total", label: "Tokens", num: true, sortValue: (r) => r.total, cell: (r) => fmt(r.total) },
    { id: "cost", label: "Cost", num: true, sortValue: (r) => r.cost, cell: (r) => usd(r.cost) },
    {
      id: "summary", label: "Summary", sortValue: (r) => r.summary,
      cell: (r) => (
        <>
          <div className="summary">{r.summary}</div>
          {r.firstPrompt && !r.summary.includes('"') && <div className="prompt">{r.firstPrompt.slice(0, 120)}</div>}
        </>
      ),
    },
  ];
  if (rows.some((s) => s.user)) {
    cols.splice(1, 0, { id: "user", label: "User", sortValue: (r) => r.user ?? "", cell: (r) => r.user ?? "" });
  }
  return cols;
}

export function Projects() {
  const { dashboard: d } = useSnapshot();
  const pj = d.byProject.slice(0, 15);

  return (
    <>
      <section>
        <h2>Projects</h2>
        <div className="grid2">
          <div className="panel">
            <h3>Tokens by project</h3>
            <ChartCanvas
              type="bar"
              height={260}
              data={{ labels: pj.map((p) => p.name), datasets: [{ label: "tokens", data: pj.map((p) => p.total), backgroundColor: SERIES.cacheRead }] }}
              options={{
                indexAxis: "y",
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${fmt(Number(c.parsed.x))} tok · ${usd(pj[c.dataIndex]!.cost)} · ${metaSessions(pj[c.dataIndex]!)} sessions` } } },
                scales: { x: { ticks: { callback: fmtTick } } },
              } satisfies ChartOptions<"bar">}
            />
          </div>
          <div className="panel">
            <h3>Est. cost by project</h3>
            <ChartCanvas
              type="bar"
              height={260}
              data={{ labels: pj.map((p) => p.name), datasets: [{ label: "USD", data: pj.map((p) => p.cost), backgroundColor: SERIES.accent }] }}
              options={{
                indexAxis: "y",
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${usd(Number(c.parsed.x))} · ${fmt(pj[c.dataIndex]!.total)} tok` } } },
                scales: { x: { ticks: { callback: dollarTick } } },
              } satisfies ChartOptions<"bar">}
            />
          </div>
        </div>
        <div style={{ marginTop: 24 }}>
          <DataTable columns={namedUsageColumns("Project")} rows={d.byProject} initialSort="total" />
        </div>
      </section>

      <section>
        <h2>Sessions ({d.sessions.length})</h2>
        <DataTable columns={sessionColumns(d.sessions)} rows={d.sessions} initialSort="start" />
      </section>
    </>
  );
}
