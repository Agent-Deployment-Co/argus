// Local (subprocess) LLM providers: `claude` (the headless `claude -p` CLI) and `command` (an
// arbitrary local command). Moved here verbatim from the old task-extraction module when LLM access
// was generalized (#132) — these are the no-API-key providers, and `claude` stays the default so
// "no LLM configured" behaves exactly as before.
import { spawn } from "node:child_process";
import type { LlmResult, LocalProviderContext, ProviderCall, ProviderDescriptor } from "../types.ts";

/** Cap on a provider's stdout so a runaway process can't exhaust memory. */
export const MAX_LLM_BUFFER_BYTES = 32 * 1024 * 1024;

/** Default model for the `claude` provider — a cheap, fast model for high-volume per-session calls. */
export const DEFAULT_CLAUDE_PROVIDER_MODEL = "haiku";

/**
 * Args for the headless `claude` provider. Defaults: `--no-session-persistence` (don't leave a
 * transcript on disk — these interpret calls would otherwise be re-indexed as bogus sessions) and a
 * cheap default model. `-` reads the prompt from stdin; a configured model overrides the default.
 * (Note: `--bare` is deliberately NOT used — in `-p` mode it skips credential loading and the call
 * fails "Not logged in"; the tolerant output parsers already handle the normal fenced/wrapped output.)
 */
export function claudeProviderArgs(model?: string): string[] {
  return ["-p", "--no-session-persistence", "--model", model || DEFAULT_CLAUDE_PROVIDER_MODEL, "-"];
}

/** Split a command string into argv, honoring single/double quotes and backslash escapes. */
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

function spawnWithStdin(
  file: string,
  args: string[],
  input: string,
  signal?: AbortSignal,
): Promise<LlmResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], signal });
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
      resolve({ ok: !error && !!stdout.trim(), text: stdout, error, status: code });
    });

    child.on("error", (err) => {
      resolve({ ok: false, text: "", error: err.message, status: undefined });
    });
  });
}

/** The general layer splits `system` from `prompt`; the single-blob CLIs take one stream, so fold a
 *  system instruction (if any) onto the front of the prompt. */
function blob(ctx: LocalProviderContext): string {
  return ctx.system ? `${ctx.system}\n\n${ctx.prompt}` : ctx.prompt;
}

export async function runClaudeProvider(ctx: LocalProviderContext): Promise<LlmResult> {
  return spawnWithStdin("claude", claudeProviderArgs(ctx.model), blob(ctx), ctx.signal);
}

export async function runCommandProvider(ctx: LocalProviderContext): Promise<LlmResult> {
  const command = ctx.command;
  if (!command?.trim()) return { ok: false, text: "", error: "no command configured" };
  let argv: string[];
  try {
    argv = splitCommand(command);
  } catch (error) {
    return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
  }
  if (!argv.length) return { ok: false, text: "", error: "no command configured" };
  return spawnWithStdin(argv[0]!, argv.slice(1), blob(ctx), ctx.signal);
}

export const claudeCliProvider: ProviderDescriptor = {
  name: "claude-cli",
  defaultModel: DEFAULT_CLAUDE_PROVIDER_MODEL,
  complete: (call: ProviderCall) =>
    runClaudeProvider({ system: call.system, prompt: call.prompt, model: call.model, signal: call.signal }),
};

export const commandProvider: ProviderDescriptor = {
  name: "command",
  complete: (call: ProviderCall) =>
    runCommandProvider({ system: call.system, prompt: call.prompt, command: call.command, signal: call.signal }),
};
