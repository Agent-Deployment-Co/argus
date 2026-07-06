// macOS sandbox wrapping for the headless `claude -p` provider. Extracted from local.ts (#132): the
// `claude` CLI is spawned inside a `sandbox-exec` profile that denies everything by default and allows
// only the reads/writes the CLI legitimately needs (its config dir, temp, system libs, network). This
// module owns the profile generation, the command wrapping, and the process-lifetime "sandbox failed,
// stop trying" latch; local.ts calls claudeSandboxCommand() and, on a sandboxed failure at runtime,
// disableClaudeSandbox() before retrying unsandboxed.
import { accessSync, constants, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { LlmResult } from "../types.ts";
import {
  defaultReadFilePrefix,
  resolveShebangSandbox,
  type ReadFilePrefix,
} from "./shebang.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Set once (process-lifetime) when a sandboxed `claude -p` call fails at runtime: later calls then
 *  skip the sandbox instead of paying the failed attempt + retry every time. */
let claudeSandboxDisabledReason: string | undefined;

/** Record that the sandbox failed at runtime so subsequent calls skip it (see runClaudeProvider). */
export function disableClaudeSandbox(reason: string): void {
  claudeSandboxDisabledReason = reason;
}

/** Test-only: re-enable sandbox attempts after a previous runtime failure disabled them. */
export function resetClaudeSandboxState(): void {
  claudeSandboxDisabledReason = undefined;
}

/** Whether a path is an executable file. Shared with local.ts's binary resolution. */
export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ClaudeSandboxProfileOptions {
  claudeBin: string;
  realClaudeBin?: string;
  homeDir?: string;
  claudeDir?: string;
  tmpDir?: string;
  env?: NodeJS.ProcessEnv;
  extraProcessExecPaths?: string[];
}

export interface ClaudeSandboxRuntimeOptions extends Omit<ClaudeSandboxProfileOptions, "claudeBin" | "realClaudeBin"> {
  platform?: string;
  sandboxExecPath?: string;
  isExecutable?: (path: string) => boolean;
  realpath?: (path: string) => string;
  readFilePrefix?: ReadFilePrefix;
}

export interface ClaudeSandboxCommand {
  file: string;
  args: string[];
  sandboxed: boolean;
  warning?: string;
}

const SANDBOX_SYSTEM_READ_SUBPATHS = [
  "/System",
  "/Library/Apple",
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/lib",
  "/usr/libexec",
  "/usr/share",
];

const SANDBOX_MACOS_READ_LITERALS = [
  "/dev/autofs_nowait",
  "/Library/Keychains/System.keychain",
  "/Library/Preferences/com.apple.networkd.plist",
];

const SANDBOX_TEMP_ROOTS = [
  "/tmp",
  "/private/tmp",
  "/var/folders",
  "/private/var/folders",
];

const CLAUDE_ROOT_FILES = [
  ".credentials.json",
  "credentials.json",
  "config.json",
  "settings.json",
  "settings.local.json",
  "statsig.json",
];

const CLAUDE_SUPPORT_DIRS = [
  ".cache",
  "agents",
  "cache",
  "commands",
  "local",
  "logs",
  "plugins",
  "skills",
];

const CLAUDE_WRITABLE_SUPPORT_DIRS = [
  ".cache",
  "cache",
  "logs",
  "plugins",
  "session-env",
  "telemetry",
];

/** With `process-exec` denied by default (see the clauses below), the sandboxed `claude -p` may exec
 *  ONLY these binaries: its own path (+ realpath), the interpreter chain for shebang wrappers, and
 *  `/usr/bin/security`. `security` is the one mandatory helper — `claude -p` shells out to it to read
 *  login-keychain credentials, and a denied exec there is a *fatal* uncaught EPERM (not the graceful
 *  "no git context" degradation). Everything else is blocked on purpose, which is the whole point of
 *  the allowlist:
 *   - Apple's Command Line Tools *stubs* in `/usr/bin` (git, python3, clang, …). On a Mac without
 *     Xcode CLT installed, exec'ing one pops the "install command line tools" dialog — jarring for a
 *     background call the user never asked to run. `claude -p` probes git for repo context and may
 *     touch others; the CLI tolerates each being unavailable, so blocking them just skips that step.
 *   - Hook/plugin subprocesses (e.g. a SessionEnd hook's `/bin/sh`). A background task-extraction call
 *     shouldn't be running the user's hooks as a side effect anyway; denying the exec is tolerated.
 *  If a future CLI version needs another mandatory helper, the denied exec surfaces "operation not
 *  permitted", which `isClaudeSandboxFailure` matches — so the caller fails open (retry unsandboxed)
 *  rather than breaking task extraction. */
const SANDBOX_ALLOW_PROCESS_EXEC_LITERALS = ["/usr/bin/security"];

function uniqueSorted(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => !!path?.trim()))].sort();
}

function sandboxPath(value: string): string {
  return JSON.stringify(value);
}

function sandboxLiteral(path: string): string {
  return `(literal ${sandboxPath(path)})`;
}

function sandboxSubpath(path: string): string {
  return `(subpath ${sandboxPath(path)})`;
}

function pathAliases(path: string | undefined): string[] {
  if (!path) return [];
  const aliases = [path];
  if (path.startsWith("/var/")) aliases.push(`/private${path}`);
  if (path.startsWith("/tmp/")) aliases.push(`/private${path}`);
  return aliases;
}

function parentDirectories(path: string | undefined): string[] {
  if (!path?.startsWith("/")) return [];
  const parents: string[] = [];
  let current = dirname(path);
  while (current && current !== "/" && current !== ".") {
    parents.push(current);
    current = dirname(current);
  }
  return parents;
}

function sandboxClause(
  operation: string,
  filters: string[],
  verb: "allow" | "deny" = "allow",
): string | undefined {
  if (!filters.length) return undefined;
  return `(${verb} ${operation}\n  ${filters.join("\n  ")})`;
}

function claudeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.CLAUDE_CONFIG_DIR || join(home, ".claude");
}

function tryRealpath(path: string, realpath: (path: string) => string): string {
  try {
    return realpath(path);
  } catch {
    return path;
  }
}

export function buildClaudeSandboxProfile(opts: ClaudeSandboxProfileOptions): string {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();
  const claudeDir = opts.claudeDir ?? claudeConfigDir(env, home);
  const effectiveTmpDir = opts.tmpDir ?? tmpdir();
  const realClaudeBin = opts.realClaudeBin ?? opts.claudeBin;
  const processExecPaths = uniqueSorted([
    opts.claudeBin,
    realClaudeBin,
    ...SANDBOX_ALLOW_PROCESS_EXEC_LITERALS,
    ...(opts.extraProcessExecPaths ?? []),
  ]);
  const loginKeychain = join(home, "Library", "Keychains", "login.keychain-db");
  const userTextEncoding = join(home, ".CFUserTextEncoding");
  const tmpAliases = uniqueSorted([
    ...pathAliases(effectiveTmpDir),
    ...pathAliases(env.TMPDIR),
  ]);

  const readLiterals = uniqueSorted([
    "/",
    "/dev/dtracehelper",
    ...SANDBOX_MACOS_READ_LITERALS,
    ...processExecPaths,
    loginKeychain,
    userTextEncoding,
    join(home, ".claude.json"),
    ...CLAUDE_ROOT_FILES.map((file) => join(claudeDir, file)),
    "/dev/null",
    "/dev/random",
    "/dev/urandom",
  ]);
  const readMetadataLiterals = uniqueSorted([
    ...parentDirectories(loginKeychain),
    ...parentDirectories(userTextEncoding),
    ...SANDBOX_MACOS_READ_LITERALS.flatMap(parentDirectories),
    ...parentDirectories(claudeDir),
    ...CLAUDE_SUPPORT_DIRS.flatMap((dir) => parentDirectories(join(claudeDir, dir))),
    ...tmpAliases.flatMap(parentDirectories),
    ...SANDBOX_TEMP_ROOTS.flatMap(parentDirectories),
  ]);
  const readSubpaths = uniqueSorted([
    ...tmpAliases,
    ...SANDBOX_TEMP_ROOTS,
    ...SANDBOX_SYSTEM_READ_SUBPATHS,
    dirname(opts.claudeBin),
    dirname(realClaudeBin),
    ...processExecPaths.flatMap((path) => parentDirectories(path).slice(0, 1)),
    ...CLAUDE_SUPPORT_DIRS.map((dir) => join(claudeDir, dir)),
  ]);
  const readWriteLiterals = uniqueSorted([
    "/dev/dtracehelper",
    join(home, ".claude.json"),
    join(home, ".claude.json.backup"),
    ...CLAUDE_ROOT_FILES.map((file) => join(claudeDir, file)),
    "/dev/null",
  ]);
  const readWriteSubpaths = uniqueSorted([
    ...tmpAliases,
    ...SANDBOX_TEMP_ROOTS,
    ...CLAUDE_WRITABLE_SUPPORT_DIRS.map((dir) => join(claudeDir, dir)),
  ]);

  const clauses = [
    "(version 1)",
    "(deny default)",
    // Allow forking and process introspection, but NOT arbitrary exec — that's clamped to an
    // allowlist below. (This replaces the old blanket `(allow process*)`.)
    "(allow process-fork)",
    "(allow process-info*)",
    "(allow network*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    // Deny exec by default, then re-allow only claude itself and the mandatory keychain helper.
    // Seatbelt gives the later, more-specific `allow` precedence over this blanket `deny`, so every
    // other exec — the Apple CLT stubs (git/python3/…) and any hook subprocesses — stays blocked.
    "(deny process-exec)",
    sandboxClause(
      "process-exec",
      processExecPaths.map(sandboxLiteral),
    ),
    sandboxClause("file-ioctl", [sandboxLiteral("/dev/dtracehelper")]),
    sandboxClause("file-read-metadata", readMetadataLiterals.map(sandboxLiteral)),
    sandboxClause("file-read*", [
      ...readLiterals.map(sandboxLiteral),
      ...readSubpaths.map(sandboxSubpath),
    ]),
    sandboxClause("file-write* file-write-create", [
      ...readWriteLiterals.map(sandboxLiteral),
      ...readWriteSubpaths.map(sandboxSubpath),
    ]),
  ].filter((clause): clause is string => !!clause);

  return `${clauses.join("\n")}\n`;
}

export function claudeSandboxCommand(
  bin: string,
  args: string[],
  opts: ClaudeSandboxRuntimeOptions = {},
): ClaudeSandboxCommand {
  if (claudeSandboxDisabledReason) {
    return {
      file: bin,
      args,
      sandboxed: false,
    };
  }

  if ((opts.platform ?? process.platform) !== "darwin") {
    return {
      file: bin,
      args,
      sandboxed: false,
      warning: "claude-cli sandbox unavailable because sandbox-exec only runs on macOS; running without sandbox",
    };
  }

  if (!isAbsolute(bin)) {
    return {
      file: bin,
      args,
      sandboxed: false,
      warning: `claude-cli sandbox unavailable because the resolved claude path is not absolute ("${bin}"); running without sandbox`,
    };
  }

  const sandboxExecPath = opts.sandboxExecPath ?? SANDBOX_EXEC;
  const canExecute = opts.isExecutable ?? isExecutable;
  if (!canExecute(sandboxExecPath)) {
    return {
      file: bin,
      args,
      sandboxed: false,
      warning: `claude-cli sandbox unavailable because ${sandboxExecPath} is not executable; running without sandbox`,
    };
  }

  try {
    const realpath = opts.realpath ?? realpathSync.native;
    const realClaudeBin = tryRealpath(bin, realpath);
    const env = opts.env ?? process.env;
    const readFilePrefix = opts.readFilePrefix ?? defaultReadFilePrefix;
    const shebang = resolveShebangSandbox({
      paths: [bin, realClaudeBin],
      env,
      canExecute,
      realpath,
      readFilePrefix,
    });
    const profile = buildClaudeSandboxProfile({
      ...opts,
      claudeBin: bin,
      realClaudeBin,
      extraProcessExecPaths: [
        ...(opts.extraProcessExecPaths ?? []),
        ...shebang.processExecPaths,
      ],
    });
    return {
      file: sandboxExecPath,
      args: [
        "-p",
        profile,
        shebang.launchFile ?? bin,
        ...(shebang.launchArgsPrefix ?? []),
        ...args,
      ],
      sandboxed: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      file: bin,
      args,
      sandboxed: false,
      warning: `claude-cli sandbox unavailable because the sandbox profile could not be built: ${message}; running without sandbox`,
    };
  }
}

export function isClaudeSandboxFailure(result: LlmResult): boolean {
  const message = `${result.error ?? ""}\n${result.text ?? ""}`;
  if (result.status == null && !result.text?.trim()) return true;
  if (/^exited with status \d+$/.test(result.error ?? "") && !result.text?.trim())
    return true;
  return /sandbox-exec|sandbox|profile|deny\(|operation not permitted|not permitted/i.test(message);
}
