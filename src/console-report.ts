import type { Dashboard } from "./types.ts";

interface Column {
  label: string;
  align?: "left" | "right";
}

const MAX_DAYS = 14;
const MAX_ROWS = 8;

function compactNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString("en-US");
}

function usd(value: number): string {
  return `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
}

function truncate(value: string, max = 38): string {
  return value.length > max ? value.slice(0, max - 3) + "..." : value;
}

function table(columns: Column[], rows: string[][]): string {
  const widths = columns.map((column, index) =>
    Math.max(column.label.length, ...rows.map((row) => row[index]?.length || 0)),
  );
  const border = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const renderRow = (row: string[], header = false): string =>
    `|${row.map((value, index) => {
      const width = widths[index]!;
      const alignRight = !header && columns[index]?.align === "right";
      return ` ${alignRight ? value.padStart(width) : value.padEnd(width)} `;
    }).join("|")}|`;

  return [
    border,
    renderRow(columns.map((column) => column.label), true),
    border,
    ...rows.map((row) => renderRow(row)),
    border,
  ].join("\n");
}

function section(title: string, columns: Column[], rows: string[][], emptyText?: string): string {
  if (rows.length === 0) return emptyText ? `${title}\n${emptyText}` : "";
  return `${title}\n${table(columns, rows)}`;
}

export function isBareInvocation(argv: string[]): boolean {
  return argv.length === 0;
}

export function consoleOverview(dashboard: Dashboard): string {
  const sections = [
    section(
      "Overview",
      [{ label: "Metric" }, { label: "Value", align: "right" }],
      [
        ["Sessions", compactNumber(dashboard.totals.sessions)],
        ["Messages", compactNumber(dashboard.totals.messages)],
        ["Total tokens", compactNumber(dashboard.totals.total)],
        ["Estimated cost", usd(dashboard.totals.cost)],
        ["Date range", dashboard.range.start && dashboard.range.end
          ? `${dashboard.range.start} to ${dashboard.range.end}`
          : "(none)"],
      ],
    ),
    section(
      `Tokens by day (latest ${MAX_DAYS} active days)`,
      [
        { label: "Date" },
        { label: "Tokens", align: "right" },
        { label: "Cost", align: "right" },
      ],
      dashboard.daily.slice(-MAX_DAYS).map((day) => [
        day.date,
        compactNumber(day.total),
        usd(day.cost),
      ]),
      "(no usage recorded)",
    ),
    section(
      "Top skills",
      [
        { label: "Skill" },
        { label: "Messages", align: "right" },
        { label: "Tokens", align: "right" },
      ],
      dashboard.bySkill
        .filter((skill) => skill.name !== "(none)")
        .slice(0, MAX_ROWS)
        .map((skill) => [
          truncate(skill.name),
          compactNumber(skill.messages),
          compactNumber(skill.total),
        ]),
      "(no skills recorded)",
    ),
    section(
      "Top MCP servers",
      [
        { label: "Server" },
        { label: "Calls", align: "right" },
        { label: "Result tokens", align: "right" },
      ],
      dashboard.byMcpServer.slice(0, MAX_ROWS).map((server) => [
        truncate(server.server),
        compactNumber(server.calls),
        compactNumber(server.approxResultTokens),
      ]),
    ),
    section(
      "Tokens by project",
      [
        { label: "Project" },
        { label: "Sessions", align: "right" },
        { label: "Tokens", align: "right" },
      ],
      dashboard.byProject.slice(0, MAX_ROWS).map((project) => [
        truncate(project.name),
        compactNumber((project.meta?.sessions as number) || 0),
        compactNumber(project.total),
      ]),
      "(no projects recorded)",
    ),
  ].filter(Boolean);

  return sections.join("\n\n") + "\n\nRun `argus report --open` to view the full HTML report.\n";
}
