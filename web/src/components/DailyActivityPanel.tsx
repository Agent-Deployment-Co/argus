import type { LucideIcon } from "lucide-react";
import { Fragment, useState } from "react";
import { toolDisplayName } from "../../../src/tool-categories";
import { eachDay, parseISO } from "../lib/calendar";
import { fmt, pluralize } from "../lib/format";
import { SessionIcon, TasksIcon, TokensIcon } from "../lib/icons";
import type { DailyActivityResponse } from "../types";
import { Panel } from "./Panel";

// Home daily-activity sketch (#270): a calendar-style total-sessions-per-day heatmap (weekday
// columns, week-of-year gutter). Selecting a day, a weekday header, or a week label highlights that
// day / column / row and fills the area below with aggregate metrics + top skills for the selection.
// A concept probe — deliberately minimal.
const MAX_SKILLS = 5;
const MAX_TOOLS = 5;

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

function Metric({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="day-activity-metric" title={label}>
      <Icon size={14} aria-label={label} />
      <span>{value}</span>
    </div>
  );
}

export function DailyActivityPanel({
  data,
  rangeStart,
  rangeEnd,
}: {
  data: DailyActivityResponse;
  rangeStart: string;
  rangeEnd: string;
}) {
  const { days, skillDays, toolDays } = data;
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
      a.tasks += day?.tasks ?? 0;
      return a;
    },
    { sessions: 0, tokens: 0, tasks: 0 },
  );

  // Top skills across the selected days, ranked by the sessions they appear in (summed per day —
  // consistent with the per-day session aggregate above).
  const selectedSet = new Set(selectedDates);
  const skillSessions = new Map<string, number>();
  for (const r of skillDays) {
    if (selectedSet.has(r.date)) skillSessions.set(r.skill, (skillSessions.get(r.skill) ?? 0) + r.sessions);
  }
  const rankedSkills = [...skillSessions.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const topSkills = rankedSkills.slice(0, MAX_SKILLS);
  const restSkills = rankedSkills.slice(MAX_SKILLS);
  const restSkillSessions = restSkills.reduce((sum, [, n]) => sum + n, 0);

  // Top tools across the selected days, ranked by calls (summed per day) — like the session-detail
  // tools list: display name + ×calls, top 5, then an "N more" row totalling the rest.
  const toolCalls = new Map<string, number>();
  for (const r of toolDays) {
    if (selectedSet.has(r.date)) toolCalls.set(r.tool, (toolCalls.get(r.tool) ?? 0) + r.calls);
  }
  const rankedTools = [...toolCalls.entries()]
    .map(([tool, calls]) => ({ tool, calls, display: toolDisplayName(tool) }))
    .sort((a, b) => b.calls - a.calls || a.display.localeCompare(b.display));
  const topTools = rankedTools.slice(0, MAX_TOOLS);
  const restTools = rankedTools.slice(MAX_TOOLS);
  const restCalls = restTools.reduce((sum, t) => sum + t.calls, 0);

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
              <Metric icon={SessionIcon} label="Sessions" value={fmt(totals.sessions)} />
              <Metric icon={TokensIcon} label="Tokens" value={fmt(totals.tokens)} />
              <Metric icon={TasksIcon} label="Tasks" value={fmt(totals.tasks)} />
            </div>
            {topSkills.length > 0 && (
              <div className="day-activity-list">
                <div className="t-overline">Top skills</div>
                <div className="kv">
                  {topSkills.map(([skill, n]) => (
                    <div className="kv-row" key={skill}>
                      <span className="kv-k" title={skill}>{skill}</span>
                      <span className="kv-v" title={`${n} ${pluralize(n, "session")}`}>
                        <span className="calls-x">×</span>
                        {fmt(n)}
                      </span>
                    </div>
                  ))}
                  {restSkills.length > 0 && (
                    <div className="kv-row">
                      <span className="kv-k">{restSkills.length} more</span>
                      <span className="kv-v" title={`${restSkillSessions} ${pluralize(restSkillSessions, "session")}`}>
                        <span className="calls-x">×</span>
                        {fmt(restSkillSessions)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
            {topTools.length > 0 && (
              <div className="day-activity-list">
                <div className="t-overline">Top tools</div>
                <div className="kv">
                  {topTools.map((t) => (
                    <div className="kv-row" key={t.tool}>
                      <span className="kv-k" title={t.display}>{t.display}</span>
                      <span className="kv-v" title={`${t.calls} ${pluralize(t.calls, "call")}`}>
                        <span className="calls-x">×</span>
                        {fmt(t.calls)}
                      </span>
                    </div>
                  ))}
                  {restTools.length > 0 && (
                    <div className="kv-row">
                      <span className="kv-k">{restTools.length} more</span>
                      <span className="kv-v" title={`${restCalls} ${pluralize(restCalls, "call")}`}>
                        <span className="calls-x">×</span>
                        {fmt(restCalls)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="note">Select a day, weekday, or week.</p>
        )}
      </div>
    </Panel>
  );
}
