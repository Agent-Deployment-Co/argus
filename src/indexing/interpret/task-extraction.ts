import { readFileSync } from "node:fs";
import {
  assignInteractionTaskSeqs,
  createFactId,
  type InteractionFact,
  type ParserDiagnostic,
  type SessionInvocation,
  type SourcePosition,
  type TaskFact,
  type TaskFrustration,
  type TaskOutcome,
} from "../../store/store-contract.ts";
import { complete } from "../../llm/index.ts";
import type { LlmResult } from "../../llm/types.ts";
import {
  DEFAULT_SUMMARY_MAX_CHARS,
  DEFAULT_TITLE_MAX_CHARS,
  type ResolvedSessionInterpretation,
} from "../../config.ts";
import { toolDisplayName } from "../../tool-categories.ts";
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

export const DEFAULT_TASK_EXTRACTION_PROMPT = `You interpret an agent session: what the user was working on, how it went, and the concrete tasks they wanted done.

Return JSON only. Use this exact shape:
{"title":"short session title","summary":"what happened in the session","tasks":[{"description":"short task description","messageIndexes":[0]}]}

Rules:
- title: a concise, specific label for the whole session — what it was about. No trailing punctuation.
- summary: a few sentences describing what the user set out to do and what actually happened, grounded in both the user messages and the assistant's responses.
- A task is concrete work the user wanted the agent to do.
- Exclude setup/context instructions, AGENTS.md instructions, aborted or cancelled turns, status messages, and messages that do not ask the agent to accomplish work.
- Combine multiple messages into one task when they are clearly part of the same user goal.
- Keep task descriptions concise and specific.
- messageIndexes must refer to the filtered user message indexes provided below (each message's assistant response, when present, is included only as context — never index it).`;

/** JSON schema for the pass-1 output (#234), enforced by providers that support structured output.
 *  Character limits are stated in the prompt and clamped on write (JSON Schema can't express them). */
export const TASK_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: { type: "string" },
          messageIndexes: { type: "array", items: { type: "integer" } },
        },
        required: ["description", "messageIndexes"],
      },
    },
  },
  required: ["title", "summary", "tasks"],
} as const;

export interface ExtractedTaskSpec {
  description: string;
  messageIndexes: number[];
}

/** Pass-1 output: the session title + summary and the segmented tasks (#234). */
export interface SessionInterpretation1 {
  title: string;
  summary: string;
  tasks: ExtractedTaskSpec[];
}

export function logTaskExtractionDebug(
  options: ResolvedSessionInterpretation | undefined,
  message: string,
): void {
  if (!options?.log) return;
  logAt(options.log, "debug", `[task extraction] ${message}`);
}

function logTaskExtractionBlock(
  options: ResolvedSessionInterpretation | undefined,
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
  options: ResolvedSessionInterpretation | undefined,
): string {
  return options?.llm.provider ?? "off";
}

/** A one-line summary of the resolved LLM configuration for debug output. Never includes the key
 *  value — only the env-var name it resolves from and whether a value was found. */
function llmConfigSummary(options: ResolvedSessionInterpretation | undefined): string {
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
  options: ResolvedSessionInterpretation,
): ResolvedSessionInterpretation["llm"] {
  if (!options.log) return options.llm;
  return {
    ...options.llm,
    log: (message) =>
      logAt(options.log!, "warn", `[task extraction] ${message}`),
  };
}

function resolveInstructions(
  options: ResolvedSessionInterpretation | undefined,
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

// Pass-1 prompt bounds (#234). A long agentic session's full text runs to hundreds of KB / megabytes,
// which blows haiku's context (fast failure) or just makes each call slow — defeating the "lightweight,
// cheap" design (haiku is the fast tier; the point is to keep its input small so it stays fast). We
// bound the WHOLE prompt to a fixed character budget and truncate every message as hard as needed to
// fit — never dropping a message, because an interior interaction can be a task pivot / new chapter
// that segmentation must see. The budget is shared equally across messages; within a message the user
// prompt (which anchors segmentation) gets priority and the assistant response takes what's left. Each
// field is truncated head+tail, so both the setup and the outcome of a long message survive.
export const PROMPT_CHAR_LIMIT = 4000;
export const RESPONSE_GROUNDING_CHAR_LIMIT = 1000;
/** Total character budget for the assembled per-message text (~4 chars/token, so ~15k tokens). */
export const PASS1_TOTAL_CHAR_BUDGET = 60_000;
/** Floor so even a very long session keeps a readable snippet per message (a pivot still shows). */
const MIN_MSG_CHARS = 200;

/** Truncate to `maxChars` keeping the head and the tail (the setup and the conclusion), with an
 *  elision marker naming how much was cut. `<= 0` yields "". */
function truncateHeadTail(text: string, maxChars: number): string {
  const t = text.trim();
  if (maxChars <= 0) return "";
  if (t.length <= maxChars) return t;
  const usable = Math.max(0, maxChars - 24); // leave room for the marker
  const headLen = Math.ceil(usable * 0.65);
  const tailLen = Math.floor(usable * 0.35);
  const head = t.slice(0, headLen).trimEnd();
  const tail = tailLen > 0 ? t.slice(t.length - tailLen).trimStart() : "";
  const elided = t.length - head.length - tail.length;
  return tail ? `${head} …[${elided} chars elided]… ${tail}` : `${head} …[${elided} chars elided]`;
}

export function buildTaskExtractionPrompt(
  sessionId: string,
  candidates: InteractionFact[],
  instructions = DEFAULT_TASK_EXTRACTION_PROMPT,
  limits?: { titleMaxChars: number; summaryMaxChars: number },
): string {
  // Equal share of the budget per message; the prompt takes up to its own cap (and the share), the
  // response takes whatever share is left (up to its cap). No message is dropped — every index slot
  // keeps real, if aggressively truncated, text so messageIndexes stays meaningful.
  const n = Math.max(1, candidates.length);
  const perMsg = Math.floor(PASS1_TOTAL_CHAR_BUDGET / n);
  const messages = candidates.map((candidate, index) => {
    const promptCap = Math.min(PROMPT_CHAR_LIMIT, Math.max(MIN_MSG_CHARS, perMsg));
    const text = truncateHeadTail(candidate.promptText ?? "", promptCap);
    const responseCap = Math.min(RESPONSE_GROUNDING_CHAR_LIMIT, Math.max(0, perMsg - text.length));
    const response = candidate.responseText ? truncateHeadTail(candidate.responseText, responseCap) : "";
    return {
      index,
      ...(candidate.timestampMs != null
        ? { timestamp: new Date(candidate.timestampMs).toISOString() }
        : {}),
      text,
      ...(response ? { response } : {}),
    };
  });
  const constraints = limits
    ? `\n\nConstraints:\n- title: at most ${limits.titleMaxChars} characters.\n- summary: at most ${limits.summaryMaxChars} characters.`
    : "";
  return `${instructions.trim()}${constraints}\n\nFiltered user messages (with assistant responses as context):\n${JSON.stringify(
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

export function parseTaskExtractionOutput(raw: string): SessionInterpretation1 {
  const parsed = JSON.parse(stripJsonFence(raw)) as unknown;
  const isObject = parsed && typeof parsed === "object" && !Array.isArray(parsed);
  const root = isObject ? (parsed as Record<string, unknown>) : {};
  // Accept a bare array as the legacy tasks-only shape (title/summary empty).
  const payload = isObject ? root.tasks : parsed;
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
  const title = typeof root.title === "string" ? root.title.trim() : "";
  const summary = typeof root.summary === "string" ? root.summary.trim() : "";
  return { title, summary, tasks };
}

/** Run the shared LLM client for a task-extraction prompt. `off` is the consumer's "no LLM" signal:
 *  it returns an empty result rather than calling the layer (which would just report ok:false). The
 *  pass-1 JSON schema is enforced by providers that support structured output; others fall back to the
 *  prompt instructions + tolerant parsing. Effort (when set) rides on the resolved llm config. */
async function runExtraction(
  prompt: string,
  options: ResolvedSessionInterpretation | undefined,
): Promise<LlmResult> {
  if (taskExtractionProvider(options) === "off")
    return { ok: true, text: '{"title":"","summary":"","tasks":[]}' };
  return complete({ prompt, schema: TASK_EXTRACTION_SCHEMA }, llmWithProviderLog(options!));
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

/** Clamp a model string to a character budget (defensive — the limit is also stated in the prompt). */
function clamp(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(0, maxChars).trimEnd();
}

export interface SessionInterpretationResult {
  title: string;
  summary: string;
  tasks: TaskFact[];
  diagnostics: ParserDiagnostic[];
}

export async function extractTasksForSession(
  sessionId: string,
  candidates: InteractionFact[],
  options: ResolvedSessionInterpretation | undefined,
): Promise<SessionInterpretationResult> {
  const provider = taskExtractionProvider(options);
  const diagnostics: ParserDiagnostic[] = [];
  const titleMax = options?.titleMaxChars ?? DEFAULT_TITLE_MAX_CHARS;
  const summaryMax = options?.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
  logTaskExtractionDebug(
    options,
    `starting interpretation for ${sessionId}: provider=${provider}, task-start interactions=${candidates.length}`,
  );
  if (provider === "off") {
    logTaskExtractionDebug(options, `skipping ${sessionId}: session interpretation is off`);
    return { title: "", summary: "", tasks: [], diagnostics };
  }
  if (candidates.length === 0) {
    logTaskExtractionDebug(options, `skipping ${sessionId}: no task-start interactions`);
    return { title: "", summary: "", tasks: [], diagnostics };
  }

  const instructions = resolveInstructions(options, diagnostics);
  if (!instructions) {
    logTaskExtractionDebug(options, `skipping ${sessionId}: no interpretation prompt available`);
    return { title: "", summary: "", tasks: [], diagnostics };
  }

  const promptSource = options?.promptFile
    ? `prompt file ${options.promptFile}`
    : options?.prompt
      ? "custom prompt"
      : "default prompt";
  logTaskExtractionDebug(options, `using ${promptSource}`);
  const prompt = buildTaskExtractionPrompt(sessionId, candidates, instructions, {
    titleMaxChars: titleMax,
    summaryMaxChars: summaryMax,
  });
  logTaskExtractionDebug(options, `prompt bytes=${Buffer.byteLength(prompt, "utf8")}`);
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
        `Couldn't interpret ${sessionId}: ${result.error ?? "no output"}`,
        "warning",
        candidates[0]?.promptPosition,
      ),
    );
    return { title: "", summary: "", tasks: [], diagnostics };
  }

  try {
    const parsed = parseTaskExtractionOutput(result.text);
    logTaskExtractionDebug(options, `parsed tasks=${parsed.tasks.length}`);
    const tasks = taskFactsFromSpecs(sessionId, candidates, parsed.tasks);
    logTaskExtractionDebug(options, `created tasks=${tasks.length}`);
    return {
      title: clamp(parsed.title, titleMax),
      summary: clamp(parsed.summary, summaryMax),
      tasks,
      diagnostics,
    };
  } catch (error) {
    logTaskExtractionDebug(
      options,
      `couldn't read provider output: ${error instanceof Error ? error.message : String(error)}`,
    );
    diagnostics.push(
      diagnostic(
        "task_extraction_bad_response",
        `Couldn't read interpretation output for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warning",
        candidates[0]?.promptPosition,
      ),
    );
    return { title: "", summary: "", tasks: [], diagnostics };
  }
}

// --- Pass 2: per-task outcome and frustration (#91) ---

export const DEFAULT_TASK_OUTCOME_PROMPT = `
You judge how a single task in an agent session turned out, from the interaction dialogue between the user and the
assistant. Note that this dialogue does not include the assistant's narration messages. It has been reduced to user
prompts and the assistant's final message at the end of a completed interaction. Where present, a mechanical summary of
the tool activity during the task is also included — this is a deterministic count of tool calls (not model narration),
useful when the tidy final message understates or overstates what actually happened.

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

/** JSON schema for the pass-2 outcome verdict (#234), enforced by structured-output providers. */
export const TASK_OUTCOME_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: ["success", "failure", "unclear"] },
    frustration: { type: "string", enum: ["none", "moderate", "high"] },
    signals: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["outcome", "frustration", "signals", "reason"],
} as const;

/** Tools that mutate a file — used to count "files edited" in the deterministic tool-usage summary. */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "write_file", "replace"]);

/** A compact, deterministic one-line summary of tool activity across a task's interactions (#234), e.g.
 *  "18 tool calls: 6× Edit, 5× Bash, 4× Read, 3× Grep; 4 files edited." Mechanical, not model narration:
 *  it gives the pass-2 judge evidence beyond the prompt + final-response text. Returns "" when empty. */
export function summarizeToolUsage(invocations: SessionInvocation[]): string {
  if (!invocations.length) return "";
  const counts = new Map<string, number>();
  const editedFiles = new Set<string>();
  for (const inv of invocations) {
    const label = toolDisplayName(inv.tool);
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (inv.filePath && EDIT_TOOLS.has(inv.tool)) editedFiles.add(inv.filePath);
  }
  const total = invocations.length;
  // Rank by count desc, then label asc for a stable, deterministic order.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked.slice(0, 6).map(([label, n]) => `${n}× ${label}`);
  const parts = [`${total} tool call${total === 1 ? "" : "s"}: ${top.join(", ")}`];
  if (editedFiles.size) parts.push(`${editedFiles.size} file${editedFiles.size === 1 ? "" : "s"} edited`);
  return `${parts.join("; ")}.`;
}

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
  toolSummary = "",
): string {
  const turns = interactionTurns(interactions);
  const toolLine = toolSummary
    ? `\n\nTool usage (mechanical summary, not narration):\n${toolSummary}`
    : "";
  return `${instructions.trim()}\n\nTask: ${description}${toolLine}\n\nDialogue:\n${JSON.stringify(turns, null, 2)}`;
}

function toOutcome(value: unknown): TaskOutcome {
  return value === "success" || value === "failure" ? value : "unclear";
}

function toFrustration(value: unknown): TaskFrustration {
  return value === "moderate" || value === "high" ? value : "none";
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
  options: ResolvedSessionInterpretation | undefined,
  toolSummary = "",
): Promise<{
  judgment?: TaskOutcomeJudgment;
  diagnostics: ParserDiagnostic[];
}> {
  const diagnostics: ParserDiagnostic[] = [];
  const hasText = interactions.some((i) => i.promptText || i.responseText);
  if (taskExtractionProvider(options) === "off" || !hasText)
    return { diagnostics };

  const prompt = buildTaskOutcomePrompt(description, interactions, DEFAULT_TASK_OUTCOME_PROMPT, toolSummary);
  logTaskExtractionDebug(
    options,
    `outcome prompt bytes=${Buffer.byteLength(prompt, "utf8")}`,
  );
  logTaskExtractionBlock(options, "outcome prompt", prompt);
  logTaskExtractionDebug(options, llmConfigSummary(options));
  const result = await complete({ prompt, schema: TASK_OUTCOME_SCHEMA }, llmWithProviderLog(options!));
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
  options: ResolvedSessionInterpretation | undefined,
  invocations: SessionInvocation[] = [],
): Promise<SessionInterpretationResult> {
  // Task candidates are the human interaction openings that carry task text (#122).
  const candidates = interactions.filter(
    (interaction): interaction is InteractionFact & { promptText: string } =>
      interaction.initiator === "human" && !!interaction.promptText,
  );
  const pass1 = await extractTasksForSession(sessionId, candidates, options);
  const diagnostics = [...pass1.diagnostics];
  if (!pass1.tasks.length)
    return { title: pass1.title, summary: pass1.summary, tasks: pass1.tasks, diagnostics };

  // Chronological order so resolved_tasks.seq (and thus the interaction→task assignment) increases
  // along the timeline.
  const tasks = [...pass1.tasks].sort(
    (a, b) => (a.timestampMs ?? Infinity) - (b.timestampMs ?? Infinity),
  );

  // Group invocations by their owning interaction seq (#234). Read from resolved_invocations, keyed by
  // interaction_seq — NOT task_seq (which writeSessionTasks assigns only after this pass runs).
  const invocationsByInteraction = new Map<number, SessionInvocation[]>();
  for (const inv of invocations) {
    if (inv.interactionSeq == null) continue;
    const list = invocationsByInteraction.get(inv.interactionSeq) ?? [];
    if (!invocationsByInteraction.has(inv.interactionSeq))
      invocationsByInteraction.set(inv.interactionSeq, list);
    list.push(inv);
  }

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
      // Deterministic tool-usage summary over this task's owned interactions' invocations.
      const taskInvocations = owned.flatMap((i) => invocationsByInteraction.get(i.seq) ?? []);
      const toolSummary = summarizeToolUsage(taskInvocations);
      const { judgment, diagnostics: outcomeDiagnostics } =
        await judgeTaskOutcome(task.description, owned, options, toolSummary);
      diagnostics.push(...outcomeDiagnostics);
      if (judgment) {
        task.outcome = judgment.outcome;
        task.frustration = judgment.frustration;
        if (judgment.signals) task.signals = judgment.signals;
        if (judgment.outcomeReason) task.outcomeReason = judgment.outcomeReason;
      }
    },
  );

  return { title: pass1.title, summary: pass1.summary, tasks, diagnostics };
}
