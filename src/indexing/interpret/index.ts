// The Interpret stage: the one model-driven, opt-in step of the pipeline. It derives interpretations
// of a session that aren't in the transcript — the #91/#122 two-pass task extraction (segment tasks
// over the session's interactions, then judge per-task outcome/frustration). Facts (Parse/Reconcile)
// are deterministic and always run; Interpret runs only when enabled and is versioned by its prompt/model.
//
// It operates entirely on the reconcile-derived interactions (#122), which carry in-memory prompt and
// response text — there is no separate candidate list or reconstructed dialogue.
import type { MaterializeSession, ParserDiagnostic } from "../../store/store-contract.ts";
import type { ResolvedTaskExtraction } from "../../config.ts";
import { isHttpProvider } from "../../llm/index.ts";
import { resolveApiKey } from "../../secrets.ts";
import { extractTasksWithOutcome } from "./task-extraction.ts";

/** True when index-time task extraction should run for this call. */
export function taskExtractionActive(taskExtraction: ResolvedTaskExtraction | undefined): boolean {
  return !!taskExtraction?.enabled && taskExtraction.llm.provider !== "off";
}

/** Fill in the API key for an HTTP provider once per run (env var → secret store). The LLM client is
 *  kept pure of secret access, so the key is resolved here and handed down on `llm.apiKey`. */
async function withResolvedApiKey(
  taskExtraction: ResolvedTaskExtraction,
): Promise<ResolvedTaskExtraction> {
  const { llm } = taskExtraction;
  if (!isHttpProvider(llm.provider) || llm.apiKey) return taskExtraction;
  const apiKey = await resolveApiKey(llm.apiKeyEnv);
  return { ...taskExtraction, llm: { ...llm, apiKey } };
}

/** A short, human-facing label for progress output: the project plus a short session id. */
function sessionProgressLabel(session: MaterializeSession): string {
  const shortId = session.meta.sessionId.replace(/^[^:]+:/, "").slice(0, 8);
  return `${session.meta.project} (${shortId})`;
}

/** Does this session have at least one human interaction opening with task text — i.e. a task candidate? */
function hasTaskCandidate(session: MaterializeSession): boolean {
  return (session.interactions ?? []).some((i) => i.initiator === "human" && !!i.promptText);
}

/**
 * Run the two-pass task extraction (#91/#122) for the given materialized sessions, attaching the result
 * to each session before it's stored (so its interactions get task_seq at materialize). Only sessions
 * in `targets` (the ones whose transcripts actually changed) are re-extracted; others keep their stored
 * tasks via the materializer's preserve-on-unchanged guard. Extraction reads the interactions' in-memory
 * prompt/response text — nothing with message text is persisted.
 */
export async function extractTasksForSessions(
  sessions: MaterializeSession[],
  targets: Set<string>,
  taskExtraction: ResolvedTaskExtraction,
  diagnostics: ParserDiagnostic[],
  log?: (message: string) => void,
): Promise<void> {
  // Task candidates are the session's human interaction openings (#122) — already on session.interactions.
  const toExtract = sessions.filter(
    (session) => targets.has(session.meta.sessionId) && hasTaskCandidate(session),
  );
  if (!toExtract.length) return;
  // Resolve the API key once for the whole run (one keychain read, not one per session).
  const resolved = await withResolvedApiKey(taskExtraction);
  // Task extraction runs an AI model per session, so it can take a while — emit a heartbeat as each
  // session starts so the command doesn't look stuck.
  log?.(
    `Extracting tasks from ${toExtract.length} session${toExtract.length === 1 ? "" : "s"} — this runs an AI model on each and can take a while…`,
  );
  let done = 0;
  for (const session of toExtract) {
    const sid = session.meta.sessionId;
    log?.(`  [${++done}/${toExtract.length}] ${sessionProgressLabel(session)}…`);
    const { tasks, diagnostics: extractionDiagnostics } = await extractTasksWithOutcome(
      sid,
      session.interactions ?? [],
      resolved,
    );
    diagnostics.push(...extractionDiagnostics);
    session.tasks = tasks;
  }
}
