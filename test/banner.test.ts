import { describe, expect, test } from "bun:test";
import { bannerText, printBanner } from "../src/banner.ts";

describe("banner", () => {
  test("renders the Argus wordmark", () => {
    const output = bannerText();
    expect(output).toContain("███████");
    expect(output).toContain("Argus by ADC");
    expect(output).not.toContain("agent audit");
  });

  test("writes the complete banner to the supplied stream", () => {
    let output = "";
    printBanner({ write: (chunk: string) => { output += chunk; return true; } });
    expect(output).toBe(bannerText());
  });
});
