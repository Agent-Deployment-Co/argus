// The Interpret stage: the one model-driven, opt-in step of the pipeline. It derives interpretations
// of a session that aren't in the transcript — today, the #91 two-pass task extraction (segment
// chapters, then judge per-task outcome/frustration). Facts (Parse/Reconcile) are deterministic and
// always run; Interpret runs only when enabled and is versioned by its prompt/model.
//
// Future (#122): this is the home for tasks-as-interaction-spans and a content-keyed interpreter
// cache. For now it hosts the single task interpreter; summarize stays a read-time reporting helper.
import type { NativeProducer } from "../producer.ts";
import type { MaterializeSession, ParserDiagnostic } from "../../store/store-contract.ts";
import type { ResolvedTaskExtraction } from "../../config.ts";
import { extractTasksWithOutcome } from "./task-extraction.ts";

/** True when index-time task extraction should run for this call. */
export function taskExtractionActive(taskExtraction: ResolvedTaskExtraction | undefined): boolean {
  return !!taskExtraction?.enabled && taskExtraction.provider !== "off";
}

/** A short, human-facing label for progress output: the project plus a short session id. */
function sessionProgressLabel(session: MaterializeSession): string {
  const shortId = session.meta.sessionId.replace(/^[^:]+:/, "").slice(0, 8);
  return `${session.meta.project} (${shortId})`;
}

/**
 * Run the two-pass task extraction (#91) for the given materialized sessions, attaching the result
 * to each session before it's stored (so its interactions get task_seq at materialize, #122). Only
 * sessions in `targets` (the ones whose transcripts actually changed) are re-extracted; others keep
 * their stored tasks via the materializer's preserve-on-unchanged guard. The reconstructed dialogue
 * is an in-memory intermediate — nothing with message text is persisted.
 */
export async function extractTasksForSessions(
  producer: NativeProducer,
  sessions: MaterializeSession[],
  targets: Set<string>,
  taskExtraction: ResolvedTaskExtraction,
  diagnostics: ParserDiagnostic[],
  log?: (message: string) => void,
): Promise<void> {
  // Task candidates are the session's human interaction openings, already derived by reconcile and
  // attached as MaterializeSession.taskPrompts (#122) — no separate candidate fact to gather.
  const toExtract = sessions.filter(
    (session) => targets.has(session.meta.sessionId) && (session.taskPrompts?.length ?? 0) > 0,
  );
  if (!toExtract.length) return;
  // Task extraction runs an AI model per session, so it can take a while — emit a heartbeat as each
  // session starts so the command doesn't look stuck.
  log?.(
    `Extracting tasks from ${toExtract.length} session${toExtract.length === 1 ? "" : "s"} — this runs an AI model on each and can take a while…`,
  );
  let done = 0;
  for (const session of toExtract) {
    const sid = session.meta.sessionId;
    log?.(`  [${++done}/${toExtract.length}] ${sessionProgressLabel(session)}…`);
    const dialogue = producer.reconstructDialogue(session.meta.filePath);
    const { tasks, diagnostics: extractionDiagnostics } = await extractTasksWithOutcome(
      sid,
      session.taskPrompts!,
      session.interactions ?? [],
      dialogue,
      taskExtraction,
    );
    diagnostics.push(...extractionDiagnostics);
    session.tasks = tasks;
  }
}
