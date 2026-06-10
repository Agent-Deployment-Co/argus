import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { aggregate } from "../src/aggregate.ts";
import { vendoredBrandFontsCss } from "../src/brand.ts";
import { vendoredChartJs } from "../src/chartjs.ts";
import { parseAll } from "../src/parse.ts";
import { renderHtml } from "../src/report.ts";
import type { PluginInfo } from "../src/types.ts";

const FIX = join(import.meta.dir, "fixtures");

describe("HTML report", () => {
  test("uses the ADC brand system with light + dark modes", () => {
    const parsed = parseAll({
      projectsDir: join(FIX, "projects"),
      historyFile: join(FIX, "history.jsonl"),
    });
    const dashboard = aggregate(parsed, new Map<string, PluginInfo>(), new Map());
    const fontCss = vendoredBrandFontsCss();
    const chartJs = vendoredChartJs();
    const html = renderHtml(dashboard, { chartJs, fontCss });

    expect(fontCss).toContain("data:font/woff2;base64,");
    expect(fontCss).not.toContain("fonts.gstatic.com");
    expect(chartJs).toContain("Chart.js v4.4.4");
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect(html).toContain("--coffee-bean:#1c1105");
    expect(html).toContain("--tiger-orange:#ef8920");
    expect(html).toContain('font:15px/1.55 "Aleo",Georgia,serif');
    expect(html).toContain('font-family:"Poppins","Avenir Next",Arial,sans-serif');
    expect(html).toContain('aria-label="The Agent Deployment Co. chevron"');
    expect(html).toContain("input:'#5dbcdf', output:'#ef8920', cacheRead:'#286992'");
    // Adapts to the OS color scheme: a light-mode block and a runtime detector for chart chrome.
    expect(html).toContain("color-scheme:light dark");
    expect(html).toContain("@media (prefers-color-scheme:light)");
    expect(html).toContain("--bg:var(--antique-white)");
    expect(html).toContain("window.matchMedia('(prefers-color-scheme: dark)')");
    expect(html).not.toContain("--bg:#0f1115");
    expect(html).not.toContain("#6ea8fe");
    expect(html).not.toContain("rgba(217,119,87");
  });
});
