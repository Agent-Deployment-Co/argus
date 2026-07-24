import { Link } from "@tanstack/react-router";
import type { ChartOptions } from "chart.js";
import { ChartCanvas } from "../components/charts/ChartCanvas";
import { DataTable, type Column } from "../components/DataTable";
import { metaSessions, namedUsageColumns } from "../components/tables";
import { fmt, SERIES, usd } from "../lib/format";
import { useDashboardFilters, useUsageByProjectQuery, viewGate } from "../lib/views";
import type { NamedUsage } from "../types";

const fmtTick = (v: number | string) => fmt(Number(v));
const dollarTick = (v: number | string) => "$" + v;

// Reuse the shared breakdown columns, but link each project to its filtered sessions list.
const projectColumns: Column<NamedUsage>[] = namedUsageColumns("Project").map((col) =>
  col.id === "name"
    ? {
        ...col,
        cell: (r) => (
          <Link to="/sessions" search={{ project: r.name }} className="table-link" title={`View sessions in ${r.name}`}>
            {r.name}
          </Link>
        ),
      }
    : col,
);

export function Projects() {
  const filters = useDashboardFilters();
  const q = useUsageByProjectQuery(filters);
  const gate = viewGate([q]);
  if (gate.pending) return <div className="center-state">Indexing your sessions…</div>;
  if (gate.errorMessage) return <div className="center-state">Couldn't load data: {gate.errorMessage}</div>;

  const byProject = q.data!.byProject;
  const pj = byProject.slice(0, 15);

  return (
    <section>
      <h2 className="t-eyebrow">Projects</h2>
      <div className="grid2">
        <div className="panel">
          <h3 className="t-subhead">Tokens by project</h3>
          <ChartCanvas
            type="bar"
            height={340}
            data={{ labels: pj.map((p) => p.name), datasets: [{ label: "tokens", data: pj.map((p) => p.total), backgroundColor: SERIES.cacheRead }] }}
            options={{
              indexAxis: "y",
              plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${fmt(Number(c.parsed.x))} tok · ${usd(pj[c.dataIndex]!.cost)} · ${metaSessions(pj[c.dataIndex]!)} sessions` } } },
              scales: { x: { ticks: { callback: fmtTick } } },
            } satisfies ChartOptions<"bar">}
          />
        </div>
        <div className="panel">
          <h3 className="t-subhead">Est. cost by project</h3>
          <ChartCanvas
            type="bar"
            height={340}
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
        <DataTable columns={projectColumns} rows={byProject} initialSort="total" />
      </div>
    </section>
  );
}
