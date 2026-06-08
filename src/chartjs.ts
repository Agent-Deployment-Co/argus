import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Vendored Chart.js source, read from disk (CLI/local use; not for the Worker bundle). */
export function vendoredChartJs(): string {
  try {
    return readFileSync(join(import.meta.dir, "vendor", "chart.umd.min.js"), "utf8");
  } catch {
    return "";
  }
}
