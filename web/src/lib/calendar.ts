// Local-date helpers for the day heatmaps. The store keys days by local YYYY-MM-DD, so parse and
// format in local time (never UTC) to keep cell alignment correct.

export function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export function toISO(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/** Every calendar day in [start, end] inclusive, as YYYY-MM-DD. Empty if start is after end. */
export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  if (!start || !end) return out;
  const end_ = parseISO(end);
  for (let dt = parseISO(start); dt <= end_; dt.setDate(dt.getDate() + 1)) out.push(toISO(dt));
  return out;
}
