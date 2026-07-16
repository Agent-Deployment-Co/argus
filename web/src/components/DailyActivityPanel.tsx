import { Fragment, useState } from "react";
import { eachDay, parseISO } from "../lib/calendar";
import { fmt } from "../lib/format";
import type { DailyActivityResponse } from "../types";
import { Panel } from "./Panel";

// Home daily-activity sketch (#270): a calendar-style total-sessions-per-day heatmap (weekday
// columns, week-of-year gutter). Selecting a day, a weekday header, or a week label highlights that
// day / column / row and fills the area below with aggregate sessions / tokens / interactions for
// the selection. A concept probe — deliberately minimal.
type Day = DailyActivityResponse["days"][number];

// A day cell, a weekday column (S..S), or a week row (index into the week rows).
type Selection =
  | { kind: "day"; date: string }
  | { kind: "weekday"; dow: number }
  | { kind: "week"; row: number };

const ACCENT = "var(--accent)";
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"]; // Sunday-first, matching Date.getDay()
const WEEKDAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const dayTitle = (date: string): string =>
  parseISO(date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const shortDate = (d: Date): string => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

// Week-of-year for the Sunday-first rows: week 1 holds Jan 1, each week starts on Sunday.
function weekOfYear(d: Date): number {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const dayOfYear = Math.round((d.getTime() - jan1.getTime()) / 86400000);
  return Math.floor((dayOfYear + jan1.getDay()) / 7) + 1;
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
  // Default to the current day of the week (its column), so the panel opens with a useful selection.
  const [sel, setSel] = useState<Selection | null>(() => ({ kind: "weekday" as const, dow: new Date().getDay() }));
  const byDate = new Map(days.map((d) => [d.date, d]));

  const calendar = eachDay(rangeStart, rangeEnd);
  const max = calendar.reduce((m, d) => Math.max(m, byDate.get(d)?.sessions ?? 0), 0);
  const lead = calendar.length ? parseISO(calendar[0]!).getDay() : 0; // pad so day 1 lands on its weekday
  const cells: Array<string | null> = [...Array(lead).fill(null), ...calendar];
  // Chunk into Sunday-first week rows so each can carry a week-of-year label + a row selection.
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const cellSelected = (d: string, row: number, dow: number) =>
    sel?.kind === "day"
      ? sel.date === d
      : sel?.kind === "weekday"
        ? sel.dow === dow
        : sel?.kind === "week"
          ? sel.row === row
          : false;

  // The days covered by the current selection, and their aggregate totals.
  const selectedDates: string[] = !sel
    ? []
    : sel.kind === "day"
      ? [sel.date]
      : sel.kind === "weekday"
        ? calendar.filter((d) => parseISO(d).getDay() === sel.dow)
        : (weeks[sel.row]?.filter((d): d is string => !!d) ?? []);
  const totals = selectedDates.reduce(
    (a, d) => {
      const day = byDate.get(d);
      a.sessions += day?.sessions ?? 0;
      a.tokens += day?.tokens ?? 0;
      a.interactions += day?.interactions ?? 0;
      return a;
    },
    { sessions: 0, tokens: 0, interactions: 0 },
  );

  let title = "";
  if (sel?.kind === "day") {
    title = dayTitle(sel.date);
  } else if (sel?.kind === "weekday") {
    title = `${WEEKDAY_FULL[sel.dow]}s`;
  } else if (sel?.kind === "week") {
    const firstReal = weeks[sel.row]?.find((d): d is string => !!d);
    if (firstReal) {
      const sunday = parseISO(firstReal);
      sunday.setDate(sunday.getDate() - sunday.getDay());
      const saturday = new Date(sunday);
      saturday.setDate(sunday.getDate() + 6);
      title = `Week ${weekOfYear(sunday)} (${shortDate(sunday)} - ${shortDate(saturday)})`;
    }
  }

  return (
    <Panel title="Daily activity" className="daily-activity">
      <div className="day-activity-cal" role="grid" aria-label="Sessions per day">
        <span className="day-activity-corner" aria-hidden />
        {WEEKDAYS.map((w, i) => (
          <button
            key={`wd${i}`}
            type="button"
            className={`day-activity-wd${sel?.kind === "weekday" && sel.dow === i ? " day-activity-wd--selected" : ""}`}
            aria-pressed={sel?.kind === "weekday" && sel.dow === i}
            title={`${WEEKDAY_FULL[i]}s`}
            onClick={() => setSel({ kind: "weekday", dow: i })}
          >
            {w}
          </button>
        ))}
        {weeks.map((week, row) => {
          const firstReal = week.find((d): d is string => !!d);
          return (
            <Fragment key={row}>
              <button
                type="button"
                className={`day-activity-week${sel?.kind === "week" && sel.row === row ? " day-activity-week--selected" : ""}`}
                aria-pressed={sel?.kind === "week" && sel.row === row}
                onClick={() => setSel({ kind: "week", row })}
              >
                {firstReal ? weekOfYear(parseISO(firstReal)) : ""}
              </button>
              {week.map((d, dow) => {
                if (!d) return <span key={dow} className="day-activity-cell day-activity-cell--pad" />;
                const count = byDate.get(d)?.sessions ?? 0;
                const level = count === 0 || max === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
                const style = level === 0 ? undefined : { backgroundColor: `color-mix(in srgb, ${ACCENT} ${level * 20 + 15}%, transparent)` };
                return (
                  <button
                    key={dow}
                    type="button"
                    className={`day-activity-cell${level === 0 ? " day-activity-cell--empty" : ""}${cellSelected(d, row, dow) ? " day-activity-cell--selected" : ""}`}
                    style={style}
                    title={`${d}: ${count} ${count === 1 ? "session" : "sessions"}`}
                    aria-pressed={cellSelected(d, row, dow)}
                    onClick={() => setSel({ kind: "day", date: d })}
                  >
                    <span className="day-activity-num">{parseISO(d).getDate()}</span>
                  </button>
                );
              })}
            </Fragment>
          );
        })}
      </div>

      <div className="day-activity-detail">
        {sel ? (
          <>
            <div className="t-subhead">{title}</div>
            <div className="day-activity-metrics">
              <Metric label="Sessions" value={fmt(totals.sessions)} />
              <Metric label="Tokens" value={fmt(totals.tokens)} />
              <Metric label="Interactions" value={fmt(totals.interactions)} />
            </div>
          </>
        ) : (
          <p className="note">Select a day, weekday, or week.</p>
        )}
      </div>
    </Panel>
  );
}
