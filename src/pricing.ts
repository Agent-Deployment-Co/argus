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
// OpenAI/Codex and Gemini cached input is represented in the shared cacheRead bucket.
// Override any of these via $ARGUS_CONFIG_DIR/pricing.json.
const DEFAULTS: Record<string, Price> = {
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gpt-5.3": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 0, cacheWrite1h: 0 },
  "codex-mini": { input: 1.5, output: 6, cacheRead: 0.375, cacheWrite5m: 0, cacheWrite1h: 0 },
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
  if (m.includes("opus")) return table.opus!;
  if (m.includes("sonnet")) return table.sonnet!;
  if (m.includes("haiku")) return table.haiku!;
  if (m.includes("codex-mini")) return table["codex-mini"]!;
  if (m.includes("gpt-5.5")) return table["gpt-5.5"]!;
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
