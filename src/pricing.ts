import { existsSync, readFileSync } from "node:fs";
import { PRICING_OVERRIDE_FILE } from "./paths.ts";
import type { Usage } from "./types.ts";

/** USD per *million* tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number; // 5-minute ephemeral cache write
  cacheWrite1h: number; // 1-hour ephemeral cache write
}

// Static defaults (USD / Mtok). Anthropic cache-write multipliers follow its published
// model: 5m write = 1.25x input, 1h write = 2x input, cache read = 0.1x input.
// OpenAI/Codex and Gemini cached input is represented in the shared cacheRead bucket; Codex cache
// *writes*, which GPT-5.6 reports separately, land in cacheWrite5m (see the gpt-5.6 note below).
// Override any of these via $ARGUS_CONFIG_DIR/pricing.json.
const DEFAULTS: Record<string, Price> = {
  fable: { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  mythos: { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  opus: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  // Opus 4.1 (deprecated) and Opus 4 (retired) kept their pre-Opus-4.5 rate.
  "opus-legacy": { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 },
  // Sonnet 5 introductory pricing runs through 2026-08-31, then reverts to the `sonnet` rate below.
  "sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  // Haiku 3.5, retired except on Bedrock/Google Cloud.
  "haiku-legacy": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite5m: 1, cacheWrite1h: 1.6 },
  // GPT-5.6 cache writes are not billed: the parser splits them out of `input` for visibility, and
  // no published OpenAI rate charges a write premium, so they price at 0.
  "gpt-5.6": { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite5m: 0, cacheWrite1h: 0 },
  // Older Codex tiers are not known to report cache writes. If one ever does, the parser would move
  // those tokens out of `input`, so these mirror each tier's input rate to keep cost from dropping.
  // (Deliberately unlike gpt-5.6 above, whose write accounting is confirmed unbilled.)
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 5, cacheWrite1h: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite5m: 2.5, cacheWrite1h: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite5m: 0.75, cacheWrite1h: 0 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite5m: 0.2, cacheWrite1h: 0 },
  "gpt-5.3": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite5m: 1.75, cacheWrite1h: 0 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 1.25, cacheWrite1h: 0 },
  "codex-mini": { input: 1.5, output: 6, cacheRead: 0.375, cacheWrite5m: 1.5, cacheWrite1h: 0 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gemini-2.5-pro-long": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite5m: 0, cacheWrite1h: 0 },
};

let table: Record<string, Price> = DEFAULTS;

if (existsSync(PRICING_OVERRIDE_FILE)) {
  try {
    const override = JSON.parse(readFileSync(PRICING_OVERRIDE_FILE, "utf8"));
    table = { ...DEFAULTS, ...override };
  } catch {
    // ignore malformed override; fall back to defaults
  }
}

const unpriced = new Set<string>();

/** Resolve a model id to its price family, or null if unknown / synthetic. */
function priceFor(model: string, usage?: Usage): Price | null {
  const m = model.toLowerCase();
  if (m.includes("fable")) return table.fable!;
  if (m.includes("mythos")) return table.mythos!;
  if (m.includes("opus")) {
    // Opus 4.1 (e.g. "claude-opus-4-1-...") and bare Opus 4 (e.g. "claude-opus-4-20250514")
    // kept the older, higher rate; Opus 4.5 and later (incl. "opus-5") share the current one.
    if (/opus-4-1(?!\d)/.test(m) || /opus-4(?:$|-\d{8})/.test(m)) return table["opus-legacy"]!;
    return table.opus!;
  }
  if (m.includes("sonnet")) {
    // Sonnet 5 (not 4.x) is on introductory pricing through 2026-08-31.
    if (/sonnet-5(?:$|-)/.test(m)) return table["sonnet-5"]!;
    return table.sonnet!;
  }
  if (m.includes("haiku")) {
    if (m.includes("haiku-3") || m.includes("haiku-3.5")) return table["haiku-legacy"]!;
    return table.haiku!;
  }
  if (m.includes("codex-mini")) return table["codex-mini"]!;
  if (m.includes("gpt-5.6-luna")) return table["gpt-5.6-luna"]!;
  if (m.includes("gpt-5.6-terra")) return table["gpt-5.6-terra"]!;
  if (m.includes("gpt-5.6")) return table["gpt-5.6"]!;
  if (m.includes("gpt-5.5")) return table["gpt-5.5"]!;
  if (m.includes("gpt-5.4-nano")) return table["gpt-5.4-nano"]!;
  if (m.includes("gpt-5.4-mini") || m.includes("gpt-5.4 mini")) return table["gpt-5.4-mini"]!;
  if (m.includes("gpt-5.4")) return table["gpt-5.4"]!;
  if (m.includes("gpt-5.3") || m.includes("gpt-5.2")) return table["gpt-5.3"]!;
  if (m.includes("gpt-5-codex") || /^gpt-5(?:-|$)/.test(m)) return table["gpt-5"]!;
  if (m.includes("gemini-2.5-flash-lite")) return table["gemini-2.5-flash-lite"]!;
  if (m.includes("gemini-2.5-flash")) return table["gemini-2.5-flash"]!;
  if (m.includes("gemini-2.5-pro")) {
    const promptTokens = (usage?.input || 0) + (usage?.cacheRead || 0);
    return promptTokens > 200_000 ? table["gemini-2.5-pro-long"]! : table["gemini-2.5-pro"]!;
  }
  if (m.includes("gemini-3") && m.includes("flash")) return table["gemini-3-flash"]!;
  if (!unpriced.has(model)) unpriced.add(model);
  return null;
}

/** Estimated USD cost of a usage record under the given model. Unknown models cost 0. */
export function cost(usage: Usage, model: string): number {
  const p = priceFor(model, usage);
  if (!p) return 0;
  return (
    (usage.input * p.input +
      usage.output * p.output +
      usage.cacheRead * p.cacheRead +
      usage.cacheWrite5m * p.cacheWrite5m +
      usage.cacheWrite1h * p.cacheWrite1h) /
    1_000_000
  );
}

/** Models we couldn't price (e.g. "<synthetic>"), for reporting transparency. */
export function unpricedModels(): string[] {
  return [...unpriced];
}
