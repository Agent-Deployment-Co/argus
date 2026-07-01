#!/usr/bin/env bun
/**
 * Product screenshots for the Argus docs.
 *
 * Drives agent-browser to navigate to a page and capture it at two viewports,
 * both at 2x display resolution, saved as WebP under docs/images/screenshots/:
 *
 *   docs/images/screenshots/{name}@1920x1280@2.webp   (tall)
 *   docs/images/screenshots/{name}@1920x1080@2.webp   (standard)
 *
 * Usage:
 *   bun run screenshot <url> [name]       Capture one page (name defaults to a URL slug)
 *   bun run screenshot --name <name>      Capture the page agent-browser is already on
 *   bun run screenshot --batch <file>     Capture every entry in a YAML batch file
 *
 * The URL may be absolute (https://…) or a path (/sessions) resolved against the
 * base URL. Argus serves at http://localhost:4242 by default; point elsewhere with
 * --base-url (or ARGUS_URL) when the app is on another port (e.g. `bun run dev`).
 *
 * Options:
 *   --base-url <url>    Base for relative URLs (default http://localhost:4242, or $ARGUS_URL)
 *   --out-dir <dir>     Output directory (default docs/images/screenshots)
 *   --quality <0-100>   WebP quality (default 90)
 *   --wait <ms>         Extra settle time after the page loads (default 0)
 *   -h, --help          Show this help
 *
 * Entries with a `script` in a batch file are skipped here: run those
 * interactions manually via the screenshot skill, then capture the
 * current page with `--name` and no URL.
 */
import { parseArgs } from "util";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import sharp from "sharp";

const DEFAULT_BASE_URL = "http://localhost:4242";
const DEFAULT_OUT_DIR = "docs/images/screenshots";
const DEFAULT_QUALITY = 90;
const SCALE = 2;
const VIEWPORTS: Array<[number, number]> = [
  [1920, 1280], // tall  (3:2)
  [1920, 1080], // standard (16:9)
];

type Shot = { name?: string; url?: string; script?: string };
type BatchFile = { baseUrl?: string; screenshots?: Shot[] };

function ab(args: string[], { check = true } = {}) {
  const p = Bun.spawnSync(["agent-browser", ...args]);
  const stdout = p.stdout.toString();
  const stderr = p.stderr.toString();
  if (check && p.exitCode !== 0) {
    console.error(`agent-browser ${args.join(" ")} failed:`);
    if (stdout.trim()) console.error(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
    process.exit(1);
  }
  return { code: p.exitCode ?? 0, stdout, stderr };
}

function resolveUrl(url: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return new URL(url, baseUrl).toString();
}

function nameFromUrl(url: string): string {
  try {
    const slug = new URL(url).pathname
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    return slug || "home";
  } catch {
    return `screenshot-${Date.now()}`;
  }
}

async function capture(opts: {
  name: string;
  url?: string; // absolute URL to open, or undefined to capture the current page
  outDir: string;
  quality: number;
  waitMs: number;
}) {
  const { name, url, outDir, quality, waitMs } = opts;
  await mkdir(outDir, { recursive: true });

  if (url) {
    ab(["open", url]);
    const idle = ab(["wait", "--load", "networkidle"], { check: false });
    if (idle.code !== 0) {
      console.warn(`  timed out waiting for network idle, capturing anyway`);
    }
  }
  if (waitMs > 0) ab(["wait", String(waitMs)]);

  for (const [w, h] of VIEWPORTS) {
    ab(["set", "viewport", String(w), String(h), String(SCALE)]);
    const tmpPng = join(tmpdir(), `argus-shot-${name}-${w}x${h}-${process.pid}.png`);
    ab(["screenshot", tmpPng]);
    const outPath = join(outDir, `${name}@${w}x${h}@${SCALE}.webp`);
    await sharp(tmpPng).webp({ quality }).toFile(outPath);
    await rm(tmpPng, { force: true });
    console.log(`  saved ${outPath}`);
  }
}

function printHelp() {
  // The header comment above is the reference; keep this terse.
  console.log(
    [
      "Product screenshots for the Argus docs.",
      "",
      "  bun run screenshot <url> [name]     Capture one page",
      "  bun run screenshot --name <name>    Capture the current agent-browser page",
      "  bun run screenshot --batch <file>   Capture a YAML batch",
      "",
      "Options: --base-url, --out-dir, --quality, --wait. See scripts/screenshot.ts.",
    ].join("\n"),
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      batch: { type: "string" },
      url: { type: "string" },
      name: { type: "string" },
      "base-url": { type: "string" },
      "out-dir": { type: "string" },
      quality: { type: "string" },
      wait: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }

  const outDir = values["out-dir"] ?? DEFAULT_OUT_DIR;
  const quality = values.quality ? Number(values.quality) : DEFAULT_QUALITY;
  const waitMs = values.wait ? Number(values.wait) : 0;
  const envBase = values["base-url"] ?? process.env.ARGUS_URL;

  if (values.batch) {
    const data = Bun.YAML.parse(await Bun.file(values.batch).text()) as BatchFile;
    const baseUrl = envBase ?? data.baseUrl ?? DEFAULT_BASE_URL;
    const shots = data.screenshots ?? [];
    if (shots.length === 0) {
      console.error(`No screenshots defined in ${values.batch}`);
      process.exit(1);
    }
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i]!;
      const url = shot.url ? resolveUrl(shot.url, baseUrl) : undefined;
      const name = shot.name ?? (url ? nameFromUrl(url) : `screenshot-${Date.now()}`);
      console.log(`[${i + 1}/${shots.length}] ${name}`);
      if (shot.script) {
        console.warn(
          `  has a script; skipping. Run it via the screenshot skill, then: bun run screenshot --name ${name}`,
        );
        continue;
      }
      if (!url) {
        console.warn(`  no url; skipping`);
        continue;
      }
      await capture({ name, url, outDir, quality, waitMs });
    }
    return;
  }

  // Single capture: `<url> [name]`, or `--name` alone to capture the current page.
  const url = values.url ?? positionals[0];
  const nameArg = values.name ?? positionals[1];
  if (!url && !nameArg) {
    printHelp();
    process.exit(1);
  }

  const baseUrl = envBase ?? DEFAULT_BASE_URL;
  const resolved = url ? resolveUrl(url, baseUrl) : undefined;
  const name = nameArg ?? (resolved ? nameFromUrl(resolved) : `screenshot-${Date.now()}`);
  console.log(`Capturing "${name}" ${resolved ? `from ${resolved}` : "from the current page"}`);
  await capture({ name, url: resolved, outDir, quality, waitMs });
}

await main();
