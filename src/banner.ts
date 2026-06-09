import type { Writable } from "node:stream";

const ORANGE = "\x1b[38;5;208m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const fg = (n: number) => `\x1b[38;5;${n}m`;

const GLYPHS: Record<string, string[]> = {
  A: ["███████", "██   ██", "███████", "██   ██", "██   ██"],
  R: ["██████ ", "██   ██", "██████ ", "██  ██ ", "██   ██"],
  G: ["███████", "██     ", "██  ███", "██   ██", "███████"],
  U: ["██   ██", "██   ██", "██   ██", "██   ██", "███████"],
  S: ["███████", "██     ", "███████", "     ██", "███████"],
};

const WORD = "ARGUS";
const WORD_COLORS = [88, 124, 166, 208, 214];
const STRIPES = [160, 166, 74, 67, 25];
const STRIPE_WIDTH = 2;
const BASE = [0, 1, 2, 1, 0];
const GAP = 3;
const SPAN = STRIPES.length * STRIPE_WIDTH;
const PAD = Math.max(...BASE) + SPAN + GAP;

function wordRow(row: number): string {
  const cells = [...WORD].map((char) => GLYPHS[char]![row]).join(" ");
  return fg(WORD_COLORS[row]!) + BOLD + cells + RESET;
}

function chevronRow(row: number): string {
  const base = BASE[row]!;
  const blocks = STRIPES.map((color) => fg(color) + BOLD + "█".repeat(STRIPE_WIDTH) + RESET).join("");
  return " ".repeat(base) + blocks + " ".repeat(PAD - base - SPAN);
}

export function bannerText(): string {
  const lines = [""];
  for (let row = 0; row < 5; row++) lines.push("  " + chevronRow(row) + wordRow(row));
  lines.push("", `  ${BOLD}${ORANGE}Argus by ADC${RESET}`, "");
  return lines.join("\n") + "\n";
}

export function printBanner(stream: Pick<Writable, "write"> = process.stderr): void {
  stream.write(bannerText());
}
