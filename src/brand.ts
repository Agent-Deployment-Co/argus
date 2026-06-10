import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cachedFontCss: string | undefined;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function fontData(filename: string): string {
  return readFileSync(join(MODULE_DIR, "vendor", filename)).toString("base64");
}

/** CSS for the vendored ADC brand fonts, embedded as data URLs for an offline report. */
export function vendoredBrandFontsCss(): string {
  if (cachedFontCss) return cachedFontCss;

  const aleo = fontData("aleo-latin.woff2");
  const poppins600 = fontData("poppins-600-latin.woff2");
  const poppins700 = fontData("poppins-700-latin.woff2");

  cachedFontCss = `
  @font-face {
    font-family:"Aleo"; font-style:normal; font-weight:300 800; font-display:swap;
    src:url(data:font/woff2;base64,${aleo}) format("woff2");
  }
  @font-face {
    font-family:"Poppins"; font-style:normal; font-weight:600; font-display:swap;
    src:url(data:font/woff2;base64,${poppins600}) format("woff2");
  }
  @font-face {
    font-family:"Poppins"; font-style:normal; font-weight:700; font-display:swap;
    src:url(data:font/woff2;base64,${poppins700}) format("woff2");
  }`;
  return cachedFontCss;
}
