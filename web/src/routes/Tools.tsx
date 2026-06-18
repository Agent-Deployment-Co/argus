import type { ChartOptions } from "chart.js";
import { ChartCanvas } from "../components/charts/ChartCanvas";
import { DataTable, type Column } from "../components/DataTable";
import { Dash, Skills } from "../components/pills";
import { CATEGORY_PALETTE, fmt, SERIES, SKILL_PALETTE, usd } from "../lib/format";
import { useSnapshot } from "../lib/snapshot";
import type { PluginRow, ToolStat } from "../types";

const fmtTick = (v: number | string) => fmt(Number(v));

const toolColumns: Column<ToolStat>[] = [
  { id: "display", label: "Tool", sortValue: (r) => r.display, cell: (r) => r.display },
  { id: "category", label: "Category", sortValue: (r) => r.category, cell: (r) => <span className="pill">{r.category}</span> },
  { id: "calls", label: "Calls", num: true, sortValue: (r) => r.calls, cell: (r) => fmt(r.calls) },
  { id: "sessions", label: "Sessions", num: true, sortValue: (r) => r.sessions, cell: (r) => r.sessions },
  { id: "resultTokens", label: "Result tokens", num: true, sortValue: (r) => r.approxResultTokens, cell: (r) => fmt(r.approxResultTokens) },
];

const pluginColumns: Column<PluginRow>[] = [
  {
    id: "name", label: "Plugin", sortValue: (r) => r.name,
    cell: (r) => <>{r.name}{r.marketplace && <span className="muted"> @{r.marketplace}</span>}</>,
  },
  {
    id: "status", label: "Status", sortValue: (r) => (r.enabled ? 2 : 0) + (r.used ? 1 : 0),
    cell: (r) => r.used
      ? <span className="pill on">used</span>
      : r.enabled
        ? <span className="pill warn">enabled · unused</span>
        : <span className="pill">disabled</span>,
  },
  { id: "skills", label: "Skills used", sortValue: (r) => r.skills.length, cell: (r) => <Skills skills={r.skills} /> },
  { id: "skillMessages", label: "Responses", num: true, sortValue: (r) => r.skillMessages, cell: (r) => fmt(r.skillMessages) },
  { id: "skillTokens", label: "Tokens", num: true, sortValue: (r) => r.skillTokens, cell: (r) => fmt(r.skillTokens) },
  { id: "mcpCalls", label: "MCP calls", num: true, sortValue: (r) => r.mcpCalls, cell: (r) => (r.mcpCalls ? r.mcpCalls : <Dash />) },
  { id: "skillCost", label: "Cost", num: true, sortValue: (r) => r.skillCost, cell: (r) => (r.skillCost ? usd(r.skillCost) : <Dash />) },
];

export function Tools() {
  const { dashboard: d } = useSnapshot();
  const sk = d.bySkill.filter((s) => s.name !== "(none)").slice(0, 12);
  const skillNames = sk.map((s) => s.name);
  const tc = d.byToolCategory;
  const tr = d.byTool.slice(0, 15);
  const mcp = d.byMcpServer.slice(0, 12);
  const ht = d.heaviestToolResults.slice(0, 12);

  return (
    <>
      <section>
        <h2>Skills</h2>
        <div className="grid2">
          <div className="panel">
            <h3>Top skills by tokens</h3>
            <ChartCanvas
              type="bar"
              height={260}
              data={{ labels: sk.map((s) => s.name), datasets: [{ label: "tokens", data: sk.map((s) => s.total), backgroundColor: SERIES.cacheWrite }] }}
              options={{
                indexAxis: "y",
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${fmt(Number(c.parsed.x))} tok · ${usd(sk[c.dataIndex]!.cost)} · ${sk[c.dataIndex]!.messages} msgs` } } },
                scales: { x: { ticks: { callback: fmtTick } } },
              } satisfies ChartOptions<"bar">}
            />
            <p className="note">Token attribution is exact — usage and the active skill are recorded on the same message.</p>
          </div>
          <div className="panel">
            <h3>Skill usage over time</h3>
            {skillNames.length > 0 && (
              <ChartCanvas
                type="bar"
                height={260}
                data={{
                  labels: d.bySkillDaily.map((x) => x.date),
                  datasets: skillNames.map((name, i) => ({
                    label: name,
                    data: d.bySkillDaily.map((x) => x.bySkill[name] ?? 0),
                    backgroundColor: SKILL_PALETTE[i % SKILL_PALETTE.length],
                    stack: "s",
                  })),
                }}
                options={{
                  plugins: { legend: { position: "right" }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(Number(c.parsed.y))} tok` } } },
                  scales: { x: { stacked: true, ticks: { maxRotation: 90, minRotation: 45 } }, y: { stacked: true, ticks: { callback: fmtTick } } },
                } satisfies ChartOptions<"bar">}
              />
            )}
          </div>
        </div>
      </section>

      <section>
        <h2>Tools</h2>
        <div className="grid2">
          <div className="panel">
            <h3>Tool calls by category</h3>
            <ChartCanvas
              type="doughnut"
              height={240}
              data={{ labels: tc.map((c) => c.label), datasets: [{ data: tc.map((c) => c.calls), backgroundColor: CATEGORY_PALETTE }] }}
              options={{
                plugins: { legend: { position: "right" }, tooltip: { callbacks: { label: (c) => `${c.label}: ${fmt(Number(c.parsed))} calls · ${tc[c.dataIndex]!.tools} tools` } } },
              } satisfies ChartOptions<"doughnut">}
            />
          </div>
          <div className="panel">
            <h3>Most-used tools (by calls)</h3>
            <ChartCanvas
              type="bar"
              height={240}
              data={{ labels: tr.map((t) => t.display), datasets: [{ label: "calls", data: tr.map((t) => t.calls), backgroundColor: SERIES.input }] }}
              options={{
                indexAxis: "y",
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${fmt(Number(c.parsed.x))} calls · ${tr[c.dataIndex]!.sessions} sessions · ${tr[c.dataIndex]!.category}` } } },
                scales: { x: { ticks: { callback: fmtTick } } },
              } satisfies ChartOptions<"bar">}
            />
          </div>
        </div>
        <div style={{ marginTop: 24 }}>
          <DataTable columns={toolColumns} rows={d.byTool} initialSort="calls" />
        </div>
        <p className="note">MCP tool names are displayed as <code>server · tool</code>.</p>
      </section>

      <section>
        <h2>MCP servers &amp; tool output weight</h2>
        <div className="grid2">
          <div className="panel">
            <h3>MCP server calls</h3>
            <ChartCanvas
              type="bar"
              height={240}
              data={{ labels: mcp.map((m) => m.server), datasets: [{ label: "calls", data: mcp.map((m) => m.calls), backgroundColor: SERIES.input }] }}
              options={{
                indexAxis: "y",
                plugins: {
                  legend: { display: false },
                  tooltip: { callbacks: { afterLabel: (c) => mcp[c.dataIndex]!.topTools.slice(0, 4).map((x) => `${x.tool} (${x.count})`).join("\n") } },
                },
              } satisfies ChartOptions<"bar">}
            />
          </div>
          <div className="panel">
            <h3>Heaviest tool results (approx tokens dumped into context)</h3>
            <ChartCanvas
              type="bar"
              height={240}
              data={{ labels: ht.map((t) => t.tool), datasets: [{ label: "approx tokens", data: ht.map((t) => t.approxTokens), backgroundColor: SERIES.output }] }}
              options={{
                indexAxis: "y",
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${fmt(Number(c.parsed.x))} tok · ${ht[c.dataIndex]!.count} results` } } },
                scales: { x: { ticks: { callback: fmtTick } } },
              } satisfies ChartOptions<"bar">}
            />
            <p className="note">Approximate (≈chars/4). Shows which tools flood context — useful for trimming.</p>
          </div>
        </div>
      </section>

      <section>
        <h2>Plugins</h2>
        <DataTable columns={pluginColumns} rows={d.byPlugin} initialSort="skillTokens" />
        <p className="note">Rows marked <span className="pill warn">enabled · unused</span> are candidates to disable — every enabled plugin's skills/MCP tools add context overhead before you prompt.</p>
      </section>
    </>
  );
}
