import { describe, expect, test } from "bun:test";
import { cost, unpricedModels } from "../src/pricing.ts";

const z = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

describe("cost", () => {
  test("prices 1M input tokens per model family at list rates", () => {
    expect(cost({ ...z, input: 1_000_000 }, "claude-sonnet-4-6")).toBeCloseTo(3, 6);
    expect(cost({ ...z, input: 1_000_000 }, "claude-opus-4-8")).toBeCloseTo(15, 6);
    expect(cost({ ...z, input: 1_000_000 }, "claude-haiku-4-5-20251001")).toBeCloseTo(1, 6);
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
  });
});
