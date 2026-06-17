import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  createFactId,
  type ParserDiagnostic,
  type SourcePosition,
  type TaskCandidateFact,
  type TaskFact,
} from "./store-contract.ts";

const MAX_LLM_BUFFER_BYTES = 32 * 1024 * 1024;

export const DEFAULT_TASK_EXTRACTION_PROVIDER = "claude";

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
}

export interface ExtractedTaskSpec {
  description: string;
  messageIndexes: number[];
}

interface ProviderResult {
  ok: boolean;
  stdout: string;
  error?: string;
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
  candidates: TaskCandidateFact[],
  instructions = DEFAULT_TASK_EXTRACTION_PROMPT,
): string {
  const messages = candidates.map((candidate, index) => ({
    index,
    ...(candidate.timestampMs != null
      ? { timestamp: new Date(candidate.timestampMs).toISOString() }
      : {}),
    text: candidate.text,
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

function runClaude(prompt: string, options: TaskExtractionOptions | undefined): ProviderResult {
  const args = ["-p", prompt];
  if (options?.model) args.push("--model", options.model);
  const result = spawnSync("claude", args, {
    encoding: "utf8",
    maxBuffer: MAX_LLM_BUFFER_BYTES,
  });
  const error = result.error
    ? result.error.message
    : result.status !== 0
      ? result.stderr?.trim() || `exited with status ${result.status}`
      : undefined;
  return { ok: !error && !!result.stdout?.trim(), stdout: result.stdout ?? "", error };
}

function runCommand(prompt: string, command: string | undefined): ProviderResult {
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
  const result = spawnSync(argv[0]!, argv.slice(1), {
    input: prompt,
    encoding: "utf8",
    maxBuffer: MAX_LLM_BUFFER_BYTES,
  });
  const error = result.error
    ? result.error.message
    : result.status !== 0
      ? result.stderr?.trim() || `exited with status ${result.status}`
      : undefined;
  return { ok: !error && !!result.stdout?.trim(), stdout: result.stdout ?? "", error };
}

function runProvider(
  provider: TaskExtractionProvider,
  prompt: string,
  options: TaskExtractionOptions | undefined,
): ProviderResult {
  if (provider === "claude") return runClaude(prompt, options);
  if (provider === "command") return runCommand(prompt, options?.command);
  return { ok: true, stdout: "{\"tasks\":[]}" };
}

function uniqueValidIndexes(indexes: number[], candidates: TaskCandidateFact[]): number[] {
  return [...new Set(indexes)]
    .filter((index) => index >= 0 && index < candidates.length)
    .sort((a, b) => a - b);
}

export function taskFactsFromSpecs(
  sessionId: string,
  candidates: TaskCandidateFact[],
  specs: ExtractedTaskSpec[],
): TaskFact[] {
  if (!candidates.length) return [];
  return specs.map((spec, taskIndex) => {
    const indexes = uniqueValidIndexes(spec.messageIndexes, candidates);
    const anchor = indexes.length ? candidates[indexes[0]!]! : candidates[0]!;
    const timestampCandidate = indexes.length
      ? indexes
          .map((index) => candidates[index]?.timestampMs)
          .find((timestamp): timestamp is number => timestamp != null)
      : anchor.timestampMs;
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
      evidence: indexes.length ? `message indexes: ${indexes.join(", ")}` : "message indexes: unknown",
      evidenceKind: "llm_inference",
      position: anchor.position,
    };
    if (timestampCandidate != null) fact.timestampMs = timestampCandidate;
    return fact;
  });
}

export function extractTasksForSession(
  sessionId: string,
  candidates: TaskCandidateFact[],
  options: TaskExtractionOptions | undefined,
): { tasks: TaskFact[]; diagnostics: ParserDiagnostic[] } {
  const provider = taskExtractionProvider(options);
  const diagnostics: ParserDiagnostic[] = [];
  if (provider === "off" || candidates.length === 0) {
    return { tasks: [], diagnostics };
  }

  const instructions = resolveInstructions(options, diagnostics);
  if (!instructions) {
    return { tasks: [], diagnostics };
  }

  const prompt = buildTaskExtractionPrompt(sessionId, candidates, instructions);
  const result = runProvider(provider, prompt, options);
  if (!result.ok) {
    diagnostics.push(
      diagnostic(
        "task_extraction_failed",
        `Couldn't extract tasks for ${sessionId}: ${result.error ?? "no output"}`,
        "warning",
        candidates[0]?.position,
      ),
    );
    return { tasks: [], diagnostics };
  }

  try {
    const specs = parseTaskExtractionOutput(result.stdout);
    return { tasks: taskFactsFromSpecs(sessionId, candidates, specs), diagnostics };
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "task_extraction_bad_response",
        `Couldn't read task extractor output for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warning",
        candidates[0]?.position,
      ),
    );
    return { tasks: [], diagnostics };
  }
}
