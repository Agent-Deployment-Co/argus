import { describe, expect, test } from "bun:test";
import { cost, unpricedModels } from "../src/pricing.ts";

const z = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

describe("cost", () => {
  test("prices 1M input tokens per model family at list rates", () => {
    expect(cost({ ...z, input: 1_000_000 }, "claude-sonnet-4-6")).toBeCloseTo(3, 6);
    expect(cost({ ...z, input: 1_000_000 }, "claude-opus-4-8")).toBeCloseTo(5, 6);
    expect(cost({ ...z, input: 1_000_000 }, "claude-haiku-4-5-20251001")).toBeCloseTo(1, 6);
  });

  test("prices legacy/deprecated Claude tiers and the newest models at their own rates", () => {
    expect(cost({ ...z, input: 1_000_000 }, "claude-opus-4-1-20250805")).toBeCloseTo(15, 6);
    expect(cost({ ...z, input: 1_000_000 }, "claude-opus-4-20250514")).toBeCloseTo(15, 6);
    expect(cost({ ...z, input: 1_000_000 }, "claude-opus-5")).toBeCloseTo(5, 6);
    expect(cost({ ...z, input: 1_000_000 }, "claude-sonnet-5")).toBeCloseTo(2, 6);
    expect(cost({ ...z, input: 1_000_000 }, "claude-haiku-3-5-20241022")).toBeCloseTo(0.8, 6);
    expect(cost({ ...z, input: 1_000_000 }, "claude-fable-5")).toBeCloseTo(10, 6);
  });

  test("prices output and cache classes", () => {
    expect(cost({ ...z, output: 1_000_000 }, "claude-sonnet-4-6")).toBeCloseTo(15, 6);
    expect(cost({ ...z, cacheRead: 1_000_000 }, "claude-sonnet-4-6")).toBeCloseTo(0.3, 6);
    expect(cost({ ...z, cacheWrite1h: 1_000_000 }, "claude-sonnet-4-6")).toBeCloseTo(6, 6);
  });

  test("unknown / synthetic models cost 0 and are tracked", () => {
    expect(cost({ ...z, input: 1_000_000 }, "<synthetic>")).toBe(0);
    expect(unpricedModels()).toContain("<synthetic>");
  });

  test("prices OpenAI/Codex models with cached input", () => {
    expect(cost({ ...z, input: 1_000_000 }, "gpt-5.5")).toBeCloseTo(5, 6);
    expect(cost({ ...z, cacheRead: 1_000_000 }, "gpt-5.5")).toBeCloseTo(0.5, 6);
    expect(cost({ ...z, output: 1_000_000 }, "gpt-5.4-mini")).toBeCloseTo(4.5, 6);
    expect(cost({ ...z, input: 1_000_000 }, "gpt-5.3-codex")).toBeCloseTo(1.75, 6);
    expect(cost({ ...z, cacheRead: 1_000_000 }, "codex-mini-latest")).toBeCloseTo(0.375, 6);
    expect(cost({ ...z, input: 1_000_000 }, "gpt-5.6-luna")).toBeCloseTo(0.2, 6);
    expect(cost({ ...z, output: 1_000_000 }, "gpt-5.6-terra")).toBeCloseTo(12, 6);
    expect(cost({ ...z, input: 1_000_000 }, "gpt-5.6")).toBeCloseTo(5, 6);
    expect(cost({ ...z, output: 1_000_000 }, "gpt-5.4-nano")).toBeCloseTo(1.25, 6);
    expect(cost({ ...z, input: 1_000_000 }, "gpt-5.1")).toBeCloseTo(1.25, 6);
  });

  test("prices OpenAI mini/nano/pro tiers off their own rates, not the base model's", () => {
    expect(cost({ ...z, input: 1_000_000 }, "gpt-5-mini")).toBeCloseTo(0.25, 6);
    expect(cost({ ...z, output: 1_000_000 }, "gpt-5-nano")).toBeCloseTo(0.4, 6);
    expect(cost({ ...z, output: 1_000_000 }, "gpt-5-pro")).toBeCloseTo(120, 6);
    expect(cost({ ...z, input: 1_000_000 }, "gpt-5.2-pro")).toBeCloseTo(21, 6);
    expect(cost({ ...z, output: 1_000_000 }, "gpt-5.4-pro")).toBeCloseTo(180, 6);
    expect(cost({ ...z, output: 1_000_000 }, "gpt-5.5-pro")).toBeCloseTo(180, 6);
  });

  test("prices Gemini models and the Pro long-context tiers", () => {
    expect(cost({ ...z, input: 1_000_000 }, "gemini-2.5-flash")).toBeCloseTo(0.3, 6);
    expect(cost({ ...z, cacheRead: 1_000_000 }, "gemini-2.5-flash-lite")).toBeCloseTo(0.01, 6);
    expect(cost({ ...z, input: 200_000 }, "gemini-2.5-pro")).toBeCloseTo(0.25, 6);
    expect(cost({ ...z, input: 200_001 }, "gemini-2.5-pro")).toBeCloseTo(0.5000025, 6);
    expect(cost({ ...z, output: 1_000_000 }, "gemini-3.6-flash")).toBeCloseTo(7.5, 6);
    expect(cost({ ...z, output: 1_000_000 }, "gemini-3.5-flash")).toBeCloseTo(9, 6);
    expect(cost({ ...z, output: 1_000_000 }, "gemini-3.5-flash-lite")).toBeCloseTo(2.5, 6);
    expect(cost({ ...z, output: 1_000_000 }, "gemini-3.1-flash-lite")).toBeCloseTo(1.5, 6);
    expect(cost({ ...z, input: 200_000 }, "gemini-3.1-pro-preview")).toBeCloseTo(0.4, 6);
    expect(cost({ ...z, input: 200_001 }, "gemini-3.1-pro-preview")).toBeCloseTo(0.800004, 6);
    expect(cost({ ...z, input: 200_000 }, "gemini-3-pro-preview")).toBeCloseTo(0.4, 6);
    expect(cost({ ...z, input: 200_001 }, "gemini-3-pro-preview")).toBeCloseTo(0.800004, 6);
  });
});
