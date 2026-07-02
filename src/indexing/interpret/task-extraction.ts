import { readFileSync } from "node:fs";
import {
  assignInteractionTaskSeqs,
  createFactId,
  type InteractionFact,
  type ParserDiagnostic,
  type SourcePosition,
  type TaskFact,
  type TaskFrustration,
  type TaskOutcome,
} from "../../store/store-contract.ts";
import { complete } from "../../llm/index.ts";
import type { LlmResult } from "../../llm/types.ts";
import type { ResolvedTaskExtraction } from "../../config.ts";
import { logAt } from "../../logger.ts";

/** The pass-2 dialogue: the prompt (user) then response (assistant) text of each of the task's
 *  interactions, in order — the projection of prompts+responses the session model describes (#122),
 *  not a role-tag reconstruction. Built straight from the interactions; never persisted. */
function interactionTurns(
  interactions: InteractionFact[],
): Array<{ role: "user" | "assistant"; text: string }> {
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const interaction of [...interactions].sort((a, b) => a.seq - b.seq)) {
    if (interaction.promptText)
      turns.push({ role: "user", text: interaction.promptText });
    if (interaction.responseText)
      turns.push({ role: "assistant", text: interaction.responseText });
  }
  return turns;
}

export const DEFAULT_TASK_EXTRACTION_PROMPT = `You identify the actual tasks a user was trying to accomplish in an agent session.

Return JSON only. Use this exact shape:
{"tasks":[{"description":"short task description","messageIndexes":[0]}]}

Rules:
- A task is concrete work the user wanted the agent to do.
- Exclude setup/context instructions, AGENTS.md instructions, aborted or cancelled turns, status messages, and messages that do not ask the agent to accomplish work.
- Combine multiple messages into one task when they are clearly part of the same user goal.
- Keep descriptions concise and specific.
- messageIndexes must refer to the filtered user message indexes provided below.`;

export interface ExtractedTaskSpec {
  description: string;
  messageIndexes: number[];
}

export function logTaskExtractionDebug(
  options: ResolvedTaskExtraction | undefined,
  message: string,
): void {
  if (!options?.log) return;
  logAt(options.log, "debug", `[task extraction] ${message}`);
}

function logTaskExtractionBlock(
  options: ResolvedTaskExtraction | undefined,
  label: string,
  body: string,
): void {
  if (!options?.log) return;
  logTaskExtractionDebug(options, `${label} begin`);
  const content = body.length ? body : "(empty)";
  for (const line of content.split(/\r?\n/)) {
    logAt(options.log, "debug", `[task extraction] ${line}`);
  }
  logTaskExtractionDebug(options, `${label} end`);
}

function diagnostic(
  code: string,
  message: string,
  severity: ParserDiagnostic["severity"] = "warning",
  position?: SourcePosition,
): ParserDiagnostic {
  return {
    code,
    severity,
    phase: "reconcile",
    message,
    ...(position ? { position } : {}),
  };
}

/** The configured provider for this run (`off` when no extraction options are present). */
export function taskExtractionProvider(
  options: ResolvedTaskExtraction | undefined,
): string {
  return options?.llm.provider ?? "off";
}

/** A one-line summary of the resolved LLM configuration for debug output. Never includes the key
 *  value — only the env-var name it resolves from and whether a value was found. */
function llmConfigSummary(options: ResolvedTaskExtraction | undefined): string {
  const llm = options?.llm;
  if (!llm) return "llm config: provider=off";
  const parts = [
    `provider=${llm.provider}`,
    `model=${llm.model ?? "(default)"}`,
  ];
  if (llm.baseUrl) parts.push(`baseUrl=${llm.baseUrl}`);
  if (llm.maxTokens != null) parts.push(`maxTokens=${llm.maxTokens}`);
  if (llm.command) parts.push(`command=${llm.command}`);
  if (llm.apiKeyEnv)
    parts.push(
      `apiKeyEnv=${llm.apiKeyEnv}`,
      `key=${llm.apiKey ? "set" : "unset"}`,
    );
  return `llm config: ${parts.join(" ")}`;
}

function llmWithProviderLog(
  options: ResolvedTaskExtraction,
): ResolvedTaskExtraction["llm"] {
  if (!options.log) return options.llm;
  return {
    ...options.llm,
    log: (message) =>
      logAt(options.log!, "warn", `[task extraction] ${message}`),
  };
}

function resolveInstructions(
  options: ResolvedTaskExtraction | undefined,
  diagnostics: ParserDiagnostic[],
): string | undefined {
  if (options?.promptFile) {
    try {
      const prompt = readFileSync(options.promptFile, "utf8").trim();
      if (prompt) return prompt;
      diagnostics.push(
        diagnostic(
          "task_extraction_prompt_empty",
          `Task prompt file is empty: ${options.promptFile}`,
        ),
      );
      return undefined;
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "task_extraction_prompt_unreadable",
          `Couldn't read task prompt file ${options.promptFile}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
      return undefined;
    }
  }
  return options?.prompt?.trim() || DEFAULT_TASK_EXTRACTION_PROMPT;
}

export function buildTaskExtractionPrompt(
  sessionId: string,
  candidates: InteractionFact[],
  instructions = DEFAULT_TASK_EXTRACTION_PROMPT,
): string {
  const messages = candidates.map((candidate, index) => ({
    index,
    ...(candidate.timestampMs != null
      ? { timestamp: new Date(candidate.timestampMs).toISOString() }
      : {}),
    text: candidate.promptText ?? "",
  }));
  return `${instructions.trim()}\n\nFiltered user messages:\n${JSON.stringify(
    { sessionId, messages },
    null,
    2,
  )}`;
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1]!.trim();
  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (!starts.length) return trimmed;
  const start = Math.min(...starts);
  const open = trimmed[start];
  const close = open === "{" ? "}" : "]";
  const end = trimmed.lastIndexOf(close);
  return end >= start ? trimmed.slice(start, end + 1).trim() : trimmed;
}

export function parseTaskExtractionOutput(raw: string): ExtractedTaskSpec[] {
  const parsed = JSON.parse(stripJsonFence(raw)) as unknown;
  const payload =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).tasks
      : parsed;
  if (!Array.isArray(payload)) {
    throw new Error("expected a JSON object with a tasks array");
  }

  const tasks: ExtractedTaskSpec[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const values = item as Record<string, unknown>;
    const description =
      typeof values.description === "string" ? values.description.trim() : "";
    if (!description) continue;
    const rawIndexes = Array.isArray(values.messageIndexes)
      ? values.messageIndexes
      : Array.isArray(values.message_indices)
        ? values.message_indices
        : [];
    const messageIndexes = rawIndexes
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0);
    tasks.push({ description, messageIndexes });
  }
  return tasks;
}

/** Run the shared LLM client for a task-extraction prompt. `off` is the consumer's "no LLM" signal:
 *  it returns an empty-tasks result rather than calling the layer (which would just report ok:false). */
async function runExtraction(
  prompt: string,
  options: ResolvedTaskExtraction | undefined,
): Promise<LlmResult> {
  if (taskExtractionProvider(options) === "off")
    return { ok: true, text: '{"tasks":[]}' };
  return complete({ prompt }, llmWithProviderLog(options!));
}

function uniqueValidIndexes(indexes: number[], count: number): number[] {
  return [...new Set(indexes)]
    .filter((index) => index >= 0 && index < count)
    .sort((a, b) => a - b);
}

export function taskFactsFromSpecs(
  sessionId: string,
  candidates: InteractionFact[],
  specs: ExtractedTaskSpec[],
): TaskFact[] {
  if (!candidates.length) return [];
  return specs
    .map((spec, taskIndex): TaskFact | null => {
      const indexes = uniqueValidIndexes(
        spec.messageIndexes,
        candidates.length,
      );
      // A task anchors to the interaction openings it references (#122). A spec the model couldn't
      // anchor to any valid candidate index is dropped — it would otherwise default onto candidate 0
      // and either own no interaction or tie onto the real first task's.
      if (!indexes.length) return null;
      const anchor = candidates[indexes[0]!]!;
      const timestampCandidate = indexes
        .map((index) => candidates[index]?.timestampMs)
        .find((timestamp): timestamp is number => timestamp != null);
      const fact: TaskFact = {
        id: createFactId(
          "task",
          anchor.source,
          sessionId,
          anchor.promptPosition,
          `llm:${taskIndex}:${spec.description}:${indexes.join(",")}`,
        ),
        source: anchor.source,
        sourceSessionId: sessionId,
        description: spec.description,
        evidence: `interactions: ${indexes.map((index) => candidates[index]!.seq).join(", ")}`,
        evidenceKind: "llm_inference",
        position: anchor.promptPosition,
      };
      if (timestampCandidate != null) fact.timestampMs = timestampCandidate;
      return fact;
    })
    .filter((fact): fact is TaskFact => fact !== null);
}

export async function extractTasksForSession(
  sessionId: string,
  candidates: InteractionFact[],
  options: ResolvedTaskExtraction | undefined,
): Promise<{ tasks: TaskFact[]; diagnostics: ParserDiagnostic[] }> {
  const provider = taskExtractionProvider(options);
  const diagnostics: ParserDiagnostic[] = [];
  logTaskExtractionDebug(
    options,
    `starting extraction for ${sessionId}: provider=${provider}, task-start interactions=${candidates.length}`,
  );
  if (provider === "off") {
    logTaskExtractionDebug(
      options,
      `skipping ${sessionId}: task extraction is off`,
    );
    return { tasks: [], diagnostics };
  }
  if (candidates.length === 0) {
    logTaskExtractionDebug(
      options,
      `skipping ${sessionId}: no task-start interactions`,
    );
    return { tasks: [], diagnostics };
  }

  const instructions = resolveInstructions(options, diagnostics);
  if (!instructions) {
    logTaskExtractionDebug(
      options,
      `skipping ${sessionId}: no task extraction prompt available`,
    );
    return { tasks: [], diagnostics };
  }

  const promptSource = options?.promptFile
    ? `prompt file ${options.promptFile}`
    : options?.prompt
      ? "custom prompt"
      : "default prompt";
  logTaskExtractionDebug(options, `using ${promptSource}`);
  const prompt = buildTaskExtractionPrompt(sessionId, candidates, instructions);
  logTaskExtractionDebug(
    options,
    `prompt bytes=${Buffer.byteLength(prompt, "utf8")}`,
  );
  logTaskExtractionBlock(options, "prompt", prompt);
  logTaskExtractionDebug(options, llmConfigSummary(options));
  const result = await runExtraction(prompt, options);
  logTaskExtractionDebug(
    options,
    `provider finished: ok=${result.ok}${result.status == null ? "" : ` status=${result.status}`}${
      result.error ? ` error=${result.error}` : ""
    }`,
  );
  logTaskExtractionBlock(options, "provider output", result.text);
  if (!result.ok) {
    diagnostics.push(
      diagnostic(
        "task_extraction_failed",
        `Couldn't extract tasks for ${sessionId}: ${result.error ?? "no output"}`,
        "warning",
        candidates[0]?.promptPosition,
      ),
    );
    return { tasks: [], diagnostics };
  }

  try {
    const specs = parseTaskExtractionOutput(result.text);
    logTaskExtractionDebug(options, `parsed tasks=${specs.length}`);
    const tasks = taskFactsFromSpecs(sessionId, candidates, specs);
    logTaskExtractionDebug(options, `created tasks=${tasks.length}`);
    return { tasks, diagnostics };
  } catch (error) {
    logTaskExtractionDebug(
      options,
      `couldn't read provider output: ${error instanceof Error ? error.message : String(error)}`,
    );
    diagnostics.push(
      diagnostic(
        "task_extraction_bad_response",
        `Couldn't read task extractor output for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warning",
        candidates[0]?.promptPosition,
      ),
    );
    return { tasks: [], diagnostics };
  }
}

// --- Pass 2: per-task outcome and frustration (#91) ---

export const DEFAULT_TASK_OUTCOME_PROMPT = `
You judge how a single task in an agent session turned out, from the interaction dialogue between the user and the
assistant. Note that this dialogue does not include the assistant's narration messages or specific tool invocations.
It has been reduced to user prompts and the assistant's final message at the end of a completed interaction.

Return JSON only. Use this exact shape:
{"outcome":"success","frustration":"none","signals":["short tag"],"reason":"one sentence"}

Rules:
- outcome is one of: "success" (the user got what they asked for), "failure" (they clearly did not), "unclear"
  (you can't tell).
- Judge from the WHOLE exchange, not just the final message.
- frustration is one of: "none", "moderate", "high" — how frustrated the user seemed across the task (repeated re-asks,
  corrections, escalating tone, or the assistant repeatedly saying it can't do something / lacks access).
- signals: a few short evidence tags, e.g. "repeated re-asks", "no access", "assistant over-claimed". Omit or use [] if there are none.
- reason: one concise sentence explaining the call.`;

export interface TaskOutcomeJudgment {
  outcome: TaskOutcome;
  frustration: TaskFrustration;
  signals?: string[];
  outcomeReason?: string;
}

export function buildTaskOutcomePrompt(
  description: string,
  interactions: InteractionFact[],
  instructions = DEFAULT_TASK_OUTCOME_PROMPT,
): string {
  const turns = interactionTurns(interactions);
  return `${instructions.trim()}\n\nTask: ${description}\n\nDialogue:\n${JSON.stringify(turns, null, 2)}`;
}

function toOutcome(value: unknown): TaskOutcome {
  return value === "success" || value === "failure" ? value : "unclear";
}

function toFrustration(value: unknown): TaskFrustration {
  return value === "low" || value === "high" ? value : "none";
}

export function parseTaskOutcomeOutput(raw: string): TaskOutcomeJudgment {
  const parsed = JSON.parse(stripJsonFence(raw)) as unknown;
  const values =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const judgment: TaskOutcomeJudgment = {
    outcome: toOutcome(values.outcome),
    frustration: toFrustration(values.frustration),
  };
  const signals = Array.isArray(values.signals)
    ? values.signals.filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      )
    : [];
  if (signals.length) judgment.signals = signals;
  const reason = typeof values.reason === "string" ? values.reason.trim() : "";
  if (reason) judgment.outcomeReason = reason;
  return judgment;
}

/** Judge one task's outcome from its interactions' prompt/response dialogue. Returns no judgment when
 *  extraction is off or the task's interactions carry no text. */
export async function judgeTaskOutcome(
  description: string,
  interactions: InteractionFact[],
  options: ResolvedTaskExtraction | undefined,
): Promise<{
  judgment?: TaskOutcomeJudgment;
  diagnostics: ParserDiagnostic[];
}> {
  const diagnostics: ParserDiagnostic[] = [];
  const hasText = interactions.some((i) => i.promptText || i.responseText);
  if (taskExtractionProvider(options) === "off" || !hasText)
    return { diagnostics };

  const prompt = buildTaskOutcomePrompt(description, interactions);
  logTaskExtractionDebug(
    options,
    `outcome prompt bytes=${Buffer.byteLength(prompt, "utf8")}`,
  );
  logTaskExtractionBlock(options, "outcome prompt", prompt);
  logTaskExtractionDebug(options, llmConfigSummary(options));
  const result = await complete({ prompt }, llmWithProviderLog(options!));
  if (!result.ok) {
    diagnostics.push(
      diagnostic(
        "task_outcome_failed",
        `Couldn't judge task outcome: ${result.error ?? "no output"}`,
      ),
    );
    return { diagnostics };
  }
  try {
    return { judgment: parseTaskOutcomeOutput(result.text), diagnostics };
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "task_outcome_bad_response",
        `Couldn't read task outcome output: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return { diagnostics };
  }
}

/** Run async work over items with a small concurrency cap, preserving input order in the result. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * The full two-pass extraction (#91/#122): pass 1 segments the session's human interaction openings
 * (the only task candidates) into tasks; pass 2 judges each task's outcome from the dialogue projected
 * over the interactions it owns. `interactions` is the reconcile-derived spine, carrying in-memory
 * prompt/response text. Materialize independently assigns the same interaction→task membership (via the
 * shared `assignInteractionTaskSeqs`) onto resolved_interactions.task_seq, so judged dialogue and
 * stored membership agree exactly.
 */
export async function extractTasksWithOutcome(
  sessionId: string,
  interactions: InteractionFact[],
  options: ResolvedTaskExtraction | undefined,
): Promise<{ tasks: TaskFact[]; diagnostics: ParserDiagnostic[] }> {
  // Task candidates are the human interaction openings that carry task text (#122).
  const candidates = interactions.filter(
    (interaction): interaction is InteractionFact & { promptText: string } =>
      interaction.initiator === "human" && !!interaction.promptText,
  );
  const pass1 = await extractTasksForSession(sessionId, candidates, options);
  const diagnostics = [...pass1.diagnostics];
  if (!pass1.tasks.length) return { tasks: pass1.tasks, diagnostics };

  // Chronological order so resolved_tasks.seq (and thus the interaction→task assignment) increases
  // along the timeline.
  const tasks = [...pass1.tasks].sort(
    (a, b) => (a.timestampMs ?? Infinity) - (b.timestampMs ?? Infinity),
  );

  // Group each task's owned interactions via the same bookmark the materializer stamps onto
  // resolved_interactions.task_seq, so the judged dialogue matches the stored membership exactly. A
  // task that owns no interaction is judged over nothing (consistent with its empty stored membership).
  const taskSeqByInteraction = assignInteractionTaskSeqs(tasks, interactions);
  const interactionsByTask = new Map<number, InteractionFact[]>();
  for (const interaction of interactions) {
    const taskIndex = taskSeqByInteraction.get(interaction.seq);
    if (taskIndex == null) continue;
    const list = interactionsByTask.get(taskIndex) ?? [];
    if (!interactionsByTask.has(taskIndex))
      interactionsByTask.set(taskIndex, list);
    list.push(interaction);
  }
  logTaskExtractionDebug(
    options,
    `judging outcome for ${interactionsByTask.size}/${tasks.length} tasks in ${sessionId}`,
  );
  await mapWithLimit(
    [...interactionsByTask.entries()],
    4,
    async ([taskIndex, owned]) => {
      const task = tasks[taskIndex]!;
      const { judgment, diagnostics: outcomeDiagnostics } =
        await judgeTaskOutcome(task.description, owned, options);
      diagnostics.push(...outcomeDiagnostics);
      if (judgment) {
        task.outcome = judgment.outcome;
        task.frustration = judgment.frustration;
        if (judgment.signals) task.signals = judgment.signals;
        if (judgment.outcomeReason) task.outcomeReason = judgment.outcomeReason;
      }
    },
  );

  return { tasks, diagnostics };
}
