import { Link } from "@tanstack/react-router";
import { DataTable, type Column } from "../components/DataTable";
import { StatCards, type Stat } from "../components/StatCards";
import { compactProject, fmt } from "../lib/format";
import { useDashboard } from "../lib/snapshot";
import type { FrictionTotals, NamedUsage } from "../types";

/** A project with observable friction, flattened for the table. */
interface ProjectFriction extends FrictionTotals {
  project: string;
}

function projectFriction(byProject: NamedUsage[]): ProjectFriction[] {
  const rows: ProjectFriction[] = [];
  for (const p of byProject) {
    const friction = p.meta?.friction as FrictionTotals | undefined;
    if (friction && friction.observableSessions > 0) rows.push({ project: p.name, ...friction });
  }
  return rows;
}

const projectColumns: Column<ProjectFriction>[] = [
  {
    id: "project", label: "Project", className: "session-project", sortValue: (r) => r.project,
    cell: (r) => (
      <Link to="/sessions" search={{ project: r.project }} className="table-link" title={`View sessions in ${r.project}`}>
        <span className="truncate">{compactProject(r.project)}</span>
      </Link>
    ),
  },
  { id: "sessions", label: "Sessions", num: true, sortValue: (r) => r.observableSessions, cell: (r) => fmt(r.observableSessions) },
  { id: "interruptions", label: "Interrupts", num: true, sortValue: (r) => r.interruptions, cell: (r) => fmt(r.interruptions) },
  { id: "rejections", label: "Rejections", num: true, sortValue: (r) => r.rejections, cell: (r) => fmt(r.rejections) },
  { id: "compactions", label: "Compactions", num: true, sortValue: (r) => r.compactions, cell: (r) => fmt(r.compactions) },
  { id: "turns", label: "Turns", num: true, sortValue: (r) => r.turns, cell: (r) => fmt(r.turns) },
];

export function Health() {
  const d = useDashboard();
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

  const projects = projectFriction(d.byProject);

  return (
    <>
      <section>
        <StatCards stats={cards} />
        <p className="note">{n} observable sessions — native Claude transcripts with friction data. Open a project to drill into its sessions.</p>
      </section>

      <section>
        <h2>Friction by project</h2>
        {projects.length ? (
          <DataTable columns={projectColumns} rows={projects} initialSort="interruptions" />
        ) : (
          <p className="note">No per-project friction to show.</p>
        )}
      </section>
    </>
  );
}
