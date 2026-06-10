import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Vendored Chart.js source, read from disk (CLI/local use; not for the Worker bundle). */
export function vendoredChartJs(): string {
  try {
    return readFileSync(join(MODULE_DIR, "vendor", "chart.umd.min.js"), "utf8");
  } catch {
    return "";
  }
}
