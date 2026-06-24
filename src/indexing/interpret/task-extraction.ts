import { spawn } from "node:child_process";
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
  type TaskPrompt,
} from "../../store/store-contract.ts";
import { sliceDialogueByTime, type DialogueTurn } from "./dialogue.ts";

const MAX_LLM_BUFFER_BYTES = 32 * 1024 * 1024;

export const DEFAULT_TASK_EXTRACTION_PROVIDER = "claude";
/** Default model for the claude provider — a cheap, fast model for the per-session interpret calls. */
export const DEFAULT_TASK_EXTRACTION_MODEL = "haiku";

export const DEFAULT_TASK_EXTRACTION_PROMPT = `You identify the actual tasks a user was trying to accomplish in a coding-agent session.

Return JSON only. Use this exact shape:
{"tasks":[{"description":"short task description","messageIndexes":[0]}]}

Rules:
- A task is concrete work the user wanted the agent to do.
- Exclude setup/context instructions, AGENTS.md instructions, aborted or cancelled turns, status messages, and messages that do not ask the agent to accomplish work.
- Combine multiple messages into one task when they are clearly part of the same user goal.
- Keep descriptions concise and specific.
- messageIndexes must refer to the filtered user message indexes provided below.`;

export type TaskExtractionProvider = "off" | "claude" | "command";
export type TaskExtractionDebugLog = (message: string) => void;

export interface TaskExtractionOptions {
  provider?: TaskExtractionProvider;
  /** Model passed to providers that support model selection. The default claude provider maps this to --model. */
  model?: string;
  /** Custom instruction prompt. The session data is appended after it. */
  prompt?: string;
  /** Read a custom instruction prompt from this file. Takes precedence over prompt. */
  promptFile?: string;
  /** Custom command provider. The command reads the full prompt on stdin and writes JSON to stdout. */
  command?: string;
  /** Optional debug sink for task extraction. Callers decide whether this goes to stdout/stderr. */
  debugLog?: TaskExtractionDebugLog;
}

export interface ExtractedTaskSpec {
  description: string;
  messageIndexes: number[];
}

interface ProviderResult {
  ok: boolean;
  stdout: string;
  error?: string;
  stderr?: string;
  status?: number | null;
}

export function logTaskExtractionDebug(
  options: TaskExtractionOptions | undefined,
  message: string,
): void {
  options?.debugLog?.(`[task extraction] ${message}`);
}

// TEMP (remove): always-on estimate of the prompt/context size sent to the interpreter, so we can
// see how big these calls get during a real run without enabling full debug logging.
function logPromptSizeEstimate(label: string, prompt: string): void {
  const bytes = Buffer.byteLength(prompt, "utf8");
  const approxTokens = Math.round(bytes / 4); // rough ~4 bytes/token heuristic
  console.error(
    `[task interpretation] ${label}: ~${approxTokens.toLocaleString()} tokens (${bytes.toLocaleString()} bytes)`,
  );
}

function logTaskExtractionBlock(
  options: TaskExtractionOptions | undefined,
  label: string,
  body: string,
): void {
  if (!options?.debugLog) return;
  logTaskExtractionDebug(options, `${label} begin`);
  const content = body.length ? body : "(empty)";
  for (const line of content.split(/\r?\n/)) {
    options.debugLog(`[task extraction] ${line}`);
  }
  logTaskExtractionDebug(options, `${label} end`);
}

function diagnostic(
  code: string,
  message: string,
  severity: ParserDiagnostic["severity"] = "warning",
  position?: SourcePosition,
): ParserDiagnostic {
  return { code, severity, phase: "reconcile", message, ...(position ? { position } : {}) };
}

export function taskExtractionProvider(
  options: TaskExtractionOptions | undefined,
): TaskExtractionProvider {
  return options?.provider ?? "off";
}

function resolveInstructions(
  options: TaskExtractionOptions | undefined,
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
  prompts: TaskPrompt[],
  instructions = DEFAULT_TASK_EXTRACTION_PROMPT,
): string {
  const messages = prompts.map((prompt, index) => ({
    index,
    ...(prompt.timestampMs != null
      ? { timestamp: new Date(prompt.timestampMs).toISOString() }
      : {}),
    text: prompt.text,
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
    const description = typeof values.description === "string" ? values.description.trim() : "";
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

export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (quote) throw new Error("unterminated quote");
  if (current) args.push(current);
  return args;
}

function spawnWithStdin(file: string, args: string[], input: string): Promise<ProviderResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let bytesOut = 0;
    let truncated = false;

    child.stdout.on("data", (chunk: Buffer) => {
      bytesOut += chunk.length;
      if (bytesOut <= MAX_LLM_BUFFER_BYTES) {
        stdout += chunk.toString("utf8");
      } else {
        truncated = true;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdin.end(input, "utf8");

    child.on("close", (code) => {
      const error = truncated
        ? "provider output exceeded buffer limit"
        : code !== 0
          ? stderr.trim() || `exited with status ${code}`
          : undefined;
      resolve({ ok: !error && !!stdout.trim(), stdout, error, stderr, status: code });
    });

    child.on("error", (err) => {
      resolve({ ok: false, stdout: "", error: err.message, stderr, status: undefined });
    });
  });
}

/**
 * Args for the headless `claude` provider. Defaults: `--no-session-persistence` (don't leave a
 * transcript on disk — these interpret calls would otherwise be re-indexed as bogus sessions) and a
 * cheap default model. `-` reads the prompt from stdin; a configured `--task-model` /
 * `taskExtraction.model` overrides the model. (Note: `--bare` is deliberately NOT used — in `-p`
 * mode it skips credential loading and the call fails "Not logged in"; the output parser already
 * tolerates the normal fenced/wrapped output, so it buys nothing here.)
 */
export function claudeProviderArgs(options: TaskExtractionOptions | undefined): string[] {
  return ["-p", "--no-session-persistence", "--model", options?.model || DEFAULT_TASK_EXTRACTION_MODEL, "-"];
}

async function runClaude(prompt: string, options: TaskExtractionOptions | undefined): Promise<ProviderResult> {
  return spawnWithStdin("claude", claudeProviderArgs(options), prompt);
}

async function runCommand(prompt: string, command: string | undefined): Promise<ProviderResult> {
  if (!command?.trim()) return { ok: false, stdout: "", error: "no task command configured" };
  let argv: string[];
  try {
    argv = splitCommand(command);
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!argv.length) return { ok: false, stdout: "", error: "no task command configured" };
  return spawnWithStdin(argv[0]!, argv.slice(1), prompt);
}

async function runProvider(
  provider: TaskExtractionProvider,
  prompt: string,
  options: TaskExtractionOptions | undefined,
): Promise<ProviderResult> {
  if (provider === "claude") return runClaude(prompt, options);
  if (provider === "command") return runCommand(prompt, options?.command);
  return { ok: true, stdout: "{\"tasks\":[]}" };
}

function uniqueValidIndexes(indexes: number[], count: number): number[] {
  return [...new Set(indexes)]
    .filter((index) => index >= 0 && index < count)
    .sort((a, b) => a - b);
}

export function taskFactsFromSpecs(
  sessionId: string,
  prompts: TaskPrompt[],
  specs: ExtractedTaskSpec[],
): TaskFact[] {
  if (!prompts.length) return [];
  return specs
    .map((spec, taskIndex): TaskFact | null => {
      const indexes = uniqueValidIndexes(spec.messageIndexes, prompts.length);
      // A task anchors to the interaction openings it references (#122). A spec the model couldn't
      // anchor to any valid prompt index is dropped — it would otherwise default onto prompt 0 and
      // either own no interaction or tie onto the real first task's.
      if (!indexes.length) return null;
      const anchor = prompts[indexes[0]!]!;
      const timestampCandidate = indexes
        .map((index) => prompts[index]?.timestampMs)
        .find((timestamp): timestamp is number => timestamp != null);
      const fact: TaskFact = {
        id: createFactId(
          "task",
          anchor.source,
          sessionId,
          anchor.position,
          `llm:${taskIndex}:${spec.description}:${indexes.join(",")}`,
        ),
        source: anchor.source,
        sourceSessionId: sessionId,
        description: spec.description,
        evidence: `interactions: ${indexes.map((index) => prompts[index]!.interactionSeq).join(", ")}`,
        evidenceKind: "llm_inference",
        position: anchor.position,
      };
      if (timestampCandidate != null) fact.timestampMs = timestampCandidate;
      return fact;
    })
    .filter((fact): fact is TaskFact => fact !== null);
}

export async function extractTasksForSession(
  sessionId: string,
  prompts: TaskPrompt[],
  options: TaskExtractionOptions | undefined,
): Promise<{ tasks: TaskFact[]; diagnostics: ParserDiagnostic[] }> {
  const provider = taskExtractionProvider(options);
  const diagnostics: ParserDiagnostic[] = [];
  logTaskExtractionDebug(
    options,
    `starting extraction for ${sessionId}: provider=${provider}, prompts=${prompts.length}`,
  );
  if (provider === "off") {
    logTaskExtractionDebug(options, `skipping ${sessionId}: task extraction is off`);
    return { tasks: [], diagnostics };
  }
  if (prompts.length === 0) {
    logTaskExtractionDebug(options, `skipping ${sessionId}: no task prompts`);
    return { tasks: [], diagnostics };
  }

  const instructions = resolveInstructions(options, diagnostics);
  if (!instructions) {
    logTaskExtractionDebug(options, `skipping ${sessionId}: no task extraction prompt available`);
    return { tasks: [], diagnostics };
  }

  const promptSource = options?.promptFile
    ? `prompt file ${options.promptFile}`
    : options?.prompt
      ? "custom prompt"
      : "default prompt";
  logTaskExtractionDebug(options, `using ${promptSource}`);
  const prompt = buildTaskExtractionPrompt(sessionId, prompts, instructions);
  logPromptSizeEstimate(`pass 1 (segment) ${sessionId}`, prompt); // TEMP (remove)
  logTaskExtractionDebug(options, `prompt bytes=${Buffer.byteLength(prompt, "utf8")}`);
  logTaskExtractionBlock(options, "prompt", prompt);
  if (provider === "claude") {
    logTaskExtractionDebug(
      options,
      `running claude provider with model ${options?.model || DEFAULT_TASK_EXTRACTION_MODEL}`,
    );
  } else if (provider === "command") {
    logTaskExtractionDebug(options, `running command provider: ${options?.command ?? "(none)"}`);
  }
  const result = await runProvider(provider, prompt, options);
  logTaskExtractionDebug(
    options,
    `provider finished: ok=${result.ok}${result.status == null ? "" : ` status=${result.status}`}${
      result.error ? ` error=${result.error}` : ""
    }`,
  );
  logTaskExtractionBlock(options, "provider stdout", result.stdout);
  if (result.stderr?.trim()) {
    logTaskExtractionBlock(options, "provider stderr", result.stderr);
  }
  if (!result.ok) {
    diagnostics.push(
      diagnostic(
        "task_extraction_failed",
        `Couldn't extract tasks for ${sessionId}: ${result.error ?? "no output"}`,
        "warning",
        prompts[0]?.position,
      ),
    );
    return { tasks: [], diagnostics };
  }

  try {
    const specs = parseTaskExtractionOutput(result.stdout);
    logTaskExtractionDebug(options, `parsed tasks=${specs.length}`);
    const tasks = taskFactsFromSpecs(sessionId, prompts, specs);
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
        prompts[0]?.position,
      ),
    );
    return { tasks: [], diagnostics };
  }
}

// --- Pass 2: per-task outcome and frustration (#91) ---

export const DEFAULT_TASK_OUTCOME_PROMPT = `You judge how a single task in a coding-agent session turned out, from the dialogue between the user and the assistant.

Return JSON only. Use this exact shape:
{"outcome":"success","frustration":"none","signals":["short tag"],"reason":"one sentence"}

Rules:
- outcome is one of: "success" (the user got what they asked for), "failure" (they clearly did not), "unclear" (you can't tell).
- Judge from the WHOLE exchange, not just the final message. Users sometimes give up mid-task, and assistants sometimes over-claim success.
- frustration is one of: "none", "low", "high" — how frustrated the user seemed across the task (repeated re-asks, corrections, escalating tone, or the assistant repeatedly saying it can't do something / lacks access).
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
  dialogue: DialogueTurn[],
  instructions = DEFAULT_TASK_OUTCOME_PROMPT,
): string {
  const turns = dialogue.map((turn) => ({ role: turn.role, text: turn.text }));
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
    ? values.signals.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];
  if (signals.length) judgment.signals = signals;
  const reason = typeof values.reason === "string" ? values.reason.trim() : "";
  if (reason) judgment.outcomeReason = reason;
  return judgment;
}

/** Judge one task's outcome from its dialogue slice. Returns undefined when it can't be determined. */
export async function judgeTaskOutcome(
  description: string,
  dialogue: DialogueTurn[],
  options: TaskExtractionOptions | undefined,
): Promise<{ judgment?: TaskOutcomeJudgment; diagnostics: ParserDiagnostic[] }> {
  const provider = taskExtractionProvider(options);
  const diagnostics: ParserDiagnostic[] = [];
  if (provider === "off" || dialogue.length === 0) return { diagnostics };

  const prompt = buildTaskOutcomePrompt(description, dialogue);
  logPromptSizeEstimate(`pass 2 (outcome) "${description.slice(0, 60)}"`, prompt); // TEMP (remove)
  const result = await runProvider(provider, prompt, options);
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
    return { judgment: parseTaskOutcomeOutput(result.stdout), diagnostics };
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
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * The full two-pass extraction (#91): pass 1 segments the user messages into tasks, pass 2 judges
 * each task's outcome from the dialogue projected over the task's **interactions** (#122). Tasks span
 * interactions, so a task's slice is `[its first owned interaction's ts, the next task's first
 * interaction's ts)` — boundaries align to interaction openings (no mid-loop slices). `interactions`
 * is the reconcile-derived spine for the session; `dialogue` is the in-memory intermediate (never
 * stored). Returns task facts carrying outcome fields. Materialize independently assigns the same
 * interaction→task membership (via the shared `assignInteractionTaskSeqs`) onto resolved_interactions.task_seq.
 */
export async function extractTasksWithOutcome(
  sessionId: string,
  prompts: TaskPrompt[],
  interactions: InteractionFact[],
  dialogue: DialogueTurn[],
  options: TaskExtractionOptions | undefined,
): Promise<{ tasks: TaskFact[]; diagnostics: ParserDiagnostic[] }> {
  const pass1 = await extractTasksForSession(sessionId, prompts, options);
  const diagnostics = [...pass1.diagnostics];
  if (!pass1.tasks.length) return { tasks: pass1.tasks, diagnostics };

  // Chronological order so resolved_tasks.seq (and thus the interaction→task assignment) increases
  // along the timeline.
  const tasks = [...pass1.tasks].sort(
    (a, b) => (a.timestampMs ?? Infinity) - (b.timestampMs ?? Infinity),
  );

  // Judge each task over the dialogue projected onto the interactions it OWNS — the same
  // assignInteractionTaskSeqs bookmark the materializer stamps onto resolved_interactions.task_seq, so
  // the judged dialogue matches the stored membership exactly. A task that owns no interaction (its
  // anchor falls between two interaction openings — its stored task_seq membership is empty too) is
  // judged over nothing: no fallback to the task's own timestamp, which would slice in turns the store
  // attributes to no task (or to the neighbour).
  const taskSeqByInteraction = assignInteractionTaskSeqs(tasks, interactions);
  const earliestInteractionTs = new Map<number, number>();
  for (const interaction of interactions) {
    if (interaction.timestampMs == null) continue;
    const taskIndex = taskSeqByInteraction.get(interaction.seq);
    if (taskIndex == null) continue;
    const prev = earliestInteractionTs.get(taskIndex);
    if (prev == null || interaction.timestampMs < prev) earliestInteractionTs.set(taskIndex, interaction.timestampMs);
  }

  // Tasks owning ≥1 interaction, oldest first; each task's window ends where the next owner's begins.
  const owners = tasks
    .map((task, index) => ({ task, start: earliestInteractionTs.get(index) }))
    .filter((o): o is { task: TaskFact; start: number } => o.start != null)
    .sort((a, b) => a.start - b.start);
  logTaskExtractionDebug(
    options,
    `judging outcome for ${owners.length}/${tasks.length} tasks in ${sessionId}`,
  );
  // `owners` is sorted ascending, so each window ends where the next begins — `owners[i + 1]`, not an
  // O(n) rescan. Owners sharing a start get an empty [start, start) slice for all but the last.
  await mapWithLimit(
    owners.map((o, i) => ({ task: o.task, start: o.start, end: owners[i + 1]?.start })),
    4,
    async ({ task, start, end }) => {
      const slice = sliceDialogueByTime(dialogue, start, end);
      const { judgment, diagnostics: outcomeDiagnostics } = await judgeTaskOutcome(
        task.description,
        slice,
        options,
      );
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
