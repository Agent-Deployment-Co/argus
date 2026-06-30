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

// The Argus arch mark, drawn as four concentric arches in the brand accent colors (Racing Red,
// Tiger Orange, Sky Surge, Cornflower Ocean — outer to inner) with the proto-"A" opening at the
// foot. Mirrors the icon: each band tops over one row lower than the one outside it.
const ARCH_COLORS = [160, 208, 74, 24];
const BAND_WIDTH = 2;
const ARCH_SLOTS = ARCH_COLORS.length * 2 + 1; // four left legs + center opening + four right legs
const ARCH_GAP = 3;

function wordRow(row: number): string {
  const cells = [...WORD].map((char) => GLYPHS[char]![row]).join(" ");
  return fg(WORD_COLORS[row]!) + BOLD + cells + RESET;
}

// Which arch band fills a given (row, slot), or null for blank space. On row r the band indexed r
// turns over the top and spans the full opening; bands outside it (index < r) show only as legs, and
// bands inside it haven't appeared yet. The bottom row is legs flanking the central opening.
function archBand(row: number, slot: number): number | null {
  const n = ARCH_COLORS.length;
  const last = ARCH_SLOTS - 1;
  if (row < n && row <= slot && slot <= last - row) return row;
  const leg = Math.min(slot, last - slot);
  return leg < n && leg <= row ? leg : null;
}

function archRow(row: number): string {
  let out = "";
  for (let slot = 0; slot < ARCH_SLOTS; slot++) {
    const band = archBand(row, slot);
    out += band === null ? " ".repeat(BAND_WIDTH) : fg(ARCH_COLORS[band]!) + BOLD + "█".repeat(BAND_WIDTH) + RESET;
  }
  return out + " ".repeat(ARCH_GAP);
}

export function bannerText(): string {
  const lines = [""];
  for (let row = 0; row < 5; row++) lines.push("  " + archRow(row) + wordRow(row));
  lines.push("", `  ${BOLD}${ORANGE}Argus by ADC${RESET}`, "");
  return lines.join("\n") + "\n";
}

export function printBanner(stream: Pick<Writable, "write"> = process.stderr): void {
  stream.write(bannerText());
}
