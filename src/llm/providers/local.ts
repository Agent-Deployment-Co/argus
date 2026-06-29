// Local (subprocess) LLM providers: `claude` (the headless `claude -p` CLI) and `command` (an
// arbitrary local command). Moved here verbatim from the old task-extraction module when LLM access
// was generalized (#132) — these are the no-API-key providers, and `claude` stays the default so
// "no LLM configured" behaves exactly as before.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { LlmResult, LocalProviderContext, ProviderCall, ProviderDescriptor } from "../types.ts";

/** Cap on a provider's stdout so a runaway process can't exhaust memory. */
export const MAX_LLM_BUFFER_BYTES = 32 * 1024 * 1024;

/** Default model for the `claude` provider — a cheap, fast model for high-volume per-session calls. */
export const DEFAULT_CLAUDE_PROVIDER_MODEL = "haiku";

const CLAUDE_BIN = "claude";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Search `$PATH` in-process for an executable `claude` (the fast path for a terminal-launched CLI;
 *  honors PATHEXT on Windows). */
function findOnPath(): string | undefined {
  const path = process.env.PATH;
  if (!path) return undefined;
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, CLAUDE_BIN + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Ask the user's login + interactive shell where `claude` resolves. This loads their profile
 *  (`.zshrc`/`.bash_profile`/…), so it finds binaries on the *shell* PATH — nvm/fnm node bins,
 *  `~/.local/bin`, Homebrew — that a GUI-launched app's minimal PATH lacks (#159). Non-Windows;
 *  time-boxed against a hang; only an absolute, executable result is accepted (so a shell function or
 *  noise printed by the profile is rejected). */
function findViaLoginShell(): string | undefined {
  if (process.platform === "win32") return undefined;
  const shell = process.env.SHELL || "/bin/bash";
  try {
    const res = spawnSync(shell, ["-lic", `command -v ${CLAUDE_BIN}`], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = res.stdout?.trim().split("\n").pop()?.trim();
    if (line && isAbsolute(line) && isExecutable(line)) return line;
  } catch {
    // ignore — fall through to the next strategy
  }
  return undefined;
}

/** Probe the common install locations for `claude` (Claude Code's native installer, Homebrew, npm
 *  global). Fast and deterministic; a fallback when the shell lookup is unavailable or fails. */
function findInKnownLocations(): string | undefined {
  const home = homedir();
  const candidates =
    process.platform === "win32"
      ? [join(process.env.APPDATA ?? "", "npm", "claude.cmd")]
      : [
          join(home, ".local", "bin", CLAUDE_BIN), // Claude Code native installer
          join(home, ".claude", "local", CLAUDE_BIN),
          `/opt/homebrew/bin/${CLAUDE_BIN}`, // Homebrew (Apple silicon)
          `/usr/local/bin/${CLAUDE_BIN}`, // Homebrew (Intel) / manual
          join(home, ".npm-global", "bin", CLAUDE_BIN),
        ];
  return candidates.find(isExecutable);
}

/** Injectable probes (the auto-resolution strategies) so tests can drive resolution without touching
 *  the real PATH/shell/filesystem. Production uses the defaults. */
export interface ClaudeBinaryProbes {
  onPath?: () => string | undefined;
  loginShell?: () => string | undefined;
  knownLocations?: () => string | undefined;
}

/** Memoized auto-resolution (no explicit override, default probes): null once we've looked and found
 *  nothing, so the login-shell spawn runs at most once per process. `undefined` = not yet computed. */
let cachedAuto: string | null | undefined;

/**
 * Resolve the `claude` binary, aiming to "just work" without configuration:
 *   1. explicit override (`llm.claudeCliPath` / `ARGUS_CLAUDE_CLI_PATH`, threaded in as `explicit`),
 *   2. `$PATH` (terminal launches),
 *   3. the user's login-shell PATH (GUI/desktop launches — #159),
 *   4. common install locations,
 *   5. bare `"claude"` (lets spawn surface a clear ENOENT we turn into actionable guidance).
 * The explicit override is honored verbatim and never cached; the auto-resolution (2–4) is cached.
 */
export function resolveClaudeBinary(explicit?: string, probes?: ClaudeBinaryProbes): string {
  if (explicit?.trim()) return explicit.trim();
  if (probes) {
    return probes.onPath?.() ?? probes.loginShell?.() ?? probes.knownLocations?.() ?? CLAUDE_BIN;
  }
  if (cachedAuto === undefined) {
    cachedAuto = findOnPath() ?? findViaLoginShell() ?? findInKnownLocations() ?? null;
  }
  return cachedAuto ?? CLAUDE_BIN;
}

/** Test-only: clear the memoized auto-resolution. */
export function resetClaudeBinaryCache(): void {
  cachedAuto = undefined;
}

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
  const bin = resolveClaudeBinary(ctx.claudeCliPath);
  const result = await spawnWithStdin(bin, claudeProviderArgs(ctx.model), blob(ctx), ctx.signal);
  // Turn a "not found" into actionable guidance instead of a bare ENOENT (the failure behind #159).
  if (!result.ok && result.error && /ENOENT|not found/i.test(result.error)) {
    return {
      ...result,
      error: `Couldn't find the \`claude\` CLI (tried "${bin}"). Make sure Claude Code is installed, set ARGUS_CLAUDE_CLI_PATH (or llm.claudeCliPath) to its full path, or choose a different LLM provider.`,
    };
  }
  return result;
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
  configFields: ["model", "claudeCliPath"],
  complete: (call: ProviderCall) =>
    runClaudeProvider({
      system: call.system,
      prompt: call.prompt,
      model: call.model,
      claudeCliPath: call.claudeCliPath,
      signal: call.signal,
    }),
};

export const commandProvider: ProviderDescriptor = {
  name: "command",
  configFields: ["command"],
  complete: (call: ProviderCall) =>
    runCommandProvider({ system: call.system, prompt: call.prompt, command: call.command, signal: call.signal }),
};
