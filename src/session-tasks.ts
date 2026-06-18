import { nativeProducerForSource } from "./producers/index.ts";
import type { ParserDiagnostic, Store, TaskFact } from "./store-contract.ts";
import {
  extractTasksForSession,
  logTaskExtractionDebug,
  type TaskExtractionOptions,
} from "./task-extraction.ts";

export type ExtractSessionTasksResult =
  | { ok: true; tasks: TaskFact[] }
  | { ok: false; status: 404 | 422 | 502; message: string; diagnostics?: ParserDiagnostic[] };

export async function extractSessionTasks(
  store: Store,
  opts: { sessionId: string; taskExtraction?: TaskExtractionOptions },
): Promise<ExtractSessionTasksResult> {
  logTaskExtractionDebug(opts.taskExtraction, `requested session ${opts.sessionId}`);
  const meta = await store.readSessionMeta(opts.sessionId);
  if (!meta) {
    logTaskExtractionDebug(opts.taskExtraction, `session ${opts.sessionId} was not found`);
    return {
      ok: false,
      status: 404,
      message: `No session found for ${opts.sessionId}. Run \`argus index\` to read sessions into the local store.`,
    };
  }

  logTaskExtractionDebug(
    opts.taskExtraction,
    `session ${opts.sessionId}: source=${meta.source}, transcript=${meta.filePath}`,
  );
  const producer = nativeProducerForSource(meta.source);
  const parsedTranscript = producer?.parseTranscriptPath(meta.filePath);
  if (!parsedTranscript) {
    logTaskExtractionDebug(opts.taskExtraction, `no transcript parser registered for ${meta.source}`);
    return {
      ok: false,
      status: 422,
      message: `Couldn't extract tasks for ${opts.sessionId}: no transcript reader is registered for ${meta.source}.`,
    };
  }
  if (parsedTranscript.status !== "current") {
    logTaskExtractionDebug(
      opts.taskExtraction,
      `parsed transcript for ${opts.sessionId}: status=${parsedTranscript.status}, parser messages=${parsedTranscript.diagnostics.length}`,
    );
    const detail = parsedTranscript.diagnostics[0]?.message ?? `Couldn't read ${meta.filePath}`;
    logTaskExtractionDebug(opts.taskExtraction, `couldn't parse ${opts.sessionId}: ${detail}`);
    return {
      ok: false,
      status: 422,
      message: `Couldn't extract tasks for ${opts.sessionId}: ${detail}`,
      diagnostics: parsedTranscript.diagnostics,
    };
  }
  logTaskExtractionDebug(
    opts.taskExtraction,
    `parsed transcript for ${opts.sessionId}: status=current, messages=${parsedTranscript.fragment.facts.messages.length}, task candidates=${parsedTranscript.fragment.facts.taskCandidates.length}`,
  );

  const candidates = parsedTranscript.fragment.facts.taskCandidates.filter(
    (candidate) => candidate.sourceSessionId === opts.sessionId,
  );
  logTaskExtractionDebug(
    opts.taskExtraction,
    `using ${candidates.length} filtered user messages for ${opts.sessionId}`,
  );
  const extracted = await extractTasksForSession(opts.sessionId, candidates, opts.taskExtraction);
  if (extracted.diagnostics.length) {
    logTaskExtractionDebug(
      opts.taskExtraction,
      `task extraction for ${opts.sessionId} returned ${extracted.diagnostics.length} parser messages`,
    );
    return {
      ok: false,
      status: 502,
      message: extracted.diagnostics[0]?.message ?? `Couldn't extract tasks for ${opts.sessionId}.`,
      diagnostics: extracted.diagnostics,
    };
  }

  const replaced = await store.replaceSessionTasks(opts.sessionId, extracted.tasks);
  if (!replaced) {
    logTaskExtractionDebug(opts.taskExtraction, `session ${opts.sessionId} disappeared before saving tasks`);
    return {
      ok: false,
      status: 404,
      message: `No session found for ${opts.sessionId}. Run \`argus index\` to read sessions into the local store.`,
    };
  }
  logTaskExtractionDebug(opts.taskExtraction, `saved ${extracted.tasks.length} tasks for ${opts.sessionId}`);
  return { ok: true, tasks: extracted.tasks };
}
