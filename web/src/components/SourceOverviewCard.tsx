import type { ReactNode } from "react";
import { fmt } from "../lib/format";
import { SourceBadge, sourceColor } from "../lib/sources";
import { Panel } from "./Panel";

// A per-source overview card (#270): a Panel titled with the source badge, split horizontally into
// key metrics (left) and a session-per-day heatmap (right). All data comes from the Home queries
// already in flight — no dedicated endpoint.

export interface SourceMetrics {
  sessions: number;
  tokens: number;
  interactions: number;
  tasks: number;
}

// Local-date helpers (the store keys days by local YYYY-MM-DD, so parse/format in local time).
function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}
function toISO(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
/** Every calendar day in [start, end] inclusive, as YYYY-MM-DD. Empty if start is after end. */
function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  const end_ = parseISO(end);
  for (let dt = parseISO(start); dt <= end_; dt.setDate(dt.getDate() + 1)) out.push(toISO(dt));
  return out;
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="metric">
      <div className="metric-value">{value}</div>
      <div className="metric-label t-overline">{label}</div>
    </div>
  );
}

/** Calendar heatmap: 7 columns (one weekday each), one row per week running top to bottom, cells
 *  tinted by the source color in proportion to that day's session count (vs. the busiest day). */
function DayHeatmap({ start, end, counts, color }: { start: string; end: string; counts: Map<string, number>; color: string }) {
  const days = eachDay(start, end);
  const max = days.reduce((m, d) => Math.max(m, counts.get(d) ?? 0), 0);
  const lead = days.length ? parseISO(days[0]!).getDay() : 0; // pad so day 1 lands on its weekday row
  const cells: Array<string | null> = [...Array(lead).fill(null), ...days];
  return (
    <div className="day-heatmap-wrap">
      <div className="t-overline">Sessions / day</div>
      <div className="day-heatmap" role="img" aria-label="Sessions per day">
        {cells.map((d, i) => {
          if (!d) return <span key={i} className="day-cell day-cell--pad" />;
          const c = counts.get(d) ?? 0;
          const level = c === 0 || max === 0 ? 0 : Math.min(4, Math.ceil((c / max) * 4));
          const style = level === 0 ? undefined : { backgroundColor: `color-mix(in srgb, ${color} ${level * 22 + 12}%, transparent)` };
          return (
            <span
              key={i}
              className={`day-cell${level === 0 ? " day-cell--empty" : ""}`}
              style={style}
              title={`${d}: ${c} ${c === 1 ? "session" : "sessions"}`}
            />
          );
        })}
      </div>
    </div>
  );
}

export function SourceOverviewCard({
  source,
  metrics,
  dailyCounts,
  rangeStart,
  rangeEnd,
}: {
  source: string;
  metrics: SourceMetrics;
  dailyCounts: Map<string, number>;
  rangeStart: string;
  rangeEnd: string;
}) {
  return (
    <Panel title={<SourceBadge id={source} />} className="source-overview-card">
      <div className="source-overview">
        <div className="source-overview-metrics">
          <Metric label="Sessions" value={fmt(metrics.sessions)} />
          <Metric label="Tokens" value={fmt(metrics.tokens)} />
          <Metric label="Interactions" value={fmt(metrics.interactions)} />
          <Metric label="Tasks" value={fmt(metrics.tasks)} />
        </div>
        <div className="source-overview-heat">
          <DayHeatmap start={rangeStart} end={rangeEnd} counts={dailyCounts} color={sourceColor(source)} />
        </div>
      </div>
    </Panel>
  );
}
