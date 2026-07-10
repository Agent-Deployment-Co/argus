// Number/label formatting + brand color helpers, ported from the inline helpers in src/report.ts.

export const fmt = (n: number): string =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + "B"
  : n >= 1e6 ? (n / 1e6).toFixed(2) + "M"
  : n >= 1e3 ? (n / 1e3).toFixed(1) + "k"
  : String(n);

export const usd = (n: number): string => "$" + (n < 1 ? n.toFixed(3) : n.toFixed(2));

/** The singular or plural form of `word` for a count, e.g. `pluralize(1, "call")` → "call",
 *  `pluralize(3, "call")` → "calls". Pass `plural` for irregular plurals. */
export const pluralize = (n: number, word: string, plural = word + "s"): string =>
  n === 1 ? word : plural;

/** Human-readable byte size (base-1024), e.g. 2048 → "2.0 KB". `—` when unknown. */
export const fmtBytes = (n: number | null): string => {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

export const dur = (ms: number): string => {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  return h + "h" + (m % 60) + "m";
};

export const dt = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** Full local date + am/pm time, e.g. "2026-06-16 1:34 PM". */
export const dtAmPm = (ms: number): string => {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
  return `${d.getFullYear()}-${m}-${day} ${time}`;
};

/** Compact stamp for lists: the time (h:mm AM/PM) if it happened today, else the YYYY-MM-DD date. */
export const dayStamp = (ms: number): string => {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
};

export function compactProject(project: string): string {
  const value = String(project || "");
  const match = value.match(/^(gemini\/)([0-9a-f]{32,})$/i);
  return match ? match[1] + match[2]!.slice(0, 8) + "…" : value;
}

/** Data-series hues — brand colors that read on either background. */
export const SERIES = {
  input: "#5dbcdf",
  output: "#ef8920",
  cacheRead: "#286992",
  cacheWrite: "#e2302c",
  accent: "#ef8920",
} as const;

export const SKILL_PALETTE = [
  "#ef8920", "#5dbcdf", "#e2302c", "#286992", "#f5a850", "#3a9060",
  "#2a8090", "#c07010", "#a04800", "#2e7eb0", "#887060", "#82d0f0",
];

export const CATEGORY_PALETTE = [
  "#ef8920", "#5dbcdf", "#e2302c", "#286992", "#f3d7ba", "#f9ebdc", "#fefaf5", "#ef8920", "#5dbcdf",
];

/** Color models by family: Claude=oranges, Gemini=blues, GPT=greens, Codex=teals, other=muted. */
export function modelFamilyColor(name: string): string {
  const n = String(name).toLowerCase();
  if (n.includes("opus-4-8") || n.includes("opus-4.8")) return "#7a3200";
  if (n.includes("opus-4-7") || n.includes("opus-4.7")) return "#a04800";
  if (n.includes("opus")) return "#7a3200";
  if (n.includes("fable")) return "#c07010";
  if (n.includes("sonnet")) return "#ef8920";
  if (n.includes("haiku")) return "#f5a850";
  if (n.includes("claude")) return "#d47820";
  if (n.includes("gemini") && n.includes("pro")) return "#1a4e78";
  if (n.includes("gemini") && n.includes("2.5") && n.includes("flash")) return "#2e7eb0";
  if (n.includes("gemini") && n.includes("flash")) return "#5dbcdf";
  if (n.includes("gemini")) return "#82d0f0";
  if (n.includes("gpt") || /\bo[13]\b/.test(n)) return "#3a9060";
  if (n.includes("codex")) return "#2a8090";
  return "#887060";
}
