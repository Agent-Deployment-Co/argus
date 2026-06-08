import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SUMMARY_CACHE_FILE } from "./paths.ts";
import type { SessionMeta } from "./types.ts";

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Free, instant summary from already-aggregated session facts. */
export function heuristicSummary(opts: {
  firstPrompt: string;
  topSkills: string[];
  toolCounts: Record<string, number>;
  filesTouched: string[];
}): string {
  const parts: string[] = [];
  if (opts.firstPrompt) parts.push(`"${truncate(opts.firstPrompt, 140)}"`);
  if (opts.topSkills.length) parts.push(`skills: ${opts.topSkills.join(", ")}`);
  const topTools = Object.entries(opts.toolCounts)
    .filter(([n]) => n !== "Skill")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([n, c]) => `${c}×${n}`);
  if (topTools.length) parts.push(topTools.join(" "));
  if (opts.filesTouched.length) parts.push(`${opts.filesTouched.length} file(s) edited`);
  return parts.join(" · ") || "(no activity recorded)";
}

interface CacheEntry {
  lastTs: number;
  summary: string;
}

function loadCache(): Record<string, CacheEntry> {
  try {
    return existsSync(SUMMARY_CACHE_FILE) ? JSON.parse(readFileSync(SUMMARY_CACHE_FILE, "utf8")) : {};
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, CacheEntry>): void {
  try {
    writeFileSync(SUMMARY_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // best-effort cache
  }
}

/** Condense a transcript file into a compact prompt body for the LLM. */
function condenseTranscript(filePath: string, limitChars = 8000): string {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o.message?.content;
    if (o.type === "user") {
      const text = typeof content === "string" ? content : extractText(content);
      if (text && !text.startsWith("<")) lines.push(`USER: ${truncate(text, 400)}`);
    } else if (o.type === "assistant" && Array.isArray(content)) {
      const text = extractText(content);
      const tools = content.filter((p: any) => p?.type === "tool_use").map((p: any) => p.name);
      if (text) lines.push(`ASSISTANT: ${truncate(text, 400)}`);
      if (tools.length) lines.push(`TOOLS: ${tools.join(", ")}`);
    }
  }
  // Favor the start (intent) and end (outcome).
  const joined = lines.join("\n");
  if (joined.length <= limitChars) return joined;
  const head = joined.slice(0, Math.floor(limitChars * 0.6));
  const tail = joined.slice(joined.length - Math.floor(limitChars * 0.4));
  return `${head}\n...\n${tail}`;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join(" ");
}

/**
 * Generate LLM summaries for the given sessions via the headless `claude -p` CLI.
 * Cached per session keyed on the latest message timestamp so re-runs are incremental.
 * Returns a map sessionId -> summary. Sessions that fail to summarize are skipped.
 */
export function llmSummaries(
  targets: { meta: SessionMeta; lastTs: number }[],
  model: string | undefined,
  log: (s: string) => void,
): Map<string, string> {
  const cache = loadCache();
  const out = new Map<string, string>();
  let done = 0;
  for (const { meta, lastTs } of targets) {
    const cached = cache[meta.sessionId];
    if (cached && cached.lastTs === lastTs && cached.summary) {
      out.set(meta.sessionId, cached.summary);
      continue;
    }
    const body = condenseTranscript(meta.filePath);
    if (!body) continue;
    const prompt =
      "Summarize what this Claude Code session accomplished in 2-3 plain sentences. " +
      "Focus on the goal and the outcome, not the mechanics. No preamble.\n\n--- TRANSCRIPT ---\n" +
      body;
    const args = ["-p", prompt];
    if (model) args.push("--model", model);
    const res = spawnSync("claude", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (res.status !== 0 || !res.stdout?.trim()) {
      log(`  ! summary failed for ${meta.sessionId.slice(0, 8)} (${res.stderr?.trim()?.slice(0, 80) || "no output"})`);
      continue;
    }
    const summary = res.stdout.trim();
    out.set(meta.sessionId, summary);
    cache[meta.sessionId] = { lastTs, summary };
    done++;
    if (done % 5 === 0) log(`  …summarized ${done}/${targets.length}`);
  }
  saveCache(cache);
  return out;
}

/** Check whether the headless claude CLI is available. */
export function claudeAvailable(): boolean {
  const res = spawnSync("claude", ["--version"], { encoding: "utf8" });
  return res.status === 0;
}
