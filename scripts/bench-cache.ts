import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  parseAllIncrementalDetailed,
  type IncrementalCacheStats,
  type IncrementalParseOptions,
} from "../src/parse-incremental.ts";
import type { AgentSource } from "../src/types.ts";

type Format = "table" | "json";
type ScenarioName = "cold" | "warm" | "changed";

interface CliOptions {
  fixtureRoot: string;
  format: Format;
  iterations: number;
  keepTemp: boolean;
  pretty: boolean;
  smoke: boolean;
}

interface CacheDbBytes {
  main: number | null;
  wal: number | null;
  shm: number | null;
  total: number | null;
}

interface BenchStats {
  hits: number;
  parsed: number;
  stored: number;
  imported: number;
  deleted: number;
  unstable: number;
  failed: number;
  incompleteDiscoveries: number;
  fallback: boolean;
}

interface ParseCounts {
  messages: number;
  sessions: number;
  toolResults: number;
}

interface WorkEstimate {
  filesOpened: number;
  bytesParsed: number;
}

interface MemorySample {
  beforeRssBytes: number;
  afterRssBytes: number;
  peakObservedRssBytes: number;
  deltaRssBytes: number;
}

interface ScenarioResult {
  iteration: number;
  scenario: ScenarioName;
  wallMs: number;
  stats: BenchStats;
  estimatedWork: WorkEstimate;
  memory: MemorySample;
  cacheDbBytes: CacheDbBytes;
  counts: ParseCounts;
  diagnostics: number;
}

interface RunSummary {
  scenario: ScenarioName;
  runs: number;
  wallMs: {
    min: number;
    median: number;
    max: number;
    mean: number;
  };
}

interface Workspace {
  root: string;
  opts: IncrementalParseOptions;
  changedFile: string;
  cachePath: string;
  allInputFiles: string[];
  allInputBytes: number;
}

const SOURCES: AgentSource[] = ["claude", "codex", "gemini"];
const SCENARIOS: ScenarioName[] = ["cold", "warm", "changed"];
const DEFAULT_FIXTURE_ROOT = resolve(import.meta.dir, "..", "test", "fixtures");

function usage(): string {
  return `Usage: bun run scripts/bench-cache.ts [options]

Options:
  --json                 output stable JSON instead of a table
  --table                output a readable table (default)
  --iterations <n>       repeat the cold/warm/changed benchmark sequence (default: 1)
  --fixture-root <path>  fixture directory to copy (default: test/fixtures)
  --smoke                assert cache behavior invariants after running
  --pretty              pretty-print JSON output
  --keep-temp            keep temporary fixture copies for inspection
  -h, --help             show this help
`;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    fixtureRoot: DEFAULT_FIXTURE_ROOT,
    format: "table",
    iterations: 1,
    keepTemp: false,
    pretty: false,
    smoke: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") opts.format = "json";
    else if (arg === "--table") opts.format = "table";
    else if (arg === "--pretty") opts.pretty = true;
    else if (arg === "--keep-temp") opts.keepTemp = true;
    else if (arg === "--smoke") opts.smoke = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--iterations") {
      const value = argv[++i];
      if (!value) throw new Error("--iterations requires a value");
      opts.iterations = parsePositiveInteger(value, "--iterations");
    } else if (arg.startsWith("--iterations=")) {
      opts.iterations = parsePositiveInteger(arg.slice("--iterations=".length), "--iterations");
    } else if (arg === "--fixture-root") {
      const value = argv[++i];
      if (!value) throw new Error("--fixture-root requires a value");
      opts.fixtureRoot = resolve(value);
    } else if (arg.startsWith("--fixture-root=")) {
      opts.fixtureRoot = resolve(arg.slice("--fixture-root=".length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function parsePositiveInteger(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

function copyFixtureWorkspace(fixtureRoot: string): Workspace {
  if (!existsSync(fixtureRoot)) throw new Error(`Fixture root does not exist: ${fixtureRoot}`);

  const root = mkdtempSync(join(tmpdir(), "argus-cache-bench-"));
  const fixtures = join(root, "fixtures");
  cpSync(join(fixtureRoot, "projects"), join(fixtures, "projects"), { recursive: true });
  cpSync(join(fixtureRoot, "history.jsonl"), join(fixtures, "history.jsonl"));
  cpSync(join(fixtureRoot, "codex-sessions"), join(fixtures, "codex-sessions"), {
    recursive: true,
  });
  cpSync(join(fixtureRoot, "gemini"), join(fixtures, "gemini"), { recursive: true });

  const cachePath = join(root, "cache", "fragments.sqlite3");
  const changedFile = join(
    fixtures,
    "codex-sessions",
    "2026",
    "06",
    "03",
    "rollout-2026-06-03T08-00-00-codex-sess1.jsonl",
  );
  const allInputFiles = [
    ...collectFiles(join(fixtures, "projects")),
    join(fixtures, "history.jsonl"),
    ...collectFiles(join(fixtures, "codex-sessions")),
    ...collectFiles(join(fixtures, "gemini")),
  ];

  return {
    root,
    cachePath,
    changedFile,
    allInputFiles,
    allInputBytes: sumFileSizes(allInputFiles),
    opts: {
      projectsDir: join(fixtures, "projects"),
      historyFile: join(fixtures, "history.jsonl"),
      codexSessionsDir: join(fixtures, "codex-sessions"),
      geminiDir: join(fixtures, "gemini"),
      sources: SOURCES,
      cachePath,
      agentsView: "off",
    },
  };
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

function sumFileSizes(paths: string[]): number {
  return paths.reduce((sum, path) => sum + (fileSize(path) ?? 0), 0);
}

function mutateOneTranscript(path: string): void {
  const event = {
    timestamp: "2026-06-03T13:10:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 3,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
          total_tokens: 4,
        },
      },
    },
  };
  appendFileSync(path, `\n${JSON.stringify(event)}`);
}

function cacheDbBytes(cachePath: string): CacheDbBytes {
  const main = fileSize(cachePath);
  const wal = fileSize(`${cachePath}-wal`);
  const shm = fileSize(`${cachePath}-shm`);
  const sizes = [main, wal, shm].filter((value): value is number => typeof value === "number");
  return {
    main,
    wal,
    shm,
    total: sizes.length ? sizes.reduce((sum, value) => sum + value, 0) : null,
  };
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function statsFrom(raw: IncrementalCacheStats): BenchStats {
  return {
    hits: raw.hits,
    parsed: raw.parsed,
    stored: raw.replaced,
    imported: raw.imported,
    deleted: raw.deleted,
    unstable: raw.unstable,
    failed: raw.failed,
    incompleteDiscoveries: raw.incompleteDiscoveries,
    fallback: raw.fallback,
  };
}

function estimateWork(scenario: ScenarioName, workspace: Workspace, stats: BenchStats): WorkEstimate {
  if (stats.fallback) {
    return {
      filesOpened: workspace.allInputFiles.length,
      bytesParsed: workspace.allInputBytes,
    };
  }
  if (scenario === "warm" && stats.parsed === 0 && stats.stored === 0) {
    return { filesOpened: 0, bytesParsed: 0 };
  }
  if (scenario === "changed") {
    return {
      filesOpened: stats.parsed,
      bytesParsed: fileSize(workspace.changedFile) ?? 0,
    };
  }
  return {
    filesOpened: stats.parsed,
    bytesParsed: workspace.allInputBytes,
  };
}

function memorySample(beforeRssBytes: number, afterRssBytes: number): MemorySample {
  return {
    beforeRssBytes,
    afterRssBytes,
    peakObservedRssBytes: Math.max(beforeRssBytes, afterRssBytes),
    deltaRssBytes: afterRssBytes - beforeRssBytes,
  };
}

async function runScenario(
  iteration: number,
  scenario: ScenarioName,
  workspace: Workspace,
): Promise<ScenarioResult> {
  const beforeRssBytes = process.memoryUsage().rss;
  const start = performance.now();
  const details = await parseAllIncrementalDetailed(workspace.opts);
  const wallMs = performance.now() - start;
  const stats = statsFrom(details.stats);
  const afterRssBytes = process.memoryUsage().rss;
  return {
    iteration,
    scenario,
    wallMs: round(wallMs, 3),
    stats,
    estimatedWork: estimateWork(scenario, workspace, stats),
    memory: memorySample(beforeRssBytes, afterRssBytes),
    cacheDbBytes: cacheDbBytes(workspace.cachePath),
    counts: {
      messages: details.parsed.messages.length,
      sessions: details.parsed.sessions.size,
      toolResults: details.parsed.toolResults.size,
    },
    diagnostics: details.diagnostics.length,
  };
}

async function runIteration(iteration: number, fixtureRoot: string): Promise<{
  results: ScenarioResult[];
  tempRoot: string;
}> {
  const workspace = copyFixtureWorkspace(fixtureRoot);
  const results: ScenarioResult[] = [];
  results.push(await runScenario(iteration, "cold", workspace));
  results.push(await runScenario(iteration, "warm", workspace));
  mutateOneTranscript(workspace.changedFile);
  results.push(await runScenario(iteration, "changed", workspace));
  return { results, tempRoot: workspace.root };
}

function summarize(results: ScenarioResult[]): RunSummary[] {
  return SCENARIOS.map((scenario) => {
    const times = results
      .filter((result) => result.scenario === scenario)
      .map((result) => result.wallMs);
    return {
      scenario,
      runs: times.length,
      wallMs: {
        min: round(Math.min(...times), 3),
        median: round(median(times), 3),
        max: round(Math.max(...times), 3),
        mean: round(times.reduce((sum, value) => sum + value, 0) / times.length, 3),
      },
    };
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper == null) return 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1] ?? upper;
  return (lower + upper) / 2;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function assertSmoke(results: ScenarioResult[], iterations: number): void {
  for (let iteration = 1; iteration <= iterations; iteration++) {
    const cold = findResult(results, iteration, "cold");
    const warm = findResult(results, iteration, "warm");
    const changed = findResult(results, iteration, "changed");

    assert(!cold.stats.fallback, `iteration ${iteration}: cold run used fallback parsing`);
    assert(cold.stats.parsed > 0, `iteration ${iteration}: cold run parsed no fragments`);
    assert(
      cold.stats.stored === cold.stats.parsed,
      `iteration ${iteration}: cold stored ${cold.stats.stored}, parsed ${cold.stats.parsed}`,
    );
    assert(warm.stats.hits > 0, `iteration ${iteration}: warm run had no cache hits`);
    assert(warm.stats.parsed === 0, `iteration ${iteration}: warm run reparsed fragments`);
    assert(warm.stats.stored === 0, `iteration ${iteration}: warm run stored fragments`);
    assert(
      warm.estimatedWork.bytesParsed === 0,
      `iteration ${iteration}: warm run estimated parsed bytes`,
    );
    assert(!changed.stats.fallback, `iteration ${iteration}: changed run used fallback parsing`);
    assert(
      changed.stats.parsed > 0 && changed.stats.parsed < cold.stats.parsed,
      `iteration ${iteration}: changed run did not reparse an incremental subset`,
    );
    assert(
      changed.stats.hits > 0 && changed.stats.hits < warm.stats.hits,
      `iteration ${iteration}: changed run cache hits were not incremental`,
    );
    assert(
      changed.counts.messages > warm.counts.messages,
      `iteration ${iteration}: changed run did not add a parsed message`,
    );
    assert(
      typeof changed.cacheDbBytes.total === "number" && changed.cacheDbBytes.total > 0,
      `iteration ${iteration}: cache DB size was unavailable`,
    );
    assert(
      cold.estimatedWork.bytesParsed > changed.estimatedWork.bytesParsed,
      `iteration ${iteration}: changed run did not reduce estimated parsed bytes`,
    );
  }
}

function findResult(
  results: ScenarioResult[],
  iteration: number,
  scenario: ScenarioName,
): ScenarioResult {
  const result = results.find(
    (candidate) => candidate.iteration === iteration && candidate.scenario === scenario,
  );
  if (!result) throw new Error(`Missing ${scenario} result for iteration ${iteration}`);
  return result;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Smoke assertion failed: ${message}`);
}

function renderTable(results: ScenarioResult[], summaries: RunSummary[]): string {
  const headers = [
    "iter",
    "scenario",
    "wall_ms",
    "hits",
    "parsed",
    "stored",
    "imported",
    "deleted",
    "files_opened",
    "bytes_parsed",
    "cache_bytes",
    "peak_rss",
    "messages",
    "sessions",
    "diagnostics",
  ];
  const rows = results.map((result) => [
    String(result.iteration),
    result.scenario,
    result.wallMs.toFixed(3),
    String(result.stats.hits),
    String(result.stats.parsed),
    String(result.stats.stored),
    String(result.stats.imported),
    String(result.stats.deleted),
    String(result.estimatedWork.filesOpened),
    String(result.estimatedWork.bytesParsed),
    result.cacheDbBytes.total == null ? "n/a" : String(result.cacheDbBytes.total),
    String(result.memory.peakObservedRssBytes),
    String(result.counts.messages),
    String(result.counts.sessions),
    String(result.diagnostics),
  ]);
  const summaryRows = summaries.map((summary) => [
    "",
    `${summary.scenario} mean`,
    summary.wallMs.mean.toFixed(3),
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
  ]);
  return formatRows([headers, ...rows, ...summaryRows]);
}

function formatRows(rows: string[][]): string {
  const widths = rows[0]!.map((_, index) =>
    Math.max(...rows.map((row) => row[index]?.length ?? 0)),
  );
  return rows
    .map((row, rowIndex) => {
      const line = row
        .map((cell, index) => cell.padStart(widths[index] ?? 0))
        .join("  ");
      if (rowIndex === 0) return line;
      if (rowIndex === 1) return `${widths.map((width) => "-".repeat(width)).join("  ")}\n${line}`;
      return line;
    })
    .join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const results: ScenarioResult[] = [];
  const tempRoots: string[] = [];

  try {
    for (let iteration = 1; iteration <= options.iterations; iteration++) {
      const run = await runIteration(iteration, options.fixtureRoot);
      results.push(...run.results);
      tempRoots.push(run.tempRoot);
    }

    if (options.smoke) assertSmoke(results, options.iterations);

    const summaries = summarize(results);
    const payload = {
      benchmark: "cache-incremental-fixtures",
      fixtureRoot: options.fixtureRoot,
      iterations: options.iterations,
      smoke: options.smoke,
      results,
      summaries,
    };

    if (options.format === "json") {
      console.log(JSON.stringify(payload, null, options.pretty ? 2 : 0));
    } else {
      console.log(renderTable(results, summaries));
      if (options.smoke) console.log("\nSmoke assertions passed.");
    }
  } finally {
    if (options.keepTemp) {
      for (const root of tempRoots) console.error(`Kept benchmark temp root: ${root}`);
    } else {
      for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
