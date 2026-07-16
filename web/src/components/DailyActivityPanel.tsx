import { useState } from "react";
import { eachDay, parseISO } from "../lib/calendar";
import { fmt } from "../lib/format";
import type { DailyActivityResponse } from "../types";
import { Panel } from "./Panel";

// Home right-rail sketch (#270): a total-sessions-per-day heatmap; clicking a day fills the area
// below with that day's sessions / tokens / interactions. A concept probe — deliberately minimal.
type Day = DailyActivityResponse["days"][number];

const ACCENT = "var(--accent)";
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"]; // Sunday-first, matching Date.getDay()

function dayTitle(date: string): string {
  return parseISO(date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-value">{value}</div>
      <div className="metric-label t-overline">{label}</div>
    </div>
  );
}

export function DailyActivityPanel({
  days,
  rangeStart,
  rangeEnd,
}: {
  days: Day[];
  rangeStart: string;
  rangeEnd: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const byDate = new Map(days.map((d) => [d.date, d]));

  const calendar = eachDay(rangeStart, rangeEnd);
  const max = calendar.reduce((m, d) => Math.max(m, byDate.get(d)?.sessions ?? 0), 0);
  const lead = calendar.length ? parseISO(calendar[0]!).getDay() : 0; // pad so day 1 lands on its weekday
  const cells: Array<string | null> = [...Array(lead).fill(null), ...calendar];

  const day = selected ? byDate.get(selected) : undefined;

  return (
    <Panel title="Daily activity" className="daily-activity">
      <div className="t-overline">Sessions</div>
      <div className="day-activity-weekdays" aria-hidden>
        {WEEKDAYS.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
      <div className="day-activity-heat" role="grid" aria-label="Sessions per day (click a day)">
        {cells.map((d, i) => {
          if (!d) return <span key={i} className="day-activity-cell day-activity-cell--pad" />;
          const count = byDate.get(d)?.sessions ?? 0;
          const level = count === 0 || max === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
          const style = level === 0 ? undefined : { backgroundColor: `color-mix(in srgb, ${ACCENT} ${level * 20 + 15}%, transparent)` };
          return (
            <button
              key={i}
              type="button"
              className={`day-activity-cell${level === 0 ? " day-activity-cell--empty" : ""}${selected === d ? " day-activity-cell--selected" : ""}`}
              style={style}
              title={`${d}: ${count} ${count === 1 ? "session" : "sessions"}`}
              aria-pressed={selected === d}
              onClick={() => setSelected(d)}
            >
              <span className="day-activity-num">{parseISO(d).getDate()}</span>
            </button>
          );
        })}
      </div>

      <div className="day-activity-detail">
        {day ? (
          <>
            <div className="t-subhead">{dayTitle(day.date)}</div>
            <div className="day-activity-metrics">
              <Metric label="Sessions" value={fmt(day.sessions)} />
              <Metric label="Tokens" value={fmt(day.tokens)} />
              <Metric label="Interactions" value={fmt(day.interactions)} />
            </div>
          </>
        ) : selected ? (
          <p className="note">No activity on {dayTitle(selected)}.</p>
        ) : (
          <p className="note">Select a day to see its activity.</p>
        )}
      </div>
    </Panel>
  );
}
