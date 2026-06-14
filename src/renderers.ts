// Presentation seam: a renderer turns the analyzed Dashboard into output. The CLI has three
// today (html, console, json); adding a format means adding an entry here, not editing the report
// command. `push` is intentionally NOT a renderer — it's network delivery + auth, not a rendered
// artifact — so it stays its own command.
import { vendoredBrandFontsCss } from "./brand.ts";
import { vendoredChartJs } from "./chartjs.ts";
import { consoleOverview } from "./console-report.ts";
import { renderHtml } from "./report.ts";
import type { Dashboard } from "./types.ts";

export type OutputFormat = "html" | "console" | "json";

export interface RenderedOutput {
  content: string;
  /** Write to stdout (the terminal overview) rather than a file. */
  toStdout: boolean;
}

export type Renderer = (dashboard: Dashboard) => RenderedOutput;

export const RENDERERS: Record<OutputFormat, Renderer> = {
  html: (dashboard) => ({
    content: renderHtml(dashboard, {
      chartJs: vendoredChartJs(),
      fontCss: vendoredBrandFontsCss(),
    }),
    toStdout: false,
  }),
  json: (dashboard) => ({ content: JSON.stringify(dashboard, null, 2), toStdout: false }),
  console: (dashboard) => ({ content: consoleOverview(dashboard), toStdout: true }),
};
