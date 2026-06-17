import { parseClaudeTranscriptPath } from "./producers/claude/parser.ts";
import { parseCodexTranscriptPath } from "./producers/codex/parser.ts";
import { parseCoworkTranscriptPath } from "./producers/cowork/parser.ts";
import { parseGeminiTranscriptPath } from "./producers/gemini/parser.ts";
import type { FileParseResult, ParserDiagnostic, Store, TaskFact } from "./store-contract.ts";
import { extractTasksForSession, type TaskExtractionOptions } from "./task-extraction.ts";
import type { AgentSource } from "./types.ts";

export type ExtractSessionTasksResult =
  | { ok: true; tasks: TaskFact[] }
  | { ok: false; status: 404 | 422 | 502; message: string; diagnostics?: ParserDiagnostic[] };

function parseTranscriptForTaskExtraction(source: AgentSource, path: string): FileParseResult {
  switch (source) {
    case "claude":
      return parseClaudeTranscriptPath(path);
    case "codex":
      return parseCodexTranscriptPath(path);
    case "cowork":
      return parseCoworkTranscriptPath(path);
    case "gemini":
      return parseGeminiTranscriptPath(path);
  }
}

export async function extractSessionTasks(
  store: Store,
  opts: { sessionId: string; taskExtraction?: TaskExtractionOptions },
): Promise<ExtractSessionTasksResult> {
  const parsed = await store.readResolved();
  const meta = parsed.sessions.get(opts.sessionId);
  if (!meta) {
    return {
      ok: false,
      status: 404,
      message: `No session found for ${opts.sessionId}. Run \`argus index\` to read sessions into the local store.`,
    };
  }

  const parsedTranscript = parseTranscriptForTaskExtraction(meta.source, meta.filePath);
  if (parsedTranscript.status !== "current") {
    const detail = parsedTranscript.diagnostics[0]?.message ?? `Couldn't read ${meta.filePath}`;
    return {
      ok: false,
      status: 422,
      message: `Couldn't extract tasks for ${opts.sessionId}: ${detail}`,
      diagnostics: parsedTranscript.diagnostics,
    };
  }

  const candidates = parsedTranscript.fragment.facts.taskCandidates.filter(
    (candidate) => candidate.sourceSessionId === opts.sessionId,
  );
  const extracted = extractTasksForSession(opts.sessionId, candidates, opts.taskExtraction);
  if (extracted.diagnostics.length) {
    return {
      ok: false,
      status: 502,
      message: extracted.diagnostics[0]?.message ?? `Couldn't extract tasks for ${opts.sessionId}.`,
      diagnostics: extracted.diagnostics,
    };
  }

  const replaced = await store.replaceSessionTasks(opts.sessionId, extracted.tasks);
  if (!replaced) {
    return {
      ok: false,
      status: 404,
      message: `No session found for ${opts.sessionId}. Run \`argus index\` to read sessions into the local store.`,
    };
  }
  return { ok: true, tasks: extracted.tasks };
}
